# Residual review findings — feat/collapsible-three-section-layout

Source: 4-reviewer code review of `e23529c..07850bb`, 13 files / ~1,300 lines.
Reviewers: correctness, testing, maintainability, project-standards.
User decision: merge to `main` with the items below accepted.

Six findings were fixed and shipped in `fix(review)`: the grid-track derivation moved into
`ui/src/layout.ts` as a pure, table-tested `deriveTracks`; the `!important` overrides that let the
stylesheet and the component disagree about collapse state were replaced with custom properties; a
lone collapsed left section now lays its rail flat instead of standing a 26px strip in a full-width
row; `loadLayout` rejects a stored all-collapsed payload; and the pane-content and rail-orientation
assertions the plan asked for were written. What follows is what was **not** fixed.

## Not fixed — accepted

**Divider drag leaks its listeners if the shell unmounts mid-gesture.** `onDividerDown` in
`ui/src/components/LayoutShell.tsx` attaches `pointermove`/`pointerup` to `window` and removes them
only on `pointerup`. An unmount between press and release leaves both attached and lets `setLayout`
run against an unmounted tree. It also ignores `pointercancel`, so a gesture interrupted by a context
menu or touch cancellation never tears down. This is the shape the original single divider already
had, and the shell only unmounts when the whole app does — but the fix (track the pair in a ref,
remove it in a cleanup effect, listen for `pointercancel`) is small and worth doing if the shell ever
becomes conditionally rendered.

**Layout is written to storage on every pointer move.** `useEffect(() => saveLayout(layout), [layout])`
fires per frame during a drag, so each frame does a `JSON.stringify` and a synchronous `localStorage`
write. Correctness is unaffected and the payload is tiny, but the write sits on the drag hot loop.
Deferring the write to `pointerup`, or debouncing it, would take it off that path.

**The drag maps against a rectangle measured once.** `getBoundingClientRect()` is captured on
`pointerdown`, so a window resize or reflow mid-drag makes the pointer-to-percentage mapping stale
until the next press. Pre-existing behaviour, carried forward unchanged.

**`ui/src/styles.css` keeps growing.** 1,205 lines before this change, ~1,340 after. The new layout,
rail, pane-header and webcam rules are cleanly delimited by section comments, so extracting them into
a separate stylesheet is available whenever the file becomes genuinely hard to navigate. Not done
here because a partial split is worse than either whole.

## Not verified

**The narrow viewport was verified by reading the rules, not by rendering them.** `AGENTS.md` puts the
visual HAL aesthetic under screenshot verification rather than assertions, and the repo has no browser
automation — no Playwright or Puppeteer — so the `max-width: 900px` behaviour (three stacked rows,
inert dividers, rails laid flat) has not been seen in a browser. The collapse behaviour it preserves
is covered by `ui/test/components/LayoutShell.test.tsx`; the geometry is not.

**Neither divider's drag geometry is exercised end to end.** `clampSplit` is unit-tested and the
handlers are shared by both axes, but no test drives a pointer sequence to confirm the horizontal
divider measures the left column rather than the body, or that the percentage math is right on either
axis. jsdom reports zero-sized rectangles, so a meaningful test here needs the browser tooling the
repo does not yet have.
