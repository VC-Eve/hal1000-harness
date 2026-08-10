---
date: 2026-08-10
topic: prompt-template-standardization
---

# One template language for every editable prompt

## Summary

Every editable prompt in HAL becomes a Template in the same language, drawing on three tiers of
vocabulary: universal readings every prompt gets for free, role readings scoped to what that
message can meaningfully see, and phrase fields inside a single line. The six prompts still
edited as plain text become Templates. `{context}` decomposes into the individual readings
behind it, so a Conversation prompt places sight, session and Monitor material itself — or
restates any of it alongside the whole block. Delivered in two stages: the conversions and the
universal tier first, the decomposition and the merged render second.

## Problem Frame

The language shipped, and then stopped halfway. Nine roles are Templates with slot
vocabularies, validation, preview and a syntax sheet. Six prompts are still plain textareas
whose braces are literal, injected into a Template through a slot as `String(prompt)`.

The seam shows most clearly in chat. A Conversation's own prompt is a Template with three
names — `{context}`, `{clock}`, `{date}` — but the **default conversation prompt in settings
that seeds it** is a plain textarea. The same text is two different languages depending on
which screen it was opened from.

Three names is also the whole vocabulary a Conversation prompt has. Readings that exist and
work — who was recognised lately, with a count; the most recent room description, quoted and
dated — are reachable only from the conversation-context Template. A user writing a
Conversation prompt cannot place them, cannot restate them, and cannot tell from the editor
that they exist.

That shortness was deliberate. `shared/src/templates.ts:274` records why: exposing
`{vision_faces}` in a Conversation prompt would render the same readings twice, and the
second copy would arrive outside the path that budgets against Context Level, applies the
Off-Machine Acknowledgement, and registers Character Profile text for redaction. The guard is
load-bearing. But it guards against *two renders with two ledgers*, not against repetition —
and merging the renders removes the hazard rather than tolerating it.

Discoverability alone would not justify this. The conversation-context Template is already
editable and already owns the order and wording of the block, so a link to it from the
Conversation editor would answer "I cannot tell these exist". What no editor change reaches is
that the context Template is one global setting while a Conversation prompt is per thread. A
thread that wants the caption at the top and the rest beneath cannot have it without changing
every other thread. That is what requires the merge.

The universal readings are asymmetric for no recorded reason at all. `{clock}` and `{date}`
exist in `conversation-system` and `chat-context`. The other seven roles all run on a timer
and none of them can say what time it is.

## Key Decisions

**Decompose to individual readings, not to three blocks.** The chat-context slots already
carry a budget `source` of `vision`, `session` or `monitor` — the three Observation Sources,
each with its own Context Level — which offers a tempting three-piece decomposition. It is
too coarse. Reaching `{vision_recent_people[3]}` from a Conversation prompt is the stated
requirement, and a `{context_sight}` block does not deliver it.

**Merge the two renders into one pass with one ledger.** This is what makes decomposition
safe rather than a weakening of the guard. Within a pass the engine already resolves a slot
once, charges it once per budget source, and adds its redaction strings once. Two passes are
what produced two ledgers and the unguarded second route; one pass produces neither.

**Allow repetition rather than refusing it.** `{context}` and any individual reading may
appear together. Restating a reading at the same count draws it once, charges it once, and
registers its redaction strings once, rendering wherever it is typed. An alternative design
refused the combination with a validation error; it was rejected because the ledger already
makes the combination correct, and a rule that forbids a safe thing is a hidden rule in a
language whose argument is that it has none.

Two limits keep that from being a hole. Naming the same reading at two different counts is two
readings, because the count is part of what was asked for and the engine cannot answer both from
one draw. And what a repetition costs in *budget* is nothing, but what it costs in *window* is
real — so the render bounds the observation characters it emits even though it charges them
once. Context Level apportions between sources; it also has to keep observations from crowding
out the conversation, and those are two jobs.

**A fourth vocabulary tier, above the roles.** Universal readings are cheap, carry no identity,
and carry no budget source of their own, so nothing about a role decides whether they are
appropriate. They are not free — one placed inside a budgeted section charges that section, the
way `{clock}` charges the sight heading today — but what they cost belongs to where they sit
rather than to what they are. Making them a tier rather than nine copied entries is what makes
adding the next one a single registration.

**`{context}` is a named group the renderer can drop whole.** Inline expansion cannot reproduce
what happens today, which is discarding the entire context render when no observation reading
emitted. Merged inline there is no render to discard, and the engine's only drop unit is a
conditional block. The group is that same drop applied to a named expansion rather than a new
construct, so the language still gains nothing.

