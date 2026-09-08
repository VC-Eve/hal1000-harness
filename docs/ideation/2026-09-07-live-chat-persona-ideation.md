---
date: 2026-09-07
topic: live-chat-persona
focus: an LLM layer on /live that reads a livestream chat feed and speaks through the shipped TTS
mode: repo-grounded
---

# Ideation: a persona in-line with the chat

## Grounding Context

### Codebase context

The request is for an LLM layer on `/live` that ingests a YouTube or Twitch chat feed, reads it,
decides whether it has something to say, and if so speaks through the already-implemented
text-to-speech — so the World appears to have a character talking with its audience. The model is
reached over an OpenAI-compatible or ollama API; which server (OpenAI, ollama, vllm, llama.cpp,
unsloth) is the operator's choice.

Most of the machinery this describes already exists.

**Providers — `server/src/providers/`.** `ollama.ts` and `openai.ts` behind `factory.ts`;
`detect.ts` sniffs the protocol; `resolve.ts` exposes `backendForRole`, `endpointForRole`,
`numCtxFor`, so roles can be pointed at different backends. `queue.ts` is a single lane with
preemption — chat preempts narration, and the preempted call surfaces as `ProviderError` with
`code === "aborted"`, treated as scheduling rather than failure. vllm, llama.cpp and unsloth all
speak the OpenAI shape, so "call an OpenAI-or-similar API" is already answered.

**Monitors — `server/src/monitors/`.** Structurally the closest thing to a chat feed already in the
repo: poll a source, buffer events, one summariser call per cycle turns them into a feed entry or
into nothing. `MonitorSource = MonitorFileSource | MonitorCommandSource` — only two kinds.
`DEFAULT_CYCLE_MS = 300_000` ("five minutes is ambient; a minute is chatter"),
`MIN_INTERRUPT_GAP_MS = 60_000`, `PENDING_CAP = 500` with its drop count reported rather than
hidden, `LINE_WINDOW = 500` for permanent dedupe, per-Monitor `MonitorSeverityRule`. A cycle with
no new events produces no entry at all — "an all-clear on a timer is noise." A source that cannot
be read reports a `problem` in persona and is retried; never terminal.

**Voice — `server/src/voice/` — shipped.** Kokoro on a resident worker via `onnxruntime-node`.
`SpeakMessage { type, text, voice }` is accepted from **any admitted socket including one that
declared `observe`** — the audio election decides who makes the noise, never who may speak. A
`generation` counter supersedes the line in flight; `report-speech-sentence` comes from the
sounding *client* because a server timer would already be ahead by fetch/decode/start latency.
Text is split into sentences and synthesised per sentence. A subtitle is an overlay `SOURCES`
entry, not a layer — a World with no `speech` slot never puts a spoken word on its projector.

**Prompt and phrase layer — `shared/src/prompts.ts`, `shared/src/phrases.ts`.** Per-role prompt
defaults, a slot system that assembles context per request, `PHRASE_GROUPS =
["sight","session","monitor","narration","people"]`, `VISION_SILENCE_TOKEN = "(nothing)"`, and
`contextBudgetChars(level, windowTokens)` expressing a context level as a share of the model's
window because installed models span 2k to 262k tokens.

**A disposition dial already exists.** `VISION_SENSITIVITIES = ["always","high","medium","low"]` —
"How readily the summariser speaks… Where that line sits is taste, so it is a dial rather than a
rule."

**Live — `server/src/live/`.** `transport.ts` (playback clock, audio authority election needing a
user gesture), `runtime.ts` (States, Parameters, conditioned transitions). Overlay slots already
declare *When* they are drawn and how their text is treated.

### The explicit invitation

`docs/brainstorms/2026-09-06-live-character-speech-requirements.md`, Scope Boundaries, Deferred:

> HAL speaking on his own initiative — narration, monitor findings or chat replies routed to the
> voice. The protocol message this feature adds is what makes that possible later.
> The World machine reacting to speech, such as a `speaking` Parameter a State could transition on.

Also deferred there: moving audio from `/live` to `/broadcast`, with the standing constraint that
"anything capturing the broadcast surface must also capture system audio, or the audience will read
subtitles under silence."

