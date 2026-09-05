---
title: A fix to what a picker offers is not a fix to what it keeps
date: 2026-09-04
category: pattern
tags: [validation, ui, editors, partial-fix, persisted-data, blind-spots]
module: ui/src/components/StateGraph.tsx, shared/src/worlds.ts, shared/src/world-graph.ts
problem_type: logic_error
symptoms:
  - the control offers the right options and the value it saved is still wrong
  - bad data appears in files written *after* the fix shipped, not only before it
  - the fix was verified by looking at the UI, and the UI was never the broken half
  - the corrupt record produces silence rather than an error, so nothing reports it
  - the same defect is authored a second time, days later, by the person who reported the first
---

## Context

`opsFor(type)` in `shared/src/worlds.ts` is the one rule for which comparison operators a Parameter's
type allows: `is`/`isNot` for bool and trigger, `gt`/`lt`/`eq`/`neq` for int and float. It matters
because `clauseHolds` implements `is` as `actual === (condition.value === true)` — a boolean operator
against a *number* collapses the right-hand side to `false` and asks whether a number equals false.
It can never hold. `isNot` is the same failure inverted and always holds. Either way the number in
the clause is never read, and the transition carrying it silently never fires.

A class of reserved audio Parameters arrived — `audio.remaining`, an int, deliberately never present
in `world.parameters`. The condition editor's `typeOf` resolved a name by looking it up in
`world.parameters` with a `?? "bool"` fallback, so it read every reserved readout as a bool and the
picker offered `is` for an integer. Authored clauses got it.

That was found and fixed: `typeOf` consults the reserved registry before falling back. The dropdown
offers the right operators. It had a test and it passed review.

**The author then wrote two more broken clauses, after the fix shipped.** Changing an existing
clause's Parameter ran `{ ...c, parameter: e.target.value }` — it spread the old clause and swapped
only the name, so the operator and value came along from the type that used to be there. `dj is true`
re-pointed at `audio.remaining` stayed `is`, and a number was typed into the value field.

The rule had two call sites. Only the one that *offers* was fixed.

## Guidance

**When a rule decides what a control offers, find the other place it decides what the record
keeps.** Offering and keeping are different code paths reached by different gestures. Fixing the
offer is the visible half and feels like the whole thing, because the fixed dropdown is right there
on screen.

Here the invariant is one sentence — *a clause's operator is always a member of
`opsFor(typeOf(clause.parameter))`* — and it has to hold at every point where `parameter` can change.
There were two, and the second one was a spread:

```ts
// Authoring a new clause — consulted opsFor, and was the half that got fixed.
const seedCondition = (): Condition => {
  const first = world.parameters[0];
  return { parameter: first.name, op: opsFor(first.type)[0]!, value: defaultValueOf(first) };
};

// Re-pointing an existing clause — never consulted opsFor at all.
transition.conditions.map((c, i) => (i === index ? { ...c, parameter: e.target.value } : c))
```

The repair puts the same rule at the second site, and keeps the author's comparison when the type
has not changed:

```ts
const repoint = (condition: Condition, parameter: string): Condition => {
  const was = typeOf(condition.parameter);
  const now = typeOf(parameter);
  if (was === now && opsFor(now).includes(condition.op)) return { ...condition, parameter };
  const declared = world.parameters.find((p) => p.name === parameter);
  const value = declared ? defaultValueOf(declared) : (readoutFor(parameter)?.idle ?? false);
  return { parameter, op: opsFor(now)[0]!, value };
};
```

**A spread that swaps one field is where this hides.** `{ ...record, x: newX }` is the idiom for "just
change x", and it is correct exactly when no other field depends on `x`. When a sibling field's
legality is *derived* from `x` — an operator from a type, a unit from a currency, a validation from a
category — the spread carries the stale sibling across the change without a word.

**Looking at the control proves nothing.** The operator dropdown here is rendered from
`opsFor(typeOf(condition.parameter))` at render time, against the clause's *current* Parameter. So a
mismatched clause draws exactly like a correct one: the list of options is right, the selected value
inside it is wrong, and nothing distinguishes them. Verifying this fix by eye was always going to
pass.

**Test the gesture, not the render.** The coverage that existed asserted what the dropdown *offered*
for a given type — true, and unable to fail for a defect on the keeping side. The test that catches
this changes an existing clause's Parameter across a type boundary through the interaction path, and
asserts the operator that survives is one `opsFor` allows.

**Fixing the editor repairs nothing already written.** A World is a portable folder that travels
between machines, so the corrupt clauses outlived the fix and had to be found separately — by reading
the manifest, because a clause that can never hold produces no error, no log line, and no failing
test. That is what a static report over stored data is for: `mismatchedOperators` in
`shared/src/world-graph.ts` derives its check from the same `opsFor` the editor and the runtime use,
so it cannot disagree with either. Note it existed and *reported* while the keeping side was still
writing new corruption — a detector is not a guard, and a report nobody scrolls to is not a fix.

**Where else this shape lives:** a validation that filters a picker and also has to validate the
save; a permission that hides a control and also has to guard the endpoint; a formatter whose
inverse parser was never updated; any `legalValuesFor(x)` helper — grep its call sites before
believing a change to it is complete, and treat each caller as a separate thing to verify.

## Related

- `a-gate-that-checks-one-direction-is-half-a-gate.md` — the sibling at the protocol level: one rule,
  several access paths, only the obvious one guarded. That doc's failure is a read given away; this
  one's is a write let through.
- `a-fix-teaches-a-pattern-go-looking-for-it.md` — the prevention angle. A fix is remembered as a
  diff rather than as a rule, so the second call site is never visited.
- `a-flag-nothing-reads-looks-shipped.md` — the same false confidence from the other direction: there
  the produced half was right and nothing consumed it; here the offered half was right and the kept
  half was wrong.
