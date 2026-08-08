# Residual findings — the HAL-side recognition loop

Accepted knowingly when this slice shipped, 2026-08-07. Plan:
`docs/plans/2026-08-07-002-feat-hal-side-recognition-loop-plan.md`. Origin:
`docs/brainstorms/2026-08-07-vision-face-recognition-requirements.md`.

## Biometric mutation rides the unauthenticated WS hub

**What.** `enrol-person` and `delete-person` create and destroy face records over the same WebSocket
hub whose per-boot token is still outstanding — the residual recorded in
`feat-ambient-log-monitors.md`. Anything that can reach the hub can enrol a person or permanently
erase one.

**Why it shipped anyway.** Proportionality, not dismissal. That same channel already accepts
`add-monitor`, which schedules and runs a shell command — a strictly larger capability than storing a
face. This widens an exposure the project has already accepted rather than opening a new kind of one.
The origin brief asks that planning treat the token as a prerequisite rather than an independently
deferrable item; the compromise taken was to ship the loop and make the debt explicit here instead of
leaving it implicit.

**What narrows it today.** The server binds `127.0.0.1` only, and the hub accepts a browser origin
only on its own port. Reaching it means already being on this machine.

**What would discharge it.** The per-boot token handshake described in `feat-ambient-log-monitors.md`.
It is now owed by two features rather than one, and this is the second time it has been deferred.

## Pointing the recogniser off this machine is unguarded

**What.** `recogniserEndpoint` accepts any URL. Set to a non-loopback host, HAL posts whole camera
frames there on the detection cadence — everyone in the room, including people who are not enrolled
and never will be.

**Why it shipped anyway.** R10 and R11 — the explicit acknowledgement naming what leaves the machine,
and the requirement that it travel only over an encrypted authenticated channel — are outside this
slice. The default is loopback and the settings copy says plainly what a remote endpoint sends, but
copy is not a control.

**What would discharge it.** R10's separate acknowledgement, distinct from typing the URL, and R11's
transport requirement.

## The confidence threshold is a guess with a good excuse

**What.** `confidenceThreshold` ships at 0.5. Same-person similarity was measured at 0.93 after the
landmark warp and a non-face at 0.21, but different-person-versus-same-person — the discrimination the
threshold actually arbitrates — has never been tested, because only one face has ever been available.

**Why it shipped anyway.** The origin brief anticipated exactly this and deferred the value until a
second face exists. The default errs toward unrecognised, so the failure mode is "does not know you"
rather than "calls you by someone else's name", which is the right way round.

**What would discharge it.** Enrolling a second person and measuring where same-person similarity
floors against where different-person similarity ceilings. No amount of code produces this.

## The output hedge is string matching

**What.** `enforceIdentityHedge` rewrites bare enrolled names in what the summariser produced. It will
not catch a model that refers to someone by description, by a nickname, or by a possessive
construction it does not anticipate.

**Why it shipped anyway.** It is the second line of defence, not the first. The caption line handed to
the model never contains a bare name at all; this exists because a model can flatten a hedge it was
given, and the brief asks for both halves precisely because neither is sufficient. A prompt rule
instead of either is the lever this project has measured failing three times.

**What would discharge it.** Nothing cheap. Treat a bare name appearing in a Narration Entry as a
defect report against this function and widen it case by case.

## Enrolment takes one frame

**What.** A person is enrolled from a single capture. The brief's design has a person accumulating
faces through the triage queue; with no queue, one frame is all there is. Someone enrolled from a
badly-lit or off-angle frame will match poorly, and the only remedy is to delete and re-enrol.

**Why it shipped anyway.** The queue is the next slice. `PeopleStore.addFace` already exists and is
tested, so accumulating faces is a wiring problem rather than a design one.

**What would discharge it.** The triage queue (R12–R21), or a "add another face" action against an
existing person.

## Two people in frame is tested only against constructed sequences

**What.** AE9 (two people are two appearances) and AE10 (a different person inside the gap window does
not inherit the identity) are covered by unit tests over synthetic embeddings. Neither has been
exercised against two real people in front of the camera.

**Why it shipped anyway.** Same reason as the threshold: only one face was available. The tracker's
logic is where a wrong answer produces a wrong name, so it is tested hard — but against vectors the
test authored, not against a second human.

**What would discharge it.** A second person, once. It is the same missing ingredient as the
threshold, and one session with a colleague would close both.
