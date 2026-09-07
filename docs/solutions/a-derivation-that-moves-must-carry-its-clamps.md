---
title: A derivation that moves must carry its clamps, not just its arithmetic
date: 2026-09-07
category: bug
tags: [refactoring, shared-code, wire-contract, audio, oracle-tests, blind-spots]
module: shared/src/audio.ts, server/src/live/transport.ts
problem_type: logic_error
symptoms:
  - a value moved into shared code disagrees with the original for inputs nobody tested
  - the field on the wire looks like the field the original read, and is not
  - the pairing test compares the new implementation to itself and can never fail
  - the divergence needs a boundary input (very small, non-finite, zero) to appear
---

## Context

The six reserved audio readouts were computed inside `Transport.readouts()` from the transport's own
private fields. To let a browser evaluate the same clauses the state machine evaluates, the
derivation moved into `shared/src/audio.ts` as `readoutsFrom(state: TransportState)`.

The plan claimed the move was a plain field read: `playing` from `sounding`, plus `index`, `tracks`,
`durationMs`, `positionMs`, `bpm`. It was not. `readouts()` computed length and remaining from a
private `totalMs()`:

```ts
const stored = track.durationMs;
if (!(typeof stored === "number" && Number.isFinite(stored) && stored > 0)) return 0;
return Math.max(stored, MIN_TRACK_MS);   // the 1000ms floor
```

`TransportState.durationMs` is the **stored** number — its own comment says "the stored number, not
the paced one", because a client needs to know a length is still unknown so it can measure it. So a
naive shared function reported `audio.length: 0` for a 300ms track the machine called `1`, and
invented a key for a hand-edited `Infinity` where the original left both absent. Two independent
reviewers found it; the pairing matrix had no sub-second row and no non-finite row, so the delegation
would have shipped green with the browser and the machine disagreeing by a whole second.

The fix moved `MIN_TRACK_MS` and the positive-finite acceptance into `shared/` **with** the function,
and `transport.ts` imports them back.

## Guidance

**A derivation is its arithmetic *plus* its clamps, its floors and its refusals.** Those live in the
private helpers the original called, not in the expression you are copying. Before moving a
computation, list every function it calls and ask which of them normalise the input — those move too,
or the move changes the answer.

**A wire field named like a private field is the trap.** `durationMs` on the message and
`totalMs()` inside the class are both "how long the track is" in English and different numbers in
fact. The comment on the message said so, and the plan still asserted they were interchangeable. When
a refactor swaps a private read for a public one, read the public field's own docstring before
believing the names.

**Absences are part of the contract, and `toEqual` is how you keep them.** `audio.length` and
`audio.remaining` are omitted while the duration is unknown and `audio.bpm` while no tempo is
established, because `clauseHolds` fails an absent value and is satisfied by a zero — an unmeasured
track would otherwise fire every below-threshold clause the moment it started. Compare with `toEqual`
so an extra key fails, not `toMatchObject`.

**After delegation, a self-comparison is not a test.** Once `readouts()` calls `readoutsFrom(...)`,
asserting the two agree is `f(x) === f(x)` and can never fail again. Freeze the *pre-move* arithmetic
as a reference implementation in the test file and compare against that — it stays discriminating
after the delegation lands, and it is the only version of this check that survives the change it was
written for. The plan's original instruction here was backwards: it said a pass after reverting the
delegation proved the test empty, when reverting is precisely what *restores* a real comparison.

**The matrix needs the rows where the clamps bite.** Nothing-held, held-not-sounding, sounding,
unknown duration and unknown tempo were all present and all agreed. The rows that mattered were a
track shorter than the floor and a duration of `Infinity`.

## Related

- `docs/solutions/a-threshold-guard-written-as-a-negation-fails-open-on-nan.md` — why the acceptance
  is one negation around the whole thing, and why it had to travel with the function.
- `docs/solutions/a-flag-nothing-reads-looks-shipped.md` — the reason the readouts are derived from
  the transport at all rather than published on the live state.
- `docs/solutions/byte-identity-needs-an-oracle-recorded-first.md` — the same lesson about what an
  oracle has to be recorded *before* the change.
