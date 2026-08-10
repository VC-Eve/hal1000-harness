---
date: 2026-08-09
topic: editable-prompt-templates
---

# Editable prompt templates

## Summary

Every message HAL sends a model becomes a template the user owns. Named slots pull live
readings into the text; conditional blocks drop the surrounding wording when a slot has
nothing to fill it. Placement stops being a decision in code and becomes wherever the slot
is typed. Each template resets to what shipped, or to a baseline the user saved.

Delivered in two phases. Phase one templates what has no editor today — the chat context
block, the narration, Monitor and Vision user messages, and the Captioner's question — and
references the six existing prompt settings from its defaults rather than absorbing them.
Phase two merges those six and retires the references.

## Problem Frame

`CONCEPTS.md` states the product's position: a System Prompt "is the user's text, not the
product's: it can be edited freely, including the parts that keep narration honest." Six
strings honour that. The rest of what reaches a model does not.

Nothing that HAL sends as a **user** message is editable at all. Narration sends
`Session activity:\n…\n\nNarrate this activity now.` A Monitor sends one of three framings
chosen by reason. Vision sends a sensitivity instruction and `Frames from the last period:`.
None of these appears in settings.

Nor is the chat context block, which is the larger surface. `shared/src/prompts.ts` builds
roughly a dozen sentences per request — `Who I can see, read live just now at 18:22:04:`,
`I am watching, and no face I can place is in view; that is not the same as nobody being
there.`, `You know Creator, whose machine this is:` — and the settings panel shows a sample
of the result under the heading `what else gets added`, marked as something to look at
rather than edit.

The comment at `ui/src/components/SettingsPanel.tsx:375` justifies that: "there is nothing
here a user could edit that would not immediately be overwritten by the next check." That
is true of the readings and false of the frames around them. `Who I can see, read live just
now at {clock}:` is a fixed sentence with one live slot. The clock is overwritten every
request; the sentence never changes and no one can reach it.

The cost is two-sided. Text the user cannot read is text they did not consent to, in a
product whose stated posture is that prompts belong to them. And tuning stops at the
boundary: this repo has measured prompt wording changing output quality repeatedly — a
caption prompt whose prohibitions produced 4 refusals in 10 frames, a vision prompt that
grew to ten competing rules until the model narrated the rules, a qualifier the model
escalated into an invented prohibition it then obeyed against its own data.

Those three were fixed by editing prompt text, and this feature reaches them. Three others
in the same record were not: timestamps removed from the rendered lines, ordinal labels
removed from them, and rougher quantities asked of the Captioner upstream. The lesson doc
ranks that class first for reliability — stop supplying the thing rather than write a rule
against it — and this feature deliberately does not reach it, because a rendered line
arrives through a slot as one opaque block. What the templates open is the wording; how the
readings themselves are shaped stays in code.

## Key Decisions

**Templates replace assembly, rather than sitting beside it.** The alternative was exposing
each hidden string as its own settings field. That reaches the text but not the
arrangement, and the user's ask named placement explicitly. A template makes order fall out
for free: a slot renders where it is typed.

**Conditional blocks over an auto-prune heuristic.** When a slot resolves empty, something
has to decide the fate of the wording around it. A renderer that silently drops lines whose
slots came back empty needs no new syntax, but it is a hidden rule inside a feature whose
purpose is removing hidden rules. An explicit block wrapper puts the decision in the user's
own text. The cost is a control structure in the language and a malformed-block failure
mode that needs validation.

**Slot arguments select; Context Level still clamps.** A count like `[5]` says which
readings to take. It does not say how much room they get — that stays the share of the
model's window that Context Level already computes, because installed models span 2k to
262k tokens and one fixed count cannot mean the same thing on both. Both bounds apply and
the smaller wins, so a slot asking for 50 remarks on a 2k model still fits.

**A stored `null` keeps meaning "never edited."** The existing convention — `null` resolves
to the shipped default at read time, so an improved default arrives on its own — carries to
templates unchanged. Rendering a shipped default template must reproduce today's output
exactly, or every existing install silently changes what HAL says on upgrade.

**The six existing prompt settings become templates rather than being referenced by them.**
One concept, not two. The narration prompt stops being its own setting and becomes the body
of the narration system template. The alternative — keeping them as settings a default
template pulls in through a slot — needs no migration, but leaves two places to look for
"the prompt" and a shipped default template that is a single slot and nothing else. The cost
is a one-way migration over text the user wrote, which R23 constrains.

**Unknown slots are rejected, never rendered empty.** A misspelled `{data_vison}` that
resolves to nothing is the hidden-behaviour problem returning by a side door: the template
looks right and the request quietly loses a section.

