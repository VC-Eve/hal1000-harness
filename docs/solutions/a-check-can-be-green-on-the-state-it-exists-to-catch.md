---
title: A check can be green on the exact state it exists to catch
date: 2026-09-06
category: pattern
tags: [verification, browser-checks, blind-spots, coverage-illusion, css, video]
module: scripts/blend-check.mjs, ui/src/styles.css, ui/src/components/BroadcastStage.tsx
problem_type: workflow_issue
symptoms:
  - a browser check reports every claim satisfied and an operator says the feature does not work
  - three independent layers of verification agree, and the screen disagrees
  - a metric phrased as "never gets worse" is satisfied by the failure as well as the fix
  - the check measures the mechanism running and never the value the mechanism exists to change
---

## Context

A crossfade between video clips shipped with a browser check written precisely because jsdom
cannot answer questions about what is on screen. The check booted a real instance, opened both
surfaces, and reported four things per boundary:

- both `<video>` elements were playing simultaneously
- the composite alpha never dipped below 1 (no dark pulse at the midpoint)
- the fading element carried its class for the full window
- the element arriving was never observed part-way through a rise

All four were green on both surfaces. The operator watching the actual product saw one surface
crossfade and the other freeze and hard-cut.

The defect was a CSS source-order collision: the fading element kept `opacity: 1` for the whole
window on one surface. Every one of those four measurements is *true* of that broken state:

| measurement | broken state |
|---|---|
| both elements playing | true — both were decoding real frames throughout |
| composite never darkens | **true, and trivially so** — the top element sat at full opacity |
| class applied for the window | true — the class was applied; only its rule lost |
| incoming never mid-rise | true — it was never visible at all |

Nothing in the check ever read the opacity of the element that was supposed to fade.

## Guidance

**Name the one number the feature is made of, and assert that it moves.** A crossfade is an
opacity going from opaque to transparent over a duration. That is the feature. Everything
else — playback, stacking, class application, composite luminance — is a precondition or a
consequence, and a check built only from preconditions and consequences can be fully green while
the feature does nothing.

The fix was one added assertion:

```js
// The fading element's opacity actually moves, and reaches the floor.
fadingActuallyFades: windows.every((w) => {
  const o = w.frames.map((f) => (w.fadingIndex === 0 ? f.a.opacity : f.b.opacity));
  return Math.max(...o) > 0.5 && Math.min(...o) < 0.2;
}),
```

**Be suspicious of any assertion phrased as an absence.** "Never darkens", "no flicker", "does
not error", "never below N" are all satisfied by a feature that does nothing at all. They are
worth keeping — they catch a different class of fault — but a suite made only of them cannot
distinguish working from inert. Pair every absence with a presence: something that must *happen*,
with a magnitude.

**Apply the revert test to checks, not only to unit tests.** The discipline of "remove the fix and
watch the test fail" is usually reserved for the suite. It applies with more force to an expensive
browser check, because a browser check is written for exactly the claims nothing else can reach,
and there is no second net underneath it. Reverting the CSS fix here turned the new assertion false
on one surface and left it true on the other — reproducing the reported asymmetry — which is the
evidence that the check now covers the thing it is named after.

**Count the layers you verified, and ask what they have in common.** Three independent layers all
passed here: DOM state (classes), media state (`currentTime`, `paused`), and decoded pixels (frames
drawn to a canvas). Their agreement felt like strong evidence and was not, because all three sit
*upstream* of compositing. Independence in the sense of "different code paths" is not independence
in the sense of "different failure modes". Three checks that share a blind spot are one check.

## When to Apply

- Writing any verification for a visual, timing, or animated behaviour, where the observable is a
  value changing over time rather than a state being reached
- Reviewing a check whose assertions are all negative ("never", "no", "not below")
- Any time verification and a human observer disagree — the question is not *who is right* but
  *which layer is each of them looking at*
- Before trusting agreement between several checks: list what each one reads, and look for a
  common upstream point past which none of them can see

## Examples

The failure this came from, in full. `scripts/blend-check.mjs` reported per surface:

```
live       bothMoving ✓  neverDarkens ✓  fadesOnBothBoundaries ✓  incomingNeverMidRise ✓
broadcast  bothMoving ✓  neverDarkens ✓  fadesOnBothBoundaries ✓  incomingNeverMidRise ✓
```

and the operator, watching both windows side by side, reported `/live` leaving trails and
`/broadcast` freezing and teleporting. Both reports were accurate.

Three hypotheses were spent before the check was questioned: a stale browser tab, a GPU
compositing path, and a wrapper element's stacking context. Each was plausible, none was
verifiable from the check, and two of them were shipped as speculative fixes and reverted. The
question that actually resolved it — "what does this check *not* measure?" — was available from the
first minute and cost nothing.

The console diagnostic that broke the deadlock printed engine-side numbers from the operator's own
browser (`wire=1000 clamped=1000 decode=25 fade=975 readyState=4`), proving the JavaScript correct
and leaving CSS as the only remaining surface. When every instrument you own says the code is
right and a person says it is wrong, the next instrument should be one that reads from *their*
machine, not a better version of yours.

## Related

- `docs/solutions/tests-that-lock-in-the-bug.md` — a test written from the implementation
  certifies the bug. This is its browser-check sibling: a check written from the mechanism
  certifies the mechanism running, not the outcome.
- `docs/solutions/assert-the-effect-not-the-existence.md` — the same instinct one level down.
- `docs/solutions/a-timer-spy-is-blind-in-a-suite-that-leaks-runtimes.md` — an assertion phrased
  as a lower bound passing while the defect stood.
- `docs/solutions/a-measurement-on-synthetic-variants-measures-your-own-transform.md` — the other
  way a measurement can be true and useless.
