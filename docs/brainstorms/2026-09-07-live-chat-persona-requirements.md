---
date: 2026-09-07
topic: live-chat-persona
---

# The character talks to her audience

## Summary

A World's character reads its livestream chat on YouTube and Twitch and answers out loud through
the voice that already ships. How she talks is governed by a **Regime** derived from how busy chat
actually is — she names a lone viewer when three people are typing and addresses the room when four
hundred are. The Regime is a World Parameter, so the World reacts to its own audience without a
model call. A rehearsal feed drives the whole pipeline from a scripted transcript, so her voice, her
judgement and the word filter are all proven before anything goes out live.

---

## Problem Frame

HAL can speak, but only when told to. `speak` is on the protocol, a voice preset renders the same
audio every time, and a subtitle rides the overlay layer onto `/broadcast`. What has never existed
is a reason for a line to be said — every word so far has been typed by the operator or sent by an
agent acting for them.

Meanwhile the surface has found its real use. `/broadcast` is being pointed at OBS on YouTube and
Twitch right now, with viewers arriving. The World plays, the music plays, and the character in the
picture is mute in front of an audience that is talking to her.

The audience is small today and may stay small. It may also not. Those two states are not two points
on one dial; they are opposite failure modes. With three messages in twenty minutes there is no room
to address — there is one person asking a direct question, and answering "the audience seems curious"
instead of answering *them* is the broken behaviour. With four hundred messages a minute a named
reply is invisible in the scroll and stale by the time the sentence finishes, `PENDING_CAP` overflows
inside a cycle, and YouTube shrinks its polling interval exactly when the quota can least afford it.
A design tuned for either end is wrong at the other.

The consequence of getting the words wrong is not a red test. Neuro-sama took a two-week Twitch ban
in January 2023 for output its operator never wrote, and enforcement did not distinguish AI intent
from human intent. The accounts carry whatever she says.

---

## Key Decisions

**The Audience is an observation role, and a chat feed is a third kind of Monitor source.** A
Monitor already polls an external source, buffers what it finds, and turns a cycle into one entry or
into nothing. Chat is that shape. Making it a third `MonitorSource` arm rather than a parallel
subsystem inherits the buffering, the reported drop count, the in-persona problem report on an
unreadable source and the never-terminal retry — and makes a second channel or a different platform
a catalogue entry rather than a new pipeline. The role registers alongside narration, monitor and
vision, so it derives its context window from its destination rather than naming its own.

**A chat feed cannot inherit two of the Monitor's rules.** A Monitor never re-reports a line
identical to one in its recent window; on chat that deletes the loudest thing an audience does.
Repetition is the signal here, so near-identical lines collapse into one event carrying a count and
a span. And a Monitor owns its own cycle length, where a chat feed is handed one: YouTube dictates a
polling interval and shrinks it under load, and the cadence must follow the platform rather than a
constant.

**Regime is a named thing, not a threshold buried in a scorer.** One word explains her behaviour at
any moment, and the same word appears on the operator's console, in the ledger, and as a World
Parameter. Because it is a Parameter, a World can cut to a different State when the room goes
viral — a reaction with no model in the path at all.

**She is asked what to say, never whether to speak.** Deciding whether a cycle earned a remark is a
prohibition-shaped question, and this project has measured six times that a prohibition becomes the
output. The gate is deterministic code over live signals; the model is invoked only once a slot is
open, and its one abstention is a positive silence token in the shape of `VISION_SILENCE_TOKEN`.

**The persona belongs to the World.** A World carries its character — name, character sheet, voice
preset — the way it already carries clips and overlay slots. This answers a question the speech
brief left open ("whether a World can name a default voice"), and it buys the safety property by the
rule already in force: a World with no `speech` slot never puts a spoken word on its projector, and a
World with no character never speaks to chat at all. Silence is a property of the arrangement rather
than a flag someone must remember to clear.

**Regime supplies an addressing rule, not a second personality.** The character sheet stays one
sheet, bounded the way a Character Profile is bounded — measured against a failure where a longer
prompt made a small local model narrate the rules back instead of describing the room.

