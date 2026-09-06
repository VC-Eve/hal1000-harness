---
title: A transformation that is right for the whole is wrong for the part
date: 2026-08-10
last_updated: 2026-09-06
category: bug
tags: [correctness, privacy, redaction, normalisation, scope, blind-spots, bounds]
module: shared/src/templates.ts, shared/src/phrases.ts, shared/src/prompts.ts, shared/src/worlds.ts, server/src/live/runtime.ts
problem_type: logic_error
symptoms:
  - a value goes in and a subtly different value comes out, and nothing errors
  - a secret is present in the output and absent from the list meant to withhold it
  - a substring search over rendered output finds nothing, though the substring is visibly there
  - a helper reused at a smaller scope quietly reshapes its input
  - a budget for the whole is spent across the parts, and the last part gets what is left
  - a doc comment names a bound that holds per item as though it bounded the collection
---

## Context

The prompt renderer normalises what it produces: `\r\n` collapses to `\n`, runs of three or more
newlines collapse to two, and the result is trimmed. That rule exists for one reason — to reproduce
the blank line that used to sit *between* assembled sections when one of them drops out.

The same renderer was then reused for "phrases", which are single lines: `You know {name}: {profile}`.
Reusing it was the right call — same braces, same escapes, same conditional blocks, one syntax to
learn. What came along uninvited was the normalisation.

A Character Profile is free text about a real person. Given one containing a blank line:

```
Runs the lab.

Allergic to bees.
```

the phrase rendered it with the blank run collapsed. The profile in the prompt was no longer the
profile on disk.

That would have been cosmetic, except for what read it next. The redaction list — the strings
withheld from an inference log that is **never pruned** — was built by searching the finished text
for the original profile:

```ts
if (profile && text.includes(profile)) redact.push(profile);
```

The search failed. `redact` came back empty. The profile went to the log in full, permanently.

## The two errors, and they are different

**A transformation was applied at a scope it was not designed for.** Collapsing blank runs is
meaningful between sections and meaningless inside one line — there is nothing to separate. At the
smaller scope the rule had no job except to reach into a substituted value and reshape it. The fix is
one flag: the whole-message renderer normalises, the phrase renderer does not.

**A secret was recovered by searching for it instead of being reported.** Even with the
normalisation fixed, `text.includes(profile)` is the wrong shape. The wording around `{profile}` is
user-editable; once the user owns it, nothing about the finished string is predictable, and a search
can only ever be a guess that happens to work today. The code that renders a sensitive value is the
only code that knows exactly what it rendered, so that is the code that must report it.

## The rules

- **When reusing a transformation at a new scope, list what it does and ask whether each part still
  earns its place.** Reuse is right; inheriting every behaviour with it is not. A parameter is
  cheaper than a second implementation and much cheaper than the bug.
- **Never recover a sensitive value by searching output for it.** Have the producer return it.
  Searching couples a security guarantee to string identity that any downstream transformation — or
  any user edit — can break silently, and "silently" is the whole problem: an empty redaction list
  looks exactly like a request that carried no secret.
- **Test the invariant, not the happy value.** The property is *whatever reaches the request is also
  on the withhold list*. A test using a one-line profile cannot see this class at all; the prior
  review fuzzed 400,000 templates and held the profile to a single clean line, so the defect was
  structurally invisible to it. Vary the **shape of the data**, not just the surrounding code.

## The same error inverted, 2026-09-06

The live subsystem had the mirror image, and fixing it produced a third instance in the fix itself.

**A bound for the whole, spent across the parts.** A transition's *bridge* is a run of clips played
while the machine crosses between States, and `MAX_BRIDGE_MS` capped how long a crossing could hold
the machine. The cap was correct — nothing is evaluated while a bridge plays. It was applied by
spending one budget across the run's members:

```ts
let budget = MAX_BRIDGE_MS;                      // 30_000
for (const member of bridge.clips) {
  const ms = Math.min(this.durationOf(member), budget);
  budget -= ms;
  await this.wait(claimed, ms, true);
}
```

A bridge of three twelve-second clips played twelve, twelve, and then **six** — the author's last
clip cut in half, and nothing said so. Measured on real timers: 30.0s with the third clip halved,
against 36.0s with every member whole. Where earlier members exhaust the budget outright, the tail is
skipped entirely. The bound belonged to the crossing; charging it against each member in turn made it
a rule about the parts.

**Then the fix asserted a part-bound over the whole.** Removing the clamp left `MAX_CLIP_MS` — one
hour, applied per clip — as what still bounds a runaway duration. The doc comment written at the same
time said:

> Since a crossing stopped being clamped to `MAX_BRIDGE_MS`, this is also the only bound on how long
> a **bridge** can hold the machine.

It bounds a *member*. Nothing sums them, and a set may hold `MAX_CLIPS_PER_SET` (200) of them, so the
reachable worst case is two hundred hours. A reviewer caught it; the author did not, having just spent
an hour fixing the mirror image of exactly that confusion.

**What generalises.** Both directions have the same shape and the same tell: a quantity is defined at
one scope and *used* at another, with nothing at the boundary marking the change. Ask of every bound,
budget, timeout, quota and cap: **is this per item or per collection, and does every reader agree?**
A budget decremented in a loop has silently become per-collection; a constant named for one item and
described as covering the run has silently become per-collection in the prose only.

The doc comment is the part that bites later. A wrong bound is a bug someone eventually measures; a
wrong claim about a bound is believed for years.

## The rules, extended

- **Say which scope a bound belongs to, in its name or its comment, and state the reachable worst
  case rather than the per-item number.** "One hour per member, and nothing sums them" is the honest
  form of what was written as "an hour".
- **A budget carried across a loop is a design decision, not an implementation detail.** If the
  members are somebody's authored work, spending a shared budget across them silently shortens it.
  Bound the collection by refusing or reporting it, not by truncating the last element.

## Related

- `docs/solutions/a-sweep-that-varies-one-input-cannot-see-the-other.md` — the sibling: varying the
  wrong dimension
- `docs/solutions/assert-the-effect-not-the-existence.md`
- `docs/solutions/a-comment-is-a-claim-and-nothing-runs-it.md` — why the wrong claim outlives the
  wrong bound
- `docs/residual-review-findings/feat-editable-prompt-templates.md`
- `docs/residual-review-findings/fix-bridge-plays-whole.md`