**Phase one templates only what has no editor today.** The transparency win comes entirely
from the chat context block and the four un-editable user messages; the six existing prompt
settings are already reachable. So phase one leaves them where they are and references each
from its default template through a slot, and phase two merges them and retires the slots.
That keeps the one irreversible step — a migration over text the user wrote — out of the
release that introduces a brand-new renderer. The end state is still one concept; it arrives
second rather than first, and the cost until it does is two places to look for a prompt.

**Composition stays in the renderers; the template places the results.** A template says
where things go and what words surround them. It does not decide how a list makes room for
its own truncation notice, how surviving sections are separated, or whether a preamble
appears when everything beneath it came back empty. Those are byte-level behaviours of the
current assembly that a language of slots and single-slot conditionals cannot express, and
adding expressions to reach them would trade the whole simplicity argument away. Keeping
them inside slot renderers is what lets R16 and the no-expressions boundary both hold.

**The baseline state revisits a decision made three days earlier.**
`docs/brainstorms/2026-08-06-editable-system-prompts-requirements.md` settled on two states
— shipped default and edited — reasoning that on a single-user machine reset-to-default is
the undo. That reasoning still holds for a prompt. It stops holding once an edit can span an
entire assembled message: reset then discards a whole message structure to recover from one
bad sentence. The third state is the narrower undo that change makes necessary, and it is
what the user asked for.

**Ordering guidance ships as the default, not as a lock.** Session context precedes sight
because sight-first was measured making HAL answer "what can you see" from narration while
a caption describing the room sat below it (`server/src/chat.ts:368-374`). Once placement
is the user's, nothing re-enforces that. The shipped default keeps the order and the field
says why.

## Requirements

**Template language**

R1. A template is text containing literal characters, slots, and conditional blocks.

R2. A slot names one live reading and renders where it is typed. Syntax is a brace-wrapped
name; `{clock}` is a slot.

R3. A slot may take an argument selecting how many items it draws, written
`{session_remarks[5]}`. Omitting the argument takes the role's default count.

R4. A conditional block wraps text that is dropped entirely when the named slot resolves
empty. The wrapped text may include the slot itself, literal text, and other slots.

R5. Literal brace characters are expressible without being read as a slot.

R6. A template referencing a slot that does not exist for its role is rejected when applied,
naming the unknown slot and listing the valid ones for that role. A misspelling is never
accepted and then rendered as empty. R35 governs the one case where a stored template comes
to hold a name the vocabulary no longer has.

R7. An unclosed or mismatched conditional block is rejected when applied, with the position
of the offending block.

R8. Rejection is at apply time, not at send time. A stored template is always renderable.

R29. Text the code selects by the value of a setting is exposed as one slot per value, each
resolving empty when that value is not in force. A Monitor's three reason framings and
Vision's four sensitivity instructions are reachable through conditional blocks this way,
without equality tests entering the language.

R30. Each template editor lists its role's valid slots, with a one-line meaning for each,
before any apply attempt. R6's rejection message is a backstop, not the way the vocabulary
is learned.

R31. A template editor shows the rendered result alongside the template, with dropped
conditional blocks marked as dropped. Seeing the assembled message is the goal this feature
exists for; a template with unresolved slots does not satisfy it.

R33. Section joining, preamble omission and truncation give-back are performed by slot
renderers rather than expressed in template syntax. A template places a rendered result and
surrounds it with words; it does not compose one.

R35. A renamed slot is rewritten in every stored template at upgrade. A withdrawn slot
renders empty, and every editor holding a template that references it marks that template
degraded and names the dead slot until it is removed. R8's guarantee holds — the template
still renders — and R6's purpose holds too, because the emptiness is announced rather than
silent.

R36. The editor for a slot that renders an identity carries a standing note saying the
reading may be uncertain and that wording around the slot can assert more than the reading
supports. Nothing in the syntax is forbidden: the hedge is the user's text like everything
else, and the output-side band check still runs on what the model produces.

**Coverage**

R9. Every message HAL sends a model is template-driven: the system and user messages for
chat, narration, Monitors and the Vision cycle summary, and the Captioner's question.

R10. Each role exposes a system template and a user template, so a role can be collapsed
into one message or kept as two.

R11. Slot vocabulary is per role. A role exposes only slots that have a meaning in it.

R12. The chat context slots cover what `visionContextSection` and `sessionContextSection`
assemble today: the current clock time, the watched session's label, its remarks with
timestamps, the live face list with identity and duration and run strength, the camera-off
and no-face-in-view states, the newest caption with its age, and the character profiles the
Identity Band unlocked. A truncation notice is not among them: it belongs to the slot whose
rendering was cut, per R21.

R13. The narration slots cover the session's rendered log lines and its label. The Monitor
slots cover the monitor's label, its rendered lines, and which of the three reasons fired.
The Vision slots cover the rendered caption lines, the sensitivity instruction, the silence
sentinel, and the profile section.