**Raw viewer text never reaches the model that speaks.** The cheap tier rewrites each candidate into
a fixed-shape card and the persona sees only cards, in the data channel. This is the structural form
of the injection defence rather than an instruction asking the model to be careful, which is the
lever measured failing here repeatedly. The existing Monitor residual bounded injection by noting
that narration "renders as React text and drives no tool use"; that bound does not survive a
synthesised voice on a public broadcast.

**The filter is a stage with a verdict, and there is no hold.** A separate check stands between
generation and synthesis with its own backend, so a stricter model can gate a persona running on a
small local one. It produces pass or blocked-with-reason, and a blocked line is visibly substituted
rather than silently vanishing. **Accepted trade:** nothing waits. She stays as live as the pipeline
allows, and a line the filter passes that the operator would not have is already out. A delay line
was considered and declined for the liveness it costs.

**An utterance is bounded by length and never by a terminating timer.** Terminating a worker during
a native synthesis call took the whole process down with no exit event; what makes synthesis safe
today is that it is bounded by its input. Autonomous lines inherit that discipline.

**The cheap work stays on the machine; only a card may leave it.** Reading the feed, carding it,
measuring the Regime and screening candidates resolve to a local backend and nothing else. A finished
card may reach a cloud endpoint, carrying a stable handle rather than the viewer's display name. This
keeps the operator's backend freedom for the one role that most wants a capable model, without
extending to viewers a decision they were never asked to make — the same principle that ruled cloud
text-to-speech out, applied to people who are not the operator.

**Rehearsal drives the real pipeline.** A scripted feed enters as a source like any other, so the
screener, the Regime detector, the filter and the synthesis under rehearsal are the ones that ship.
A rehearsal that bypassed any of them would prove a code path that never runs live.

---

## Requirements

**Ingest**

- R1. A chat feed is a third kind of Monitor source, alongside a file and a command, and reaches the
  feed through the same buffering and reporting.
- R2. YouTube and Twitch are both supported from the first version.
- R3. The read cadence follows the platform's own instruction where the platform states one, rather
  than a cycle length HAL chose.
- R4. Near-identical messages arriving close together collapse into one event carrying a count and
  the span they arrived over, and the count is available to the screener as a signal.
- R5. A message that cannot be read, an expired credential, or a feed that has stopped is reported
  in persona and retried, and never ends the run.
- R6. The operator can see what the feed is costing against any quota the platform meters, and what
  remains at the current burn.
- R7. When a metered quota is running out, the ingest degrades through stated steps rather than
  stopping — the character becomes less lively, never absent.
- R8. What the ingest discards under load is counted and reported, not dropped silently.

**Regime**

- R9. Regime is a named band derived from two measures together: how fast messages arrive, and how
  many separate people are typing. Four bands ship: quiet, conversational, busy, viral.
- R9a. Entering a busier band requires both measures, so one viewer typing quickly never reads as a
  crowd and she goes on naming them. A chant is settled by the same rule: forty people typing one word
  is forty authors, one person repeating it is one.
- R10. Regime governs four things: who she addresses, how often she may speak, how much of the feed
  is read, and which signals the screener scores on.
- R11. In the quieter bands she addresses a named viewer directly; in the busier bands she addresses
  the room and names nobody.
- R12. Band changes carry hysteresis, so entering a busier band takes a higher rate than remaining in
  it, and a single burst does not flip her behaviour and back.
- R13. A band change takes effect at a cycle boundary and never while a line is being spoken.
- R14. Regime is readable as a World Parameter, so States and overlay conditions can transition on it
  with no model call in the path.
- R15. The band thresholds are settings with shipped defaults, and the defaults are measured against
  a real channel rather than chosen.

**The decision to speak**

- R16. Whether a speaking slot opens is decided in code, from the current Regime, the time since her
  last line, whether a line is already sounding, and whether the candidate is still fresh.
- R17. The model is asked only what to say. It may decline with a silence token, and a declined turn
  produces nothing at all — no placeholder and no entry.
- R18. A cheap screening stage selects which of a cycle's messages become candidates, so the model
  never sees the whole feed.
- R19. How readily she speaks is an operator dial with shipped defaults, in the shape the vision
  summariser's sensitivity already takes.
