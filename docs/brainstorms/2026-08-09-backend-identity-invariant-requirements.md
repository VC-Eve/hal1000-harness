---
date: 2026-08-09
topic: backend-identity-invariant
---

# One name for two questions: making the backend-identity leak impossible

## Summary

A code review of the shipped backend split found ten defects, four of which are the same
mistake — a backend is `(endpoint, protocol, apiKey)` but is compared as an endpoint string.
The obvious remedy, making the comparison take whole backends, is wrong: an audit of every
identity site shows most of them are *correctly* endpoint-scoped, and widening them would
break the queue's contention rule.

The actual defect is that one function, `sameBackend`, answers two different questions that
diverge precisely when two slots share a host. Split the name, and the compiler stops being
neutral about which one a caller meant. Then delete the two call sites that wanted the second
question, because both exist only to avoid asking a server twice — a job a cache does without
a predicate.

## Problem Frame

`server/src/providers/provider.ts:117` declares:

```ts
export function sameBackend(a: string, b: string): boolean
```

Its own comment states the assumption: *"Both need one value to compare, and `endpoint` is
it."* That was true before the split, when an endpoint was the whole of a backend. It has been
false since `ResolvedBackend` gained `protocol` and `apiKey`, and the signature has kept every
caller compliant with the old world — reaching into `.endpoint` is not a lapse, it is the
calling convention.

The full audit of identity sites, which is what makes the scope small:

| Site | Question | Endpoint sufficient |
|---|---|---|
| `providers/queue.ts:43` `contends` | Is this the same machine, busy with a model? | Yes |
| `chat.ts:374`, `vision/service.ts:1119` `identityMayLeave` | Is this destination on this machine? | Yes |
| `providers/detect.ts:35` cache key | What protocol does this endpoint speak? | Yes |
| `chat.ts:329` `windowKey` | Which server and model does this window belong to? | Near enough |
| `chat.ts:193` list-models short-circuit | Will one slot's answer transfer to the other? | **No** |
| `readiness.ts:65` `chatIsSeparate` | Will one slot's verdict transfer to the other? | **No** |

Five of seven are right. The two that are wrong are the two asking about *transferable
answers* rather than about a machine, and both were reviewed as confirmed defects: a chat slot
reported `ok` on a probe run with the observation slot's key, and a working observation slot
reported `error` because the chat slot's keyless list failed.

The queue is the proof that "compare whole backends" is the wrong general rule. Contention is
about VRAM on one box. Two slots on one host with different keys genuinely do contend, and
teaching `contends` to distinguish them would restore the very stall the preemption fix
removed.

A third review finding, `readiness.ts:113`, rides along here. Its `models` leg probes only the
observation backend, so "nothing pulled where chat sends" is reported nowhere. It is not a
comparison bug, but it has the same origin — one leg written when there was one endpoint to
have models on — and it is cheapest to correct while readiness is open.

## Key Decisions

**D1. Two named predicates, not one widened one.** `sameHost(a: string, b: string)` keeps the
current body and takes the five correct call sites. `sameDestination(a, b)` compares endpoint,
protocol and key-presence, and answers "will an answer about one apply to the other". The name
is the fix: a caller picking wrongly is now visibly picking, rather than complying with a
signature.

**D2. Delete both `sameDestination` call sites rather than correcting them.** `chat.ts:193`
and `readiness.ts:65` are short-circuits whose only purpose is to avoid a duplicate round trip
when both slots name one server. A probe cache keyed on the resolved backend achieves that
without a predicate: both slots ask, the second gets a hit, and a differing key produces a
different key and therefore a real second probe. This is the load-bearing decision — it means
the correct answer is reached by *not* comparing, and `sameDestination` may ship with no
callers at all.

**D3. `sameDestination` is written and tested even if D2 leaves it uncalled.** It is the
written form of the invariant, and the next module to ask "are these the same destination"
must find it rather than reach for `sameHost`. If it ends with no callers it is deleted, and
that deletion is the strongest possible statement that the question no longer arises.

**D4. Key *presence*, not key value, is what `sameDestination` compares.** Comparing secrets
puts a credential on a hot comparison path for no gain — two slots with different keys are
different destinations whatever the keys say.

**D5. `sameBackend` is removed, not deprecated.** A name that meant one thing and now means one
of two is worse than either replacement, and the codebase is small enough that the compiler
finds every caller in one pass.

## Requirements

- **R1.** `sameHost(a: string, b: string)` exists with `sameBackend`'s current body and comment,
  and is the predicate used by `contends`, `identityMayLeave`'s callers, and the detection cache
  key. Its comment states that it deliberately ignores protocol and key, and why.
