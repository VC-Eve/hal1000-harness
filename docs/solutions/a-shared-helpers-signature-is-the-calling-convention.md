---
title: A shared helper's signature is the calling convention, so four call sites "forgetting" is one signature
date: 2026-08-09
category: pattern
tags: [refactoring, invariants, code-review, types, blind-spots]
module: server/src/providers/provider.ts, server/src/providers/probe.ts, server/src/readiness.ts
problem_type: logic_error
symptoms:
  - a review returns several findings that are obviously the same mistake in different files
  - the obvious remedy is "apply the rule everywhere" and it feels mechanical
  - the helper everyone calls has a comment stating an assumption that used to be true
  - one of the sites you were about to "fix" is actually correct as written
---

## What happened

A review of the backend split returned ten findings. Four were visibly one mistake: a backend had
become `(endpoint, protocol, apiKey)`, and four places still compared it as an endpoint string.

The tempting reading is that four call sites forgot. The actual cause was one line:

```ts
export function sameBackend(a: string, b: string): boolean
```

Backend identity was compared by a function taking two strings, whose own doc comment said
*"Both need one value to compare, and `endpoint` is it."* Every caller had to reach into `.endpoint`
to call it. Collapsing a backend to its endpoint was not a lapse anyone committed — it was the only
way to use the helper. The signature was the convention, and the convention was written when it was
true.

## What the audit changed

The obvious remedy — make it take whole backends, fix every caller — would have been a regression.

Enumerating **all seven** identity sites, rather than the four the review named, showed five were
correctly endpoint-only:

| Site | Question | Endpoint enough |
|---|---|---|
| the queue's `contends` | which machine is busy generating? | yes |
| the off-machine gate | is this destination on this box? | yes |
| the protocol cache key | what does this port speak? | yes |
| the window cache key | which server-and-model is this window for? | near enough |
| readiness' verdict copy | will one slot's answer transfer? | **no** |
| `list-models`' short-circuit | will one slot's answer transfer? | **no** |

Contention is about VRAM on one box. Two slots pointed at one host with different keys genuinely do
contend — one GPU, one model at a time — so teaching that comparison to tell them apart would have
restored the exact stall that narrowing preemption had just removed.

So one name was answering two questions that agree everywhere except the configuration where it
matters: one host, two credentials. Every caller wanting "same machine" got it right. Both callers
wanting "same destination" got "same machine".

## The rule

**When a review returns N instances of one mistake, find the shared thing that made it the default
before fixing the instances.** A signature, a helper, a base class, a convention in a doc. N sites
independently making the same error is rare; N sites complying with one stale contract is common.

**Then enumerate every site, not just the reported ones, before deciding the remedy.** The reported
sites are the ones that broke. The unreported ones tell you whether the rule you are about to apply
universally is actually universal. Here, five of seven said it was not.

**Prefer splitting the name over widening the type.** `sameHost` and `sameDestination` make a caller
picking wrongly visibly pick, rather than comply. A single widened predicate would have forced one
answer where two are correct.

**Then try to delete the call sites rather than correct them.** Both wrong callers were
short-circuits avoiding a duplicate round trip. Moving that job into one helper that dedupes by whole
backend left `sameDestination` with exactly one caller — inside the helper. The invariant now holds
because there is one place to ask, not because everyone remembers.

## The near-miss worth recording

The plan for this work specified a cache keyed on the resolved backend, invalidated when settings
change — reusing the protocol cache's invalidation point.

That would have shipped a staleness bug. Both callers list models, and a model list is not stable for
a process lifetime: someone who runs `ollama pull` expects the next readiness refresh to show it,
without touching a setting. A protocol is a property of an endpoint and keeps; a model list is a
snapshot and does not. What the callers needed was a **dedupe scoped to one pass and discarded**,
which has the round-trip saving with no staleness and no invalidation point at all.

Reading the consuming code end to end is what caught it, after the design decision had already been
stated out loud. Related: [[a-value-frozen-for-one-caller-is-stale-for-the-next]] — same family, and
this is the version where the freezing had not happened yet.

Related: [[splitting-a-singleton-leaves-every-lookup-keyed-to-the-old-one]], which named this class
one day earlier for *caching*. This is the same lesson for *comparison*, and the earlier pass did not
reach it because comparison sites do not look like state.
