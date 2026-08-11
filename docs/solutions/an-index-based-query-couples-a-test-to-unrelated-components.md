---
title: An index-based query couples a test to every component rendered before it
date: 2026-08-11
category: pattern
tags: [testing, react-testing-library, jsdom, accessibility-tree, coupling, ui]
module: ui/test/components/SettingsPanel.test.tsx
symptoms:
  - a test breaks when a component it never mentions gains a button
  - "getAllByRole(...)[1] passes today for a reason nobody wrote down"
  - a UI decision is constrained by test fragility rather than by design
  - a plan justifies a production choice with a claim about the test framework that turns out false
---

## Problem

Two assertions in the settings panel suite pick a control out of a list by position:

```ts
fireEvent.click(category("vision"));
fireEvent.click(screen.getAllByRole("button", { name: "on" })[1]!);   // recognition toggle
// ...
fireEvent.click(screen.getAllByRole("button", { name: "apply" })[1]!); // recogniser endpoint
```

Neither says which control it wants. Both say "the second one that happens to be there", and both
have been correct only because nothing had been added above them.

The settings drawer was then reorganised: fifty-two wording editors moved into the four sections that
own them, twenty-three of them into vision — the same section these two assertions run against. Each
editor renders an `apply` button. Both assertions would have started clicking a different control,
and the failure would have surfaced in the *recognition roster* tests, which have nothing to do with
the wording editors that broke them.

## Root cause

An index into a role query is a claim about global render order inside whatever container the query
can see. It couples the test to every component that draws before its target — including components
that do not exist yet, written by someone who will never read this test.

The scope of that coupling is narrower than it first appears, and getting it wrong is its own defect.
Every settings section is mounted at all times, with only `hidden` distinguishing the active one, so
the obvious reading is "any editor added to any section shifts these indices." That is **false**.
Testing Library's role queries default to `hidden: false` and exclude subtrees hidden from the
accessibility tree; `dom-accessibility-api` short-circuits on `element.hidden === true` before it ever
consults a stylesheet, so the seven inactive sections are invisible to `getAllByRole` regardless of
CSS. Only the *active* section counts — and both assertions click `category("vision")` first.

That distinction matters because a plan justified a production design decision on the wrong version
of it. The collapsed-block control was partly argued for on "otherwise editors anywhere shift these
indices", which overstates the constraint. Two reviewers checked it against the installed library and
found it false. Had the wrong rationale survived, it would have bought a permanent UI constraint for a
reason that does not hold — and anyone who later tested the claim, found it false, and discarded the
constraint would have broken the tests for real, because the *narrow* version of the constraint is
true and load-bearing.

## Solution

The immediate fix is to make the query say what it means. Scope it, or name the target:

```ts
// scoped to the section under test
const group = (id: string) => within(screen.getByTestId(`group-${id}`));
fireEvent.click(within(screen.getByTestId("recognition-settings")).getByRole("button", { name: "on" }));
```

The same applies to navigation helpers, which had the identical shape:

```ts
// before: matches any button in the whole mounted panel named "vision"
const category = (name: string) => screen.getByRole("button", { name });
// after
const category = (name: string) =>
  within(screen.getByTestId("settings-nav")).getByRole("button", { name });
```

`scripts/screenshot.mjs` had already scoped its own equivalent, and said why — "Collapse vision" is a
button named vision too. The test suite had not.

Where an index survives for now, the constraint it implies must be written down where the *code* can
see it, not only in the test. The disclosure control carries it:

```
 * Nothing renders until the block is first opened. [...] It also means no block
 * may default to open: one that did would put its buttons back in the tree.
```

and a case asserts it on arrival rather than after a click, because counting after an interaction
passes just as happily with a block defaulting open:

```ts
for (const role of ["vision-system", "vision-user", "captioner-user"]) {
  expect(screen.queryByTestId(`template-${role}`), `${role} renders before it is asked for`).toBeNull();
}
```

## Prevention

**An index in a role query is a TODO.** `[0]` is usually fine — "the only one" and "the first one"
coincide when there is one. `[1]` and beyond are asserting a layout nobody promised. Prefer a testid,
a scoped `within`, or a value-based `find`, in that order.

**A value-based `find` is not automatically safer.** Searching a whole section for the spinbutton
holding `20` found `faces kept for naming` before the intended `frames kept`, which also defaults to
20. Scope first, then match — and prefer asserting the set (`expect(values.sort()).toEqual([...])`)
over fishing one element out of it.

**Verify framework claims before building on them.** "All sections are mounted, so everything shifts"
sounded obviously true and was wrong. The check is minutes: render two same-named buttons, hide one,
and count what `getAllByRole` returns. A design decision resting on an unverified claim about a
library is a decision nobody can safely revisit.

**When a test's fragility does constrain production code, put the constraint in the production file.**
A comment in the test cannot reach the person adding a component three files away. The invariant that
survives is the one written where the code that could break it lives.

## See also

- `docs/solutions/assert-the-effect-not-the-existence.md` — the sibling failure: a query that finds
  *something* and proves nothing about whether it is the right thing.
- `docs/solutions/css-tracks-with-two-sources-of-truth.md` — jsdom does no layout, which is why these
  queries are the only handle a component test has on structure, and why they deserve care.
- `docs/solutions/tests-that-lock-in-the-bug.md` — the other way a green suite stops meaning anything.