- **R2.** `sameDestination(a, b)` exists, comparing normalised endpoint, resolved protocol, and
  whether a key is present. Its comment states what question it answers and names the two review
  findings that motivated it.
- **R3.** `sameBackend` no longer exists. Typecheck passes with no remaining callers.
- **R4.** Readiness probes both slots independently. A slot's verdict is never copied from the
  other slot; a duplicate probe against one server is avoided by cache, not by predicate.
- **R5.** `list-models` lists both slots independently, on the same terms as R4.
- **R6.** The probe cache is keyed such that two slots differing only by key produce two entries,
  and two slots identical in every field produce one.
- **R7.** The readiness `models` leg reports on the backend chat sends to as well as the
  observation one. A chat backend listing no models is visible in readiness rather than only as
  an empty dropdown.
- **R8.** The queue's contention behaviour is unchanged. A test asserts that two slots sharing a
  host but differing by key still contend.

## Acceptance Examples

- **A1.** Both slots on one hosted endpoint, key set on observation only. Readiness reports
  observation `ok` and chat unreachable-or-unauthorised — not `ok` copied across. This is the
  reviewed defect, inverted into a test.
- **A2.** Same configuration, chat keyless. The narration model picker still populates from the
  working observation backend, rather than showing "this backend could not be reached".
- **A3.** Both slots identical in every field. Exactly one probe reaches the server, and both
  rows report from it — the round-trip saving that motivated the original short-circuit survives
  its deletion.
- **A4.** Narration streaming on local Ollama, chat pointed at the same host with a different
  key. A chat send still preempts, because contention is about the machine.
- **A5.** Chat pointed at a server with no model loaded, observation stocked. Readiness says so.

## Scope Boundaries

**In scope.** The identity predicates, the two short-circuit deletions, the probe cache, the
readiness models leg, and tests for each.

**Deferred for later.** The two remaining review findings are adjacent but separate ideas and
are not bundled here: `chat.ts:322` `windowSource` claiming `"reported"` when no window was
obtained, and `openai.ts:83` `modelWindow` ignoring its `model` argument. Both are about a
*window's* provenance rather than a *backend's* identity. `chat.ts:329` `windowKey` stays
endpoint-keyed; the protocol edge is real but has produced no observed defect and inventing a
key for it here would be speculative.

**Outside this work.** The module-contract question — what `ResolvedBackend`, `Provider` and the
factory switch must become for a CLI-subprocess provider that has no URL, no model list and no
messages array — is deliberately not answered here. It is the natural successor, and it should
inherit a seam that is not lying about what a backend is.

**Explicitly not doing.** Widening every comparison to whole backends. The audit shows this
would be a regression in the queue and unnecessary in three other places.

## Dependencies / Assumptions

- Assumes the five endpoint-scoped sites listed in the audit are genuinely correct. Each was
  read for this document; none is assumed from its name.
- Assumes probe results are safe to cache within a settings generation. `SettingsStore.update`
  now clears the protocol cache wholesale (commit `ba3cf38`), which establishes both the
  precedent and the invalidation point a probe cache would reuse.
- Assumes readiness can afford two probes where it currently makes one when the slots differ.
  It already does exactly this today for the separate-backend case.

## Outstanding Questions

- Does the probe cache belong beside the protocol cache in `providers/detect.ts`, or is a
  second module clearer? Both are per-endpoint, both are dropped on settings update, and one
  invalidation point is easier to keep honest than two.
- Should `sameDestination` compare the *resolved* protocol or the stored preference? `auto` on
  both slots resolving to the same protocol is the same destination; `auto` versus a pinned
  `ollama` reaching one server is arguably also the same destination but is not the same
  setting. Resolved is the better answer for probing and the worse one for explaining a
  settings diff to a user.

## Sources / Research

- Review of commits `d5aa105..d5033e9`, 36 candidates, 26 verifiers, 10 reported findings.
  Five fixed in `ba3cf38`, `110ed6b`, `5d80894`; five carried into this document.
- `docs/solutions/a-value-frozen-for-one-caller-is-stale-for-the-next.md` and commit `d5033e9`,
  which named this class before it recurred: *a value that belongs to an instance, stored or
  checked as though it belonged to the application.* This document is that lesson applied to the
  one case the earlier pass did not reach — comparison, as opposed to caching.
- Audit of all seven backend-identity sites, `server/src` and `ui/src`, 2026-08-09.
