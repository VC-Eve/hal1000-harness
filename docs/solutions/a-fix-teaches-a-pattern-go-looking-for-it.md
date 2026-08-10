---
title: A fix teaches a pattern — go looking for it, not just at the instance
date: 2026-08-10
category: pattern
tags: [review, blind-spots, process, correctness]
module: server/src/templates/chatContext.ts, server/src/templates/conversationSystem.ts
problem_type: process
symptoms:
  - a defect a review just caught reappears in code written days later
  - a mechanism added to fix a bug is not used at the next site that needs it
  - a second reviewer flags something as "the same as finding N" from an earlier round
---

## Context

A code review found that a chat context decided "did this render say anything?" by watching its own
resolver — a flag set as a side effect of being *asked* for a slot. That is wrong whenever a block
can drop after resolving: the slot was asked for, contributed nothing, and the flag says otherwise.

The fix added `RenderResult.emitted` — the slots whose text actually reached the output, truncated by
rollback — and read the verdict from that.

Three commits later, a new feature composed a Conversation's system message and needed the same
verdict: was `{context}` placed by the template, or should it be appended beneath? It was written
with a closure flag set inside the resolver. The identical defect, in new code, by the same author,
days after fixing it — and `emitted` was sitting right there, added for exactly this.

A `{#context}` block that held without containing `{context}` set the flag, so the context was
neither placed nor appended. It vanished.

## Why fixing the instance is not enough

Closing a finding feels like closing the class. It is not, and the gap has a specific shape:

- **The fix is remembered as a diff, not as a rule.** "I changed that line" is easy to hold; "a
  verdict about output must come from output" is the thing that generalises, and it is not written
  anywhere the next keystroke will meet it.
- **The mechanism added by the fix is invisible at the next call site.** `emitted` existed. Nothing
  prompted its use, because nothing connects "I am about to decide whether a slot rendered" to "there
  is a field for that".
- **New code does not feel like the code that was reviewed.** A different file, a different feature,
  a different day. The pattern does not care.

## The rule

**When a review finds a defect, do three things, not one.**

1. Fix the instance.
2. Name the rule in a sentence, and put that sentence where the mechanism lives — on the field, the
   function, the type. `emitted`'s doc comment now says what it is *for*, and says that reading a
   resolver instead is the mistake it was added to prevent.
3. **Grep for the shape.** Not the symbol — the shape. Here: every place a boolean is assigned inside
   a resolver, a callback, or a visitor. That search takes a minute and would have caught this before
   it was written.

For a reviewer: **when a finding matches an earlier round's, say so explicitly.** The second
reviewer's phrase — "the same defect the first review caught, reintroduced in new code" — is what
turned a fix into a lesson. A finding reported as novel gets fixed; a finding reported as *recurring*
gets a rule.

## In this repo

`docs/residual-review-findings/` is per shipped feature and reads as accepted risk. Recurrence is a
different thing and belongs here, in `docs/solutions/`, because the next author will not read the
residuals of a feature they are not touching.

## Related

- `docs/solutions/self-review-finds-mechanism-bugs-not-outcome-bugs.md`
- `docs/solutions/a-boundary-guard-is-not-defence-for-the-comparisons-behind-it.md` — the same shape
  from the other side: the rule was known, cited, and then broken six lines later
- `docs/solutions/resolve-and-charge-are-two-steps-when-the-caller-may-discard.md`