R14. Templates are readable and writable over the WS protocol, and the shipped defaults are
carried in the settings broadcast, so a protocol-only client can read what HAL sends and
reproduce a reset.

**Defaults and rollback**

R15. A stored template of `null` means never edited and resolves to the shipped default at
render time.

R16. Rendering a shipped default template produces byte-identical output to what the
equivalent hardcoded assembly produces today, given the same readings.

R17. Each template offers reset to the shipped default.

R18. Each template offers saving the current text as a user baseline, and reverting to that
baseline. A saved baseline is independent of the shipped default and survives upgrade.

R19. A template's editor states which of the three states it is in: shipped default, user
baseline, or edited beyond baseline.

R37. When a release changes a shipped default template, every install holding an edited
version of it is told. The editor marks that template behind, shows the new default against
the user's text as a diff, and offers taking the new default whole or keeping the current
text. There is no merge: taking the new default replaces the edit, which is what the baseline
in R18 exists to make safe.

R32. Each shipped default template carries a note stating what its wording protects and
which measured failure produced it, delivered over the protocol alongside the default. The
phrasing in these templates is the outcome of measurement recorded in `docs/solutions/`, and
a frame exposed for editing with its reasoning stripped makes reintroducing a known failure
the easy path.

**Migration from the existing prompt settings — phase two**

The six settings: the narration prompt, the default conversation prompt, the observation
context preamble, the Monitor prompt, the Vision summariser prompt, and the Vision caption
prompt.

R38. In phase one these six stay as they are. Each shipped default template references its
prompt through a slot, so editing the prompt continues to work exactly as it does today,
including presets, reset, and the `null`-tracks-shipped-defaults convention.

R39. Phase two merges them into their templates and retires the six slots. R23 to R28 apply
to that release, not to phase one, and nothing in phase one is irreversible.

R23. A stored prompt that the user edited is carried into the corresponding template
verbatim, in the position the shipped default template puts it. No stored text is discarded
or reworded. Brace characters in it are escaped to their literal form during migration, so
the rendered output matches the stored prompt character for character and the migrated
template cannot fail validation on syntax the user never wrote.

R24. A stored prompt of `null` migrates to a template of `null`, so an install that never
edited a prompt continues tracking shipped defaults after the migration.

R25. Blankness is a property of the rendered result, not of the template text. A system
template sends no message when its whole render is empty; a template whose body is blank but
whose profile or context slot resolves still sends what it resolves. Blanking the Vision
prompt means "say nothing of your own about how to narrate", never "forget who these people
are".

R26. The narration presets seed the whole system template rather than a prompt field inside
it. Applying a preset replaces the template body and leaves other roles untouched.

R27. A new Conversation copies the chat system template as template text, not as rendered
output. The copy is still frozen at creation, so editing the default never rewrites a thread
already under way, and the slots inside the copy still resolve live at each send. It carries
role-general slots only; the R12 context slots are valid solely in the global context
template and rejected under R6 elsewhere, so context reaches a request once, through the
path that budgets it and builds its redaction list. The context preamble belongs to that
global template rather than to the per-Conversation copy, which is what keeps an edit to it
reaching threads already under way.

R28. Selecting a preset over a template the user edited beyond a preset or a default warns
before overwriting, since a preset now replaces more text than it did.

**Budgets and safety**

R20. A slot argument selects items; a character budget still bounds what renders, and where
both apply the smaller wins. The budget is charged against the whole rendered message,
literal template text and line separators included — a long heading spends the same
allowance a remark does. Chat budgets per source: vision slots against the vision Context
Level share, session slots against the session share. A source set to `off` makes its slots
resolve empty, so the conditional block around them drops.

R21. A slot whose rendering was truncated emits its own "what was dropped" notice as part of
that rendering, giving back lines to make room for the notice the way the current assembly
does. The guarantee belongs to the slot, so deleting text from a template cannot produce a
silent truncation.

R34. A slot that renders a Character Profile registers the exact text it rendered on the
request's redaction list. The list is an output of rendering rather than a substring scan
over the result, so a profile that was truncated, or separated by text the user typed, is
still withheld from the inference log — which is never pruned, and would otherwise outlive
deleting the person it describes.

R22. Off-Machine Acknowledgement decides whether the context renders at all for a role, not
merely whether identity slots resolve. When the gate is closed for the backend a send
resolves to, every context slot in that role renders empty — session remarks and the
preamble included — matching the single early return the current assembly makes. Gating
per slot would start carrying commentary off-machine that today never leaves it.

## Acceptance Examples

