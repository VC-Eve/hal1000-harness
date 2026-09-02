# Residual findings — clip sets and bridges

Accepted knowingly, 2026-09-02, after a twelve-reviewer pass over
`docs/plans/2026-09-02-002-feat-clip-sets-and-bridges-plan.md`. Roughly twenty findings were fixed —
including two that made the bridge fail to be what it claims — and each carries a test that fails
without its fix. What follows is what was raised and deliberately left.

The subsystem's earlier residuals are in `feat-live-scene-worlds.md` and still apply.

---

## Nothing bounds how long a clip check may take — discharged 2026-09-02

**What.** `usableDraw` and `validate` resolve clip paths through `fs.realpath`, which has no timeout.
A drive that stalls — a disconnected network share, a sleeping external disk — blocked the await with
no bound, on a path that runs on the way into every State.

**How it was discharged.** `server/src/deadline.ts` bounds both, and each caller answers the question
it is actually asking rather than inventing a third state:

- The runtime treats silence as **playable**. A slow disk is far more likely than a missing file, the
  clip route refuses a genuinely missing one a moment later, and refusing to play would stop a World
  that is merely waiting on its storage.
- The confinement pass reports **nothing** for a check that did not answer. An unknown clip is not a
  broken one, and marking a World red because its disk is slow says something false.

The four cases that used to hang — entering a State, drawing from a set, crossing a bridge, and a
check that rejects outright — each have a test that hangs without the deadline.

**What it does not cover.** A drive that answers slowly rather than not at all still costs up to the
deadline per pass. That is bounded and rare, and the alternative is caching answers whose whole point
is to be current.

---

## A set's order does not affect what plays

**What.** The draw is uniform, so the order the author arranges a set in is presentational. A State's
panel offers ↑/↓ controls anyway, and a transition's does not.

**Why it shipped anyway.** A stable arrangement is still worth having for reading a list of ten
idles, and `CONCEPTS.md` now says plainly that order is for reading rather than for playback. The
asymmetry is the part that is hard to defend, and it is cosmetic in both directions.

**What would discharge it.** Either give a transition's set the same controls, or take the State's
away and sort the list by name — the second is probably better, and is a small enough change that it
belongs with whatever next touches that panel.

---

## Two clients editing one clip set still race

**What.** A clip-set edit sends the whole next array. The panel now waits for its own round trip
before allowing another edit, which fixes the common case of one person clicking twice. Two *clients*
editing the same set still race: the later message wins wholesale, and an `import-clip` that landed
in between is dropped from the manifest while its file stays in `clips/`.

**Why it shipped anyway.** HAL is a single-operator harness, and the whole-array patch is what makes
the protocol a primitive an agent can use without a bespoke reorder message. The fix is
element-addressed set operations, which is a real protocol design rather than a guard.

**What would discharge it.** Add/remove/move messages addressed by clip path, with the whole-array
patch kept for the cases that genuinely replace a set.

---

## `LiveState` says where the machine is with two fields rather than one

**What.** `stateId` keeps naming the source State while `transitionId` names the crossing, so a
reader has to check the second before trusting the first. A discriminated union would make that
impossible to get wrong.

**Why it shipped anyway.** The flat shape is what makes a clip-end report from a crossing resolve
against the same identity check a State's loop uses, and every current reader checks in the right
order. Changing it is a wire-contract change for a correctness property that currently holds.

**What would discharge it.** A `LiveState` whose in-transit and in-State cases are separate variants,
taken alongside the next change to that message.

---

## `ClipPlayer` plays a bridge by accident rather than by design — discharged 2026-09-02

**What.** The player keys its `<video>` on the State, the generation and the clip path. A crossing
bumps the generation on both edges, so the element swaps correctly — but nothing in that component
knew a bridge existed, and no test covered it.

**How it was discharged.** Three component tests drive it with `transitionId` set: the swap into the
bridge while the State is unchanged, the swap at the landing, and the clip-end report carrying the
source State the server still names. The key's comment now says what it depends on and points at
them. The component still knows nothing about bridges, which is the right amount — what changed is
that the dependency is written down and something fails if it stops holding.
