---
title: A property declared twice in one rule keeps the last value and the first comment
date: 2026-08-11
category: bug
tags: [css, cascade, comments, stale-documentation, single-source-of-truth, review]
module: ui/src/styles.css
symptoms:
  - a CSS bound described in a comment has demonstrably never applied
  - a rule sets the same property twice and only the later one has any effect
  - a value is edited, the numbers look right in the diff, and nothing changes on screen
  - no linter, typecheck or test failure, because both declarations are individually legal
---

## Problem

`.settings-modal` carried a height floor and a flex reset:

```css
.settings-modal {
  /* The floor stops the modal collapsing to a strip on the small
     categories; the ceiling is where the tall ones start scrolling inside. */
  height: auto;
  min-height: min(480px, 70vh);
  max-height: min(880px, 92vh);
  background: var(--panel2);
  border: 1px solid var(--border);
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  /* The fixed-height root the overflow chain below is measured against. */
  min-height: 0;
  overflow: hidden;
}
```

`min-height` is declared twice. Same selector, same specificity, so the later one wins: the modal's
real minimum height has always been `0`. The floor never applied on any category, at any viewport,
on any day since it was written — and the comment eight lines above it says it does.

The small categories have therefore always rendered short. Nobody noticed, including during a later
change that re-typed *new numbers* into the dead declaration (`min(560px, 76vh)`) and wrote a fresh
comment about what the floor now achieved.

Nothing catches this. Both declarations are valid CSS. There is no linter in this repo, and a linter
would likely not flag it anyway — duplicate declarations are legal and occasionally deliberate
(progressive enhancement, fallbacks for older engines). The build succeeds. jsdom does no layout, so
no test can observe a height.

## Root cause

The two declarations were added at different times for unrelated reasons, and neither author read the
whole rule.

`min-height: 0` came first, from the flexbox overflow work — every flex ancestor between a scroll
container and its fixed-height root needs it, or `overflow-y: auto` silently stops working (see
`flexbox-min-height-scroll-trap.md`). It was placed next to `display: flex` because that is what it
is about.

`min-height: min(480px, 70vh)` came later, from sizing work, and was placed next to `height` and
`max-height` because *that* is what it is about. Both placements are locally correct. The rule is
long enough — six declarations and a comment separate them — that a reader scanning for one intent
never has the other in view.

The comment is the part that made it durable. It reads as documentation of a working bound, so every
subsequent reader — including two who edited the numbers — took the behaviour on trust and looked no
further. A stale comment does not merely fail to help; it actively stops the check that would have
found the defect.

This is the declaration-level twin of a defect found in the same file the week before: `.templates-intro`
was defined as two separate rule blocks, the second silently overriding the first for both usages.
Same failure, one level up.

## Solution

There is no clever fix. Read the whole rule, decide which declaration is real, and delete the other.

Here the reset won on merit — it is load-bearing for the overflow chain, and the floor had been
inert for so long that its absence was the shipped, accepted behaviour. So the floor and its claim
went:

```css
.settings-modal {
  /* ...
     There is no floor. One was written here as `min-height`, and the `0` below
     — the flex reset the overflow chain needs — is a second declaration of the
     same property in the same rule, so it has always won and the floor has
     never once applied. Removed rather than left to read as a bound that
     exists: the small categories have shipped short since the day it was
     written, and nobody noticed, which is its own answer about whether the
     floor was needed. */
  height: auto;
  max-height: min(1100px, 94vh);
  /* ... */
  min-height: 0;
}
```

Deleting a bound that never applied changes nothing on screen, which is the point — the diff is
behaviour-neutral and the rule stops lying.

## Prevention

**When adding a declaration to an existing rule, read the whole rule first.** Not the neighbouring
lines — the whole rule. Grouping declarations by what they are *about* is good style and is exactly
what hides a duplicate: the two instances end up in different clusters, far apart, each looking
correct in its own neighbourhood.

**A comment asserting a bound is a claim, not documentation.** Treat "the floor stops X" the way you
would treat a test name: something to verify once rather than believe forever. This one was written
in good faith and was false on the day it was committed.

**Measure the computed value, do not read the source.** One `getComputedStyle` call answers this in
seconds and cannot be fooled by declaration order, specificity, or a shorthand written later in the
file:

```js
// against the running app, from the repo root so `playwright` resolves
await page.evaluate(() => getComputedStyle(document.querySelector(".settings-modal")).minHeight);
```

This is the same discipline that catches an invisible colour and a truncated input — see
`css-tracks-with-two-sources-of-truth.md` for why reading this stylesheet is unreliable in general.

**Suspect it hardest where a property has two legitimate owners.** `min-height` is the canonical case:
it means "how small may this get" to a sizing author and "let me shrink below content" to a flexbox
author. Any rule that is both a sized box and a flex ancestor can carry both intents, and neither
author is wrong to reach for the same property.

## See also

- `docs/solutions/flexbox-min-height-scroll-trap.md` — why the `min-height: 0` that won is
  load-bearing, and must not be removed to make room for a floor.
- `docs/solutions/css-tracks-with-two-sources-of-truth.md` — the same stylesheet, and the same shape
  of failure: a comment asserting behaviour the rule contradicts, invisible to the suite.
- `docs/solutions/a-completeness-guard-is-only-as-honest-as-its-exemptions.md` — the general form. A
  claim nobody re-checks stops being a claim and becomes scenery.
