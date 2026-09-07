---
date: 2026-09-06
topic: live-character-speech
---

# The character speaks

## Summary

`/live` gains a speech control: type a line, pick one of your voices, and the AI character says
it. A voice is a preset you author in the app by blending stock synthesiser voices and
auditioning by ear, so the character sounds the same every time and sounds like nobody else's.
The spoken line can optionally be drawn over the picture on both surfaces.

---

## Problem Frame

HAL has a face, a narration voice in prose, and a World of clips that plays behind him, but he
has never made a sound of his own. The character on the broadcast surface is whatever clip is
running; when it should be *speaking*, there is nothing to speak with.

The nearest thing that exists is not in this repo at all. A separate project rendered a nine-line
voiceover with Kokoro-82M and shipped it, leaving behind a working environment, a set of measured
traps, and a recipe. That work is a one-off script driving a finished video file. It cannot be
pointed at a live surface, and re-typing a line means editing a Python list and re-running a job.

`AGENTS.md` lists voice output on the deferred roadmap under *do not build uninvited*. This is the
invitation.

---

## Key Decisions

**Voices are blends of stock vectors, not clones of a recording.** A Kokoro voice is a
`(510, 1, 256)` float array, and the synthesiser accepts a raw array as readily as a name — so a
new voice is a weighted sum of existing ones, and it renders bit-identically every time. This buys
a CPU-only, torch-free, deterministic engine that never queues behind image generation. The
ceiling is honest: it will always sound like well-blended Kokoro, never like a performance, and
never like a specific person. Cloning would mean a GPU engine and a second heavy environment,
which is not what this feature is for.

**The voice joins the existing audio authority on `/live`; `/broadcast` stays silent.** Exactly
one client sounds, elected per socket, and an unmuted element needs a user gesture before it will
play. Speech reuses that election and that gesture rather than inventing a second of each.
`/broadcast` produces no soundtrack audio today, and giving it any is a separate feature with its
own gesture problem on a surface that is meant to have no chrome.

**Speaking is authored input, not a transport command.** The election decides which client makes
the noise — never who is allowed to speak. This asymmetry is the only way R7 and R8 can both hold:
an agent connection declares `observe` and is refused the audio grant by construction, so gating
the request on the authority would mean an agent could never make the character talk.

**A subtitle is an overlay slot.** The slot says where the line goes and how it looks, and is the
World's; the words are resolved when they are drawn and never reach the manifest — the shape the
playlist header and track description already have. A World that carries no speech slot shows no
spoken word on either surface, so placing the slot is how subtitles are turned on, and `/broadcast`
goes on rendering only what the operator arranged.

**Subtitles are timed per sentence, not per word.** The synthesiser can emit per-phoneme timings,
but only from a model exported to report durations; the shipped model refuses, naming that
requirement. Splitting the text into sentences and synthesising each gives exact per-sentence
durations for free, which is the method the prior voiceover already proved.

**Synthesis runs in its own process inside this repo.** `recogniser/` already establishes the
pattern for a Python-shaped service that must not live in `server/`. Reaching across into the
other project's virtualenv would make HAL depend on a sibling project's directory layout. The
model must stay resident: a cold start on every audition would break the design-by-ear loop the
voice editor exists for.

---

## Requirements

**Voices**

- R1. A voice preset is a name, a weighted mix of one or more stock synthesiser voices, and a
  speed. The same preset renders the same audio every time.
- R2. Presets are authored in the app: choose the stock voices, set their weights, set the speed,
  name it, save it.
- R3. The editor auditions an unsaved preset against sample text the operator types, so a voice
  can be shaped by ear before it is committed.
- R4. Presets persist across restarts, and are readable and writable over the protocol.
- R5. A preset naming a stock voice the model does not carry is refused at save, with the offending
  name reported.
- R6. One preset ships, so the speech control is usable the first time it is opened rather than
  offering an empty picker.

**Speaking**

- R7. `/live` carries a speech control: a text field, a picker over the saved presets, and a Speak
  button. Speaking is a protocol message carrying the text and the voice, reachable by an agent on
  the same terms as the operator.
- R8. Any connected client may request speech; only the audio authority sounds it. The gesture that
  unlocks the transport unlocks speech, and no second gesture is asked for.
- R9. A new speak supersedes the line in flight rather than queueing behind it.
- R10. While a line is sounding the soundtrack ducks, and returns to level when the line ends. The
  duck depth is a setting with a shipped default.
- R11. A speak request arriving with no attending audio authority is refused with a reason naming
  that nothing would be heard — not accepted and silently dropped.
- R12. Text is bounded in length, and an over-long request is refused rather than occupying the
  service for minutes.

**Subtitles**

- R13. The line being spoken can be drawn over the picture on `/live` and `/broadcast` by a speech
  overlay slot.
- R14. The slot's presence in a World is what turns subtitles on and off; a World without one draws
  no spoken text on either surface.
- R15. A subtitle is never written to the World manifest.
- R16. Text is split into sentences and synthesised per sentence, and each sentence's subtitle is
  shown for that sentence's measured duration.
- R17. A subtitle with nothing to say renders no element at all, keeping `/broadcast`'s no-text
  discipline exact.

**Synthesis service**

- R18. Synthesis runs in a separate process holding the model resident, so an audition costs
  roughly the time the line takes to say and not a model load.
