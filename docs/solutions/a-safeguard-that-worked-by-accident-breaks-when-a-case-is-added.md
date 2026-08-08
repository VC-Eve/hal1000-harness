---
title: A safeguard that worked by accident breaks when a case is added
date: 2026-08-08
category: pattern
tags: [correctness, regex, refactoring, invariants, blind-spots, testing]
module: shared/src/prompts.ts
problem_type: logic_error
symptoms:
  - code that worked for years fails the first time a new variant is added
  - a loop of replacements corrupts text only when the replacement shape changes
  - the original had no comment explaining the property it depended on
  - a longest-first sort stops protecting shorter names that are substrings
---

## Context

`enforceIdentityHedge` rewrote any bare enrolled name in a model's output into a hedged form —
`Dave` became `someone who looks like Dave`. It looped over the roster, longest name first, running
one regex replacement per name. Fifteen tests covered it, each recording a defect it prevented. It
had been correct for as long as it existed.

Adding a second output form broke it immediately. With bands, a confident match now renders as the
bare name plus a percentage — `Dave 71%` — so the same loop over `["Ann", "Ann Marie"]` produced:

```
Ann 90% Marie 80%
```

The longest-first sort was supposed to prevent exactly this. It rewrote `Ann Marie` first, correctly,
and then the pass for `Ann` matched the `Ann` inside the result it had just written.

## Guidance

**The old code was never protected by the sort. It was protected by what the replacement happened to
start with.**

Every string the old function wrote began with `someone who looks like `. The pattern matched that
prefix as an optional leading group, and the replacer returned the match untouched when the prefix
was present. So the second pass for `Ann` *did* match inside `someone who looks like Ann Marie` — and
then declined to change it, because the prefix was there.

That is not the sort doing the work. It is a coincidence between the shape of the output and the
shape of the pattern. The moment a band produced output with no prefix, the coincidence stopped
holding and the sort was revealed to protect nothing on its own.

**The fix is to stop making a sequence of passes over text you are also rewriting.** One pass over an
ordered alternation consumes each position exactly once, and depends on nothing about what the
replacement looks like:

```ts
// Before — N passes, each over the output of the last.
for (const name of sortedLongestFirst) {
  out = out.replace(patternFor(name), replace);
}

// After — one pass. Alternation is ordered, so longest-first still prefers the
// longer name, but nothing re-reads text this call already wrote.
const alternation = ordered.map(escapeAndSpace).join("|");
const pattern = new RegExp(`(?<!\\w)(${PREFIX})?(${alternation})(?!\\w)(${SUFFIX})?`, "giu");
return text.replace(pattern, (match, prefix, name, suffix) => { /* ... */ });
```

## Why This Matters

The dangerous property of an accidental invariant is that it leaves no trace. There is no comment
saying "this relies on every replacement starting with the prefix", because nobody knew it did. The
tests all passed, and would have kept passing forever, right up until someone added the one case that
removed the accident — at which point the failure looks like a bug in the *new* code rather than a
latent one in the old.

It is also why "the tests were green before my change" is weak evidence when adding a variant. Green
means the old cases still hold. It says nothing about whether they were holding for the reason
anybody assumed.

## When to Apply

Look for this whenever you add a **second output shape** to something that produces one shape today:

- A formatter that gains a variant
- A serialiser with a new encoding
- A rewriter, linter, or codemod that gains a second replacement form
- Any loop that transforms text and then transforms it again

The diagnostic question: **if my replacement produced something structurally different, would this
still be correct?** If the answer depends on what the output happens to look like, the safety is
accidental — write it down or restructure it so it is not.

The general shape: *iterative rewriting of a buffer you are also matching against is only safe if
rewritten regions can no longer match. That property must be stated, not inherited.*

## Examples

The test that caught it was written against the *old* behaviour's guarantee, in the new band:

```ts
it("does not partially rewrite a longer name", () => {
  // Longest first. "Ann" must not consume the "Ann" inside "Ann Marie".
  const out = enforceIdentityBands("Ann Marie is here.", [stated("Ann", 0.9), stated("Ann Marie", 0.8)]);
  expect(out).toBe("Ann Marie 80% is here.");
});
```

It failed with `Ann 90% Marie 80%` — a property the old code had, expressed in the new form, which is
what made the accident visible.

**Verification worth doing once the fix is in:** reintroduce each bug deliberately and confirm the
tests fail. A regression test that has only ever been green has not been shown to test anything.

| Bug reintroduced | Tests that failed |
|---|---|
| Hedged band stops adding its prefix | 16 |
| Trailing-suffix group removed (idempotence) | 5 |
| Sort changed to shortest-first | 1 — the `Ann Marie` case |

The third row is the interesting one: exactly one test covers the property everyone assumed the sort
provided, and it is the property that turned out to be doing less than it looked.

## Related

- `tests-that-lock-in-the-bug.md` — the postscript there is the same discipline: reintroduce the bug
  and watch the test fail.
- `a-removed-precondition-blinds-every-test-that-set-it.md` — the inverse case, where a change made a
  precondition optional and every existing fixture kept establishing it.
