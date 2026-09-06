---
title: A wrapper element is a scoping ancestor — flatten it with `display: contents`, not by deleting it
date: 2026-09-05
category: pattern
tags: [css, grid, react, selectors, refactor, silent-failure, ui]
module: ui/src/components/StateGraph.tsx, ui/src/styles.css
problem_type: logic_error
symptoms:
  - a component is refactored to return a fragment and styling quietly stops applying
  - rules keyed on an ancestor class match nothing, and no test, typecheck or build fails
  - a parent cannot place a divider between a child component's own two children
  - grid items land in the wrong tracks and the layout still looks plausible
---

## Context

`/live` needed three columns — stage, graph canvas, sidebar — with a draggable seam between each pair.
The canvas and the sidebar were children of `.state-graph`, which was its own two-column grid. The plan
said to delete that wrapper: have `StateGraph` return a fragment so both children became grid items of
the parent, and let the parent put a divider between them.

That was wrong twice.

**A parent cannot interleave into a child's fragment.** `LivePane` would render
`stage · divider · StateGraph{canvas, side} · divider`, and grid places children into tracks in DOM
order — so the sidebar lands in the divider's 6px track and the trailing divider takes the sidebar's.
Both dividers render, so a `role="separator"` assertion passes cheerfully; jsdom has no layout, so only
a browser could catch it.

**And the wrapper was load-bearing as a selector.** `.state-graph` scopes eight rules in
`ui/src/styles.css` — the crossing transition path, the whole `.clip-set` run-grouping vocabulary
(`in-run`, `run-first`, `run-last`, `button.linked`), and `broken-clips` — plus a test id asserted in a
different component's suite. Two of those subtrees live under the sidebar and the rest on the canvas.
Removing the element unmatches all eight. Nothing fails: not a test, not a typecheck, not a build.

## Guidance

**Before deleting a wrapper, grep for it as an ancestor.** `grep -n "^\.wrapper-class" styles.css` takes
seconds and answers the only question that matters. An element that carries no styles of its own may
still be the scope for a dozen rules that do — and the loss is silent in every channel a CI run watches.

**`display: contents` is the flatten that keeps the element.** The children become grid or flex items of
the grandparent exactly as if the wrapper were gone, while the wrapper stays in the DOM as a selector
scope and as a test id:

```css
/* was: display: grid; grid-template-columns: 1fr minmax(240px, 34%); */
.state-graph {
  display: contents;
}
```

**Split the ownership rather than the element.** The parent owns the geometry — it derives the track
list, so it must know how many grid children there are — and the child owns its children's order, so it
renders the divider that sits between them and takes the drag handler as a prop. That keeps the
"tracks and children must agree" invariant in one place instead of split across two components:

```tsx
<StateGraph state={state} send={send} onSideSeamDown={onSeamDown("side")} />
```

Make the prop optional if the component is also mounted alone by its own test suite, where there is no
grid and nothing to resize.

**Verify the flatten in a browser, because jsdom cannot.** `display: contents` has had real
interoperability bugs, and its whole purpose is a layout effect. Assert it by measurement: that the
wrapper computes `contents`, that the two children measure the widths their tracks declare, and that one
of the previously-scoped rules still resolves.

```js
canvasW: 634, sideW: 354,          // against tracks "368 6 634 6 354"
wrapperDisplay: "contents"
```

**Consider what the alternative would really have cost.** Exporting the two halves as separate
components was the other option, and it reads cleaner until you count the state: `selectedNode`,
`selectedTransition`, `connecting`, `browsingFor` and `dragging` are all shared between them, so it
means lifting five pieces of state out of the component. `display: contents` gets the same layout for
one declaration.

## Related

- `docs/solutions/css-tracks-with-two-sources-of-truth.md` — the same silent class: a layout defect that
  passes every check because CSS failures are not runtime failures.
- `docs/solutions/a-fix-teaches-a-pattern-go-looking-for-it.md`
