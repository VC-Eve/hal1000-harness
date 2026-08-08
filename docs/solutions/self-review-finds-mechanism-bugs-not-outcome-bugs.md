---
title: Self-review finds mechanism bugs; the outcome bugs need someone who did not write it
date: 2026-08-08
category: workflow
tags: [review, blind-spots, verification, agents, process]
module: docs/solutions, server/src/vision
problem_type: workflow_issue
symptoms:
  - a careful self-review finds real bugs and the independent pass then finds worse ones
  - every finding from one reviewer falls into the same category
  - the code is verified correct and still produces a wrong user-visible result
  - "\"I already reviewed this\" is offered as a reason to skip review"
---

## Context

The recognition feature was self-reviewed carefully before an eleven-agent independent review ran on
the same diff. Both found real defects. What they found was not the same *kind* of thing, and the
split was almost clean.

**Self-review found three, two of them concurrency:** thumbnailing inside the detection lock;
unserialised store mutations losing a write; a failed enrolment destroying the candidate it had
taken. All real, all fixed, all verified by reproduction.

**The independent pass found four P1s in the identity path** — the thing the feature exists to get
right — and self-review had found none of them:

- The output hedge failed on its single most likely input. The summariser is *handed*
  `"someone who looks like Dave"` and naturally capitalises it at a sentence start; the
  anti-double-hedge lookbehind was lowercase-only. The most probable output shape sailed past it.
- The same matcher was case-sensitive on the name, so a model writing an enrolled `"sw"` as `"SW"`
  shipped a **bare name** — the exact outcome the whole hedging design exists to prevent.
- An observation was labelled with whoever was in view when the *captioner answered*, not when the
  frame was taken. Captioning takes tens of seconds, so a frame of an empty room could carry a name.
- One false gallery match welded a stranger onto an enrolled person's appearance, so no new
  appearance opened, the stranger was never queued for triage, and the rolling embedding update then
  replaced the appearance's face with theirs.

The pattern: **self-review audited the machinery. It did not audit what came out of the machine.**

## Guidance

### The author's attention follows the author's model

Every self-review finding was about a mechanism the author had been actively reasoning about —
locks, ordering, lifecycles. That is not laziness; it is what having a mental model *does*. The model
that made the code writable is the same model that decides where to look, so the review inherits its
shape, including its edges.

The bugs it missed were all one step further out: not "is this code correct" but "is the thing that
reaches the user correct". Nobody rereads their own guarantee asking whether the *producer* emits the
shape they tested against.

### Predictions before an independent review are a cheap calibration check

Before dispatching, the author predicted two findings: another fixture swallowed by a threshold, and a
performance problem in a base64 broadcast. The performance one landed. The fixture one did not — the
fixtures were fine, and the testing reviewer instead found an entire pipeline with no assertions at
all behind a swallowing `.catch`.

Being wrong in that specific way was the useful part. The author had over-indexed on the failure mode
most recently learned, which is exactly the bias an independent pass exists to break. **Write the
prediction down first; the delta tells you which way your attention is skewed.**

### Exclude what you already found, so the pass spends itself on what you cannot see

The three self-review findings were named up front as already-fixed and out of scope. Without that,
several reviewers would have spent their budget rediscovering them and reporting them as new. The
handoff is: *here is what I already know is wrong; find what I don't.*

### Point reviewers at the recorded lessons, not just the code

The learnings reviewer was given the `docs/solutions/` corpus and asked which lessons this diff
honoured or violated. It found an instance of `a-flag-nothing-reads-looks-shipped.md` — a field
produced and read nowhere — by knowing the *shape* to look for rather than by noticing the field. A
reviewer holding the catalogue of past mistakes finds this class of thing that a reviewer holding only
the diff does not.

It also produced one false positive, claiming a threshold-range test was missing when it existed.
Contradiction between two reviewers is signal: check it, drop the loser, and do not let it reach the
report.

### Nobody checks the plan against the tree

Eleven reviewers, one of them given the plan file explicitly, and none noticed that the plan's own
Implementation Unit listed a test file that was never written — `recogniser.test.ts`, eleven named
scenarios, absent for three slices. It surfaced by accident, from a stray shell command creating the
empty file.

Reviewers read the diff. A file that was never created is not in the diff. **Plan completeness needs
its own check: list the plan's `Files:` entries and confirm each exists.**

## Why This Matters

The cost is asymmetric in an unusual direction. Self-review is cheap and finds the bugs that would
have caused a crash or a corrupted store — the ones that announce themselves. The independent pass is
expensive and finds the bugs that ship quietly and produce a wrong answer to the user: a name on the
wrong person, an identity on a frame it does not belong to.

For a feature whose entire purpose is to say *who* someone is, the second class is the one that
matters, and it is precisely the class the author cannot see.

## When to Apply

- Any feature where the failure mode is a wrong *answer* rather than an error. Recognition,
  classification, ranking, pricing, permissions.
- After a self-review that felt thorough. That feeling is not evidence of coverage; it is evidence of
  consistency with the model that wrote the code.
- Do **not** skip the independent pass because a self-review happened. They are different instruments.
  Skip it when the change cannot produce a wrong answer, not when you have already looked.

## Examples

The two reviews, side by side:

| | Self-review | Independent pass |
|---|---|---|
| Findings | 3 | 20+ merged, 9 P1 after promotion |
| Dominant class | concurrency and ordering | identity correctness |
| Found any identity-path P1 | no | four |
| Found the untested pipeline | no | yes |
| Cost | minutes | eleven agents |

See also `docs/solutions/tests-that-lock-in-the-bug.md`, whose fixture lesson the author had recorded
hours earlier and then repeated anyway — in the tests written for the hedge, using a lowercase fixture
against a producer that capitalises.
