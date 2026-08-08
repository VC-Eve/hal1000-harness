# Residual findings — identity bands, roster editing, and character profiles

Accepted knowingly, 2026-08-08. Covers the work in
`docs/plans/2026-08-08-001-feat-recognition-identity-and-profiles-plan.md`, phases 0 to 3. Builds on
`feat-recognition-loop.md` and `feat-enrolment-candidates.md`; the residuals there that this work
discharges are listed at the end.

## The statement threshold is field observation, not measurement

**What.** 0.6 decides whether HAL states a name flatly or attributes it. It rests on two enrolled
people in daily use with no cross-person false positive observed at 0.5 — not on a measured ceiling
for different-person similarity, which has still never been taken.

**Why it shipped anyway.** The number that would settle it needs a second session with real people
and cannot be produced by code. Meanwhile the observation is real and it is about the room this
actually runs in. The band below 0.6 is kept rather than removed, both thresholds are settable, and
`MIN_BAND_SEPARATION` stops the hedge being configured away.

**What would discharge it.** Independent captures of two or more people, measuring where same-person
similarity floors against where different-person ceilings. A third person, or a genuine lookalike, is
the event that invalidates the current default.

**Worth recording:** the figure everyone reaches for — same-person 0.93 — cannot place this
threshold. It was measured over synthetic variants of one frame, so it described the embedder's
invariance to rotation and scale. Independent captures score 0.53 to 0.78. A first draft of this
feature derived 0.85 from 0.93 and would have shipped a band that never fired. See
`docs/solutions/a-measurement-on-synthetic-variants-measures-your-own-transform.md`.

## The output check lost its oracle

**What.** Previously any bare enrolled name in a Narration Entry was unambiguously a defect. A bare
name is now correct above the statement threshold, so that test no longer exists.

**What narrows it.** `server/test/narration/bands-output.test.ts` covers both bands, both idempotence
cases, and a name with no live reading. All fifteen pre-band cases are kept verbatim, with the roster
they run against now stated rather than implied. Each of three deliberately reintroduced bugs was
confirmed to fail tests before the code was accepted.

**What would discharge it.** Nothing cheap. The honest position is that those tests are now the only
thing between a band bug and silence.

## The percentage is supplied to the summariser deliberately

**What.** `Dave 71%` reaches the model, not only the pane. This is the class of supplied label that
`docs/solutions/an-instruction-that-fights-its-own-input-loses.md` records becoming the subject of
narration three times — timestamps and ordinals both did.

**Why it shipped anyway.** A deliberate user decision, taken with the counter-argument stated. The
first rule in that document is to stop supplying the label rather than write a rule against it, and
the pane already renders the confidence.

**What would discharge it.** It is recorded as a bet rather than a caveat: a test in
`server/test/vision/bands.test.ts` asserts a cycle describing only posture produces narration that
does not discuss the number. If narration starts remarking on its own confidence, that is the failure
and the fix is to stop supplying it.

## AE6 is unverified — profiles in the system prompt are a reasoned placement, not a measured one

**What.** The design rests on the claim that a profile in the system prompt does not become the
subject of narration the way a profile in the caption line would. The structure is in place — one
positive instruction, phrased as knowledge rather than as a document, bounded across everyone — and
the outcome has not been observed.

**Why it shipped anyway.** Falsifying it needs a real model producing real narration over several
cycles. A fake provider yielding a canned reply certifies nothing, and writing such a test would have
been worse than none.

**What would discharge it.** Vision running with a narration model set and at least one person
described, at `always` sensitivity — the setting where the model must speak every cycle and reaches
for whatever material it has. The failure looks like HAL remarking on a described person's habits
when all it saw was someone at a desk.

## Enrolment from a photograph is unverified on a real face

**What.** The whole chain is proven — file, EXIF-aware decode, canvas transcode to JPEG, base64 over
WS, the sidecar, and the refusal wording — but only with an image containing no face. Whether YuNet
finds a face in a real photograph is the model's judgment on real data.

**Why it shipped anyway.** No photograph was available that was not the user's own biometric data,
and reaching into the live gallery for a crop to test with was the wrong trade.

**What would discharge it.** One photo of an enrolled person, added through the roster.

## Chat cannot be told who is present

**What.** The vision-to-chat seam is not built. `server/src/chat.ts` still assembles a request as a
system message and a history with no vision awareness, so a Conversation cannot be told who HAL is
looking at or who its Operator is. Requirements R25 to R32 in the brief are unimplemented, and the
plan's units U13 to U15 are unstarted.

**Why it shipped anyway.** Deliberately paused by the user in favour of iterating on what is built.
Nothing already shipped depends on it: profiles reach the vision observer today, and the Operator
mark is stored and read.

**What would discharge it.** U13 to U15. Three constraints are already established and should not be
rediscovered: identity context must be assembled per request and never persisted into
`conversations/*.json`, or profile text lands beyond the reach of deletion and the roster freezes at
thread creation; a conversation's toggle must read absent-as-off so a thread started under the old
contract is unchanged; and HAL's chat replies need the same band check narration gets, or the
Operator's name is stated on standing context alone — the failure AE4 exists to prevent, arriving
through the other surface.

## Confirming an uncertain match is a feedback loop that can run backwards

**What.** With `queueUncertainMatches` on, a hedged match is kept for review and confirming it adds
that face to the suspected person. A correct confirmation makes the next match better. A wrong one
puts another person's face into that gallery entry, which makes future false positives more likely —
and then those false positives are themselves offered for confirmation. The hedged band is by
definition where HAL is least sure, so this is the exact population where a reviewer is most likely
to be wrong.

**Why it shipped anyway.** The value is real and the setting is off by default. The confirmation is
built to make comparing easy and agreeing hard: the queued face is shown beside a face already held
for that person rather than described with a name to nod at, and rejecting offers naming someone else
rather than only dismissing.

**What would discharge it.** Nothing structural — the loop is inherent to accretive enrolment. What
would narrow it: a way to see which faces were added by confirmation and remove them as a group, so a
run of bad confirmations is recoverable without pruning face by face. Today the roster editor removes
one face at a time and does not record where a face came from.

**Watch for.** A person whose face count grows steadily while their match confidence does not
improve, or gets worse. That is what a gallery accumulating the wrong faces looks like from outside.

## The off-machine acknowledgement is still owed

**What.** Pointing the recogniser at a non-loopback host still takes no separate acknowledgement, and
this work widened what that would send: `add-face-from-image` posts pictures from the user's disk to
the configured endpoint, not only live camera frames.

**Why it shipped anyway.** Inherited rather than introduced, and the endpoint defaults to loopback.

**What would discharge it.** The brief's R10 — an acknowledgement naming what actually leaves the
machine, now including chosen photographs.

---

## Residuals this work discharged

- `feat-ambient-log-monitors.md` — the outstanding per-boot WS token is built. The hub now requires it
  before any handler runs *and* before any broadcast reaches a socket; gating inbound messages alone
  was half a gate, and the first implementation shipped that half until a test caught it.
- `feat-recognition-loop.md` — biometric mutation over the unauthenticated hub, closed by the same
  token. Enrolment taking one frame, closed by adding a face from a picture.
- `feat-enrolment-candidates.md` — naming merging by name with no way to correct it, and editing HAL's
  state files under a running server. Both closed by the roster editor: renaming, merging and pruning
  are reachable over the protocol, so consolidating never means touching the file behind the server's
  back.
- The full biometric purge, specified in the vision brief's R28 and never built, now exists.
