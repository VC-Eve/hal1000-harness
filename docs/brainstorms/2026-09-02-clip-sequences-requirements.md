---
date: 2026-09-02
topic: clip-sequences
---

# Clip sequences: a set holds runs, not only single clips

## Summary

A clip set becomes a set of **sequences**. Each pick plays a run of clips in order rather
than one clip, on both States and transitions. Sequences are authored by linking adjacent
rows in the list that already exists, and a State's set carries a switch for whether a pick
can be interrupted part-way through.

---

## Problem Frame

A clip set is a bag: one clip is drawn uniformly each time it is needed, never the one that
just played. That is what stops ten idles reading as one gesture repeating, and it is the
right shape for variety.

It cannot say "these two, in this order". The case that surfaced it is a transition whose
bridge is two clips — the character stands, then walks — that must play in sequence before
the destination State begins. Today the author can put both clips in the transition's set
and get one of them at random, or route through an intermediate State and get a State that
loops when it should pass through. Neither is the gesture.

The same gap sits on States. A three-beat idle — settle, look around, sigh — is authorable
only as three unrelated draws that arrive in whatever order chance gives.

`docs/residual-review-findings/feat-live-clip-sets-and-bridges.md` already records the
adjacent wart: a set's order is presentational, the State panel offers reorder controls
anyway, and the transition panel does not. Sequences make order load-bearing, so that
residual is inside this change rather than beside it.

---

## Key Decisions

**A set holds sequences; a sequence holds clips.** The manifest gains the second level
rather than encoding runs as marks on a flat list. The draw then reads as it behaves — pick
a sequence, play it through — and no arrangement of the data can mean something the machine
does not do.

**Authoring is flat, storage is nested.** The panel stays the single ordered list it is
today, with a link/unlink control between adjacent rows and a bracket showing what belongs
to one run. Linking merges two rows into one sequence; unlinking splits one. This buys the
explicit model without nested drag-and-drop, which is where panels of this kind usually
become unpleasant.

**Atomicity is a switch on a State's set, defaulting to today's behaviour.** An
interruptible set behaves as now: a transition without Has Exit Time cuts the current clip,
and Exit Time is a fraction of the clip currently playing. An atomic set plays the drawn
sequence whole, and the machine evaluates nothing until the run completes. Every World
already authored keeps its behaviour, because every existing set is interruptible.

**A transition's set is always atomic, and the switch does not appear there.** "While a
crossing is live, nothing is evaluated at all" is the subsystem's load-bearing invariant. A
multi-clip bridge is a longer freeze, which is what the originating case asks for; an
interruptible bridge would repeal the invariant.

**A sequence is the unit of playability.** A sequence one of whose clips cannot be played
drops out of the draw rather than playing its remaining members. A run missing its middle is
not the run the author wrote.

---

## Requirements

**The model**

- R1. A clip set on a State or a transition holds zero or more sequences; a sequence holds
  one or more clips in an order that decides playback.
- R2. A draw picks a sequence, not a clip, and avoids the sequence that played last unless
  the set holds one. The avoid-repeat memory stays in memory, not in the manifest.
- R3. A sequence of one clip behaves exactly as a single clip does today.
- R4. An empty set on a State still means the State holds silently; an empty set on a
  transition is still an instant cut.
- R5. The manifest version rises, and a World written at the previous version loads with each
  of its clips read as a one-clip sequence.

**Playback**

- R6. A State's set carries an interruptible/atomic switch. Existing sets, and new sets by
  default, are interruptible.
- R7. On an interruptible set, Exit Time is a fraction of the clip currently playing and is
  re-checked on every clip, so a three-clip sequence has three wake points a pass.
- R8. On an atomic set, the drawn sequence plays whole: no Exit Time wake point, no Parameter
  evaluation, no Any State, until the run completes. Evaluation resumes at the end of the run.
- R9. A transition's set is always atomic regardless of length, and no switch is offered for it.
- R10. A Parameter set while an atomic run is playing is recorded and acted on the moment the
  run completes, matching what a bridge already does.

**Authoring**

- R11. A set's panel shows one ordered list with a control between adjacent rows that links
  them into a sequence or splits them apart, and a visible bracket marking each run of two or
  more.