**Delivered in two stages.** Stage one converts the six prompts and adds the universal tier,
and touches no ledger: it ends the two-languages seam, which is the friction met daily, without
going near the guard. Stage two decomposes `{context}` and merges the renders. Sequencing them
this way puts most of the value in reach before the riskiest change is attempted, and means a
defect in the merge does not hold back a conversion that had nothing to do with it.

**The language does not grow.** No loops, no arithmetic, no comparisons. Composition — joining
surviving sections, giving back lines to make room for a truncation notice — stays inside slot
renderers, exactly as `templates.ts` argues.

### The render, before and after

```
BEFORE — two passes, two ledgers

  conversation-system render          chat-context render
  ┌───────────────────────┐           ┌────────────────────────────┐
  │ user's prompt text    │           │ {context_preamble}         │
  │ {context} ────────────┼──────────▶│ {vision_faces}             │
  │ {clock} {date}        │  inert    │ {vision_recent_people[N]}  │
  └───────────────────────┘  text     │ {session_remarks[N]} …     │
                                      └────────────────────────────┘
        vocabulary: 3 names             budgets: vision/session/monitor
                                        redaction: registered here
                                        consent: applied here

AFTER — one pass, one ledger

  ┌──────────────────────────────────────────────────────────┐
  │ user's prompt text                                        │
  │ {vision_recent_people[3]}   ← placed directly             │
  │ {context}                   ← still the whole block       │
  │ {vision_caption}            ← restated; billed once       │
  └──────────────────────────────────────────────────────────┘
     one budget ledger · one redaction list · one consent check
```

## Requirements

**One language everywhere**

R1. Every editable prompt in the app is a Template, edited through the Template editor, with
a slot list, validation on apply, live preview and access to the syntax sheet.

R2. The six prompts currently edited as plain text become Templates: the narration prompt,
the Monitor prompt, the Vision prompt, the caption prompt, the default conversation prompt,
and the observation context preamble.

R3. A prompt that is rendered into another Template's slot renders first, and its output
enters the outer slot as inert text. Slot results are never re-parsed, so nothing a user
writes in an inner prompt can be read as syntax by the outer one.

R3a. R3's inner-render composition applies only to prompts whose vocabulary contains no
budgeted or identity-bearing reading. The observation context preamble is expanded inside the
merged pass rather than rendered separately, and its vocabulary is the universal tier alone — so
no template that can name an Observation Source reading ever gets a ledger of its own.

R4. Redaction strings produced by an inner prompt's render reach the outer render's redaction
list. A Character Profile rendered from a Conversation prompt is withheld from the inference
log on the same terms as one rendered from the context block.

R5. Braces in a prompt stored before it became a Template are read literally. Saving through
the editor escapes them and converts that prompt to a Template. Nothing is migrated without
the user saving.

R5a. Each of the six converted prompts gains its own stored is-template marker, mirroring the
one a Conversation carries. Applying a preset or a reset sets that marker to template, because
the shipped text is authored as a Template.

R5b. A Conversation seeded from a default conversation prompt that is a Template is created as
a Template, so the seeded copy renders in the same language as the setting it came from.

**Universal vocabulary**

R6. A universal tier of slots is available in every role without being listed per role.
Membership is limited to readings that carry no identity, carry no budget source of their own,
and mean something in every message HAL sends. A universal reading placed inside a budgeted
section still charges that section, exactly as `{clock}` charges the sight and session headings
today.

R7. The tier launches with: `{clock}`, `{date}`, `{model}` (the model this message is
addressed to), and `{backend}` (which Backend it resolves to). A reading joins the tier when
something asks for it; R8 is what makes that a one-line addition rather than an argument for
launching wide.

R7b. The tier carries readings, not policy. `{off_machine}` was considered and left out: a
prompt that branches on whether a send leaves the machine is a prompt being invited to write a
prohibition, and this project has measured prohibitions becoming the model's subject. The
Off-Machine Acknowledgement acts on the readings themselves under R19a, where nothing has to be
said about it.

R7a. `{clock}` and `{date}` exist in the universal tier alone once it ships, and are removed
from the role vocabularies that carry them today, so no slot list shows the same name under two
headings.

R8. Adding a universal reading is one registration and reaches every role, with no per-role
edit.

R9. A universal slot resolves consistently across roles. `{model}` in the captioner prompt
names the Captioner, not the chat model, because it names the model the message is going to.

R9a. Every render is given one send description — the model, the Backend, whether this send
leaves the machine — from which a single shared resolver answers the whole universal tier. A
new universal reading is registered once and read once, rather than wired into each role's own
resolver.

**Reaching the readings from a Conversation prompt**

