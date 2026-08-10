# Residuals — editable prompt templates (phase one)

Accepted differences and agreed follow-ups from
`docs/plans/2026-08-09-003-feat-editable-prompt-templates-plan.md`. Read before changing
`shared/src/templates.ts`, the shipped default templates in `shared/src/prompts.ts`, or any
of the four render call sites.

## Accepted, with the reasoning

**One case does not reproduce the old assembly, and it is named in a test.** Given a sight
budget smaller than the 45-character heading, the previous implementation failed to add the
heading, dropped every face for the same reason, and then found room for the "8 others in
view" notice — emitting a parenthetical about a list it had never introduced. The heading is
literal text inside a block now, so it lives and dies with the block, and the section is
simply absent. Unreachable through any Context Level: the smallest share of the smallest
window this project supports is around 400 characters. Covered by *the one deliberate
difference* in `server/test/chat/context-template-parity.test.ts`.

**The rendered message is trimmed, and runs of blank lines in it collapse to one.** That is
what lets a dropped section take its separators with it. It also means a slot value carrying
three consecutive newlines comes out with two, and a prompt with trailing whitespace loses
it. Prompts here are paragraphs, so this has no practical effect — but it is a property of
the renderer rather than an accident, and a template whose *content* genuinely needs three
blank lines cannot have them.

**Vision's budget counts content, not separators; the session's counts both.** The two
conventions are in the code this replaced, and harmonising them would move the point at
which a crowded frame or a long feed starts being truncated — which is a change to what HAL
says, arriving disguised as a tidy-up. Both are pinned by the parity sweeps. The one visible
consequence is that the sight section can exceed its stated budget by one character per
line, exactly as it always could.

**The identity hedge is reachable from a template.** `{vision_faces}` renders the banded
form, but the wording around it is the user's, so "Confirmed present:" typed above it
reframes an attributed match as certain without touching the hedge. This matches the stance
`CONCEPTS.md` already takes — the prompt is the user's text, guardrails included — and the
editor carries a standing note rather than a restriction. The output-side check
(`enforceIdentityBands`) is unaffected and still runs on what the model produced.

**Client-side validation is not the gate.** `TemplateField` refuses to send an invalid
template, but a protocol client can still write one; the server stores whatever arrives. The
renderer tolerates it — a stored template always renders (R8) — so the failure mode is a
degraded message rather than a failed send. Server-side rejection on `update-settings` is
the follow-up below.

## Follow-ups, agreed and not started

- **Server-side validation of a stored template.** Today the parity between what the editor
  refuses and what the server accepts rests on both sides calling the same shared function,
  and only one of them does. A protocol client can store a template with an unclosed block.
- **The Captioner's system template.** The role exposes only a user template because the
  captioner takes one message carrying the question and the image together. If the Captioner
  ever grows a system-message path, `TEMPLATE_ROLES` needs a `captioner-system` and the role
  table's asymmetry note goes.
- **A preview against live readings.** Deferred deliberately — see the plan's Open
  Questions. The fixed sample is in `ui/src/templatePreview.ts`.
- **`sessionContextSection` and `visionContextSection` are test-only oracles now.** Nothing
  in the server calls them. They survive so the parity suite has something to compare
  against, and they go when phase two lands.

## Phase two, not started

Migrating the six prompt settings into their templates (origin R23–R28), retiring the
reference slots (R39), and templating the per-Conversation system prompt. Nothing in phase
one is irreversible, which was the point of splitting it.

Two things phase two must not forget, both recorded in the origin's Outstanding Questions:
braces inside a stored prompt have to be escaped during migration or the migrated template
cannot render, and a Conversation copy frozen under an older slot vocabulary needs a rule.