### The blocking dependency

The feature as literally specified is dead on an unattended machine, for two documented reasons.
`Sounding` is a precondition — `server/src/voice/service.ts` refuses with "Nothing is listening, so
nothing would be heard" — so a `/live` tab nobody clicked cannot speak at all. And
`docs/spikes/2026-09-04-attendance-silences-unattended-playback.md` is a live, reproduced, unfixed
defect: a browser *merely opening* on an unattended sounding World moves attendance `none` →
`silent`, and the next `begin()` sets `sounding = false` — "the clock stops… and nobody clicked
anything." Both reproductions fail today and are kept as a spike because committing them would
leave the suite red. Anything autonomous on `/live` inherits this.

### Past learnings that bind this work

- **`an-instruction-that-fights-its-own-input-loses.md`** — six measured recurrences, three
  self-inflicted while citing the lesson. Prohibitions become the output. The measured fix was
  *removing the timestamps from the input*, not strengthening the rule.
- **`the-window-is-a-property-of-the-destination-not-of-the-role.md`** — ollama sizes the KV cache
  when the runner starts; `num_ctx=8192` warm at `load_ms 192` became `load_ms 3159` after a
  4096 request. It does not reuse a larger runner for a smaller request. A new role registers with
  `contextCapFor`; it does not invent a second window constant.
- **`a-lane-is-a-property-of-the-machine-not-of-the-app.md`** — `contends()` was wired to the
  preemption decision but not the serialization one. "A half-wired distinction reads as coverage."
- **`docs/residual-review-findings/feat-live-character-speech.md`** — `speak` has no rate limit and
  the file says why that is safe *only today*: "Build a per-socket minimum interval the day
  something untrusted can connect." Supersede is a dequeue, not a queue. Rendered lines are not
  archived.
- **`terminating-a-worker-during-a-native-call-aborts-the-process.md`** (critical) — terminating a
  worker during `session.run()` killed the process with `0xC0000409`, no exit event. Kokoro's
  510-token cap is what makes synthesis safe *because it bounds by input, not by a clock*.
- **`suppressing-an-evaluation-is-half-of-deferring-it.md`** — "A hold has an exit, and the exit is
  where the deferred work happens. Clearing the flag is not the exit."
- **The model-facing-string guard**, `server/test/templates/surface.test.ts` — "There is
  deliberately no `wording` category: a string that tells a model something gets a Phrase or the
  test stays red."
- **`assert-the-effect-not-the-existence.md`** — a test that the decision-LLM was *called* proves
  nothing about whether the character spoke.

### External context

- **YouTube** `liveChatMessages.list` needs OAuth and bills against a shared 10,000-unit/day project
  quota. The response carries `pollingIntervalMillis`, set by the server and *shrunk on busy chats*;
  honouring it is contractual. The per-call unit cost is not published in current docs and must be
  measured at build time. Google recommends push-based `streamList` over polling.
- **Twitch** is migrating chat reading from IRC to EventSub (`channel.chat.message`); reading is
  effectively unthrottled but needs an app token and the channel's chat scope. The harsh limits are
  on sending. Automated access must go through the sanctioned bot path, not scraping.
- **Neuro-sama** (Vedal, Dec 2022–) is the reference implementation: a separate **"Filter AI"**
  layer that replaces disallowed output with the literal word *"Filtered"* rather than silently
  refusing. Took a **two-week Twitch ban in Jan 2023** under Hateful Conduct; enforcement did not
  distinguish AI intent from human intent. The only hard consequence datum in this space.
- **kimjammer/Neuro** (OSS recreation) gates generation in `prompter.py` on live signals — human
  talking, AI thinking, new chat messages, time since last message — an explicit state machine, not
  an LLM decision per message. **Open-LLM-VTuber** and **yf591/AITuber-Projects** are the closest
  active stacks; none publishes a rigorous reply-selection algorithm.
- **Cascade / triage inference** is the literature for the selection problem: a documented four-tier
  waterfall routes ~97.5% of traffic through cheap tiers at ~1.5% of naive cost. Salience prediction
  research (arXiv 2404.10917) finds instruction-tuned models only moderately good at self-judging
  relevance.
