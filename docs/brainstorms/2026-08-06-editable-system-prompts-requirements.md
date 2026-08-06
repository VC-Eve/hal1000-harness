---
date: 2026-08-06
topic: editable-system-prompts
---

# Editable system prompts

## Summary

Make the system prompt HAL sends a thing the user owns rather than a string in source. Narration
gets one editable prompt for all observation; each Conversation gets its own, seeded from a global
default when it is created. Persona Intensity retires into three presets that seed the narration
prompt.

## Problem Frame

HAL sends two very different things today, and neither is visible.

Narration sends a system prompt built by `personaPrompt()` in `server/src/narration/narrator.ts`.
It fuses three concerns into one hardcoded string: HAL's voice, the tag glossary that teaches the
model what `[thinking]` and `[tool-result]` mean, and the honesty rules that forbid inventing
activity. The only exposed control is a three-way Persona Intensity switch that swaps the final
sentence. Changing anything else means editing source and restarting.

Chat sends no system prompt at all. `server/src/chat.ts` maps the stored messages straight to the
provider, so chat HAL is whatever the underlying model is. The v1 requirements committed in R11 to
making settings a user is expected to vary editable in the app; the prompt was never one of them.

The user has not yet hit friction tuning the narration voice — nothing has been edited or worked
around. The pressure is ownership and visibility, not an iteration loop that hurts today.

## Key Decisions

**The whole narration prompt is editable, guardrails included.** The glossary and the honesty
rules are editable text like everything else, and deleting them is permitted. This is a
single-user tool on the user's own machine; reset-to-default is the undo. The alternative — a
locked core with only a voice layer editable — would preserve the `CONCEPTS.md` invariant literally
but is the option least compatible with owning the prompt.

**Persona Intensity retires rather than layering over the editable prompt.** Once the prompt is one
editable string, an intensity switch either overwrites the user's text or silently appends to it,
and appending means the prompt shown is not the prompt sent. Retiring it keeps one prompt in one
place. The cost is real and accepted: a documented concept and a wire-contract field are deleted,
and the one-click tone switch becomes a one-click seed with an overwrite warning.

**Chat prompts are per-Conversation with a global default, copied at creation.** This mirrors how
`model` already works — `create(model)` in `server/src/storage/conversations.ts` stamps it onto the
record and `setModel` mutates it per thread. Copy-at-creation means an old conversation keeps the
prompt its replies were generated under, rather than having its context rewritten underneath it.

**The chat default ships empty.** Preserving today's behavior exactly is worth more than making
chat HAL in-character on upgrade without being asked. The feature is the editor; the user owns the
prompt, including owning that it is blank.

**Visibility means the prompt, not the request.** The editor shows what HAL is told. The assembled
`Session activity:` envelope — the coalesced event lines, their tool annotations, and the character
budget that drops events — stays invisible for now.

## Requirements

**Narration prompt**

- R1. The narration system prompt is editable in the app as one block of plain text holding the
  entire prompt, including the tag glossary and the honesty rules.
- R2. One narration prompt applies to all observation, whichever Adapter produced the events.
- R3. Three presets carrying the current low, medium, and high Persona Intensity wordings seed the
  narration prompt in one click.
- R4. Seeding a preset over a prompt the user has edited warns before overwriting.
- R5. Persona Intensity is removed as a setting — from the wire contract, the settings UI, and
  `CONCEPTS.md`.
- R6. An edited narration prompt applies to the next narration, and never rewrites entries already
  in the Narration Feed.

**Chat prompt**

- R7. Each Conversation owns a system prompt, editable from that Conversation.
- R8. A new Conversation copies the global default chat prompt at creation.
- R9. Editing the global default leaves existing Conversations untouched.
- R10. The shipped default chat prompt is empty.
- R11. When a Conversation's prompt is blank, the request omits the system message rather than
  sending one with empty content.

**Defaults, reset, and upgrades**

- R12. Every prompt can be reset to its shipped default.
- R13. A prompt the user has never edited follows the shipped default, including across an upgrade
  that changes that default.
- R14. A prompt the user has edited is never overwritten by an upgrade.

**Reach**

- R15. Both prompts are readable and writable through the WS protocol, not only the settings UI.

## Acceptance Examples

- AE1. **Covers R11.** Given a Conversation whose prompt is blank, when the user sends a message,
  the provider receives the message history with no system message of any kind.
- AE2. **Covers R4.** Given the user has edited the narration prompt, when they click a preset,
  they are warned that their text will be replaced and can decline.
- AE3. **Covers R4.** Given the narration prompt is untouched, when the user clicks a preset, it is
  seeded with no warning.
- AE4. **Covers R13, R14.** Given a release changes a shipped default, when HAL restarts, a prompt
  the user never edited reflects the new default and an edited prompt is unchanged.
- AE5. **Covers R9.** Given a Conversation created before the global default was last edited, when
  the user opens it, it still carries the prompt it was created with.
- AE6. **Covers R8, R10.** Given a fresh install, when the user creates a Conversation and sends a
  message, chat behaves exactly as it does today.
- AE7. **Covers R6.** Given narration is in flight, when the user saves a new narration prompt, the
  in-flight entry is unaffected and the following narration uses the new text.

Key Flows are omitted: the behavior is prompt editing plus Conversation creation, and the
conditional cases that would carry a flow are covered above.

## Scope Boundaries

- A view of the assembled request — system prompt plus the real `Session activity:` block and its
  event lines. This is what would answer "why did HAL say that," and it is the natural next step if
  narration debugging ever becomes the pressure.
- A live preview pane that streams requests while editing.
- Per-Adapter narration prompts.
- Saved prompt profiles, prompt history, or versioning.
- Any validation, warning, or enforcement about what the user writes, including deleting the
  honesty rules.

## Dependencies / Assumptions

- The value here is ownership and visibility. Faster voice iteration is an anticipated benefit, not
  an observed pain — no prompt has been tuned or worked around yet. If a prompt-tuning loop turns
  out to be the real need, the deferred assembled-request view is the item to revisit first.
- Deleting the tag glossary or the honesty rules is expected to degrade narration quality. That is
  the user's call to make and reset is the remedy; nothing guards against it.
- Retiring Persona Intensity is a breaking change to the wire contract. HAL is local and
  single-user with no external clients, so no compatibility shim is assumed.

## Outstanding Questions

**Deferred to planning**

- How "never edited" is represented so R13 and R14 can both hold — the shape that avoids comparing
  stored text against historical defaults.
- Whether the narration prompt lives beside the existing settings or gets its own surface, given a
  full prompt is much larger than any current setting.
- Where a Conversation's prompt is edited, and how that surface stays out of the way for the
  common case of never touching it.
- What the settings UI does with the space Persona Intensity vacates.

## Sources / Research

- `server/src/narration/narrator.ts` — `personaPrompt()` builds the narration system prompt; the
  narration request pairs it with the assembled `Session activity:` user message.
- `server/src/chat.ts` — chat generation maps stored messages to the provider with no system
  message.
- `server/src/storage/conversations.ts` — `create(model)` and `setModel`, the precedent for
  per-Conversation state with a global default.
- `shared/src/types.ts` — `Settings`, `SettingsPatch`, and `Conversation`; the wire contract R15
  extends and R5 removes a field from.
- `AGENTS.md` — the agent-native parity rule requiring meaningful behavior to be reachable through
  the protocol.
- `CONCEPTS.md` — the Persona Intensity entry that R5 removes, and the Conversation and Adapter
  entries this brief builds on.
- `docs/brainstorms/2026-08-02-hal-1000-harness-requirements.md` — R11, the commitment to make
  varying settings editable without touching code.