- R20. A candidate whose moment has passed is dropped before synthesis rather than spoken late.
- R21. When a gap or a hold suppresses a decision, that decision is re-offered when the hold lifts
  rather than discarded.

**The persona**

- R22. A World carries its character: a name, a character sheet, and a voice preset.
- R23. A World with no character never speaks to chat, and needs no other setting to be silent.
- R24. The character sheet is bounded in length, at a bound measured against model behaviour rather
  than chosen for tidiness.
- R25. The character's identity and register are authored through the project's existing template and
  phrase vocabulary, not as free strings in message-building code.
- R26. Chat text reaches the model only as rewritten cards in the data channel, never as raw viewer
  text and never in the instruction channel.
- R27. A card carries who said it, what it amounts to, and how old it is.

**Speaking and the World**

- R28. An utterance carries its text, what motivated it, when that motivation arrived, and a length
  bound.
- R29. An utterance may be rendered as spoken audio, as a subtitle, or as a feed entry, and the
  renderers are independent — a World that cannot sound can still show her words.
- R30. An autonomous utterance arriving while a line is sounding waits for that line to finish rather
  than cutting it.
- R31. An utterance is bounded by its length, and no path terminates a synthesis in progress.
- R32. Whether she is speaking is readable as a World Parameter that States and overlay conditions can
  transition on.
- R33. When she cannot speak, HAL says so in words and says which reason it is.

**Moderation and the console**

- R34. Every line passes a filter stage before synthesis, and that stage resolves its own backend
  independently of the persona's.
- R35. The filter returns a verdict rather than a rewrite, and a blocked line is visibly marked as
  blocked rather than silently absent.
- R36. Nothing is held waiting for operator review; a passing line proceeds directly to synthesis.
- R37. One control stops her speaking, and stopping her does not stop the World.
- R38. Speech requests carry a minimum interval per sender, so a fault in the pipeline cannot
  saturate synthesis.
- R39. Every decision is recorded — the candidates, the screening verdicts, the Regime, the model's
  output or its silence, the filter's verdict, the backend used, and whether the line actually
  sounded.
- R40. The record is readable after the fact, so a line the audience heard can be traced to the chat
  that produced it.

**Rehearsal**

- R41. A scripted transcript can drive the pipeline in place of a live platform, entering through the
  same source seam so the screener, Regime detection, filter and synthesis exercised are the ones
  that ship.
- R42. A rehearsal script states message text, author, and arrival timing, so a slow chat and a
  barrage are both expressible.
- R43. Rehearsal runs at wall-clock speed, so her prose and delivery can be judged by ear.
- R44. Rehearsal also runs accelerated for logic only, so a ramp across every Regime band can be swept
  without waiting for audio.
- R45. The same script run twice produces the same decisions, and the same voice preset produces the
  same audio.
- R46. A rehearsal corpus exercises the filter with material that must be blocked, including slurs and
  attempts to instruct her through chat.
- R47. The corpus of blocked material lives in the operator's data directory and is not committed;
  the repository carries the corpus format and a small safe sample.
- R48. A rehearsal never contacts a platform and never sounds anything on a surface being captured
  unless the operator asked for that.

**Backends and what leaves the machine**

- R49. Reading the feed, carding it, measuring the Regime and screening candidates resolve only to a
  local backend.
- R50. A card is the only thing that may reach a non-local backend, and it carries a stable handle in
  place of the viewer's display name.
- R51. The settings surface states in words what leaves the machine under the current configuration.

---

## Key Flows

- F1. A quiet channel
  - **Trigger:** Three people are in chat. One types "is this AI?"
  - **Steps:** The message is read and carded. The Regime is quiet, so the screener weights direct
    address and questions, and the gate opens a slot promptly. The persona is asked what to say and
    answers the viewer by name. The filter passes it. The soundtrack ducks and she speaks; the
    subtitle appears on `/broadcast`.
  - **Outcome:** A viewer got an answer addressed to them, and nothing about the World on disk
    changed.
  - **Covers:** R9, R11, R16, R18, R26, R29, R34

