---
title: A perpendicular reverses when the edge does
date: 2026-09-04
category: pattern
tags: [geometry, svg, graph-layout, ui, off-by-symmetry, comments]
module: ui/src/graph.ts
problem_type: logic_error
symptoms:
  - N items are drawn and fewer than N appear
  - the one that cannot be seen also cannot be clicked, because it is underneath
  - the spreading works for some counts and not others, with no obvious pattern
  - a comment directly above the code claims the collision cannot happen
---

## Context

Four transitions between two States in the graph drew as three lines. The fourth was not missing — it
was exactly underneath another one, so it could not be seen and could not be selected.

Parallel edges are fanned apart: each is offset along the perpendicular of the straight line between
its endpoints, by a step that alternates either side of centre — `0`, `+g`, `-g`, `+2g`, `-2g`. That
is correct for edges pointing the same way. These do not. Two of the four run A→B and two run B→A, and
**a return leg's perpendicular points the opposite way**, so the same step lands on the opposite side
of the line. Step `+g` outbound and step `-g` inbound produce the identical screen offset.

Measured against the real World, printing the offset each transition actually received:

```
dance-floor1-hard -> djing-left    idx 0  step   0   offset (  0.0,   0.0)
djing-left -> dance-floor1-hard    idx 1  step  26   offset (-15.4, -21.0)
dance-floor1-hard -> djing-left    idx 2  step -26   offset (-15.4, -21.0)   <- collides with idx 1
djing-left -> dance-floor1-hard    idx 3  step  52   offset (-30.7, -41.9)

distinct curves drawn: 3 for 4 transitions
```

The collision needs the directions to **alternate**. Four edges ordered A, A, B, B fan out correctly;
A, B, A, B collide on the middle pair. That is why it looked intermittent and why nothing had caught
it — a lane of two, or a lane whose edges happened to be stored in the convenient order, is fine.

## Guidance

**An offset expressed relative to a direction inherits that direction's sign.** Anything derived from
an edge's own vector — a perpendicular, a normal, a tangent, a "left of the line" — flips when the
edge is traversed the other way. If several such things must be *spread apart from each other*, they
have to be measured in a frame they share, not each in its own.

The fix is to pick a canonical direction per pair and negate the step for any leg running against it,
so the flipped perpendicular cancels:

```ts
const ends = [fromKey, t.to].sort();          // the lane's canonical order
const lane = ends.join("~");
const index = lanes.get(lane) ?? 0;
lanes.set(lane, index + 1);
const along = fromKey === ends[0] ? 1 : -1;   // does this leg run with it, or against it
const step = Math.ceil(index / 2) * (index % 2 === 1 ? 1 : -1) * PARALLEL_GAP * along;
```

**The lane key was already canonical and the offset was not.** The code sorted the endpoints to build
the grouping key — deliberately, so a transition and its return share a lane and get consecutive
indices. Everything about the grouping was direction-independent; only the geometry it fed was not.
A half-applied canonicalisation is harder to spot than none at all, because the part you look at first
is right.

**The comment claimed the opposite, and nothing ran the comment.** Directly above:

> *Unordered, so a transition and its return share a lane and fan apart rather than being drawn on top
> of one another.*

True for half the index parities. It describes the intent of the sort, which was correct, and then
asserts an outcome the arithmetic does not deliver.

**Test the property, not the path string.** The first regression test compared a fixed-length slice of
each SVG path starting at its control point — which swept up the trailing endpoint coordinates, and
those differ between a leg and its return *whatever the offset does*. It passed with the fix reverted.
Comparing control points alone fails correctly, because for a lane sharing one pair of endpoints, two
curves coincide exactly when their control points do. Build the fixture so the directions alternate,
or the collision is not reachable at all.

## Related

- `a-comment-is-a-claim-and-nothing-runs-it.md` — the comment here asserted the collision could not
  happen, in the same breath as the code that caused it.
- `a-sweep-that-varies-one-input-cannot-see-the-other.md` — the fixture problem: a test whose inputs
  never alternate cannot reach a defect that only appears when they do.
- `a-safeguard-that-worked-by-accident-breaks-when-a-case-is-added.md` — the same family: an invariant
  true only for a coincidental subset of cases, with nothing marking which subset.
