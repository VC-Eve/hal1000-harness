---
title: A sweep that varies one input cannot see the interaction between two
date: 2026-08-09
category: bug
tags: [testing, refactor, parity, budgets, blind-spots, coverage]
module: shared/src/templates.ts, server/test/chat/context-template-parity.test.ts
problem_type: logic_error
symptoms:
  - a parameter sweep passes and a defect in the swept area ships anyway
  - two resources share an accounting structure and only one is ever funded in tests
  - a byte-identity or equivalence guarantee holds in every test and fails in use
  - a cache or memo key omits a dimension the callers vary
---

## Context

Replacing hand-assembled prompt construction with a template renderer had one load-bearing
requirement: identical output for anyone who edits nothing. It was tested seriously — snapshots
recorded from the old implementation before the refactor, plus sweeps comparing old against new
across budgets 0 to 900 in steps of seven.

Both sweeps passed. Both were blind.

The chat context has **two** budgets, sight and session, set independently by two controls. The
session sweep pinned the sight budget at zero; the sight sweep pinned the session budget at zero.
Neither ever funded both at once — so no test in the suite exercised the two sources interacting,
which is the only condition under which the renderer's shared ledger can get them wrong.

It did. `{clock}` appears in both the session heading and the sight heading. The charge ledger keyed
it by slot name alone, so once the session block had paid for it the sight block got it free — eight
characters of extra sight budget, which is enough to change which face lines survive truncation. A
purpose-built sweep with both sources funded found 29 disagreeing budget values immediately.

A second defect hid in the same blind spot: the sight budget was charged for the newlines joining
face lines, which the old code never charged, so the caption below them silently vanished at some
budgets.

## The rule

**When a structure is shared between N resources, the sweep has to fund all N.** Sweeping one at a
time proves each resource in isolation and says nothing about the structure they share — and the
shared structure is exactly where a refactor puts its bugs, because that is the part that did not
exist before.

Concretely, for any accounting or caching structure:

- **Check the key.** If two callers can differ on a dimension, that dimension belongs in the key. A
  slot billed per render rather than per budget source is the same defect as a window cached by
  model name without the endpoint — see
  `splitting-a-singleton-leaves-every-lookup-keyed-to-the-old-one.md`.
- **Fund every source in at least one sweep.** Cheap: one extra loop.
- **Step by one, and past the interesting range.** The newline defect sat at a budget of about 1075.
  The sweep stepped by seven and stopped at 900. Even funded on both sides it would have been missed.

## Why the test design failed

Not carelessness — the sweeps looked thorough, and the one-variable-at-a-time habit is right for
isolating a cause. It is wrong for *proving equivalence*, where the whole point is that no
combination of inputs distinguishes old from new. Isolation is a debugging technique; equivalence
needs the cross product, or at least a diagonal through it.

The tell was available and unread: the code under test took two budgets, and no test passed two
non-zero budgets. When a function's signature has two of something, grep the tests for a case that
supplies both.

## Related

- `docs/solutions/splitting-a-singleton-leaves-every-lookup-keyed-to-the-old-one.md` — the key-omission
  half of this, from the other direction
- `docs/solutions/tests-that-lock-in-the-bug.md` — on oracles, and where assertions should come from
- `docs/residual-review-findings/feat-editable-prompt-templates.md`