- F2. The channel goes viral
  - **Trigger:** Traffic climbs from a handful of messages a minute to several hundred.
  - **Steps:** The smoothed rate crosses into busier bands with hysteresis, one band at a time, each
    change landing at a cycle boundary. Repeated lines collapse into counted events. She stops naming
    anyone and remarks on the room. The read degrades as the quota runway shortens, and what is
    discarded is counted. A World State wired to the Regime Parameter cuts to a different clip.
  - **Outcome:** She stays intelligible and affordable at a volume where naming a viewer would be
    meaningless, and the picture visibly acknowledges the crowd.
  - **Covers:** R4, R6, R7, R8, R10, R12, R13, R14

- F3. Rehearsing before going live
  - **Trigger:** The operator wants to hear her before pointing her at a real channel.
  - **Steps:** A script is run at wall-clock speed and she speaks the room the script describes. The
    same script is run accelerated to sweep every band. A corpus of material that must be blocked is
    run, and each line is refused with a verdict.
  - **Outcome:** Her candor and prose have been judged by ear, every band has been exercised, and the
    filter has been shown to block what it must — with no platform contacted.
  - **Covers:** R41, R42, R43, R44, R45, R46, R48

---

## Acceptance Examples

- AE1. **Covers R11, R17.** Given the quiet band and one viewer asking a direct question, when a slot
  opens, then she answers that viewer by name — and given the model returns the silence token
  instead, then no line is spoken, no subtitle is drawn and no entry is written.
- AE2. **Covers R12.** Given a quiet channel receiving one short burst, when the burst ends, then the
  band does not change and change back — the smoothed rate never crosses the entry threshold.
- AE3. **Covers R13, R30.** Given a line is half spoken when the band changes, then the line finishes
  in the register it began in, and the next utterance uses the new band.
- AE4. **Covers R4.** Given forty viewers type the same word within a few seconds, when the cycle is
  screened, then the screener sees one event with a count of forty rather than one message and
  thirty-nine discards.
- AE5. **Covers R23.** Given a World that carries no character, when chat is busy, then nothing is
  spoken and nothing is drawn, and no setting had to be changed to achieve it.
- AE6. **Covers R26.** Given a viewer types an instruction addressed to the character telling her to
  ignore her character sheet, then that text never reaches the persona model in any channel, and what
  reaches it is a card describing the message.
- AE7. **Covers R35.** Given the filter blocks a line, then nothing is synthesised, the console shows
  the line was blocked and why, and the absence is never indistinguishable from her having nothing to
  say.
- AE8. **Covers R29, R33.** Given no client is attending audio, when a slot opens, then the utterance
  is still drawn as a subtitle and written to the feed, and HAL states that she cannot be heard and
  why.
- AE9. **Covers R45.** Given the same rehearsal script is run twice against the same settings, then
  the same decisions are made and the same audio is produced.
- AE10. **Covers R20.** Given a candidate that was fresh when generation began and stale when it
  ended, then nothing is spoken and the drop is recorded.

---

## Success Criteria

- A viewer in a quiet channel feels answered rather than narrated at.
- Her prose sounds like the character the World declares, and it still sounds like her in hour six.
- The operator can sit through a viral surge without touching anything, and afterwards can read what
  she decided and why.
- Nothing bannable has been spoken during rehearsal against a corpus built to provoke it.
- A stream can go from quiet to viral and back without the character's behaviour visibly oscillating.

---

## Scope Boundaries

**Deferred for later**

- Posting text back into chat. She speaks and subtitles; she does not type. Posting brings a bot
  account and send-side rate limits with it.
- Repairing the attendance defect. Reloading `/live` mid-stream silences the room at the next track
  boundary and she goes mute until the tab is clicked again; this work reports that condition rather
  than fixing it.
- Memory of individual viewers across a stream or between streams.
- Moving audio output to `/broadcast`. Not needed while OBS captures the operator's system audio.
- A hold or delay line before speech, and any operator veto that depends on one.
- Archiving rendered audio for reuse. Every line is synthesised fresh.

**Outside this feature's identity**

