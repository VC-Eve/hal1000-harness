---
title: A value frozen for one caller is stale for the next one that reads it
date: 2026-08-08
category: pattern
tags: [caching, staleness, coupling, telemetry, logging, invariants, verification]
module: server/src/vision/appearances.ts, server/src/vision/service.ts
problem_type: logic_error
symptoms:
  - a logged measurement repeats to the digit across readings that should vary
  - the value changes only at a lifecycle boundary — a session, an appearance, a connection
  - a metric built to fall can only rise, because the number feeding it never moves
  - the field being read carries a comment explaining why it must not change
---

## Context

`appearance.match` is the identity decision the vision tracker makes when a face first appears. It is
deliberately frozen for the life of that appearance, and the module says so at the top:

> consecutive detections of one face collapse into ONE appearance carrying ONE identity decision
> (R4), and that decision is made on entry and never revisited while the appearance is open

That freeze is correct. Detection fires every few seconds and a person stands in frame for minutes;
without it, narration would read a hundred identity decisions per visit as arrivals and departures.

Months later the vision timeline shipped, whose entire premise is recording what each individual
check found. It read the same field. Nothing in the timeline's code was wrong on its own terms, and
1,023 tests passed.

The user caught it by eye:

```
2:44:09 PM  Creator 61%  w 0.86
2:44:15 PM  Creator 61%  w 0.87
2:44:21 PM  Creator 61%  w 0.88
   ... eleven more identical readings while moving around ...
2:45:21 PM  an unrecognised face
2:45:27 PM  Creator 62%  w 0.86
2:45:33 PM  Creator 62%  w 0.87
```

> "I feel like its very unlikely to get the same 61% repeatedly despite me moving around a little
> bit. and then eventually it changes, but then it gets stuck on that percentage."

They were right. Independent captures of one face score 0.53–0.78 against a gallery; a live cosine
similarity does not repeat to the digit. And the jumps were not random — `61 → unrecognised → 62`
is an appearance closing and a new one opening, taking a fresh decision that then froze in turn.

## Guidance

**When a value is cached, frozen, or debounced for one consumer's benefit, that property is part of
its contract — and the next consumer to read it inherits the property without being told.**

The freeze here was well-reasoned, well-commented, and load-bearing. None of that helped, because
the comment answered "why does this not change?" and the new caller was asking a different question:
"what did this check find?" The same field answers both questions and is only correct for one.

Three things make this shape hard to see:

- **The stale reader is not the buggy code.** `recordCheck` looked obviously right — pair face to
  appearance, read its match, record it. The defect was in the *pairing of question to field*, which
  no line of either module states.
- **Freshness is invisible to type systems and to tests with fixed fixtures.** A fake gallery that
  returns one constant match makes frozen and fresh indistinguishable. Every test here used one.
- **The fresh value often already exists.** In this case the tracker was calling the gallery per
  face per frame anyway — it needs that for continuity — and discarding the answer one line later.
  The fix was to stop throwing it away, not to compute anything new.

## Why This Matters

The visible cost was a log that lied at accurate timestamps: a feature built so that recognition
timings could later be injected into prompts, recording one reading repeated.

The invisible cost was worse. Recognition weight — which is supposed to rise on confident sightings
and fall on weak ones — was being fed the frozen number. A constant can never be lower than itself,
so weight could only ever climb. It sat at 0.88 and looked healthy. A metric that can only move one
way is not a weak metric; it is not a metric at all, and nothing about its output says so.

## When to Apply

Suspect this whenever a second consumer starts reading a field that predates it, and especially when:

- the field's comment explains **stability** rather than **meaning** — "decided once", "never
  revisited", "held for the life of", "debounced", "memoised"
- the new consumer is a **log, metric, or telemetry sink**. These are exactly the consumers that
  want per-event truth, and exactly the ones whose output nobody diffs against reality
- the fresh computation is **already happening nearby** for a different reason

The diagnostic that works on the output alone: **a real measurement jitters.** A number that repeats
exactly, then steps to a new value and repeats exactly again, is being copied rather than measured.
Ask what changed at the step — the answer names the lifecycle whose cache you are reading.

## Examples

Before — the record reads the decision:

```ts
const appearance = open.find((a) => a.box === face.box);
const match = appearance?.match ?? null;   // frozen on entry, for R4's benefit
```

After — the decision stays frozen; the record reads the frame:

```ts
// THIS frame's reading, not the one the appearance opened on.
//
// `appearance.match` is deliberately frozen for the life of a visit so HAL does
// not flicker between matched and unmatched mid-sentence — that is what R4 is
// for, and it is right for what HAL SAYS. It is wrong for what the record says
// each check FOUND.
const match = appearance?.currentMatch ?? null;
```

The tracker keeps both, and clears the fresh one every frame so an appearance that claims no face
cannot carry last frame's reading forward:

```ts
for (const a of this.tracked) a.currentMatch = undefined;   // before assignment
...
existing.currentMatch = match;   // the reading, kept. Not the decision.
```

The test that would have caught it varies the fixture — which is the whole point, since a constant
fake cannot distinguish frozen from fresh:

```ts
const readings = [0.71, 0.55, 0.64];
let i = 0;
(svc as unknown as { people: Pick<Gallery, "match"> }).people = {
  match: async () => ({ personId: "p1", name: "Creator", confidence: readings[Math.min(i++, 2)]! }),
};
// before the fix: [0.71, 0.71, 0.71]
expect((await awaitChecks(3)).map((e) => e.faces[0]?.confidence)).toEqual(readings);
```

Verified against the real camera afterwards — 51.1% to 68.4% across a run, dropping to unrecognised
on turns away, where before it repeated to the digit.

## It happened again, in a second consumer

Fixing the timeline did not fix the defect — it fixed one reader of it. `broadcastAppearances`
carried `appearance.match` to the pane's recognition strip and nothing else, so the percentage under
the Vision title sat on the value the visit opened with while the timeline directly beneath it moved
every few seconds. The same frozen field, the same wrong reading, a different consumer, and the
strip is the *more* visible of the two.

Two things generalise from the repeat.

**Fixing a frozen value at one call site is not fixing it.** The freeze is a property of the field,
so every reader inherits it. When a field is deliberately frozen, the useful move is to find every
consumer at once and decide for each whether it wants the decision or the reading — not to fix the
one that was reported.

**A hand-copied type is what let it hide.** `ui/src/store.ts` restated the appearance shape inline
instead of deriving it from the wire contract, so the server could gain fields the client's type did
not know existed and the compiler had nothing to say. It now reads
`VisionAppearancesMessage["appearances"]`, and the same drift becomes a type error.

The reported symptom was "it does not update as the log updates", from a user watching two numbers
disagree on one screen. Neither the full suite nor the component tests had anything to say: the
component tests passed a fixture whose standing and live values were the same number, which is the
one case where the bug is invisible.

## Related

- `editing-state-a-running-process-caches-loses-the-edit.md` — the operational cousin: an in-memory
  cache silently overwriting edits made on disk. Same family of failure (a held value diverging from
  the truth), different mechanism.
- `a-flag-nothing-reads-looks-shipped.md` — the other way a feature can look wired and measure
  nothing.
- `a-measurement-on-synthetic-variants-measures-your-own-transform.md` — the same repo's other
  lesson in numbers that look authoritative while describing the wrong thing. Both were caught by
  asking whether a value's *shape* was physically plausible, not by a test.
- `self-review-finds-mechanism-bugs-not-outcome-bugs.md` — this was found by a human watching output,
  after a full suite and a self-review passed. It is another entry in that column.
