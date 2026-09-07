# Residual findings — the character speaks

Accepted knowingly, and written at the moment each trade was made rather than after a review found
it. Origin: `docs/brainstorms/2026-09-06-live-character-speech-requirements.md`. Plan:
`docs/plans/2026-09-06-003-feat-live-character-speech-plan.md`.

The plan was reviewed by six personas before a line was written, and the two decisions that mattered
most were both reversals of what the brief had settled. Those are recorded here as decisions rather
than as residuals, because they changed what shipped.

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
