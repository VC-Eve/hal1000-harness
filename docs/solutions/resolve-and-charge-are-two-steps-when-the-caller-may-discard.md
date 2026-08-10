---
title: Resolve and charge are two steps when the caller may discard the result
date: 2026-08-09
category: pattern
tags: [architecture, budgets, rollback, accounting, templates]
module: shared/src/templates.ts
problem_type: design_decision
symptoms:
  - a budget is spent on output that never reaches the result
  - a rollback restores some ledger fields and leaves others stale
  - asking "does this have anything to say?" costs the same as saying it
  - a conditional section's contents affect what fits after the section is dropped
---

## Context

The prompt template renderer has conditional blocks: `{#slot}wording{/}` keeps its wording only if
the slot has something to say. Sections also share a character budget, and a list slot is handed
whatever budget remains at its position.

Those two facts collide. Deciding whether a block survives means resolving its slot — and resolving
a slot, in the first implementation, also billed the budget for it. So a block that then dropped had
already spent budget on text nobody would see, and the section beneath it silently got less room.

The first fix was rollback: snapshot the ledger before a block, restore on drop. That works and it is
where the real complexity lives, because a ledger has more than one field and every one of them has
to be restored. Missing one is a quiet bug — this renderer shipped with `produced` (which slots
returned text) restored by key rather than by value, so a dropped block could leave a stale verdict
behind for a later block to read and drop on.

## The rule

**Separate resolving from charging.** Resolve to learn what a thing would be; charge only when it
actually reaches the output.

```
resolveSlot(name)   // memoised, no budget effect — safe to ask speculatively
emitSlot(name)      // resolves, then charges once, and records that it emitted
```

Rollback then has almost nothing to undo, because the speculative path never touched the ledger.
What remains — a block whose body emitted before a later sibling decided the block drops — still
needs a snapshot, but the surface is small enough to get right.

Two consequences worth stating, because both were bugs before they were rules:

- **Key the charge by every dimension the budget cares about.** A slot appearing in two
  differently-budgeted sections must be billed to each, even though it resolves once. Memo key and
  charge key are not the same key.
- **Report what was emitted, not what was resolved.** A caller asking "did this render say
  anything?" must not watch its own resolver — a slot inside a block that then dropped resolved and
  contributed nothing. Track emission in the renderer and expose it.

## When this applies

Any accumulate-then-maybe-discard design: a query planner costing a branch it may not take, a
layout pass measuring a node it may not place, a retry that reserves quota before knowing whether it
will send. The question to ask at design time is *can the caller throw this away after I have
charged for it?* — and if so, split the two steps before writing the rollback, not after.

## Related

- `docs/solutions/a-value-frozen-for-one-caller-is-stale-for-the-next.md` — the memo's other hazard
- `docs/solutions/a-sweep-that-varies-one-input-cannot-see-the-other.md` — how the keying defect got
  past the tests
- `docs/residual-review-findings/feat-editable-prompt-templates.md`