- **Prompt injection from chat is first-class and unsolved.** Mitigation is structural: chat text
  never in the system-prompt channel, treated as data and never as directives at prompt-construction
  time, with output filtering.
- **The radio call-screener** is the strongest cross-domain match: high-volume input, one scarce
  output slot, an *editorial* rather than correctness criterion.

## Topic Axes

1. `chat-ingest` — how the feed arrives, what a message is, what breaks on a busy channel
2. `decision-to-speak` — silence as the default, cadence, what earns a reply, what is ignored
3. `persona-and-knowledge` — identity, the prompt/phrase layer, context assembled per turn
4. `world-reacting` — speech's effect on the surface: overlays, subtitles, States, ducking
5. `operator-unattended` — moderation, kill switch, backend choice, cost, review

## Ranked Ideas

### 1. The Audience is an observation role, not a chat client
**Description:** Add `MonitorStreamSource` as a third arm beside `MonitorFileSource |
MonitorCommandSource`, and register `audience` in `resolve.ts` alongside narration, monitor and
vision. Its product is a *feed entry*, not speech — speech is a downstream sink that can be left
unwired, so the feature ships useful before anything is audible. Buffering, `PENDING_CAP`-style
drop counts, in-persona `problem` reporting, never-terminal retry and `catalog.ts` suggestions with
a `requires` probe all come free.

Two things it cannot inherit, and naming them is the point:
- **Dedupe must invert.** `LINE_WINDOW = 500` never re-reports an identical line. On chat that
  deletes the loudest thing an audience does. Near-identical lines should collapse into one event
  carrying a count and a span (`"F" ×47 in 9s`), and the count is what makes it notable.
- **Cadence belongs to the platform.** `DEFAULT_CYCLE_MS = 300_000` is ambient-log tempo. YouTube
  dictates `pollingIntervalMillis` and shrinks it on busy chats against a shared daily quota, so
  burn rate is set by the audience. The operator needs a visible runway and a downshift ladder —
  running out mid-stream must degrade liveliness, never take the character off air.

