---
date: 2026-08-10
type: fix
status: active
---

# fix: Every string that reaches a model has an editor

## Summary

`AGENTS.md` claims "there is no human-chosen wording left reaching a model
without an editor". It is false: the Vision cycle's caption line is assembled in
code. Find every instance, cover the ones that are wording, record the boundary
for the ones that are formatting, and replace the claim with a test.

---

## Problem Frame

The template work extended the catalogue thoroughly and never audited it. A user
asked why `{vision_faces}` could not be used in the Vision prompt; the honest
answer was that identity already reaches the summariser through a caption-line
prefix — which turned out to be built in `server/src/vision/service.ts:1165`,
with no editor anywhere.

One known instance is not the finding. The finding is that nobody had enumerated
what reaches a model, so the count is unknown. A first sweep turned up the
caption line, a second `join(" and ")` at `service.ts:795`, and a set of date,
clock and duration formats whose status is genuinely undecided.

See `docs/solutions/extending-a-catalogue-is-not-auditing-it.md`.

---

## Key Technical Decisions

**Enumerate the domain, not the catalogue.** Start from "what strings reach a
model" and check each against the Phrase list. Auditing the Phrase list cannot
find an absence.

**The shipped text is what the code emits today.** Every phrase added here ships
with the exact string currently produced, so the oracle stays green and no
install hears anything different until its owner edits it.

**Wording and formatting are different, and the line gets written down.**
Otherwise the next audit draws it somewhere else.

---

## Implementation Units

### U1. Inventory what reaches a model

**Goal.** A list, in the plan or a doc, of every string reaching a model and
whether it has an editor.

**Files.** `server/src/vision/service.ts`, `server/src/narration/narrator.ts`,
`server/src/monitors/narrator.ts`, `shared/src/prompts.ts`,
`server/src/templates/*`.

**Approach.** Grep the message-building paths for string construction — template
literals, `join(`, bracket wrappers — and trace each to whether it is a Phrase, a
Template, or neither. Known starting points: `service.ts:1165` (caption line),
`service.ts:795` (the same joiner for the timeline), `narrator.ts:291` (session
label format), `prompts.ts:397-403` (relative age), `:423` (clock), `:807`
(date). The list is the deliverable; do not fix while surveying.

**Verification.** Every entry is classified. The count of unclassified is zero.

### U2. Cover the Vision caption line

**Goal.** The one confirmed gap, closed.

**Requirements.** Byte-identical output.

**Dependencies.** U1.

**Files.** `shared/src/phrases.ts`, `server/src/vision/service.ts`,
`server/test/templates/` (a new case).

**Approach.** `sight.caption_line` with fields `names` and `caption`, shipped as
`[{names}] {caption}`. `sight.identity_join` for the ` and `, used at both sites,
because two copies is how they drift. Carry the note the vision-user slot already
records — timestamps and ordinals were both tried and both became the subject of
the summary — since that reasoning has never reached a surface a user can read.

**Test scenarios.** Shipped phrases reproduce today's line exactly, for one name,
two names and none. An edited phrase changes the line. The identity band is
unaffected by the wording. The oracle's snapshots are unchanged.

### U3. Write down where wording ends and formatting begins

**Goal.** A recorded boundary, so the next audit does not redraw it.

**Dependencies.** U1.

**Files.** `AGENTS.md`, `CONCEPTS.md` (the Phrase entry).

**Approach.** State the test in one sentence. Working proposal: a Phrase covers
anything a reader could reasonably reword; a format renders a value and has one
correct shape. `relativeAge`'s singular/plural sits on the line and should be
named explicitly whichever way it goes.

**Test expectation: none — documentation.**

### U4. Replace the claim with a test

**Goal.** The guide stops asserting completeness in prose.

**Dependencies.** U2, U3.

**Files.** `server/test/templates/` (new), `AGENTS.md`.

**Approach.** A test that enumerates the message-building surface and asserts
each entry is a Phrase, a Template slot, or on the recorded formatting list. It
will need a registry the test can read rather than a grep; deciding that shape is
the unit's real work. Then reword `AGENTS.md` to point at the test.

**Test scenarios.** Adding a hardcoded line to a render path fails the test.
Adding a Phrase for it passes.

---

## Scope Boundaries

- No wording changes. Every shipped string stays exactly what it is today; this
  is about who can edit it, not what it says.
- The language gains nothing. Phrases already exist for this job.

---

## Risks

- **U4 may not be cheap.** A completeness test needs something enumerable, and
  the surface is currently spread across four files. If it turns into a large
  refactor, U1–U3 still stand on their own and U4 can be reconsidered — but say
  so rather than quietly weakening the test.
- **The oracle is the guard.** Any phrase whose shipped text is not byte-exact
  will show there. Do not re-record it.
