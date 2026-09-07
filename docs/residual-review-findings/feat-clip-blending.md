# Residual findings — clips dissolve into each other

Accepted knowingly, 2026-09-06, after a four-persona document review of
`docs/plans/2026-09-06-002-feat-clip-blending-plan.md` (coherence, feasibility, scope-guardian,
adversarial) and eight implementation units each held to a revert check. Everything actionable that
pass found is fixed and committed. What follows is what was raised and deliberately not changed,
what shipped unproven, and — because this feature earned it — what the whole apparatus still missed.

---

## Two defects reached the operator's screen anyway

Worth stating first, because it is the most useful thing in this file. The review found three
Key Technical Decisions that were factually wrong about this codebase and one origin requirement
that would have deadlocked working Worlds. All four were fixed before a line was implemented. Every
unit then landed with a revert check. A browser check was written specifically because jsdom cannot
see the screen.

**Two defects still shipped**, both found by the operator within minutes of watching it:

1. **The machine handed back the window it freed.** `closeWindow` was awaited *before* the clip's
   own wait rather than overlapping it, so the boundary landed on the clip's true end again and
   every clip after the first dissolved from a frozen last frame. The browser check had the
   evidence — `framesBothPlaying` was 0 in all ten windows — and the final report had stopped
   printing that field.
2. **A CSS rule lost the cascade on one surface only.** `.front` and `.blending-out` are both
   specificity `0,2,0`, and the stylesheet orders them differently for `.clip-video` and
   `.broadcast-video`. Identical markup faded on `/live` and stayed fully opaque on `/broadcast`.

Both are documented as learnings
(`docs/solutions/a-check-can-be-green-on-the-state-it-exists-to-catch.md`,
`docs/solutions/two-rules-of-equal-specificity-are-ordered-by-the-file-not-by-you.md`). Neither is a
gap in the review; both are shapes a document review and a unit-level revert check structurally
cannot reach.

---

## `supersede` clearing the blend — RESOLVED, and the reasoning here was wrong

**Superseded 2026-09-06 by the code review.** This section originally argued that a stale blend flag
was unobservable, on the premise that *"the only path that could observe it is a fault mid-window,
and `faulted()` does not re-enter."* **That premise was false.** A fault leaves the machine live, and
driving a Parameter is the ordinary way an operator gets out of one — which at `blendMs: 0` works and
at `blendMs: 250` did not, because `faulted()` cleared `crossing` and the pending and not the blend
flags. Two reviewers reproduced it independently.

Worse, the argument was self-sealing: it reasoned from "no test fails" to "nothing can observe it",
when the correct reading of an unproven line is that the *test* is missing, not the observation. A
reviewer who went looking for the observable found it in one probe.

Fixed in `8a80584`: `faulted()` clears the three flags as `supersede()` does, and
`playThrough` is split so a live pass has exactly one exit for its hold. Both are proven by revert —
`stays drivable after a fault raised inside a blend window` and `does not go deaf on entering a State
that holds no clips`. The first version of that fault test faulted inside `take`, before the window
was ever raised, and passed with the fix removed; it now uses the "file moved between the two checks"
race, which is the only way to fault after `enter` has opened one.

**Kept rather than deleted** because the reasoning error is the useful part: an accepted residual is
a claim, and this one was written confidently and was wrong within a day.

---

## Cancelling a superseded fade is unproven by revert

**What.** The client cancels an in-flight fade when a new clip is assigned mid-window, restoring the
target element and cancelling the pending demote. Removing it fails no test.

**Why it stands.** jsdom's mocked `play()` never clears `paused`, so asserting the element is still
playing is false in both directions and proves nothing. A `pause` spy installs too late to catch the
stale timer's call. Three attempts at a discriminating assertion were made and discarded; the test
file says so where a reader will find it rather than leaving a weak assertion looking like coverage.

**What would discharge it.** A browser check that drives a duration correction mid-window — the
ordinary trigger for this path, since `report-clip-duration` fires inside a window for any clip whose
stored length is off by more than the tolerance.

---

## A clip at or below twice the blend is never on screen alone