AE1. **Covers R4, R12.** Vision is off and a session is watched. A template reading
`{#vision_faces}Who I can see at {clock}:\n{vision_faces}{/}\n{#session_remarks}What I have
been saying about {session_label}:\n{session_remarks}{/}` renders only the session block.
The vision heading does not appear.

AE2. **Covers R6.** Applying a chat template containing `{data_vison}` is rejected. The
error names `data_vison` and lists the chat role's slots. The previously stored template is
unchanged and the next send uses it.

AE3. **Covers R16.** With every template at `null` on an install that has narration, a
Monitor and Vision configured, the messages sent to each backend are identical to those the
previous release sent for the same readings.

AE4. **Covers R3, R20.** A chat template asks for `{session_remarks[50]}` on a model with a
2k window at a Context Level permitting eight remarks. Eight render, followed by the
truncation notice.

AE5. **Covers R18, R19.** The user edits the narration template, saves it as a baseline,
edits again, then reverts. The text returns to the saved baseline rather than to the shipped
default, and the editor reports "user baseline."

AE6. **Covers R23, R24.** An install has an edited Vision caption prompt and every other
prompt untouched. After migration the Captioner template holds the edited text verbatim and
every other template is `null`. A later release improving the narration default reaches this
install; the caption prompt is unchanged.

AE7. **Covers R22.** The chat backend is remote and the acknowledgement has not been given.
Every context slot renders empty: the vision block drops, the session block drops, and the
preamble is absent. The request carries the Conversation's own system prompt and nothing
else — the same message the current assembly produces.

AE8. **Covers R34.** A user moves the profile slot to the top of their chat context template
and wraps it in their own wording. A profile renders. The request's redaction list contains
that profile's exact text, and the inference log records the request with it withheld.

AE9. **Covers R23, R5.** An install has a conversation prompt containing `Reply as {"tone":
"dry"}`. After migration the template renders that text character for character, and neither
`{"tone"` nor the closing brace is read as a slot or rejected as unknown.

AE10. **Covers R25.** An install blanked its Vision prompt while two people carry Character
Profiles. After migration the Vision cycle still sends a system message containing the
profile section, exactly as it does today.

## Scope Boundaries

- `enforceIdentityBands` stays outside the template system. It rewrites what the model
  produced, so it is a check on output rather than a prompt.
- Off-Machine Acknowledgement gating stays in code, per R22.
- No loops, arithmetic, or general expressions. Slots and conditional blocks only.
- Line rendering stays code-owned: whether a log line carries a timestamp or an ordinal, how
  a caption line is composed, and what the Captioner is asked to produce upstream. Changing
  what the code supplies is the repair this project has found most reliable, and it is
  deliberately not template-controlled — a template receives a rendered line, not its parts.
- No per-Conversation *context* template. A Conversation keeps its own system template copy
  per R27; the context block's template is one global setting.
- The Identity Band thresholds, Context Level shares and Vision Sensitivity remain
  settings-level controls rather than template syntax.

## Dependencies / Assumptions

- Assumes the four Deferred-roadmap CLI-subprocess providers stay deferred. An agent surface
  with no messages array would not consume templates in this shape.
- Assumes the settings broadcast can carry the shipped default templates without a size
  concern; it already carries `PROMPT_CATALOG`.
- Assumes a template rejected at apply time is an acceptable failure mode for an agent
  client, which must read the error rather than assume success.

## Outstanding Questions

**Deferred to planning**

- How a position-in-text validation error surfaces in a textarea — cursor jump, inline
  highlight, or an explicit line and column in the message.
- Whether phase two's migration is destructive or leaves the six settings readable for one
  release as a rollback path.
- How a Conversation copy frozen under an older slot vocabulary is treated by R35 — rewritten
  in place like a settings-level template, or left alone.
- Whether the preview required by R31 renders against real current readings or a fixed
  sample.
- Whether validation runs client-side, server-side, or both.
- Whether a template that inverts the measured session-before-sight order warns, or the
  ordering stays purely advisory.
- How the Captioner's template coexists with the image payload in its message, given it has
  no system-message path today.

## Sources

- `shared/src/prompts.ts` — the assembly functions and every hardcoded frame
- `server/src/chat.ts:342-416` — context assembly, ordering, and the redaction list
- `server/src/narration/narrator.ts:485-490`, `server/src/monitors/narrator.ts:194-217`,
  `server/src/vision/service.ts:1084-1180` — the user messages that have no editor
- `ui/src/components/SettingsPanel.tsx:375-390` — the sample block and its rationale
- `docs/solutions/an-instruction-that-fights-its-own-input-loses.md` — the three measured
  prompt failures the shipped defaults encode
- `CONCEPTS.md` — System Prompt, Conversation Context, Context Level, Identity Band,
  Off-Machine Acknowledgement