- R19. Leading and trailing silence is trimmed from every render before the audio is used. The
  synthesiser pads both ends, and untrimmed, every line lands late by a measurable margin.
- R20. HAL reports when the voice service is not running, in the shape the other sidecar's
  readiness is already reported.
- R21. Grapheme-to-phoneme conversion fails silently on proper nouns — the audio is clean and the
  word is wrong. The editor exposes the phonemes a line will actually be read as, so a bad
  pronunciation is visible rather than only audible.

---

## Key Flows

- F1. Authoring a voice
  - **Trigger:** The operator opens the voice editor to make a new character voice.
  - **Steps:** Choose two or more stock voices; set their weights and a speed; type a sample line;
    audition; adjust and audition again; name and save.
  - **Outcome:** The preset appears in the speech control's picker and survives a restart.
  - **Covered by:** R1, R2, R3, R4, R5

- F2. Speaking a line
  - **Trigger:** The operator types into the speech control and presses Speak, or an agent sends
    the same message.
  - **Steps:** The text is split into sentences and synthesised in the named voice; the soundtrack
    ducks; the audio authority sounds each sentence in turn while its subtitle is shown; the
    soundtrack returns to level.
  - **Outcome:** The character has spoken, and nothing about the World on disk has changed.
  - **Covered by:** R7, R8, R9, R10, R13, R15, R16

---

## Acceptance Examples

- AE1. **Covers R8, R11.** Given only a `/broadcast` tab is open and no client is attending audio,
  when a speak request arrives, then it is refused with a reason and no subtitle is drawn.
- AE2. **Covers R7, R8.** Given an agent connection that declared `observe` and was refused the
  audio grant, when it sends a speak request, then the character speaks on the operator's attending
  client.
- AE3. **Covers R9.** Given a line is half-spoken, when a second speak arrives, then the first stops
  where it is, its subtitle is replaced, and the second begins.
- AE4. **Covers R10.** Given the soundtrack is playing, when a line begins, then the music drops by
  the configured amount and is back at level after the last sentence, including when the speech was
  superseded rather than finished.
- AE5. **Covers R16.** Given a three-sentence line, when it is spoken, then three subtitles appear
  in turn, each for its own sentence's duration rather than a third of the total.
- AE6. **Covers R15.** Given subtitles are on and a line is spoken, when the World is reloaded from
  disk, then its manifest is byte-identical to before the line.

---

## Success Criteria

- An audition returns fast enough that a voice can be shaped by ear in a sitting — the loop is
  adjust, hear, adjust, and a multi-second wait per iteration destroys it.
- The same preset spoken on two different days produces the same audio.
- A viewer of `/broadcast` sees the character's words and no HAL chrome, exactly as with the
  existing overlay slots.

---

## Scope Boundaries

**Deferred for later**

- Moving audio output from `/live` to `/broadcast`, so the audience hears the character directly
  rather than through a captured operator tab. Wanted eventually; not now.
- HAL speaking on his own initiative — narration, monitor findings or chat replies routed to the
  voice. The protocol message this feature adds is what makes that possible later.
- The World machine reacting to speech, such as a `speaking` Parameter a State could transition on.
- Word-level subtitle synchronisation, which needs a re-exported model.
- Archiving rendered lines for reuse. Every speak re-synthesises.

**Outside this feature's identity**

- Cloud TTS. It sends the character's words to a third party, costs money per line, and breaks the
  local-only property the rest of the harness holds to.
- Voice cloning from a recording. A different engine class, a GPU dependency, and a different
  answer to what "original" means.

---

## Dependencies / Assumptions

- The synthesiser needs a Python 3.12 environment and roughly 350MB of model files. Both exist on
  this machine already, in the sibling project; whether they are copied in or referenced is a
  planning question.
- Synthesis is CPU-only and does not contend with image or video generation for the GPU.
- The assumption behind the deferred `/broadcast` audio: while output stays on `/live`, anything
  capturing the broadcast surface must also capture system audio, or the audience will read
  subtitles under silence.

---

## Outstanding Questions

**Deferred to planning**

- Whether the model files are copied into this repo or referenced where they sit, and what that
  costs in disk and in provenance.
- Whether a World can name a default voice, or the picker is purely a live control.
- Whether the subtitle toggle persists across restarts or resets each boot.
- What the shipped duck depth is. Numbers measured on comparable material in the sibling project: a
  10 dB static duck left only 3–5 dB of separation on loud beds, while 12 dB down plus 3 dB up
  cleared 8 dB everywhere.

---

## Sources / Research

- `AGENTS.md` — voice output listed on the deferred roadmap; the audio authority election, the
  gesture rule, and `/broadcast`'s containment discipline.
- `docs/brainstorms/2026-09-03-live-audio-soundtrack-requirements.md` — the election and transport
  this feature joins.
- `docs/brainstorms/2026-09-04-broadcast-surface-requirements.md` and
  `docs/brainstorms/2026-09-05-video-text-overlays-requirements.md` — why the broadcast surface
  renders only operator text, and the layer subtitles ride on.
- `recogniser/README.md` — the sidecar precedent for a Python service outside `server/`.
- The sibling project's Kokoro voiceover recipe and its origin plan, under
  `C:\AI\ComfyUI_windows_portable_nvidia\docs\` — the silence-padding trap, the silent phonemiser
  failures on proper nouns, and the ducking measurements. Outside this repo, so cited by absolute
  path rather than linked.
