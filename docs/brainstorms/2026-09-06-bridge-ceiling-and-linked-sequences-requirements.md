---
date: 2026-09-06
topic: bridge-ceiling-and-linked-sequences
---

# A bridge plays what was linked

## Summary

A crossing stops being clamped to a total of thirty seconds. A bridge plays every clip its
author linked, whole, and the graph reports the transitions whose bridges hold the World
longer than a crossing was ever meant to. The cost of a long crossing becomes visible at
authoring time instead of arriving as a clip cut in half on the projector.

---

## Problem Frame

An author reported linked clips ending early: a sequence of several videos would stop part
way and the machine would move on. Single long clips were unaffected. Two separate mechanisms
produce that one symptom, and only the second is a defect.

On a **State**, an interruptible run is evaluated at every member boundary and an exit time is
a fraction of whichever clip is playing — so a transition with Has Exit Time at 0.75 over a
three-clip gesture is offered three times a pass and can leave after the first clip. That is
the documented design (`docs/brainstorms/2026-09-02-clip-sequences-requirements.md`, R7 and
AE2) and the **plays whole** switch is its answer. Nothing here changes it.

On a **transition**, there is no switch, because a crossing is uninterruptible by
construction. But the ceiling that bounds a crossing bounds the *whole* crossing rather than
each clip in it (`server/src/live/runtime.ts:1180-1190`):

```
let budget = MAX_BRIDGE_MS;                      // 30_000
for (const member of bridge.clips) {
  const ms = Math.min(this.durationOf(member), budget);
  budget -= ms;
  await this.wait(claimed, ms, true);
}
```

Once the budget is spent, the remaining members are waited on for zero milliseconds. A bridge
of three twelve-second clips plays twelve, twelve, and then flashes its third clip and lands.
The author is told nothing: `longAtomicRuns` in `shared/src/world-graph.ts:603-621` reports
over-long runs on atomic States and deliberately excludes transitions, on the reasoning that
"a crossing is already clamped to that ceiling, so it cannot exceed what this warns about".

That reasoning is sound about the freeze and silent about the video. The clamp does keep the
World from being held past thirty seconds — and it buys that by cutting a clip in half, which
is the exact failure the subsystem's atomicity invariant exists to prevent. The ceiling was
built for a crossing that gets *stuck*; it cannot tell a stuck bridge from a long one somebody
authored on purpose, so it truncates both, invisibly.

---

## Key Decisions

**A bridge plays whole, whatever its length.** The total clamp is removed. What an author
linked is what crosses. This restates for a transition the rule the rest of the subsystem
already keeps: a run missing part of itself is not the run that was written.

**Nothing replaces the total clamp.** Not a per-member cap, not a raised ceiling. A per-member
cap would still cut a clip in half, and a raised ceiling only moves the cliff somewhere the
author is less likely to find it — both keep the property that made this invisible. The
existing per-clip bounds every clip already passes through (`durationOf`, floored at
`MIN_CLIP_MS` and capped at `MAX_CLIP_MS`) remain the backstop against a nonsense duration, so
removing the crossing's own clamp does not make an unbounded freeze reachable.

**The warning is the guard.** `MAX_BRIDGE_MS` survives as a *reporting* threshold rather than
an enforcement one. A transition whose bridge exceeds it is named in the graph, exactly as an
atomic State's over-long run already is, and for the same reason: a long hold is a thing the
author chose and should be able to see, not a thing the machine silently prevents.

**A long crossing is a warning, never a refusal.** A World that holds one still opens, still
plays, and still crosses. This follows the precedent `longAtomicRuns` set — "a run longer than
a bridge's ceiling is reported rather than refused" — and it keeps an authoring mistake from
becoming a stopped machine mid-show.

**The State side is unchanged.** Per-clip exit times on an interruptible run stay as designed,
and **plays whole** remains the way an author asks for a State's gesture to finish. Changing
the default there is a separate question and is not taken here.

---

## Requirements

- R1. A crossing plays every member of its drawn bridge for that member's own duration. No
  budget is carried across members and no member is waited on for less than its length because
  an earlier member was long.
- R2. `MAX_BRIDGE_MS` no longer clamps playback. It remains defined, and becomes the threshold
  the graph reports against.
- R3. Each member of a bridge is still subject to the bounds every clip passes through, so a
  missing, zero or nonsensical duration behaves on a transition exactly as it does on a State.
- R4. The graph reports every transition whose drawn bridges could total more than
  `MAX_BRIDGE_MS`, naming the transition. A transition with several sequences is reported when
  any one of them exceeds it, because any one of them may be drawn.
- R5. The report is a warning. It never refuses the World, never blocks a save, and never stops
  the crossing being taken.
