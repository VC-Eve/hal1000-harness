---
title: A transformation that is right for the whole is wrong for the part
date: 2026-08-10
category: bug
tags: [correctness, privacy, redaction, normalisation, scope, blind-spots]
module: shared/src/templates.ts, shared/src/phrases.ts, shared/src/prompts.ts
problem_type: logic_error
symptoms:
  - a value goes in and a subtly different value comes out, and nothing errors
  - a secret is present in the output and absent from the list meant to withhold it
  - a substring search over rendered output finds nothing, though the substring is visibly there
  - a helper reused at a smaller scope quietly reshapes its input
---

## Context

The prompt renderer normalises what it produces: `\r\n` collapses to `\n`, runs of three or more
newlines collapse to two, and the result is trimmed. That rule exists for one reason — to reproduce
the blank line that used to sit *between* assembled sections when one of them drops out.

The same renderer was then reused for "phrases", which are single lines: `You know {name}: {profile}`.
Reusing it was the right call — same braces, same escapes, same conditional blocks, one syntax to
learn. What came along uninvited was the normalisation.

A Character Profile is free text about a real person. Given one containing a blank line:

```
Runs the lab.

Allergic to bees.
```

the phrase rendered it with the blank run collapsed. The profile in the prompt was no longer the
profile on disk.

That would have been cosmetic, except for what read it next. The redaction list — the strings
withheld from an inference log that is **never pruned** — was built by searching the finished text
for the original profile:

```ts
if (profile && text.includes(profile)) redact.push(profile);
```

The search failed. `redact` came back empty. The profile went to the log in full, permanently.

## The two errors, and they are different

**A transformation was applied at a scope it was not designed for.** Collapsing blank runs is
meaningful between sections and meaningless inside one line — there is nothing to separate. At the
smaller scope the rule had no job except to reach into a substituted value and reshape it. The fix is
one flag: the whole-message renderer normalises, the phrase renderer does not.

**A secret was recovered by searching for it instead of being reported.** Even with the
normalisation fixed, `text.includes(profile)` is the wrong shape. The wording around `{profile}` is
user-editable; once the user owns it, nothing about the finished string is predictable, and a search
can only ever be a guess that happens to work today. The code that renders a sensitive value is the
only code that knows exactly what it rendered, so that is the code that must report it.

## The rules

- **When reusing a transformation at a new scope, list what it does and ask whether each part still
  earns its place.** Reuse is right; inheriting every behaviour with it is not. A parameter is
  cheaper than a second implementation and much cheaper than the bug.
- **Never recover a sensitive value by searching output for it.** Have the producer return it.
  Searching couples a security guarantee to string identity that any downstream transformation — or
  any user edit — can break silently, and "silently" is the whole problem: an empty redaction list
  looks exactly like a request that carried no secret.
- **Test the invariant, not the happy value.** The property is *whatever reaches the request is also
  on the withhold list*. A test using a one-line profile cannot see this class at all; the prior
  review fuzzed 400,000 templates and held the profile to a single clean line, so the defect was
  structurally invisible to it. Vary the **shape of the data**, not just the surrounding code.

## Related

- `docs/solutions/a-sweep-that-varies-one-input-cannot-see-the-other.md` — the sibling: varying the
  wrong dimension
- `docs/solutions/assert-the-effect-not-the-existence.md`
- `docs/residual-review-findings/feat-editable-prompt-templates.md`
