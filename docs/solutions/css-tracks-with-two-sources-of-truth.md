---
title: A layout computed in JS and overridden in CSS has two sources of truth
date: 2026-08-06
category: bug
tags: [css, grid, layout, react, media-queries, important, single-source-of-truth]
module: ui/src/styles.css
symptoms:
  - a collapsed section stretches to a share of the screen instead of shrinking to its rail
  - the stylesheet and the component disagree about the same layout state
  - a comment in the CSS asserts behaviour the rule two lines below it contradicts
  - "!important appears next to an inline style set from component state"
---

## Problem

The three collapsible body sections derive their grid tracks from collapse state: a collapsed
section should take an `auto` track and shrink to its rail, an expanded one takes a fraction of the
space. The component computed those track lists and wrote them as inline styles.

Inline styles beat stylesheet rules, so the narrow-viewport block could not restyle the grid without
`!important`. It used it:

```css
.left-column {
  grid-template-rows: minmax(0, 1fr) minmax(0, 1fr) !important;
}
```

Below 900px a collapsed section stretched to half the column instead of shrinking. The comment above
the rule claimed the opposite — "a collapsed section drops out of the stack rather than shrinking
everything else" — and was wrong the moment it was written.

Nothing failed. Tests passed, typecheck passed, the build passed. Two reviewers found it by reading.

## Root cause

Two places computed the same fact and were free to disagree.

The component knew the collapse state and derived tracks from it. The stylesheet could not know the
collapse state — CSS has no access to it — so its media query could only assert a fixed pair of
tracks for every case. `!important` is what let that fixed assertion win over the state-aware one.

The `!important` was not the bug. It was the symptom of putting a state-dependent value somewhere
that cannot see the state, and then needing a bigger hammer to make it stick.

This is invisible to the test suite by construction. Tests asserted which sections were present —
`getByTestId`, `queryByTestId` — and every one of those assertions was true. jsdom does not do
layout, so no test could observe that the surviving section was the wrong size. The class of bug
"the tracks and the children disagree" has no cheap runtime signal.

## Solution

Derive every track list in one place, including the narrow-viewport variant, and let CSS read the
result rather than override it.

```ts
// ui/src/layout.ts — the pure module that already owned collapse state
export function deriveTracks(state: LayoutState): LayoutTracks {
  // ...
  return { columns, rows, stackRows };
}
```

The component writes all three as custom properties. The stylesheet consumes them, and the media
query swaps *which* property applies instead of overriding a value:

```css
.layout {
  grid-template-columns: var(--cols);
}

@media (max-width: 900px) {
  .layout {
    grid-template-columns: 1fr;
    grid-template-rows: var(--stack-rows);
  }
}
```

No `!important` survives. The narrow layout is as state-aware as the wide one because it is computed
by the same function from the same state.

Moving the derivation into the pure module also made it testable without a DOM, which closed the
observability gap:

```ts
it("declares exactly as many column tracks as children in every layout", () => {
  for (const state of everyCollapseCombination) {
    expect(trackCount(deriveTracks(state).columns)).toBe(childCount(state));
  }
});
```

## Prevention

**`!important` next to an inline style is a design smell, not a specificity problem.** When you reach
for it to beat a value the component wrote, the question is not "how do I win the cascade" but "why
are two places deciding this." Fix the ownership.

**A media query cannot be state-aware, so do not ask it to be.** CSS can respond to the viewport;
it cannot respond to application state. Any value that depends on both belongs in the code that
knows the state, with the viewport variant computed alongside it and handed to CSS as data.

**Custom properties are the handoff.** Inline a `--var` and let the stylesheet read it. That keeps
selectors, breakpoints, and cascade in CSS where they belong, and keeps the state-derived values in
one function.

**Watch for the count invariant.** When conditional children and explicit track lists coexist, the
number of tracks must equal the number of grid items. Dividers that render conditionally, and
`display: none` elements that leave grid flow entirely, both change that count. It is worth one
direct assertion — a DOM-presence test will not catch it, and neither will jsdom.

## See also

- `docs/solutions/flexbox-min-height-scroll-trap.md` — a different failure in the same stylesheet
  (flex children refusing to shrink below content size). Same file, unrelated cause; worth reading
  the pair when touching `.layout` or the panes inside it.
- `docs/solutions/tests-that-lock-in-the-bug.md` — the other instance of a green suite that proved
  nothing about the thing that was actually wrong.