- Any design where the model is asked to judge whether it should speak.
- Raw viewer text reaching the model that produces her lines.
- A character that talks continuously because chat is busy. Silence stays the default at every band.

---

## Dependencies / Assumptions

- Reading YouTube live chat needs OAuth and bills against a shared daily project quota; the per-call
  cost is not stated in current documentation and has to be measured rather than assumed. Twitch
  reading over a socket needs a *user* access token carrying the chat-read scope — an application
  token cannot open that transport — and is not metered the same way.
- A Google consent screen left in Testing status issues refresh tokens that expire in seven days for
  the scopes this needs. Publishing the consent screen is an operator prerequisite with review lead
  time, not a detail.
- Automated chat access must use each platform's sanctioned path. Neither platform's terms
  distinguish AI-generated content from human content when enforcing conduct rules.
- Her voice reaches viewers because the `/live` tab holds the audio grant and OBS captures system
  audio. A capture setup that reads only the `/broadcast` window, or an OBS browser source with no
  user gesture, would show subtitles under silence.
- Synthesis is CPU-only and does not contend with image or video generation.
- Installed models span a wide range of context sizes, so any budget expressed as a share of the
  window is not interchangeable with one expressed as a fixed count.

---

## Outstanding Questions

**Deferred to planning**

- Where the Regime band thresholds sit, the author floor per band, and over what window the rate is
  smoothed. All measured against a real channel, not chosen.
- What a moderator's deletion or a viewer's ban should do to a message already read. Both platforms
  emit these events; this brief did not consider them, and speaking a line a moderator removed seconds
  earlier is the worst outcome the feature can produce.
- Whether the screener is heuristic only or admits a small model, and on which backend.
- Whether the recorded decision log shares the vision timeline's storage shape or gets its own.
- How a rehearsal script is authored, and whether a real stream's chat can be captured into one.
- Whether the character sheet's bound matches the Character Profile bound or is measured separately.
- What a viewer's stable handle is derived from, and whether it holds across streams or is minted per
  stream.

---

## Sources / Research

- `docs/ideation/2026-09-07-live-chat-persona-ideation.md` — the ranked ideas this brief was drawn
  from, and the ones rejected with reasons.
- `docs/brainstorms/2026-09-06-live-character-speech-requirements.md` — the shipped speech feature,
  and the deferral this work takes up: "HAL speaking on his own initiative… The protocol message this
  feature adds is what makes that possible later."
- `docs/residual-review-findings/feat-live-character-speech.md` — that `speak` carries no rate limit
  and why that is safe only while nothing untrusted can connect; that supersede is a dequeue rather
  than a queue; that a sounding client is a precondition.
- `docs/spikes/2026-09-04-attendance-silences-unattended-playback.md` — reproduced and unfixed; a
  re-announcement drops the audio grant back to silent and the next track begins muted.
- `docs/solutions/an-instruction-that-fights-its-own-input-loses.md` — six measured recurrences of a
  prohibition becoming the output, and the fix being to change the input.
- `docs/solutions/the-window-is-a-property-of-the-destination-not-of-the-role.md` — why a new
  inference role must derive its window from its destination.
- `docs/solutions/a-lane-is-a-property-of-the-machine-not-of-the-app.md` — the two backends and what
  distinguishes them, and why a half-wired distinction reads as coverage.
- `docs/solutions/suppressing-an-evaluation-is-half-of-deferring-it.md` — a hold has an exit, and the
  exit is where the deferred work happens.
- `docs/solutions/terminating-a-worker-during-a-native-call-aborts-the-process.md` — why an utterance
  is bounded by length rather than by a clock.
- `docs/solutions/assert-the-effect-not-the-existence.md` — why a test that the model was called
  proves nothing about whether she spoke.
- `CONCEPTS.md` — Observation, Monitors, Providers, Prompts, Live state machines, Speech.
- Neuro-sama's separate moderation layer and its January 2023 Twitch ban — the one documented
  consequence in this space, and the shape of the mitigation that followed it.
- kimjammer/Neuro's gating on explicit live signals rather than a model call per message; cascade and
  triage inference for the selection problem; salience-prediction research finding instruction-tuned
  models only moderately good at judging their own relevance.
