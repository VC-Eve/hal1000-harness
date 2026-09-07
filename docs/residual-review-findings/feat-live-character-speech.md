# Residual findings — the character speaks

Accepted knowingly, and written at the moment each trade was made rather than after a review found
it. Origin: `docs/brainstorms/2026-09-06-live-character-speech-requirements.md`. Plan:
`docs/plans/2026-09-06-003-feat-live-character-speech-plan.md`.

The plan was reviewed by six personas before a line was written, and the two decisions that mattered
most were both reversals of what the brief had settled. Those are recorded here as decisions rather
than as residuals, because they changed what shipped.

---

## What a post-merge review changed

Eleven reviewers ran over this feature after it merged. They found one P0 and five other real
defects, all now fixed; the notes below are what remains *accepted* rather than what was wrong.
Recorded here because the fixes are part of the feature's history and two of them were caught only
because a reviewer disbelieved a comment:

- **A missing `.catch` on the fire-and-forget message handler** (P0). `AGENTS.md` states the rule and
  `WorldService` shows the pattern one file away; the handler had real throw paths behind it, so one
  bad message would have taken the process down.
- **The audition was refused for every unnamed voice.** The editor sent its save-shaped payload, and
  `cleanPreset` requires an id — so the adjust-hear-adjust loop the feature exists for did not work
  until you named the voice first. The test blessed it by asserting only that a message was *sent*.
- **`ensureModels` had no caller.** The whole fetch-on-first-use path was dead, `fetching` was
  unreachable, and `AGENTS.md` documented a download that never happened.
- **Every spoken line re-hashed 353MB on the main thread** (~260ms of blocked event loop, measured),
  inside the audition loop and next to a live state machine's timers. The digest is now memoised
  against size and mtime: 242ms then 0ms.
- **A client outrunning the renderer killed the line.** Reporting past the last *rendered* sentence
  read as "finished", cleared the utterance, and made the render loop dereference null.
- **A sounding tab closing mid-line stranded everything** — Speak disabled, music ducked under
  silence, and a reopened tab replaying the stale line.

The crash lesson has been promoted out of this file into
`docs/solutions/terminating-a-worker-during-a-native-call-aborts-the-process.md`, because the next
person doing native or worker-thread work will not read a speech feature's residuals.

---

## A native fault in `onnxruntime-node` takes HAL down

**What.** Synthesis runs on a worker thread inside the server process (KTD1). A native abort in ONNX
Runtime kills HAL, not just speech. A worker thread does **not** isolate that — an earlier draft of
the plan claimed it bounded a hang, and that claim was false.

**Measured.** Terminating a worker holding an ORT session *during* `session.run()` killed the whole
process with exit code `3221226505` (`0xC0000409`, STATUS_STACK_BUFFER_OVERRUN): no `exit` event, no
`terminate()` resolution, no chance for the parent to report anything. The control — terminating the
same worker with a session loaded and no run in flight — exited cleanly with code 1.

**Why it shipped anyway.** The cancellation the isolation would buy is not needed. Kokoro caps a
sequence at 510 tokens, so a synthesis is bounded by its input rather than by a clock, and
`synth.ts` refuses an over-long sequence before the thread ever sees it. `stop()` waits a dispatched
run out rather than terminating over the top of it.

**What would change it.** A **Node child process in this repo** — no Python, killable safely, crash
contained — is the third option and the only one that removes the cost. It was not taken because
every argument in KTD1 is an argument against Python rather than against a separate process, and the
gain (no venv, no second command) survives either way. Revisit if a native fault is ever observed in
practice, or when a GPU engine arrives. The synthesis boundary in `synth.ts` is where that seam
already is.

---

## `speak` has no rate limit

**What.** `speak` is accepted from any admitted socket with a length bound of 2000 characters and
nothing else. Phonemisation and synthesis are serialised, so a socket sending repeatedly keeps the
one worker busy.

**Why it shipped anyway.** The server binds loopback only and the sockets are the operator and their
own agents. The flood cost is already bounded from two directions: a supersede **dequeues**, so
repeated requests replace each other rather than accumulating, and nothing terminates the worker any
more, so no request can force a 325MB model reload. Security-lens rated this before either of those
existed.

**What would change it.** The bound is emergent rather than enforced, so a later change to the queue
reopens it silently. Build a per-socket minimum interval the day something untrusted can connect, or
the day the queue stops dropping superseded work.

**Narrowed since.** `phonemes-for` was unbounded and shares the process-wide phonemiser queue with
`speak`, so one pasted document stalled every later line — a hole the 2000-character bound did not
cover because that bound was only on `speak`. It now carries the same limit.

---

## Speech audio is a fifth host-checked media surface

**What.** `/api/live/speech` rests on the `Host` check alone, joining `/api/vision/stream`,
`/api/live/clip`, `/api/live/image` and `/api/live/audio`. An `<audio>` element sends no `Origin` and
cannot present the per-boot WS token.

**Why it shipped anyway.** Exactly the trade the other four make, and the alternative is a route an
`<audio>` element cannot play from. This route is *narrower* than its siblings: the audio lives in
memory keyed by the generation that produced it, so a URL is refused the moment the line it belongs
to is superseded, where the file-backed routes serve a stable path indefinitely.

**Note on the count.** The plan said "a fourth media route" and was wrong: `/api/live/image` already
existed and had been missed. The debt recorded in `feat-live-audio-soundtrack.md` is owed a fifth
time.

