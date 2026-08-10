---
category: workflow
module: shared/src/templates.ts, server/test/chat, server/test/templates
tags: [byte-identity, refactor, snapshot, oracle, budget, sweep, verification]
symptoms:
  - a refactor claims byte identity and the test proves only that it agrees with itself
  - a parallel reimplementation passes because both paths share the code being changed
  - a budget sweep passes and a real defect sits just past where the sweep stopped
  - a charging change is invisible because the rendered text only differs at the truncation boundary
---

# Byte identity needs an oracle recorded first

When a refactor must produce exactly what the old code produced, the test cannot
be `new(x) === old(x)`. Record the current output as literal strings, commit
them, and assert the new path against the recording.

## Why the obvious test does not work

A parallel reimplementation is not an oracle. If both paths end up sharing any
of the code being changed — a helper, a formatter, a budget calculation — the
test agrees with itself, and it agrees with the mistake too. Recorded strings
cannot drift in sympathy with a defect, because they are not code.

This also decides *when*. The recording has to be taken from the running code
**before the refactor starts**, not before the risky part of it. By the time the
first commit lands, the thing being preserved is already gone.

## What to record

Not just the happy path. Record the boundaries: truncation, zero budgets, absent
sources, every branch of a state machine, and every shape of data the values can
take. When the output carries side channels — a redaction list, a list of what
emitted, what degraded, what dropped — record those too. A change that alters
which strings are withheld from a never-pruned log is invisible in the rendered
text.

Vary the *shape* of the data, not just its value. A profile containing a blank
line, one containing CRLF, and a multi-line one are three different tests; a
previous round fuzzed four hundred thousand templates using a single clean-line
profile and was structurally blind to the defect that shipped.

## Sweep the parameter, and fund every shared resource

Where the behaviour depends on a number, sweep it rather than picking three
sizes. Two rules, both learned the hard way here:

**Step by 1, and run past the interesting range.** A sweep that stepped by 7 and
stopped at 900 missed a defect sitting at a budget of 1075.

**Fund every shared resource in at least one sweep.** Sweeping each budget with
the others pinned at zero proves each source in isolation and never touches the
shared ledger — which is the part that did not exist before the refactor, and
therefore the part most likely to be wrong. A review found two real byte-identity
defects living exactly there. If a function's signature has two of something,
grep the tests for a case that supplies both.

## Keep the old implementation under test/

If the previous implementation is retained as a comparison oracle, it belongs in
`test/`, not in the production module with a comment saying nothing else calls
it. "Nothing else calls this" should be true by construction.

## Expect a genuine divergence, and surface it

One or two real differences usually turn up, and the temptation is to widen the
test until they stop failing. Don't. The precedent here: the old assembly emitted
a truncation notice with no heading above it when the heading did not fit. The
right move was a named test documenting both behaviours, a line in the residuals
file, and telling the person whose install would change — not a floor on the
sweep that quietly hid it.

## Say "do not re-record" in two places

Put it in the snapshot's own test file and in `AGENTS.md`. A snapshot file is one
keystroke from becoming a description of the bug, and the person about to press
that key is usually not the person who wrote it.