- R12. Reordering controls are available on a transition's set as well as a State's, because
  order now decides playback in both.
- R13. Every operation reachable from the panel is reachable over the protocol, including
  linking, splitting, and setting the atomicity switch.

**Reporting**

- R14. A sequence containing a clip that cannot be played is excluded from the draw as a whole.
- R15. The World reports name an owner whose sequences are all excluded, the same way they
  name a set today whose clips are all unplayable.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R9.** Given a transition whose set holds one sequence of `stand` then
  `walk`, when the transition is taken, then `stand` plays whole, `walk` plays whole, and the
  destination State begins — with nothing evaluated between the two clips or during either.
- AE2. **Covers R6, R7.** Given a State with an interruptible set holding one sequence of three
  two-second clips, and an outgoing transition with Has Exit Time at 0.75, when the machine
  holds in that State, then the conditions are checked three times a pass — at 1.5s, 3.5s and
  5.5s.
- AE3. **Covers R8, R10.** Given the same State with its set marked atomic, when a Parameter
  changes one second into the first clip, then nothing happens until the sixth second, and the
  transition is evaluated once the run ends.
- AE4. **Covers R3, R5.** Given a World authored before this change, when it is opened, then
  every set reads as one-clip sequences, every set is interruptible, and playback is
  indistinguishable from before.
- AE5. **Covers R14.** Given a set holding the sequence `settle`, `look`, `sigh` alongside the
  sequence `blink`, when `look` cannot be played, then only `blink` is ever drawn.
- AE6. **Covers R14, R15.** Given that same set when `look` and `blink` are both unplayable,
  then the State holds silently and the reports name it.

---

## Scope Boundaries

- One-shot States — a State that plays once and leaves — as a way to compose sequences out of
  the graph. It would make sequences arbitrary, but the common case would cost two extra States
  and two transitions of authoring, and Any State would fire into the middle of what the author
  meant as one gesture.
- Element-addressed set edits. A set edit still sends the whole next array, so the
  two-clients-editing-one-set race recorded in
  `docs/residual-review-findings/feat-live-clip-sets-and-bridges.md` stays as it is. Sequences
  make the array nested; they do not change how it is written.
- Weighting a draw, or playing sequences in a fixed rotation rather than at random.
- Blending or crossfading between the clips of a sequence. There is never a blend.

---

## Dependencies / Assumptions

- The runtime owns the clock, so a sequence is a chain of server-side timers seeded by
  durations the browser measured. A clip-end report arriving mid-sequence has to resolve
  against the right member of the right run; the subsystem has already had one bug from two
  armed waits resolving the wrong one.
- `LiveState` names where the machine is with a State id and a transition id. What a watching
  client needs in order to play the right member of a running sequence is an addition to that
  shape, and it meets the flat-versus-union residual already recorded against it.
- Graph analysis — dead ends, unreachable States — is unaffected. Atomicity is a timing
  property, not a reachability one.

---

## Outstanding Questions

**Resolve before planning**

- Whether an atomic State set has a ceiling on total run length, as a bridge does. A bridge's
  ceiling exists because it freezes everything, and an atomic State run freezes everything for
  the same reason.

**Deferred to planning**

- Whether the atomicity switch is stored on the set or per sequence. The dialogue settled it as
  a property of the set; per-sequence would be more expressive and is worth a look before the
  shape is fixed.
- How the link control renders when a set is long enough to scroll.

---

## Sources

- `shared/src/worlds.ts` — `WorldState.clips`, `Transition.clips`, the manifest shape and its
  version gate.
- `server/src/live/runtime.ts` — `usableDraw`, the draw's avoid-repeat memory, and the timer
  seeding that makes the server the timing authority.
- `CONCEPTS.md`, "Live state machines" — Clip set, Bridge, In transit, Has exit time.
- `docs/residual-review-findings/feat-live-clip-sets-and-bridges.md` — the presentational-order
  residual, the panel asymmetry, and the whole-array edit race.
- `docs/brainstorms/2026-09-02-live-state-machine-requirements.md` — the subsystem's origin brief.