R10. The `conversation-system` vocabulary gains the individual chat-context readings, so a
Conversation prompt can place any of them where it wants. This is every chat-context reading —
sight, session and Monitor alike, `{vision_profiles}`, `{vision_off}` and `{vision_nobody}`
included. R15–R18 name only the readings whose own behaviour changes; the rest become
reachable unchanged.

R11. `{context}` is retained and means the whole observation block, in the
conversation-context Template's own order and wording.

R11a. The block is appended beneath a prompt that omits `{context}`, as it is today, only when
no observation reading was named anywhere in that prompt. A prompt that places readings
individually gets exactly what it placed.

R12. `{context}` and individual readings may be used together. A reading named more than once
at the same count is resolved once, charged once against its Context Level, and contributes its
redaction strings once — and renders at each place it is named. The same reading named at two
different counts is two readings: separately resolved and separately charged.

R12a. The merged render tracks characters actually emitted per source, separately from the
charge ledger. The total rendered observation text is bounded by the sum of the three Context
Levels: a repeated reading is resolved and charged once, but the words it renders each time
count against that bound.

R13. The conversation prompt and the observation context render in one pass sharing one
budget ledger, one redaction list, and one Off-Machine Acknowledgement check.

R13a. Every live reading in the merged pass is taken from one instant captured when the render
begins. A resolution repeated after a conditional block rolled back cannot disagree with the
first about what time it is or what the camera last saw.

R14. `{context}` renders as a named group the renderer can drop as a unit. Whether the
observation block is sent is decided from the observation readings that reached the output
inside that group. Readings the Conversation prompt placed elsewhere do not keep the group
alive, and a Conversation prompt's own words never count as observations.

**Vision granularity**

R15. `{vision_recent_people[N]}` is reachable from a Conversation prompt. `[1]` is the most
recently recognised face alone.

R16. `{vision_caption}` is reachable from a Conversation prompt, quoted and dated as it is
today.

R17. `{vision_caption[N]}` renders the N most recent room descriptions, newest first, each
quoted and dated. It reads the Vision Timeline, which already persists every caption.

R18. `{vision_faces}` accepts a count, bounding how many of the people currently in view are
listed.

R18a. The merged pass parses both templates before any reading is fetched, takes the largest
count named for each counted reading, and fetches that many. The slot resolver is synchronous
and cannot read the Vision Timeline itself, so what a template asks for has to be known before
the render starts.

R19. Every observation reading reachable from a Conversation prompt passes the Identity Band,
the Character Profile band gate, and the Off-Machine Acknowledgement on the same terms as it
does from the context block. Reachability changes where a reading may be placed, never what
may be said about a person.

R19a. When the Off-Machine Acknowledgement is withheld for the endpoint this send resolves to,
every observation reading in the merged pass resolves empty — session and Monitor as well as
sight — and does so without being consulted. The gate prevents the read, not merely the
wording, which is what it does today by returning before any source is touched.

**Not changing the output**

R20. The shipped defaults render byte-identically to what they render today. The shipped
conversation-context Template is rewritten to compose the decomposed readings and produces the
same block it produces now. The default conversation prompt stays blank, and a blank prompt
still sends no system message of its own.

R21. The current rendered output of every role is recorded as a fixture before any of this
work begins, and the byte-identity claim is checked against that recording rather than against
a reimplementation. The oracle covers the rendered text and the redaction, emitted, degraded
and dropped lists, captured across a swept range of vision, session and Monitor budgets rather
than at one size — a charging change is invisible in the text at every budget except the one
where truncation begins.

R22. Every existing slot keeps its name, its budget source, its meaning and its note. Count
behaviour changes only where R17 and R18 add one, and a slot written without a count renders
exactly what it renders today.

**Editor surface**

R23. Each editor's slot list distinguishes universal readings from that role's own, and
sub-groups a role's own readings by the Observation Source they draw from, so the list mirrors
the structure the vocabulary already has.

R24. Every slot new to a role carries the meaning and the note the existing vocabulary
carries, including what its wording is protecting where a measured failure produced it.

R24a. R23 and R24 apply to the chat-side Conversation prompt editor as well as the Settings
editors. Its slot presentation is brought up to the Settings format — visible meaning, the note
reachable, the tiers distinguished — rather than staying a row of chips whose meanings appear
only on hover. It is the surface this work exists for.

R25. The syntax sheet describes the vocabulary tiers. The four syntax rules are unchanged and
stay four.

R25a. The conversation-system preview fixture decomposes its sample `{context}` text into the
same substrings the standalone readings use, so a reading named twice visibly repeats in the
preview. The one place a user goes to check that repetition worked has to be able to show it.

## Acceptance Examples

AE1. **Covers R12, R13.** A Conversation prompt reads
`{vision_caption}\n\n{context}`, and the observation context Template also names
`{vision_caption}`. The caption text appears twice in the sent message. Context Level for the
vision source is charged for it once.