**What.** `effectiveBlend` clamps to half the clip, so a 4-second clip in a 1000ms World blends for
1000ms at both ends and is mid-dissolve for half its life. Shorter than 2× and it fades up and
immediately begins fading out, never displayed on its own.

**Why it stands.** This is what a blend longer than half a clip *means*; the alternative is to
refuse the blend for that boundary, which would give a World two grammars — the thing the brief
explicitly rejected for authored cuts. `shortForBlend` reports every affected clip on the graph, so
the cost is visible at authoring time rather than silent.

**What would discharge it.** An operator decision. It is recorded as an open question in
`docs/brainstorms/2026-09-06-clip-blending-requirements.md` and has not been made.

---

## Long blends and interactive Parameters are in tension

**What.** The machine evaluates nothing while a blend runs. At the 1000ms ceiling a Trigger can wait
a full second before anything acts on it.

**Why it stands.** It is the mechanism, not a bug: the engine owns two video elements and a blend
occupies both, so a transition taken mid-blend has nowhere to draw. The hold is what makes that
impossible rather than merely unlikely.

**What would discharge it.** Nothing, short of a third element — which would change what the engine
is. Worth knowing when authoring: a World driven interactively wants a short blend, an ambient one
can afford the ceiling.

---

## The clip-end report is no longer a late resync

**What.** The machine's final wait now always fires *before* the browser finishes the clip, so a
client's clip-end report matches a superseded generation at every boundary and is discarded. The
path still exists and no longer does anything, and each boundary now costs one refused message per
open tab.

**Why it stands.** Nothing depends on it today — the server's timer has been the authority since the
runtime was written, and the report was always a resync signal rather than a driver. Removing the
path would be a larger change than the feature warrants and would lose the resync for
`blendMs: 0` Worlds, where it still functions.

**What would discharge it.** Measuring whether the refused messages matter at scale (many tabs, many
boundaries). Unmeasured.

---

## From the code review of 2026-09-06 — raised, not fixed

A four-persona code review ran after the feature had shipped and been debugged
against a real World (the earlier four-persona pass reviewed only the plan).
Three reviewers built throwaway runtimes and measured rather than reading, and
between them found **five ways the machine could strand or truncate a World** —
all five fixed in `8a80584`, each with a regression test that fails without it.
Four doc comments orphaned by insertion were fixed in `77c57a9`. What follows is
what those reviews raised and this branch did not change.

**Deferring a bridge landing's arrival is unproven by revert.** `cross` now sets
`pendingArrival` instead of spending the arrival into a hold that refuses it.
Removing that and calling `onTrigger("arrival", 0)` directly fails no test: the
existing bridge fixtures have no arrival-triggered transition whose condition is
already true. The behaviour it protects is real — a Trigger set mid-bridge would
otherwise wait until the next boundary — and it is untested. A fixture with a
satisfied non-exit-time transition out of the landing State would discharge it.

**A short clip following a long one can have its boundary land after it ends.**
`elapsed` is the window the clip was *issued* under and the final wait subtracts
the window its *own* boundary will use, so when `windowFor(outgoing) > total −
windowFor(current)` the wait clamps to 0. With a 1000ms blend, a 4000ms clip
followed by a 1500ms one gives `1500 − 750 − 1000 = −250`. The short clip is
replaced with 500ms left and its dissolve outruns it. `shortForBlend` reports the
1500ms clip, so it is visible at authoring time — but this is a timing error
rather than the accepted aesthetic cost of a clip never seen alone, and it is a
narrower instance of the shape that already shipped once.

**A bridge landing loses part of its window to filesystem work.** Between the
last member's wait resolving and `enter` issuing the landing there is a
`usableDraw` over the destination's whole set. Whatever that costs is subtracted
from the crossfade. Environment-dependent and not reproduced; on a slow or
networked drive it could consume the window entirely, giving a frozen-frame
dissolve at every landing. The same applies entering a bridge.

**`supersede` clears `pendingArrival`.** A duration report landing inside a
bridge's landing window supersedes, drops the deferred arrival, and the
"honoured the moment it lands" half of the Trigger bargain waits until the next
clip end. Low confidence, not reproduced.

