---
title: Copy both halves of a mechanism, not the half that has a name
date: 2026-09-07
category: pattern
tags: [design, reuse, vocabulary, planning, blind-spots, overlays, state-machine]
module: shared/src/overlays.ts, shared/src/worlds.ts, ui/src/components/OverlayLayer.tsx
problem_type: design_gap
symptoms:
  - a feature reuses an existing vocabulary and still cannot express its most ordinary case
  - the workaround for the missing case is elaborate, latches, or fires on the wrong clock
  - reviewers read the design as sound because the half that is missing was never named
  - the gap is obvious in one sentence to whoever uses the original mechanism daily
---

## Context

Overlay slots needed to come and go — a caption on screen only under some circumstance. The state
machine already had a vocabulary for *when*: `Condition`, `opsFor`, `clauseHolds`, the reserved audio
readouts, a picker, and five reports. The plan gave a slot `conditions?: Condition[]` and stopped.

That is only half of what a transition uses to say when it applies. A transition says it
**structurally** — `from` and `fromAny` are its position in the graph — and then *filters* that with
conditions. A slot has no position in the graph at all, so conditions alone left it unable to say the
most ordinary thing an operator wants: draw this lower third while the machine is in the interview
State.

The workaround was not small. A bool Parameter written by an Effect on the State **latches**: leaving
a State resets nothing, its Effects simply stop being live and the Parameter keeps its last value, so
every *other* State needs the inverse Effect and a State added later silently breaks the caption. It
is also not prompt — Effects fire on a shared 100ms clock with a 250ms floor and never on arrival, so
the caption lands at least a quarter-second after the cut it is meant to label.

Six reviewers read the plan. Two noticed. The framing survived anyway, because by then it had been
written up as an *out-of-scope question* ("a clause cannot name a State") rather than as a missing
half — so the reviewers who saw it were arguing against a stated boundary rather than reporting a
gap. SW dissolved it in one question: *"I had assumed that was how it would work, the same way other
transitions work."*

The fix was `states?: string[]` beside `conditions?: Condition[]` — no new operator, no new value
type, reading a `stateId` the browser already held exactly.

## Guidance

**A mechanism's parts are not equally visible.** The filter half is a named, exported type you can
grep for. The structural half is a *field on the thing that owns it*, so it does not look like part
of the vocabulary at all — it looks like part of the transition. Copying the greppable half feels
like reuse, passes review as reuse, and ships a feature missing the axis nobody wrote down.

**Before copying a mechanism, ask what its existing user gets for free from where it sits.** Not what
it declares — what its position, its owner, or its container already answers on its behalf. A
transition knows which State it applies to without a field for it. A slot knows nothing about where
it is, so anything the transition got structurally has to become explicit.

**Cost the workaround honestly, and out loud.** "You could declare a bool" sounds like a minor
inconvenience until you write down that it latches on exit, needs an inverse Effect in every other
State, silently breaks when a State is added, and arrives a quarter-second late. A workaround that
bad is the signal the missing half is load-bearing. Writing the cost down is also what turns a
disagreement into a decision — SW chose the States list in one exchange once the alternative was
spelled out.

**A gap written as a scope boundary stops being reviewable.** Once the plan said "a clause cannot
name a State" under *Not in scope*, every reviewer read it as a decision someone had made rather than
a hole. If you find yourself declaring a boundary that happens to sit exactly where a capability is
missing, say which it is — a decision needs its alternative named and rejected, and a hole needs
fixing.

**Ask the person who uses the original.** The reviewers were reasoning about the design. SW was
reasoning about the machine they drive every day, and the question took one sentence. When a feature
reuses something with existing users, the cheapest review available is asking one of them whether it
works the way they expected.

## Related

- `docs/solutions/read-how-a-system-resolves-not-where-it-stores.md` — the sibling failure: ruling a
  system out on a premise about it that was never checked.
- `docs/solutions/extending-a-catalogue-is-not-auditing-it.md` — reading the catalogue rather than
  enumerating the domain, which is the same blindness one level down.
- `docs/plans/2026-09-07-001-feat-overlay-conditions-plan.md` — the plan, whose Problem Frame states
  the two halves explicitly because of this.
