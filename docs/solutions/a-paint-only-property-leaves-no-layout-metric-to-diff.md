---
title: A paint-only property leaves no layout metric to diff
date: 2026-09-07
category: bug
tags: [css, verification, measurement, browser-checks, false-green, blind-spots, review]
module: scripts/treatment-check.mjs, ui/src/textTreatment.ts
problem_type: logic_error
symptoms:
  - a browser check reports the same number whether the feature works or not
  - a before/after width comparison shows exactly zero difference and the screen plainly differs
  - a verification is written, run, and passes nothing — it could not have failed
  - the metric is real, the element is right, and the property was never going to move it
---

## Context

An overlay caption gained an authored outline. The requirement was specific: the
border has to sit **outside** the letterform, so raising its width thickens the
border and never thins the glyph. `-webkit-text-stroke` alone is centred on the
glyph path and eats inward; `paint-order: stroke fill` paints the stroke first
so the fill covers its inner half. Whether an engine honours that on live text
is a claim about a browser, so the plan said: measure it.

The check that was written compared the **rendered width of one word** outlined
against the same word bare. The reasoning was that a stroke painted outside adds
roughly its width to each side of every glyph, so the outlined word should come
out wider.

It came out identical. Both surfaces, both words, to the hundredth of a pixel:

```
{"bareInkW":74.13,"outlinedInkW":74.13,"grewPx":0,"expectedPx":2.64,"paintOrder":"stroke"}
```

The first reading was that `paint-order` had failed and the fallback was needed.
It had not. **A text stroke changes no layout metric in any engine.** Stroke,
shadow, outline, filter, box-shadow are *paint* — they are drawn after layout is
decided and cannot move a box, an advance width or a `Range` rect. So the check
reported `grewPx: 0` for a working implementation, and would have reported
`grewPx: 0` for one that drew nothing at all. It was incapable of failing for
the reason it existed.

The property was applied correctly the whole time. Counting pixels instead
proved it in one run: 92.9% of the word's white kept, 5,816 black border pixels
added.

## Guidance

**Before diffing a metric across a CSS change, ask which pipeline stage the
property belongs to.** Layout properties (width, padding, font-size, flex,
position) move boxes and every geometry API sees them. Paint properties
(`text-shadow`, `-webkit-text-stroke`, `outline`, `filter`, `box-shadow`,
`background`, `color`) are invisible to `getBoundingClientRect`, to a `Range`
rect, to `scrollWidth`, to `offsetWidth` — to all of it, by construction. A
geometry comparison across a paint-only change is guaranteed to report no
difference, which is indistinguishable from a broken build.

**For a paint property, the pixels are the only witness.** In a Playwright
check, the browser is its own decoder — no Node image library needed:

```js
const shot = await page.screenshot({ clip: box });          // Buffer
const counts = await blankPage.evaluate(async (b64) => {     // hand it back
  const img = new Image();
  await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = `data:image/png;base64,${b64}`; });
  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  // count what the property is supposed to add or remove
}, shot.toString("base64"));
```

**Design the count so the two outcomes are far apart, not adjacent.** Here:
white fill, black stroke, a flat grey clip behind. Painted behind the fill the
letter keeps ~93% of its white; painted over it, a stroke thicker than the stem
takes nearly all of it. There is no threshold between 0.93 and 0.1 worth
arguing about. A busy background would have supplied whites and blacks of its
own that no threshold could separate from the letters — the flat field is part
of the measurement, not scene dressing.

**A check that cannot fail is worse than no check**, because it is reported as
evidence. The tell is a control: run the same measurement against a case that
is supposed to differ, and confirm the number actually moves. Here the control
was the untreated slot, and the moment its `white` and the outlined slot's
`black` were both in the output, the method's soundness was visible.

## When to Apply

Any browser verification of appearance — a border, a shadow, a glow, a blur, a
filter, a colour, a contrast. Also any claim of the form "X is bigger/heavier
than Y on screen" where X and Y have the same font, size and text: if the only
difference is paint, geometry will not show it.

## Related

- `docs/solutions/a-check-can-be-green-on-the-state-it-exists-to-catch.md` — the
  same family. That one is a check that never reads the value the feature
  changes; this one reads a value the feature *provably cannot* change. Both
  produce a confident green on a broken build.
- `docs/solutions/verify-hal-by-running-it` in memory, and
  `docs/solutions/a-measurement-on-synthetic-variants-measures-your-own-transform.md`
  — measuring the wrong thing, from two other directions.
- `scripts/treatment-check.mjs` — the working version, and `AGENTS.md`'s entry
  for it, which records the measurement that matters.
