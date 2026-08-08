---
title: A threshold guard written as a negation fails open on NaN
date: 2026-08-08
category: bug
tags: [correctness, thresholds, nan, input-validation, javascript, blind-spots]
module: server/src/vision/people.ts, server/src/vision/recogniser.ts
problem_type: logic_error
symptoms:
  - a confidence or score threshold admits a value it should reject
  - a match is reported with a score that is not a number
  - arithmetic over externally-supplied numbers produces NaN and nothing errors
  - a guard reads correctly and behaves backwards for exactly one input
---

## Context

Face matching refused any score below a configured threshold — that refusal is the requirement that
stops HAL guessing at the nearest person:

```ts
if (!best || best.confidence < threshold) return null;
return best;
```

Correct for every number. Not for `NaN`:

```
confidence 0.9  -> MATCH RETURNED
confidence 0.3  -> no match (safe)
confidence NaN  -> MATCH RETURNED
```

`NaN < 0.5` is `false`, so the guard does not fire and the function returns a **confident
identification** built on a score that is not a number. Every comparison operator returns `false` for
`NaN`, so a guard phrased as "reject when below" cannot reject it, while a guard phrased as "accept
when at or above" cannot accept it.

The `NaN` was reachable: a cosine over an embedding containing one non-finite element is `NaN`, and
embeddings arrive as JSON from a separate process.

## Guidance

### Phrase the guard as the acceptance, not the rejection

```ts
// Fails open on NaN
if (best.confidence < threshold) return null;

// Fails closed on NaN
if (!(best.confidence >= threshold)) return null;
```

The double negative is uglier and it is correct. `NaN >= threshold` is `false`, so the negation makes
it a rejection. Write the condition you actually want to be true, then negate it once — do not write
its inverse and trust the two to be equivalent, because for `NaN` they are not.

### Reject non-finite values at the boundary, not only at the guard

The guard is the second line. The first is refusing the value where it enters:

```ts
embedding:
  Array.isArray(face.embedding) &&
  face.embedding.length > 0 &&
  face.embedding.every((v) => typeof v === "number" && Number.isFinite(v))
    ? face.embedding
    : null,
```

`typeof NaN === "number"` and `JSON.parse` will not object, so a type annotation of `number[]` is not
a guarantee about the values. Any array of numbers crossing a process boundary needs
`Number.isFinite` per element if arithmetic downstream feeds a decision.

### Suspect every comparison that decides a user-visible outcome

The dangerous ones are thresholds, sort comparators, and clamps — anywhere one comparison decides
between two behaviours. `Math.min`/`Math.max` propagate `NaN`, sorts with a `NaN` comparator produce
implementation-defined order, and a clamp written with `<`/`>` passes `NaN` straight through.

### The type system will not help

`confidence: number` is satisfied by `NaN`. TypeScript has no non-`NaN` number type, so this class of
bug is invisible to `tsc` and to any test that does not deliberately supply `NaN`. It has to be
written as a test:

```ts
it("fails closed when a stored vector produces a non-finite score", async () => {
  await store.create("Dave", [Number.NaN, 0], THUMB);
  expect(await store.match([1, 0], 0.5)).toBeNull();
});
```

## Why This Matters

The failure is silent and it is in the direction that does harm. A threshold exists to make the system
say "I do not know"; failing open converts exactly that case into a confident assertion. Here it meant
naming a human — the single outcome the feature was designed to prevent, arriving through a comparison
operator.

It survived a careful self-review, a full typecheck, and 740 passing tests.

## When to Apply

- Every `<` or `>` guarding a decision on a number that came from outside the process: another
  service, a file, user input, or arithmetic over any of those.
- Any similarity, confidence, probability, or score comparison.
- When reviewing: read each threshold and ask what it does for `NaN` specifically. It is a two-second
  check with one right answer.

## Examples

The full set of comparisons in one small module, after the fix — acceptance-phrased and boundary-checked:

```ts
// recogniser.ts: refuse the value at the wire
face.embedding.every((v) => typeof v === "number" && Number.isFinite(v))

// people.ts: and phrase the threshold as acceptance
if (!best || !(best.confidence >= threshold)) return null;

// recogniser.ts: cosine stays total rather than throwing
if (na === 0 || nb === 0) return 0;
```

Found by an independent security review, not by the author — see
`docs/solutions/self-review-finds-mechanism-bugs-not-outcome-bugs.md`.
