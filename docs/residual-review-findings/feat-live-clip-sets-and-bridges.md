# Residual findings — clip sets and bridges

Accepted knowingly, 2026-09-02, after a twelve-reviewer pass over
`docs/plans/2026-09-02-002-feat-clip-sets-and-bridges-plan.md`. Roughly twenty findings were fixed —
including two that made the bridge fail to be what it claims — and each carries a test that fails
without its fix. What follows is what was raised and deliberately left.

The subsystem's earlier residuals are in `feat-live-scene-worlds.md` and still apply.

---

## Nothing bounds how long a clip check may take

**What.** `usableDraw` and `validate` resolve clip paths through `fs.realpath`, which has no timeout.
A drive that stalls — a disconnected network share, a sleeping external disk — blocks the await with
no bound. The bridge made this worse before it was narrowed: the check now runs on every transition
and on the way into every State.

**Why it shipped anyway.** Node's fs API offers no timeout, so this needs a race against a timer at
every call site, and a timeout has to decide what an unanswered check *means*. Treating "slow" as
"broken" would fault a World whose disk is merely busy, which is a worse failure than waiting.

**What would discharge it.** A single wrapper around clip resolution that races a deadline and
reports a distinct third answer — usable, unusable, or *unknown* — with the runtime holding rather
than faulting on the third.

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

## `ClipPlayer` plays a bridge by accident rather than by design

**What.** The player keys its `<video>` on the State, the generation and the clip path. A crossing
bumps the generation on both edges, so the element swaps correctly — but nothing in that component
knows a bridge exists, and no component test covers it.

**Why it shipped anyway.** It is correct as it stands, and the protocol verification exercises the
whole path with a real crossing.

**What would discharge it.** A component test that drives the player with `transitionId` set, so the
behaviour is pinned rather than inherited.
