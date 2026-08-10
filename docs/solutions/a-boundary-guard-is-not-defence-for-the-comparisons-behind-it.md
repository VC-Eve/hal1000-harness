---
title: A boundary guard is not defence for the comparisons behind it
date: 2026-08-09
category: bug
tags: [correctness, thresholds, nan, defence-in-depth, blind-spots, review]
module: shared/src/prompts.ts, shared/src/templates.ts
problem_type: logic_error
symptoms:
  - a guard is written correctly in one place and the same class of comparison is written unsafely six lines later
  - every comparison downstream of a validated boundary is phrased as a rejection
  - a new caller reaches a helper without routing through the function that sanitises its arguments
  - the author cites the lesson in a comment and then breaks it in the same file
---

## Context

`docs/solutions/a-threshold-guard-written-as-a-negation-fails-open-on-nan.md` is the rule this
repo already had: a guard phrased "reject when below" cannot reject `NaN`, because every
comparison against `NaN` is `false`. Phrase it as acceptance and non-finite input falls out of
the bottom instead of sailing through.

Building the prompt template renderer, that rule was applied at the boundary and nowhere behind it.
`contextBudgetChars` — the one function that turns a Context Level into a character budget — is
guarded exactly right, and its comment re-derives the reasoning from scratch:

```ts
if (!(share > 0)) return 0;
if (!(Number.isFinite(windowTokens) && windowTokens > 0)) return 0;
```

Six new slot renderers were then written behind it, every one of them phrasing its fit check as a
rejection:

```ts
if (spent + line.length > cap) { dropped += 1; continue; }
if (line.length > budget) return "";
```

For a `NaN` budget those read "keep the line". The only reason nothing was broken is that the sole
production path routes through `contextBudgetChars`, which cannot emit `NaN`.

That is not a defence. That is one function standing between a live bug and the user, with no test
in front of any of the six.

## What made it hard to see

The author knew the rule. It is cited by path in `identityBand` a hundred lines above, and
independently restated in the `contextBudgetChars` comment. The failure was not ignorance — it was
the reasonable-feeling inference that **guarding the boundary makes the interior safe**.

It does, until someone adds a second caller. A budget is exactly the kind of value that acquires new
callers: a preview, a different role, a test harness, phase two of the same feature. Each is a chance
to compute the number some other way and reach the helpers directly.

The original lesson gestures at this — it has a section on rejecting non-finite values at the
boundary — but frames boundary rejection as *additional* defence on top of acceptance-phrased
comparisons everywhere. The gap is that under time pressure, boundary-first reads as
boundary-*only*, and the interior never gets rewritten.

## The rule

**Phrase every comparison that decides a user-visible outcome as acceptance, including the ones
behind a validated boundary.** The boundary guard is where you reject bad input; the interior
comparisons are where you survive having missed one.

Mechanically: `if (!(amount <= cap))` rather than `if (amount > cap)`. Identical for every finite
number; opposite for `NaN`, and the opposite is the safe direction.

And put a test on each helper directly, not only on the guarded path. If the only coverage feeds the
helper through the function that sanitises its arguments, the helper's own behaviour on bad input is
unasserted, and the next caller inherits an untested contract.

## How it was caught

Not by the author, and not by the tests — every test passed. A learnings-search agent reading the
diff against `docs/solutions/` noticed that a doc was cited in one place and contradicted in six
others in the same file. That is a specific, cheap thing to look for and it generalises:

**When a change cites one of these docs, check the rest of the change against the doc it cited.**
An author who reaches for a lesson has demonstrated they know it, which is exactly the condition
under which nobody checks whether they applied it consistently.

## Related

- `docs/solutions/a-threshold-guard-written-as-a-negation-fails-open-on-nan.md` — the original rule
- `docs/solutions/self-review-finds-mechanism-bugs-not-outcome-bugs.md` — same shape of blind spot
- `docs/residual-review-findings/feat-editable-prompt-templates.md`
