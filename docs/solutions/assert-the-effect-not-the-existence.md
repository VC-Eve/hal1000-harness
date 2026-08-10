---
title: Assert the effect, not the existence — a dropped argument and a dead control look identical from outside
date: 2026-08-10
category: pattern
tags: [testing, blind-spots, refactor, config, coverage]
module: shared/src/prompts.ts, shared/src/phrases.ts
problem_type: logic_error
symptoms:
  - a parameter is accepted by a function and never used
  - a setting exists in the UI and changes nothing about the output
  - a mechanical edit threaded through N call sites lands on N-1 of them
  - the whole suite passes and a feature does not work for one caller
---

## Context

Two defects shipped together in one change, from the same root.

**A dropped argument.** A `phrases` parameter was threaded through six slot resolvers so a user's
edited wording would apply. It was added to `visionProfilesSlot`'s signature and to its call site,
and never forwarded to the function that actually rendered the line. Editing a profile line therefore
applied to Vision and silently not to chat. The threading was done with a regex; the regex matched
five sites and not the sixth.

**A dead control.** A phrase called `session.heading` was defined, listed in settings with a label,
a meaning and a rationale note, given an editor and a preview — and rendered by nothing. The heading
it claimed to own is literal text in a template. A user could edit it all day and change no prompt.

Every test passed for both. Nothing asserted the effect.

Worse: a reviewer in the same round *predicted* the first one in the abstract — "no test sets
`phrases` and asserts the output changes; a dropped argument on any one call would pass the whole
suite" — while a different reviewer found the actual instance. The prediction and the instance were
in the same review and did not meet.

## Why these are one lesson

Both are things that **exist** without **doing anything**, and existence is what tests usually check:

- The signature has the parameter. Typecheck passes.
- The catalogue has the entry. The UI renders it. A test asserting "every phrase has a label and a
  note" passes — and says nothing about whether the phrase is ever rendered.

From outside, a parameter that is accepted and ignored is indistinguishable from one that is used,
and a control wired to nothing is indistinguishable from one that is wired. Only an assertion about
the **output** separates them.

## The rules

- **After threading anything through N call sites, write one test per site that observes the effect.**
  Not "the argument is passed" — set the value to something distinctive and assert it appears in the
  result. In this repo that is a table: for each phrase id, render the context with that phrase
  edited and assert the edit is present.
- **A catalogue of controls needs a reachability test.** For every entry, assert something renders it.
  A control that changes nothing is worse than a missing control: it invites a user to tune something
  and then quietly ignores them.
- **Distrust mechanical edits in proportion to how mechanical they were.** A regex across six call
  sites is six chances to miss one, and the compiler will not help when the parameter is optional.
  Count the sites before and after; better, make the test count them for you.
- **When a review predicts a class of defect, go and look for an instance immediately** — do not file
  it as a testing gap for later. The prediction is the cheapest search term you will ever get.

## Related

- `docs/solutions/a-flag-nothing-reads-looks-shipped.md` — the same shape in a different guise
- `docs/solutions/a-sweep-that-varies-one-input-cannot-see-the-other.md`
- `docs/solutions/a-fix-teaches-a-pattern-go-looking-for-it.md`
