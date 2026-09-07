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

## `supersede` clearing the blend is unproven by revert

**What.** `supersede()` clears `blending`, `pendingArrival` and `deferredEvaluation` alongside
`holding`. Removing those three lines fails no test.

**Why it stands.** It is genuinely unobservable through the seams available: `enter()` opens a fresh
window on the next pass, so a stale flag is overwritten before anything can read it. The only path
that could observe it is a fault mid-window, and `faulted()` does not re-enter. Writing a test that
reaches that state would mean constructing a fault whose timing lands inside a specific window —
more machinery than the line it guards.

**What would discharge it.** A fault injected mid-window that then proves the machine still responds
to a Parameter. If a fault path is ever added that leaves the machine live, this becomes reachable
and should get a test then.

**The risk if wrong.** A pass that faults inside a window leaves `blending` true forever, and the
machine evaluates nothing for the rest of the World's life. Same failure mode `supersede` already
guards for `holding`, which is why the line is there.

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
