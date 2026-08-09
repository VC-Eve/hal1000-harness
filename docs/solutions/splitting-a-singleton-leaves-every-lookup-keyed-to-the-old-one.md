---
title: Splitting a singleton leaves every lookup still keyed to the old one
date: 2026-08-09
category: pattern
tags: [caching, refactoring, invariants, blind-spots, wire-contract, privacy]
module: server/src/chat.ts, server/src/vision/service.ts, server/src/providers/resolve.ts
problem_type: logic_error
symptoms:
  - a cache returns the right answer for the wrong instance after a config change
  - a picker offers values that belong to a different server
  - a guard exists at two of three call sites and nobody can say why the third was missed
  - every one of these is invisible until the singleton actually becomes plural
---

## Context

HAL had one model provider endpoint. `Settings.providerEndpoint` was a single string, and four
inference roles resolved from it: chat, narration, monitors, and Vision's cycle summary.

Adding a second wire protocol turned that one endpoint into two independent backends. The provider
work itself was the easy part. What actually bit — three separate times, in three unrelated
subsystems — was code that had been correct *only because there was one of the thing*.

## The three instances

**A cache keyed by model name.** `ChatService.windowFor` memoised a model's context window by model
name. Correct with one endpoint. With two, `qwen3` on a `llama-server` built at 8k and `qwen3` on
one built at 128k are the same key, so the first backend's answer was served for the second — and
Context Level sized its budgets against a window from a different machine.

**A list broadcast as though it were global.** `list-models` resolved through the chat backend and
broadcast one flat `models` array. The narration model picker read it. So the picker for the
observation backend was offering the chat backend's models.

**A guard applied per-sender rather than per-destination.** The Off-Machine Acknowledgement was
checked at two call sites — chat's context assembly and the recogniser. Vision's cycle summariser,
which ships Character Profiles and banded enrolled names, had no check at all. It was not a
regression: it had never had one, and nobody noticed because every endpoint was loopback Ollama, so
the gate had never once needed to fire.

## The shape

All three are the same mistake wearing different clothes: **a value that belongs to an instance,
stored or checked as though it belonged to the application.**

While there is one instance, "the window", "the models" and "the destination" are unambiguous. The
identity is implicit and therefore uncheckable. Splitting the singleton does not break the code — it
reveals that the code was already relying on a coincidence.

The tell is grammatical. Before the split you say "*the* provider endpoint". After it you must say
"*which* endpoint", and every place that cannot answer that question is a defect.

## What to do

When making a singleton plural, do not start from the feature. Start from an inventory:

1. **Every cache key.** Does it identify the instance, or only what was asked of it? A key of
   `model` must become `endpoint + model`.
2. **Every broadcast.** Does the message say which instance it describes? A payload that does not
   carry its own provenance will be read as belonging to whichever instance the reader happens to
   care about.
3. **Every guard.** Is it applied at the sender or at the destination? A per-sender guard has to be
   remembered N times; a per-destination guard applied through one named function makes an omission
   visible, because a sender that does not call it is a sender that does not mention the rule at all.
4. **Every mutual-exclusion rule.** A lane, a lock, a semaphore, an "only one at a time" — is it
   guarding *the* resource or *a* resource? Anything phrased "one at a time" is a claim about
   something countable, and after a split there is more than one of it.
5. **Every value sent outward.** Not just what is cached and read back, but what is put on the wire.
   Two roles naming two values for one field on one destination is a disagreement the destination has
   to resolve, and it may resolve it expensively.

Item 3 is why `identityMayLeave(endpoint, acknowledged)` exists rather than two open-coded
conditions. The gate did not need better logic. It needed a name, so that not calling it was
conspicuous.

Items 4 and 5 were added a day later, after
[a-lane-is-a-property-of-the-machine-not-of-the-app](a-lane-is-a-property-of-the-machine-not-of-the-app.md)
and [the-window-is-a-property-of-the-destination-not-of-the-role](the-window-is-a-property-of-the-destination-not-of-the-role.md)
turned up as two more instances. The inventory being incomplete is itself the lesson: a list of
places to check, written from the instances you happened to find, is a starting point rather than a
sweep. The queue case is the sharper warning — `contends()` already existed and was correct, wired to
one of the two decisions it governed, and its existence read as coverage to anyone auditing the file.

## Verification that actually bites

Each of these was fixed with a test that fails on the old code, and each was checked by reverting the
fix and watching it fail:

- the window cache test returns 8192 where 131072 is correct
- the model-list test finds `observation-only` offered inside the chat picker
- the summariser test finds an enrolled name in the outgoing prompt

A test that only passes on the fixed code proves nothing about the bug. Reverting and watching red is
the cheap step that turns a plausible test into evidence.

## The trap inside the third one

The summariser tests were written negative-first: "the name does not reach the provider". They passed
immediately — because the harness never produced a recognised face at all, so no name reached the
provider under any condition.

Detection in Vision is fire-and-forget from the tick, so the appearance it opens is only visible to a
*later* capture. Two ticks summarise a cycle in which nobody had been recognised yet. Three ticks —
detect, capture, summarise — are needed before the positive case fires.

**Make the positive case pass first.** A withholding test written before anything was there to
withhold is a test of the harness, not of the gate. See
[tests-that-lock-in-the-bug](tests-that-lock-in-the-bug.md).

## Related

- [a-value-frozen-for-one-caller-is-stale-for-the-next](a-value-frozen-for-one-caller-is-stale-for-the-next.md)
  — the same family, from the other direction: there, one caller's deliberate freeze went stale for a
  second reader. Here, one instance's answer goes stale for a second instance.
- [a-gate-that-checks-one-direction-is-half-a-gate](a-gate-that-checks-one-direction-is-half-a-gate.md)
  — the guard half of this, previously seen as requests-checked-but-pushes-given-away.
- [a-flag-nothing-reads-looks-shipped](a-flag-nothing-reads-looks-shipped.md) — why the window's
  provenance had to be rendered and not merely carried.
- [a-lane-is-a-property-of-the-machine-not-of-the-app](a-lane-is-a-property-of-the-machine-not-of-the-app.md)
  — instance four: the scheduler serialized globally while the helper that knows which machine is
  busy was wired only to preemption.
- [the-window-is-a-property-of-the-destination-not-of-the-role](the-window-is-a-property-of-the-destination-not-of-the-role.md)
  — instance five: the same window cache from instance one, keyed correctly by endpoint but *asked
  for* per role, so two roles named two sizes for one runner.