---

## The oracle needs an environment this repo deliberately does not have

**What.** `server/test/voice/fixtures/` was recorded from the reference Python `kokoro-onnx`, which
lives in a sibling project outside this repo. The recording script and a manifest pinning every
version are committed, but re-recording needs that environment.

**Why it shipped anyway.** It is the only way the reimplementation is checked against something other
than itself. A fixture recorded from the code under test proves nothing, and this repo has already
paid for that mistake once
(`docs/solutions/byte-identity-needs-an-oracle-recorded-first.md`).

**What is guarded and what is not.** The fixtures catch drift in the phonemiser and in the blend
arithmetic. They cannot catch drift in the *audio*, because the two sides run different ONNX Runtime
builds and bit-identity across them is not achievable — measured agreement is ~2e-6 with an identical
trimmed sample count. A separate digest of **our own** output
(`fixtures/rendered-node.json`) covers that: it is a change detector, not an oracle, and it is
labelled as one.

---

## 10.2% of the phonemiser corpus does not match the reference, on purpose

**What.** `server/src/voice/phonemes.ts` reproduces the reference exactly on 167 of 186 corpus lines.
The remaining 19 are not chased.

**Why it shipped anyway.** They are entirely cases where the reference is *worse*. It runs eSpeak
with `preserve_punctuation=True`, which makes it read `0.5` as "zero. five" and put a literal colon
into `09:00`. The npm package takes no options at all, so the flag cannot be matched, and matching
its consequences would mean making the character read numbers badly. The measurement, the method and
the reasoning are in `server/test/voice/fixtures/README.md`, and a test pins the floor so a
regression fails.

**What would change it.** A number that falls is a change in how the character pronounces things and
nothing else in the suite would notice. Re-run `node scripts/differential-phonemes.mjs` after any
`phonemizer` bump.

---

## The sentence splitter's abbreviation list is short and cannot be complete

**What.** `ABBREVIATIONS` holds about thirty common cases. English does not resolve this ambiguity.

**Why it shipped anyway.** The cost of a miss is a subtitle boundary in an odd place and two shorter
synthesis calls — not a wrong pronunciation. A longer list buys proportionally less each time.

---

## What a second review round changed, and what it left

A six-persona review of the *fixes* — a P0 batch, a settings control and a race fix, all written fast
under review pressure — found four more defects, all now fixed and each with a test that fails
without it:

- **A refusal after the generation claim stranded the line already sounding.** Claiming the
  generation before the awaits is what makes supersede follow arrival order; it also meant every
  refusal after that point (unknown voice, models absent, text that phonemises to nothing) left the
  previous utterance live but unreachable — its audio 404s, its reports are refused, Speak stays
  disabled and the music stays ducked under silence. Only Stop recovered. `refuseClaimed` now ends it.
- **A dying worker failed its successor's queue.** Node emits `error` then `exit` for one death, and
  the retry runs in the gap; the second event rejected the replacement's live request and cleared the
  wait `stop()` uses to keep `terminate()` off a running `session.run()`. The identity check now comes
  before the settling.
- **The startup promise was still settled below the stop check.** The same latching bug one line
  lower: a `stop()` during the first model load left every parked `render()` hung for the life of the
  process, each holding `rendering` pinned at a dead generation.
- **The duck slider sent one `update-settings` per pixel of drag.** Each is a whole-settings atomic
  write racing over one rename target, so a value merely dragged through could persist; each also
  flushed the backend protocol and context-window caches. It now sends once, on release.

Three findings from that round were kept rather than fixed:

**Closing one of two `/live` tabs can cut the line the survivor would have finished.** The speech
closer asks the global `canSound()`, and during the handover — `leave` releases the transport before
the successor is elected and reports ready — the answer is transiently no. Testing the specific
condition means the speech side learning about attendance per client, which is the coupling the
`SoundSide` seam exists to avoid. The registration order it already depends on is now documented at
both sites. The cost is one cut line in a two-tab session; the alternative is a wider interface.

**A hand-edited duck depth between 25 and 60 is read two ways.** `usableDuck` refuses the patch and
keeps the stored number while `duckFactor` falls back to 12. Both are safe, they simply disagree, and
the only way to reach it is to edit the settings file by hand — the band the control offers is 0–24.

**The late-death race has no test.** The fix is a three-line identity check and is verifiable by
reading it, but making the second death event land *after* a replacement holds real work needs
control over when Node emits `exit` that the stub worker cannot give. A test written in the natural
shape passes with the fix removed, which is worse than no test — so there is none rather than a
false one.

---

## Deferred, and unchanged from the brief

- **Audio still sounds on `/live` only.** `/broadcast` draws the subtitle and stays silent. The seam
  in KTD5 removes the protocol and state rewrite from moving it, and leaves the origin's actual
  blocker entirely untouched: a gesture requirement on a surface deliberately built with no chrome
  to press. That move is a feature, not a change of destination.
- **HAL does not speak on his own initiative.** The `speak` message is what makes it possible later.
- **The World machine does not react to speech.** No `speaking` Parameter.
- **No word-level subtitle sync.** It needs a model exported to report durations; the shipped one
  refuses, naming that requirement.
- **No A/B comparison of two candidate mixes.** The editor auditions one at a time, so comparing two
  means remembering slider positions. Deferred until the by-ear loop has been used in anger.
- **Rendered lines are not archived.** Every speak re-synthesises.
