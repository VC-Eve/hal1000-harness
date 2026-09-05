---
title: A container-query unit in the container's own padding measures the viewport
date: 2026-09-05
category: bug
tags: [css, container-queries, cqh, layout, video, measurement, verification, blind-spots]
module: ui/src/styles.css, ui/src/components/OverlayLayer.tsx, scripts/overlays-check.mjs
problem_type: ui_bug
component: frontend_stimulus
severity: medium
symptoms:
  - text sized as a percentage of a box measures a different percentage on two surfaces of that box
  - both measurements fall short of what was asked, by amounts that track the window rather than the box
  - every unit test is green, because jsdom lays nothing out and can only assert the expression
root_cause: logic_error
resolution_type: code_fix
---

## Problem

The overlay layer sizes a slot's text as a share of the *picture's* height, so the small player on
`/live` and a fullscreened `/broadcast` draw the same proportions. The layer is a
`container-type: size` box placed on the letterboxed rect of the video, and each slot's
`font-size` is `<size>cqh`. Measured in a real browser, a slot asked to be 5% of the picture drew
at 4.8% on the 1080p broadcast and 4.3% on the 366-pixel-wide player.

## Symptoms

- The ratio of computed font size to picture height was below the asked value on both routes,
  and by different amounts.
- The shortfall was not a constant: on a 1080-high window it was 4% of 1080, on a 950-high window
  4% of 950 — the *viewport's* height, not the picture's.
- `npx vitest run` was green. The component test asserts that the inline style says `4cqh`, which
  it did. Nothing in jsdom resolves a `cqh`.

## What Didn't Work

- Reasoning from the CSS. The rule looked right: the container had an explicit inline width and
  height, `box-sizing: border-box`, and `padding: 2cqh 2cqw` so the text sat inside a margin that
  scaled with the picture. Reading it, the padding is 2% of the picture and the font is 5% of what
  is left. That is not what a browser does with it.

## Solution

The container's own padding used container-query units:

```css
.overlay-picture {
  container-type: size;
  box-sizing: border-box;
  padding: 2cqh 2cqw;   /* resolves against the viewport, not this box */
}
```

The inset moved onto the children, which *can* resolve against the container:

```css
.overlay-picture {
  container-type: size;
}

.overlay-cell {
  box-sizing: border-box;
  padding: 2cqh 2cqw;   /* 2% of the picture, as intended */
}
```

Re-measured, both routes draw exactly 5%, 3% and 3.5% for the three default slots, before and
after a swap between clips of different aspect.

## Why This Works

A size container's content box is what its descendants' `cq*` units resolve against. The
container cannot resolve its own `cqh` against itself — its content box is not known until its
padding is — so the specification falls back to the nearest *ancestor* container, and with none,
to the small viewport. The padding was therefore 2% of the window on each side. With
`box-sizing: border-box` and an inline height, that padding was subtracted from the content box the
slots' `cqh` then measured, so the font came out as 5% of (picture − 4% of viewport). Putting the
inset on a child lets it resolve against the container it is inside, and leaves the container's
content box equal to the picture.

## Prevention

- Never use a `cq*` unit in a property of the element that is the container. Padding, border,
  gap and inset on a size container all resolve against something else. Put them on a child.
- A percentage-of-height claim is only provable by measuring: read `getComputedStyle(slot).fontSize`
  and divide by the container's rendered height, on every surface the claim covers.
  `scripts/overlays-check.mjs` does this for both routes and prints the ratios; it needs
  `ffmpeg` and playwright's chromium, and nothing else in the suite can stand in for it.
- A jsdom test can assert the *expression* (`"4cqh"`) and should, so a refactor cannot silently
  switch units. It cannot assert the pixel, and a green suite says nothing about the ratio.

## Related Issues

- `docs/solutions/css-tracks-with-two-sources-of-truth.md` — the other way a layout that is
  partly JS and partly CSS goes wrong; this one is entirely CSS and still needs a browser.
- `docs/solutions/a-requirement-not-to-show-text-is-not-a-dom-requirement.md` — the same
  surface, the same lesson: what is painted is not what the DOM says.
- `docs/plans/2026-09-05-001-feat-video-text-overlays-plan.md`, U6 — where the measurement
  was taken and the defaults chosen.
