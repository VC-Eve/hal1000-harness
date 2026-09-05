---
date: 2026-09-04
topic: graph-never-fires-marks
---

# Marking transitions that can never fire

## Summary

Mark on the graph, on the line itself, any transition that cannot fire no matter what the machine
does. Static only — the mark is either there or it is not, for as long as the World is in that shape.
No live values, no motion.

---

## Problem Frame

A transition out of `djing-left` stopped working and the author could not see why. Diagnosing it meant
reading the stored manifest and comparing each clause's operator against its Parameter's type. The
graph was no help: it drew the transition exactly as it draws a working one.

Two separate things made it invisible. The clause was `audio.remaining is 90` — a boolean operator on
an integer, which `clauseHolds` reads as "equals false" and which can therefore never hold. And four
transitions between two States were drawn as three lines, so the one underneath could not even be
clicked. The line bug is fixed. The silence is not.

The author's own summary of what would have been enough: *"the red mark alone would have done it."*
That is the scope. A clause-by-clause readout of live values was explicitly considered and cut — it
answers a question the author was not asking.

---

## Key Decisions

**Static, not live.** A mark reflects the World's shape, not its current values. `energy > 75` when
energy is 40 is not a defect; `audio.remaining is 90` is one whatever is playing. Only the second
gets a mark. This keeps the canvas still: audio readouts change every second while a track plays, and
a graph that re-coloured on those would never sit still.

**On the line, not only in prose.** The operator defect was already reported as text in the reports
panel by the time the author hit it, and it did not help — it was a paragraph to scroll to, not a
mark on the thing being looked at. The change is location, not content.

**Two classes of "never fires", both static.** A clause that cannot hold, and a transition that
cannot win because an unconditional sibling sits above it in order. Same symptom, same silence.

---

## Requirements

**The marks**

R1. A transition holding a clause that can never hold is marked on its line in the graph.

R2. A transition that can never be reached because an earlier-ordered sibling out of the same State
is unconditional — or holds only always-true clauses — is marked on its line.

R3. A mark is visually distinct from the existing muted, soloed, selected and crossing states, which
already have styling.

R4. Selecting a marked transition says which clause or which sibling is responsible, in the panel
that already opens on selection.

R5. The analysis runs on the World's stored shape alone. It produces the same answer whether the
machine is running, stopped, or has never been started.

**What counts as never holding**

R6. A clause whose operator is not one `opsFor` offers for its Parameter's type can never hold — or,
for `isNot`, always holds, which shadows every clause after it in the same transition. Both are
marked. This is the class that has actually occurred.

R7. A clause comparing a Parameter against a value outside that Parameter's declared range can never
hold. In scope if it is cheap against the existing range logic; see Outstanding Questions.

---

## Acceptance Examples

- AE1. **Covers R1, R6.** Given a transition whose clause is `audio.remaining is 90`, when the World
  loads, then that transition's line carries the mark, whether or not anything is playing.

- AE2. **Covers R5.** Given the same World with the machine stopped, when the graph renders, then the
  mark is identical to the one shown while it runs.

- AE3. **Covers R2.** Given two transitions out of one State where the earlier-ordered one has no
  conditions, then the later one carries the mark and the earlier one does not.

- AE4. **Covers R3.** Given a marked transition that is also muted, when the graph renders, then both
  states are distinguishable from each other and from an ordinary line.

- AE5. **Covers R4.** Given a marked transition, when it is selected, then the panel names the clause
  or the shadowing sibling responsible.

---

## Scope Boundaries

- No live evaluation of any kind — no per-clause readout of current values, no colouring by whether a
  transition is satisfied right now, no motion on the canvas. Cut deliberately after the author said
  the mark alone was sufficient.
- No automatic node layout. The lines were overlapping because of an arithmetic defect in the
  parallel-edge offset, since fixed; the layout itself is not the problem.
- No labels on edges. Reading a transition's conditions still means selecting it.
- No repair. A marked transition is reported, never rewritten — the clause is the author's work, the
  same rule the store already follows for a clip path it cannot resolve.

---

## Dependencies / Assumptions

- `mismatchedOperators` in `shared/src/world-graph.ts` already computes R6's class and renders as
  prose in the reports panel. This work reuses that answer rather than deriving a second one; the new
  part is carrying it to the line and adding R2's class beside it.
- Graph reports are pure functions of the manifest and live in `shared/src/world-graph.ts` so the
  server can answer over the protocol and the graph can draw the same result. Both new marks belong
  there for the same reason.
- The ordering analysis must account for Has Exit Time: a transition offered at a mid-clip wake point
  is not shadowed by one offered only at the clip's end. An analysis that ignored this would report
  transitions that fire perfectly well.

---

## Outstanding Questions

**Resolve before planning**

- Where the line sits between "obviously broken" and "provably impossible". Three candidates, in
  increasing cost: an operator its type does not offer (already computed); a comparison outside a
  Parameter's declared range (cheap, uses existing range logic); two clauses in one transition that
  contradict each other (real analysis, grows teeth over time). The first is certain. The third is
  the one that turns a report into a solver, and is the one to say no to unless there is a reason.

**Deferred to planning**

- Whether the mark is drawn on the line, at its midpoint beside the arrowhead, or on the node it
  leaves — a question about legibility at the density of a real World, best answered by looking at
  one.
