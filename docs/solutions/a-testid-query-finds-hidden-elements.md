---
title: A testid query finds hidden elements; only role queries honour `hidden`
date: 2026-09-05
category: pattern
tags: [testing, react-testing-library, jsdom, accessibility-tree, disclosure, ui, blind-spots]
module: ui/test/components/StateGraph.test.tsx, ui/src/components/StateGraph.tsx
problem_type: logic_error
symptoms:
  - content is put behind a disclosure and every existing assertion still passes
  - a test proves an element exists while no reader could reach it
  - "a plan specifies `queryByTestId(...)` is null as the proof that something is hidden"
  - the suite gets greener as the UI gets less reachable
---

## Context

Nine diagnostic report sections in the `/live` sidebar were folded into one collapsible
`problems (n)` group, collapsed by default with the `hidden` attribute. Nine existing assertions
addressed those reports by test id:

```ts
expect(within(screen.getByTestId("dangling-effects")).getByText(/fires and does nothing/)).toBeInTheDocument();
```

All nine passed, unchanged, against a group that was now closed. That is the wrong kind of green: the
content they assert had become unreachable, and the suite said nothing, because `getByTestId` finds
hidden elements. Only *role* queries honour `hidden` — they default to `hidden: false`, and
`dom-accessibility-api` short-circuits on `element.hidden` before consulting any stylesheet.

The plan for the work made the same mistake in the other direction. It specified the proof of hiding as
"collapsed, `queryByTestId` is null", which would have passed against an implementation that hid nothing
at all — an assertion that cannot fail is not a test.

## Guidance

**Pick the query by what you are claiming, not by what is convenient.**

| Claim | Query that can actually fail |
|---|---|
| this element exists in the DOM | `getByTestId` |
| a reader can reach this | `getByRole(...)`, or `expect(el).toBeVisible()` |
| this is hidden from assistive tech | `queryByRole(...)` is null |
| this is out of the layout | a browser measurement — jsdom has no layout |

**When you put existing content behind a disclosure, drive the disclosure in the existing tests.** Not
as ceremony — as the thing that keeps them honest. A tolerant helper is enough, and making it idempotent
means a test that already opened the group does not toggle it shut:

```tsx
const openProblems = () => {
  const toggle = screen.queryByTestId("toggle-problems");
  if (toggle && toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
};
```

**Collapse with `hidden`, not with CSS, when you want the claim to be testable.** Under CSS, jsdom
applies no stylesheet, so nothing in a component test can tell open from closed. Under `hidden`, the
element leaves the accessibility tree, so `queryByRole` returning null is a real assertion and
`toBeVisible()` works. This is the same property that makes the collapsed state correct for screen
readers, so the testable choice and the accessible choice are the same choice.

**Beware the state that outlives the element.** The open/closed flag lived in the parent, which does not
unmount when the group empties — so fixing every fault left the flag `true`, and a fault raised an hour
later rendered the group already expanded. Extracting a child component with its own state inverts the
bug rather than fixing it: a momentarily empty payload then collapses the group under whoever is
reading it. Reset on the emptiness instead, and assert it:

```tsx
useEffect(() => {
  if (problems.length === 0) setProblemsOpen(false);
}, [problems.length]);
```

Verified by revert: removing that effect fails `comes back collapsed after the faults are fixed and a
new one appears`, and restoring it passes.

## Related

- `docs/solutions/an-index-based-query-couples-a-test-to-unrelated-components.md` — the same
  `hidden: false` default, reached from the other direction: there it *narrowed* the blast radius of an
  index-based query, here it is what a testid query ignores.
- `docs/solutions/assert-the-effect-not-the-existence.md`
- `docs/solutions/tests-that-lock-in-the-bug.md` — why the revert experiment above is not optional: a
  test that passes with the fix removed was never covering the defect.