**`rearmCrossing` and `cross` clamp differently.** `cross` arms
`durationOf(member) − windowFor(member)` with no ceiling; `rearmCrossing` applies
`Math.min(durationOf, MAX_BRIDGE_MS)` as well. A 46-second bridge member arms for
45.6s and re-times to ~29s after any duration correction. The asymmetry predates
this work — commit `16931e1` is about the ceiling no longer clamping — but the
`− window` term now lands on top of it and `rearmCrossing` is where the two rules
meet.

### Structure raised and not changed

**`openWindow` vs `carryWindow` is a trap with no enforcement.** `cross` must use
one and `enter` the other; nothing but a doc comment says so, and picking wrong
reproduces a hold nothing closes. The `playThrough`/`walk` split in `8a80584`
narrows the blast radius — a leaked hold is now cleared on every exit of a live
pass — but the two-method split remains. Renaming to `announceWindow` /
`holdForWindow` would put the difference in the name.

**The two surfaces carry a copy-pasted class ternary.** `ClipPlayer` and
`BroadcastStage` compute the same three-way className and inline style, differing
only in the base class and `blank`. A cascade divergence between these two already
shipped. Returning the derived props from `useClipStage` would leave one real
difference visible as one line.

**`runtime.ts` is 1525 lines and the blend machinery is separable.** Four fields
and five methods would move to a `BlendWindow` collaborator, which would make the
open/close lifetime a property of a small object rather than of a large class.

### Tests that do not discriminate

The testing reviewer traced ten. The ones worth naming, none of them changed here:

- `not.toContain(4000)` in two runtime tests is the exact instrument
  `a-timer-spy-is-blind-in-a-suite-that-leaks-runtimes.md` records as unusable —
  about thirty unstopped rigs are pacing 4000ms clips when the blend block runs.
  The fix is a duration unique to the test (`4137` → assert `3887`).
- Every server-side blend fixture is 250ms on 4000ms clips, so `windowFor(outgoing)`
  and `windowFor(incoming)` are always equal and the load-bearing "read the
  outgoing clip before it is overwritten" capture cannot be told from the bug.
- `expect(el(x).paused).toBe(true)` is vacuous — jsdom's `paused` is `true` at
  construction and nothing in those tests changes it.
- `BroadcastStage.test.tsx` has no blend assertion at all, on the surface where
  the cascade defect actually shipped.
- The blend slider and the `short-for-blend` panel — the only authoring surfaces
  for this feature — have no component test, though every sibling report panel does.

`scripts/blend-check.mjs` was fixed rather than recorded: three of its five
verdict claims were vacuously true when no blend happened, `fadingActuallyFades`
was satisfied by an instantaneous 1→0 step, and the script exited 0 whatever it
printed. It now guards emptiness, requires the fade to be observed part-way, and
exits non-zero — reverting the CSS fix produces `FAILED: broadcast`, exit 1.

---

## Scope deliberately not taken

Carried from the brief and unchanged: per-transition and per-State blend lengths (the resolution
seam is `transition.blendMs ?? world.blendMs ?? 0`, unbuilt); blend curves — the transition is
linear; blends other than a dissolve; a fade in on World open and out on close.

Two plan-local items were also deferred rather than done. **U3** was scoped as a behaviour-neutral
refactor to disambiguate the visible-element index ahead of the dissolve, and had nothing to do:
`front` already meant the right thing for both readers, and the ambiguity only exists once something
blends. It was folded into U4 rather than committed empty, and the general fix — changing what the
engine exposes so a single index cannot be misread — is still not done. **`MAX_BLEND_MS` and
`MAX_BRIDGE_MS`** are both named thresholds on how long the machine may hold and were arrived at
separately; whether they should share a home or a rationale is open.

---

## What would have caught the two that shipped

Only running it. That is not a counsel of despair — it is the reason `scripts/blend-check.mjs`
exists — but the check as first written was satisfied by the broken state, and the unit tests were
satisfied by a mechanism that gave back the time it freed. The gate that actually worked, both
times, was an operator watching two windows side by side and saying the words "it looks like it
teleports".

The check now asserts `fadingActuallyFades` and reports `bothMoving` first. Reverting either fix
turns one of those false. That is the guard; it is not a substitute for looking.