AE2. **Covers R14.** A Conversation prompt has words of its own, the camera is off, the
Watched Session is clear, and Monitor context is off. No observation block is sent. The
prompt's own words are sent unchanged.

AE3. **Covers R5.** A Conversation prompt written before this work contains
`Reply as {"tone": "dry"}`. It renders literally. The user opens it in the editor and saves;
the stored text becomes `Reply as {{"tone": "dry"}}` and renders identically.

AE4. **Covers R4.** A Conversation prompt names `{vision_profiles}` directly. A profile
renders into the message and its exact text is withheld from the inference log.

AE5. **Covers R17.** `{vision_caption[3]}` with two captions on record renders both, newest
first, and says nothing about a third.

AE6. **Covers R9.** The caption prompt contains `{model}`. It renders the Captioner's model,
not the chat model.

AE7. **Covers R19.** Someone in view is in the attributed band. A Conversation prompt naming
`{vision_faces}` renders "someone who looks like Alice 55%", and `{vision_profiles}` renders
nothing for them.

AE8. **Covers R19a.** The chat Backend is remote and the Off-Machine Acknowledgement has not
been given. A Conversation prompt names `{session_remarks}` directly. Nothing observational is
sent, the camera and the Gallery are not consulted, and the prompt's own words go out unchanged.

AE9. **Covers R12.** A Conversation prompt names `{vision_recent_people[1]}` and the
conversation-context Template names `{vision_recent_people[3]}`. Both render. The vision Context
Level is charged twice, and the render charges them in the order they are reached, so the second
one is the one the budget truncates.

## Scope Boundaries

- The language gains no expressions — no loops, comparisons or arithmetic. Composition stays
  in slot renderers.
- The phrase layer keeps its per-phrase field sets and is not restructured. Universal slots
  are a Template tier, not a phrase tier.
- Conversion rewrites braces at save time and at no other time. The editor shows the escaping
  before it is applied and displays the escaped form afterwards, so the change to the user's own
  text is never silent.
- Presets and reset behaviour for the six converted prompts are unchanged.

## Dependencies / Assumptions

- The Vision Timeline persists captions and is scannable backward from the tail, which
  `newestCaption()` in `server/src/vision/timeline.ts` already does for the single most recent
  one. R17 needs no new storage. The constraint it does carry is the synchronous slot resolver,
  which is what R18a answers: the count has to be known before the fetch, and the fetch before
  the render.
- `recentlySeen` already reaches the context render as a list, newest first, so R15 is
  reachability rather than new plumbing.
- The engine's existing memo and per-source charging are assumed correct and are what R12
  rests on. They are exercised today only within a single pass; R13 is what keeps that true.

## Outstanding Questions

**Deferred to planning**

- The observation context preamble resolves empty when nothing else in the context produced
  anything. R3a puts it inside the merged pass; the emptiness rule needs restating against the
  named group R14 now defines.
- Whether the Monitor and Vision system prompts gain their role's readings when they become
  Templates, or only the universal tier. Their current slot lists are one name each.

## Sources / Research

- `shared/src/templates.ts` — the language, the vocabulary, and the render ledger. The
  reasoning behind the three-name Conversation vocabulary is at line 274; the memo and
  per-source charging that R12 rests on are in `renderTemplate`.
- `server/src/templates/chatContext.ts` — the context render, its three budget sources, and
  the content check that R14 relocates.
- `server/src/templates/roleMessages.ts` — how the observation roles render, and the
  degraded-slot report.
- `server/src/vision/timeline.ts` — `newestCaption()`, the backward tail scan R17 extends.
- `ui/src/components/SettingsPanel.tsx` — the six `PromptField` uses that R2 converts.
- `docs/brainstorms/2026-08-09-editable-prompt-templates-requirements.md` — phase one, which
  shipped. Its phase two ("merges those six and retires the references") is R2 here.
- `docs/solutions/a-sweep-that-varies-one-input-cannot-see-the-other.md` — why R21 sweeps rather
  than samples, and why every budget source must be funded in one sweep. The fuller
  record-the-oracle-first argument behind R21 is currently a working note outside the repo and
  belongs in `docs/solutions/`.
- `docs/solutions/a-fix-teaches-a-pattern-go-looking-for-it.md` — R14's decision, written wrongly
  twice before. The verdict reads the render's emitted list; a flag set inside a resolver is the
  forbidden implementation.
- `docs/solutions/a-rule-that-is-right-for-the-whole-is-wrong-for-the-part.md` — the basis for R4
  being producer-reports rather than outer-searches.
- `docs/residual-review-findings/feat-editable-prompt-templates.md` — required reading before
  changing the engine or any render call site.
