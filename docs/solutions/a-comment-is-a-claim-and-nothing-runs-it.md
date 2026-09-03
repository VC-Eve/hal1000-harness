---
title: A comment is a claim, and nothing runs it
date: 2026-09-02
category: pattern
tags: [comments, commit-messages, documentation, verification, blind-spots, review]
module: server/src/storage/worlds.ts, server/src/live/runtime.ts, CONCEPTS.md
symptoms:
  - a comment describes behaviour the code beneath it does not have
  - a commit message claims a change that is not in the diff it describes
  - a reviewer reports "the comment says X, the loop does Y"
  - a scripted edit reports success and the file is unchanged
  - a doc promises a guarantee that no test asserts
---

# A comment is a claim, and nothing runs it

Code is checked by the compiler, the tests and the reviewers. A comment beside it is checked by
nobody. So a comment can assert anything — including a fix that was never written — and stay green
forever, in the one place a future reader is most likely to trust without looking.

One feature produced four of these in a day.

## What happened

Four claims shipped, none of them true:

| Claim | Where | Reality |
|---|---|---|
| "Each owner's members resolve together" | `validate` comment **and** the commit message | The loop still awaited one path at a time |
| "A member found unplayable must not be what the next draw avoids" | `usableDraw` comment | The recording happened at draw time; the fix described was never written |
| "A value that changed mid-bridge is honoured the moment it lands" | `CONCEPTS.md` | It waited for the destination's whole clip |
| "A transition plays nothing — clips live on States" | `take` docstring | The same change gave transitions clips |

Two mechanisms produced them.

**A scripted edit that never ran.** Twice, an edit was written into a script with a heredoc and then
something else was run — `npx tsc`, a `grep` — instead of the script. Both times the shell reported
success, because `cat` had succeeded. The comment the script *would* have added went in by a
different route, so the file ended up carrying a description of a change it did not contain.

**A comment written from intent rather than from the code.** The other two were written while
thinking about what the code should do, at a moment when it did not yet do it, and were never
revisited. `take`'s docstring is the mildest kind: true when written, falsified by the very change
that sat beneath it.

## Why it survives

Every signal a project relies on is indifferent to a comment.

- The typechecker does not read it.
- The tests do not read it.
- A reviewer skimming a diff reads the comment *as* the explanation of the code and stops there — a
  confident comment actively suppresses the check it should invite.
- A commit message is the same claim with a wider audience and even less scrutiny.

Two of these were found only because a reviewer was pointed at the fixes themselves and read the
loop under the comment. One was found by running the thing. None was found by the suite, which was
green throughout.

## What to do

**Read back what changed, not what you asked to change.** After a scripted or automated edit, grep
for the *new text* and confirm it is there. A tool reporting success proves the tool ran, not that
the edit landed.

**Write the comment last.** A comment written before the code describes a plan. Written after, it
describes the code. When a change is abandoned or reshaped mid-flight, the comment written first is
the artefact that survives to lie about it.

**Treat a comment that makes a testable claim as a test that is missing.** "Resolves together",
"never repeats", "honoured on landing" are all assertions. If one is worth writing down, it is worth
one test — and if it cannot be tested, say less: describe the intent, not the guarantee.

**Check the docstrings a change falsifies.** A change that gives a thing a new capability usually
invalidates a sentence somewhere that says it has none. Grep the changed symbols for prose about
them.

**Do not let a commit message outrun the diff.** Write it from the diff. The message is the most
durable claim in the repository and the least verified.

## What caught each one

Worth recording, because it says where to spend effort:

- Two were caught by a **second review round aimed only at the fixes** the first round produced.
- One was caught by **running the feature** — the suite was green and the behaviour was wrong.
- One was caught by a reviewer asked to check whether the **learnings cited in comments were
  actually earned**, which is a cheap and unusually high-yield thing to ask for.

## Related

- `a-flag-nothing-reads-looks-shipped.md` — the same shape one level down: code that exists, is
  correct, and is wired to nothing. The `allClipsUnusable` report in this feature shipped as a
  function with no caller, which is a claim of a different kind.
- `a-regression-test-must-fail-without-the-fix.md` — the discipline that turns an assertion into
  evidence.
- `rebuilding-a-cache-field-by-field-turns-a-read-into-a-delete.md` — the learning whose citation was
  the false claim in one of the cases above; the comment named it correctly and the code violated it
  one level down.