**Axis:** `chat-ingest`
**Basis:** `direct:` `shared/src/types.ts:129` — `export type MonitorSource = MonitorFileSource |
MonitorCommandSource;`. CONCEPTS names exactly two Backends: chat ("someone is waiting") and
observation ("narration, Monitors and Vision — the three roles that run whether or not anybody is
watching"). Grounding on dedupe: "For chat that would silence a chant or a repeat — which may be
exactly the thing worth reacting to."
**Rationale:** Made once, this makes a Discord feed, a raid-alert stream or a second channel a
catalog entry rather than a subsystem. Made wrong, every future feed re-implements buffering,
capping, drop-reporting and failure persona. It also makes the risky half — a stranger's words
reaching a synthesised public voice — a separately shippable increment behind an already-reviewed
surface.
**Downsides:** Forces the lane question immediately: this role is observation-shaped by CONCEPTS'
definition but has an audience waiting, which is the chat Backend's defining property. That must be
decided explicitly and recorded, not settled by which queue the code pushes to.
**Confidence:** 90%
**Complexity:** Medium
**Status:** Explored — seeded the brainstorm of 2026-09-07

### 2. Never ask the model whether it has something to say
**Description:** The expensive model is asked *what*, never *whether*. A cheap deterministic
screener (addressed-to-persona, question rate, novelty against the recent window, repeat count,
per-source notability) selects a handful of candidates; a small state machine over live signals —
time since last utterance, a line currently sounding, freshness, attendance — opens a speaking slot;
only then is the model invoked, and its one abstention is a positive silence token in the shape of
`VISION_SILENCE_TOKEN = "(nothing)"`. Eagerness is exposed as `CHATTER_SENSITIVITIES` mirroring
`VISION_SENSITIVITIES = ["always","high","medium","low"]` — same vocabulary, same reasoning that
where the line sits is taste rather than a rule.

**Axis:** `decision-to-speak`
**Basis:** `direct:` `docs/solutions/an-instruction-that-fights-its-own-input-loses.md` — six
measured recurrences. The prompt said "do not remark on the timestamps or on the passage of time
itself" and the model replied "In frame 10:29:37 PM and in frame 10:29:51 PM there is no person…";
strengthening the rule changed nothing, removing the timestamps from the input fixed it. "Do you
have something worth saying?" is exactly that prohibition shape.
`external:` kimjammer/Neuro's `prompter.py` gates on explicit flags rather than an LLM call per
message; arXiv 2404.10917 finds instruction-tuned models only moderately good at self-judging
relevance; documented four-tier cascades route ~97.5% of traffic through cheap tiers at ~1.5% of
naive cost.
**Rationale:** The naive design spends a model call — on the single lane chat already preempts, at
risk of a 3.2-second runner reload — to decide *not* to speak, hundreds of times an hour. Moving the
gate into code makes silence free, makes cadence auditable, and makes the decision assertable at the
far side of the boundary, which a "was the model called" test cannot do. The screener is also the
reusable artifact: HAL narrating his own findings aloud later needs the same stage.
**Downsides:** Reframes the request's own words ("determines if it would have something to say") as
a code decision rather than a model one. Needs explicit assent.
**Confidence:** 88%
**Complexity:** Medium
**Status:** Explored — seeded the brainstorm of 2026-09-07

### 3. Speak to the room, not to a message — behind a declared lag
**Description:** The unit of input is a *window* of chat; the unit of output is a remark about the
window, never a quoted reply. No `@user`. Staleness is a property of the referent's lifetime rather
than the pipeline's speed: a named line lives seconds on a busy chat, the room's state lives
minutes. Borrowing décalage from simultaneous interpreting, the character considers a window that
**closed** `DECALAGE_MS` ago, so freshness is a comparison against a known offset instead of against
zero, and `window_close + inference + synthesis` becomes arithmetic measurable on the operator's
actual backend.

**Axis:** `decision-to-speak`
**Basis:** `direct:` the Monitor rule that "a cycle with no new events produces no entry at all — an
all-clear on a timer is noise", and `DEFAULT_CYCLE_MS`'s stated reasoning about cost per hour.
`external:` grounding measures the naive path speaking to a message 20–40s old; Gile's Effort Model
treats interpreter lag as deliberate resource management rather than latency.
`reasoned:` every other design in this space picks a message and then spends its life trying to be
fast enough. Choosing the longer-lived referent puts the unavoidable multi-second pipeline latency
inside the tolerance instead of outside it.
**Rationale:** Dissolves the staleness race rather than fighting it, largely dissolves the selection
problem because nothing has to be picked, and removes the addressable target that makes the
character read as a reply bot rather than a presence — which also removes most of the injection
surface.
**Downsides:** Directly contradicts the most literal reading of the request. Trades "@HAL, what's
your favourite film?" for a character that reads a crowd. Must be argued and either adopted or
explicitly rejected.
**Confidence:** 80%
**Complexity:** Low-Medium
**Status:** Unexplored

### 4. Cards in, exemplars out
**Description:** Both directions of the prompt boundary, structurally enforced. **In:** the cheap
tier does not score a message and pass it through — it *rewrites* it into a fixed-shape card
(`who`, `gist`, `angle`, `age_s`), the way a radio screener forwards a card and never the caller.
Raw viewer bytes never reach any tier that produces speech, and cards arrive through one named Slot
in the data channel, never the system channel. **Out:** a new `audience` entry in `PHRASE_GROUPS`
holds three or four sentences HAL has actually said, so the persona is specified by exemplars rather
than a paragraph of adjectives.

**Axis:** `persona-and-knowledge`
**Basis:** `direct:` the recorded Monitor residual — "Monitored log content enters the model prompt
verbatim, so a log line carrying prompt-injection text can steer narration. Bounded: output renders
as React text and drives no tool use" — and that bound evaporates when the output is a synthesised
voice on a public broadcast. `MAX_PROFILE_CHARS = 600` was set against a measured failure where a
longer prompt worked *worse*, a small local model narrating the rules back instead of describing the
room. `server/test/templates/surface.test.ts` fails any model-facing string that is not a Slot or a
Phrase — "there is deliberately no `wording` category" — so this is the only legal shape anyway.
`external:` structural instruction/data separation is the mitigation the injection literature
endorses; a better instruction is not.
**Rationale:** Injection cannot be patched later — it is a shape decision made when the prompt
scaffolding is first written. Making the quarantine a named Slot means the next untrusted source
inherits the separation instead of re-deriving it, and the surface test enforces it mechanically.
Exemplars sidestep the measured tendency of small local models to regurgitate rules, and give the
persona something that is the same in hour six as in hour one.
**Downsides:** A card costs one cheap call per batch, and a bad rewrite loses nuance the persona
might have used.
**Confidence:** 85%
**Complexity:** Medium
**Status:** Unexplored

### 5. An utterance has a lifecycle, and voicing it is one renderer
**Description:** Split the decision from the delivery. The pipeline produces an **Utterance** — text,
provenance, a length bound, and the timestamp of the newest message that motivated it — and
rendering is pluggable: the overlay `SOURCES` speech entry (subtitle only), Kokoro audio, or the
narration feed. Audio requires `Sounding`; a subtitle does not, so an unattended `/live` still has a
talking character — it just reads, which the `/broadcast` deferral already concedes.

Three lifecycle rules follow:
- **Queue, do not supersede.** `generation` is claimed before any await, so an autonomous speaker
  firing mid-line silently chops its own sentence. HAL ships the supersede half of turn-taking and
  none of the restraint half. Air-band radio discipline: listen before keying, and a blocked
  transmission is held and re-offered at unkey.
- **Expire, do not speak late.** A candidate whose window has moved on is dropped in the queue.
- **Bound by length, never by a timer.** Terminating during `session.run()` took the whole process
  down with `0xC0000409`, no exit event; Kokoro's 510-token cap is what makes synthesis safe because
  it bounds by input rather than by a clock.

Plus a `speaking` readout in the family of `idleReadouts()`, so States and overlay *When* conditions
can see the mic keyed.

**Axis:** `world-reacting`
**Basis:** `direct:` `docs/residual-review-findings/feat-live-character-speech.md` — "`Sounding` is
a precondition… a `speak` with nothing sounding is refused before the synthesis is spent" and
"Supersede is a dequeue, not a queue"; `docs/solutions/suppressing-an-evaluation-is-half-of-
deferring-it.md` — "A hold has an exit, and the exit is where the deferred work happens. Clearing
the flag is not the exit"; `docs/solutions/terminating-a-worker-during-a-native-call-aborts-the-
process.md`. The deferred invitation already names "a `speaking` Parameter a State could transition
on."
**Rationale:** Today the whole feature is dead on an unattended machine, which is precisely the
operating mode it is for. Splitting the renderer also isolates both live hazards — the supersede cut
and the attendance spike — to the audio path only, leaving the decision pipeline testable without
either.
**Downsides:** The biggest build of the seven, and it inherits the unfixed attendance spike, which
should land first.
**Confidence:** 87%
**Complexity:** Medium-High
**Status:** Explored — seeded the brainstorm of 2026-09-07

### 6. Audience Parameters — the World reacts before anyone speaks
**Description:** The cheap ingest tier writes scalars straight into the World runtime as Parameters
— message rate, novelty, dominant emote, a mood band — with no model call at all. Operators wire
States and overlay *When* conditions to them, so a chat surge visibly cuts to a different clip or
lights a slot. Speech becomes the rarest and most expensive tier of reaction rather than the only
one.

**Axis:** `world-reacting`
**Basis:** `direct:` `server/src/live/runtime.ts` is already a state machine of States, Parameters
and conditioned transitions, and overlay slots already declare which States and under what
conditions they are drawn. The deferred list asks for "a `speaking` Parameter a State could
transition on" — the same seam, generalised.
**Rationale:** Reframes "something to say" as "something to *do*", and is the only reaction path
that survives every constraint stacked against audio — no sounding client, no gestured tab,
`/broadcast` capturing video only. The World can be visibly alive to its audience in total silence.
**Downsides:** Speculative on operator appetite; nobody has asked for audience-driven Parameters.
Lowest-confidence survivor.
**Confidence:** 72%
**Complexity:** Low-Medium
**Status:** Unexplored

### 7. The operator's console: shadow mode, a delay line, and a dump
**Description:** Five controls that share one surface.
- **Shadow mode and an utterance ledger.** Every decision recorded — candidate batch, screener
  verdicts, model output or silence token, filter verdict, backend, latency, whether it actually
  sounded — running against a real channel *without speaking*. Reply-worthiness has no correct
  answer to unit-test against, so a recorded corpus from the operator's own audience is the only way
  to know the dial is set right. It also gives replay without re-synthesis.
- **A dump, nearly free.** Synthesis is already per-sentence and the sounding client already reports
  which sentence started. Holding sentence one gives a broadcast-style profanity delay; a dump kills
  every *unsounded* sentence and never touches a running `session.run()`.
- **The filter is a stage with a verdict**, with its own `backendForRole` entry so a small-local-
  model operator can point it somewhere stricter, and it *visibly substitutes* rather than silently
  refusing.
- **Consent that expires**, rail-alerter style: leaving stops the character, rather than requiring an
  operator who is not there to reach a switch. Pair with the per-socket minimum speak interval the
  residual file asked for.
- **The redaction boundary.** Cheap tiers always local; only a de-identified brief may cross to a
  cloud endpoint.

**Axis:** `operator-unattended`
**Basis:** `external:` Neuro-sama's separate Filter AI substitutes the literal word "Filtered"; it
took a two-week Twitch ban in Jan 2023 under Hateful Conduct, and enforcement did not distinguish AI
intent from human intent. `direct:` the residual finding that `speak` has no rate limit — "The bound
is emergent rather than enforced… Build a per-socket minimum interval the day something untrusted
can connect"; "Rendered lines are not archived — every speak re-synthesises";
`docs/solutions/assert-the-effect-not-the-existence.md`. `AGENTS.md` ruled cloud TTS outside the
feature's identity because "it sends the character's words to a third party… and breaks the
local-only property the rest of the harness holds to" — an asymmetry this request creates, since it
routes chat *and* the character's lines through a possibly-cloud LLM.
**Rationale:** The one documented real-world consequence in this space is a platform ban, and the
mitigation that survived it was a separate layer with a visible verdict, not a stronger system
prompt — which is also what this repo's own "a prohibition becomes the output" lesson predicts. A
character who occasionally says "filtered" is diagnosable; one who mysteriously goes quiet is not.
**Downsides:** Broad. Each control is individually small, but together they are a settings surface
and a storage format, and the redaction boundary is a product-identity decision of the same weight
as the cloud-TTS refusal.
**Confidence:** 90%
**Complexity:** Medium
**Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Pre-generate a bank of lines, speak by cheap pick | Interesting latency fix, but trades away responsiveness to the actual room — the thing the feature exists for; `reasoned:` only |
| 2 | Chorus refractory — phase-reset cadence instead of a cooldown floor | Genuinely novel control law, cheap to prototype offline against a captured log, but a variant *inside* idea 2 rather than a peer; revisit when tuning the dial |
| 3 | Persona as a per-World object | Real, but a packaging decision belonging to idea 4's brainstorm, not a separate direction |
| 4 | Per-viewer ledger, regulars remembered across a stream | Strong flavour, but opens a privacy and storage question disproportionate to a first cut; overlaps idea 4's surface |
| 5 | "Presence is the kill switch" — no explicit switch | Elegant, but rests entirely on the unfixed attendance spike; absorbed into idea 7's expiring consent, which degrades safely |
| 6 | Preflight "can this World carry a line" check | Good and small, but follows from idea 5 — an implementation detail, not a direction |
| 7 | Gate speaking on overlay *When* conditions | Duplicates idea 5's `speaking` readout from the other side; kept as a design option there |
| 8 | A separate chat subsystem beside Monitors | Rejected on the grounding's own evidence — duplicates six tested behaviours and coins synonyms for vocabulary CONCEPTS.md already defines |

No axis ended with zero survivors. `chat-ingest`, `persona-and-knowledge` and `operator-unattended`
carry one each; `decision-to-speak` and `world-reacting` carry two.