- R6. The report is a sibling of the existing atomic-State report and is surfaced the same way,
  so an author meets one vocabulary for "this holds the World for a long time" rather than two.
- R7. Everything that makes a crossing uninterruptible is untouched: nothing is evaluated in
  transit, a Parameter set while crossing is recorded and acted on at the landing, a client's
  clip-end report is refused for the crossing's duration, and a Trigger is consumed on landing.
- R8. A World authored before this change plays identically except where it was being truncated,
  where it now plays whole. No manifest change and no migration.

---

## Acceptance Examples

- AE1. **Covers R1, R2.** Given a transition whose bridge is one sequence of three twelve-second
  clips, when the transition is taken, then each clip plays for twelve seconds and the machine
  lands after thirty-six — where today the third clip is waited on for zero.
- AE2. **Covers R4, R5.** Given that same World, when the graph is read, then the transition is
  named as holding the World longer than a crossing is meant to, and the World opens, saves and
  runs unchanged.
- AE3. **Covers R4.** Given a transition holding two sequences, one totalling ten seconds and one
  totalling forty, when the graph is read, then the transition is reported — the short draw does
  not excuse the long one.
- AE4. **Covers R3.** Given a bridge member whose stored duration is missing, when the transition
  is taken, then that member is waited on for the same fallback a State's clip with no duration
  gets, and the crossing completes rather than faulting.
- AE5. **Covers R7.** Given a thirty-six-second bridge, when a Parameter is set eight seconds in,
  then nothing is evaluated until the crossing lands, and the new value is evaluated once there.
- AE6. **Covers R8.** Given a World whose every bridge is a single clip under the ceiling, when it
  is opened after this change, then its behaviour is indistinguishable from before.

---

## Scope Boundaries

**In scope**

- The crossing's wait loop and the ceiling's role in it.
- A graph report for over-long bridges, alongside the one for over-long atomic runs.

**Out of scope**

- The State side of the reported symptom. Per-clip exit times on an interruptible run remain as
  designed, and **plays whole** remains the switch that makes a State's gesture finish.
- Any change to the **plays whole** switch itself, including narrowing what it suppresses.
- Making a crossing interruptible in any way. The invariant is load-bearing and is not in
  question here.
- Anything about how a bridge is authored — linking, unlinking, the panel.

**Deferred for later**

- Whether an interruptible State run should offer an exit time against the whole gesture rather
  than against whichever clip is playing. The current behaviour is authored and documented, but
  "three quarters of the way through whichever clip happens to be on screen" is not a thing an
  author asks for, and this session found it by walking into it. Worth its own brief.
- Whether the **plays whole** switch's label and helper text should mention linked clips, which
  are the only case where its absence bites. Discoverability, not behaviour.

---

## Dependencies / Assumptions

- Assumes `MAX_BRIDGE_MS` is worth keeping as a threshold. Nothing here depends on its being
  thirty seconds; the number is what the report is calibrated against and may be retuned without
  touching any of the above.
- Assumes the existing per-clip duration bounds are an adequate backstop against a nonsense
  reading. They are the same bounds a State's clip already relies on, so this is not a new
  exposure — but it is the only thing standing between a corrupt manifest and a long hold.
- Assumes the graph's existing warning surface can carry a second kind of long-hold report
  without redesign. Unverified against the surface itself.

---

## Outstanding Questions

- **The report cannot see an unmeasured clip.** `longAtomicRuns` sums raw `durationMs` and
  counts a missing one as zero, so a bridge of freshly imported clips — measured by the browser
  on first play, not on import — totals zero and is never reported, however long it really is.
  The new report inherits this if it is built the same way. Whether to report "may exceed, not
  yet measured" as a third state, or to leave the hole, is unresolved.
- Whether the report belongs on the transition's line in the graph, in the fault/warning list,
  or both. The never-fires marks put a static mark on the line; the atomic-run report does not.
- Whether a bridge long enough to outlast the audio Transport's own expectations causes anything
  observable. Not investigated.

---

## References

- `server/src/live/runtime.ts` — `cross`, the budget loop at 1180-1190, `bridgeMs`, `durationOf`.
- `shared/src/world-graph.ts:603-621` — `longAtomicRuns` and the comment that excludes transitions.
- `shared/src/worlds.ts:52` — `MAX_BRIDGE_MS`.
- `docs/brainstorms/2026-09-02-clip-sequences-requirements.md` — R7, R9, AE1, AE2; where the
  per-clip exit time and the always-atomic bridge were decided.
- `CONCEPTS.md`, "Live state machines" — Bridge, In transit, Plays whole, Clip set, Sequence.
