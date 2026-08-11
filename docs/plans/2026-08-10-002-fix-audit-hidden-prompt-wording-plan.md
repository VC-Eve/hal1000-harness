---
date: 2026-08-10
type: fix
status: completed
---

# fix: Every string that reaches a model has an editor

## Summary

`AGENTS.md` claimed "there is no human-chosen wording left reaching a model
without an editor". The survey below found five instances that have none. Cover
them as Phrases with byte-identical shipped text, record where wording ends and
formatting begins, and replace the prose claim with a test.

---

## Problem Frame

A user asked why `{vision_faces}` could not be used in the Vision prompt. The
honest answer was that identity already reaches the summariser through a
caption-line prefix — which turned out to be built in code, with no editor.

The survey that followed found four more. The most consequential is not the
caption line: `shared`'s narration prompt contains a glossary explaining that
each log line is tagged `[user]`, `[assistant]`, `[thinking]`, `[tool-result]`,
and that `(tools: Name(target))` lists what the agent invoked. That glossary is
editable. **The format it describes is not.** Edit the explanation and the tags
do not move; change the tags and the explanation is silently wrong. Only one
half of a documented contract is reachable.

See `docs/solutions/extending-a-catalogue-is-not-auditing-it.md` for why this
survived every review: extending a catalogue pulls attention onto the entries
that exist, and auditing the catalogue cannot find an absence.

---

## The survey

Done 2026-08-10, so the units below are sized rather than exploratory.

**Already covered.** Nine role Templates; the six settings-level prompts; the
slot renderers, which reach Phrases through 19 `renderPhrase` call sites
(`sight.*`, `session.*`, `monitor.*`, `people.*`).

**Wording with no editor — five instances.**

| # | Where | What |
|---|---|---|
| 1 | `server/src/narration/coalescer.ts:14-17` | `` `[${kind}] ${text}${tools}` `` and `` ` (tools: ${joined})` ``, joined by `, ` |
| 2 | `server/src/monitors/narrator.ts:258` | `[severe] ` prefix, `` `${source}: ` `` separator |
| 3 | `server/src/vision/service.ts:1165` | `` `[${names}] ${caption}` `` |
| 4 | `server/src/vision/service.ts:795` and `:1165` | `.join(" and ")`, twice |
| 5 | `server/src/narration/narrator.ts:291` | `` `${adapterLabel} [${id.slice(0,8)}]` `` — the session label, which renders through `{session_label}` |

**Formatting, boundary undecided.** `relativeAge` (`prompts.ts:397-403`,
including the singular/plural), `clockTime` (`:423`), `dateStamp` (`:807`).
`VISION_SILENCE_TOKEN` is a sentinel the vision-user template already names via
`{silence_token}`, so it is reachable and out of scope.

---

## Key Technical Decisions

**Shipped text is exactly what the code emits today.** Every Phrase added here
reproduces the current string, so the oracle stays green and no install hears
anything different until its owner edits it. A phrase whose shipped text is not
byte-exact will show in `server/test/templates/oracle.test.ts` — do not
re-record it.

**Instance 1 first, because it is a contract and not just a line.** The
narration prompt documents that format. Covering it makes both halves editable
by the same person in the same place; leaving it makes the guide's own example
a thing that can go stale.

**A joiner used twice is one Phrase.** Two copies is how they drift.

**The boundary gets written down, not just applied.** Otherwise the next audit
redraws it somewhere else.

---

## Implementation Units

### U1. The narration log-line format

**Goal.** The tags and tool annotation the narration prompt describes become
editable.

**Files.** `shared/src/phrases.ts`, `server/src/narration/coalescer.ts`,
`server/test/narration/` (new case).

**Approach.** `narration.event_line` with fields `kind`, `text`, `tools`,
shipped `[{kind}] {text}{tools}`; `narration.tool_list` with `tools`, shipped
` (tools: {tools})`; `narration.tool_join` for the `, `. Carry a note saying the
narration prompt's glossary describes this format, so an editor of one is told
about the other.

**Test scenarios.** Shipped phrases reproduce today's line exactly — with tools,
without tools, and for each event kind. An edited phrase changes the line. The
narration user message is otherwise unchanged.

### U2. The Vision caption line and the identity joiner

**Goal.** The confirmed gap, closed.

**Dependencies.** U1 (establishes the phrase-note convention).

**Files.** `shared/src/phrases.ts`, `server/src/vision/service.ts`,
`server/test/templates/`.

**Approach.** `sight.caption_line` with `names` and `caption`, shipped
`[{names}] {caption}`. `sight.identity_join` for the ` and `, used at both
`:795` and `:1165`. Carry the note the vision-user slot already records —
timestamps and ordinals were both tried and both became the subject of the
summary — which has never reached a surface a user can read.

**Test scenarios.** One name, two names, none. Consent withheld renders the
caption alone, as today. The identity band is unaffected by the wording.

### U3. The Monitor line prefix

**Goal.** `[severe] ` and the source separator become editable.

**Dependencies.** U1.

**Files.** `shared/src/phrases.ts`, `server/src/monitors/narrator.ts`,
`server/test/monitors/`.

**Approach.** `monitor.event_line` with `severity_marker`, `source`, `text`.
Note that severity is judged without the model, so the marker is a report and
not an instruction.

**Test scenarios.** Severe and routine, with and without a stated source. The
budget arithmetic in `render()` still measures the rendered line.

### U4. The session label, and the boundary

**Goal.** Decide whether the label is wording or an identifier, and write the
rule down either way.

**Dependencies.** U1–U3.

**Files.** `server/src/narration/narrator.ts` and `shared/src/phrases.ts` if it
is wording; `AGENTS.md` and `CONCEPTS.md` regardless.

**Approach.** `Claude Code [a408c0a1]` is a name a model reads and a key the
session block filters on — it is plausibly both. Decide, and state the general
test in one sentence. Working proposal: a Phrase covers anything a reader could
reasonably reword; a format renders a value and has one correct shape.
`relativeAge`'s singular/plural sits on the line and should be named explicitly
whichever way it falls.

**Test expectation: none — documentation, unless the label becomes a Phrase.**

### U5. Replace the claim with a test

**Goal.** The guide stops asserting completeness in prose.

**Dependencies.** U4.

**Files.** `server/test/templates/` (new), `AGENTS.md`.

**Approach.** A test that enumerates the message-building surface and asserts
each entry is a Template slot, a Phrase, or on the recorded formatting list.
Deciding what makes that surface enumerable is the unit's real work — a grep in
a test is brittle, so prefer a registry the render sites feed. Then reword
`AGENTS.md` to point at the test rather than repeat the claim.

**Test scenarios.** A hardcoded line added to a render path fails the test.
Adding a Phrase for it passes.

---

## Scope Boundaries

- **No wording changes.** Every shipped string stays exactly what it says today.
  This is about who can edit it.
- The language gains nothing. Phrases already exist for this job.
- Date, clock and duration formats are not converted in U1–U3; U4 decides them.

---

## Risks

- **U5 may not be cheap.** A completeness test needs something enumerable and
  the surface spans four files. If it becomes a large refactor, U1–U4 stand on
  their own — say so out loud rather than quietly weakening the test.
- **The oracle is the guard for all of U1–U3.** Byte-identical is checkable;
  check it rather than assuming, and do not re-record.
- **`eventLine` is on the narration hot path.** A phrase render per log line is
  more work than a template literal. Measure before assuming it does not matter.
