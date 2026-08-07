# Vision — accepted residuals

Shipped from `docs/brainstorms/2026-08-06-webcam-observation-requirements.md`. These are known and
accepted, not oversights.

## The captioner disagrees with itself, and HAL reports it as change

Measured on a Logitech C310 against Qwen2.5-VL-3B: consecutive captures of a stationary ceiling fan
described three blades, then four, then three. The summariser reads that wobble as something
happening and says so, which is the one thing the Vision prompt is written to prevent.

Two causes, only one of them the model's: a low-grade webcam genuinely produces different frames, and
the captioner rewords and miscounts on top of that. Prompt instructions to treat differently-worded
descriptions of the same subject as unchanged did not hold — the local chat model does not follow
them reliably.

The shipped caption prompt asks the captioner not to give exact counts. **It does not obey.** Later
testing produced "three red cups and a pair of headphones" and "two computer monitors" from the same
prompt, and the summariser turned that variance into a fabricated event: *"One cup was placed on the
desk between cycles."* Nobody moved a cup.

Note what that costs. The ceiling-fan case was harmless noise; this invents history, stated as fact,
in a feed the user reads as a record. Prompting the captioner does not fix it, because a small model
under-follows a prohibition, and prompting the summariser cannot fix it either — it never sees the
image, so it has no way to tell an invented count from an observed one.

Accepted for now, with the mitigation known not to work. The only lever that would is collapsing
near-identical captions before the summariser sees them — a change gate on text rather than pixels,
upstream where the noise is generated. R20 keeps that insertion point open, and
`docs/solutions/an-instruction-that-fights-its-own-input-loses.md` is why it belongs there rather
than in another prompt rule.

## `always` forces speech, and speech about nothing invites invention

At the top of the sensitivity dial the summariser must produce an entry every cycle, including cycles
where nothing happened. A model with nothing to say and an instruction to speak reaches for the
differences between captions. This is inherent to the setting rather than a defect in it, and the
other three settings do not have it.

## The camera is held for as long as Vision is on

One ffmpeg owns the device from the moment Vision is enabled until it is switched off, because the
live preview and the capture cannot both open an exclusive device. The consequences are accepted: the
camera light stays on continuously, and no other application can use the camera meanwhile.

The preview is served as `multipart/x-mixed-replace` from `/api/vision/stream`, which returns 503
while Vision is off rather than opening a camera to satisfy a request.

The route checks `Host` and `Origin` through the same predicate the WS hub uses (`server/src/origin.ts`).
That check was missing at first, and review found it: loopback binding alone does not defend a route,
because DNS rebinding points an attacker's hostname at 127.0.0.1 and any page the user visits can
then embed the stream in an `<img>`. The earlier claim here — that the route sat at "the same trust
boundary as the rest of the HTTP surface" — was wrong in a way worth recording: the rest of that
surface is static assets and a health check, while this one is live video of the user.

What remains outstanding is what `feat-ambient-log-monitors.md` already owes: a per-boot token. The
origin check narrows the window on both surfaces; it does not shut it.

## The captioner is a separate process the user starts

HAL talks to a configured endpoint and reports its absence through readiness; it does not launch or
supervise the captioner. Whether HAL should own that process is still open, and is the difference
between "works after you start two things" and "works".

`llama-server` also defaults to permissive CORS and no API key. It is bound to loopback and HAL
treats it as untrusted, but nothing stops a user pointing `captionerEndpoint` somewhere else — the
setting is not validated against loopback.

## Frames are retained without an expiry

The rolling window is bounded by count, not by age, and is purged only when Vision is switched off or
the user clears it. A window of twenty frames at a one-minute interval is twenty minutes of history;
at a one-hour interval it is most of a day.

## Raw observations are not replayed to a client that connects late

Cycle summaries reach the narration feed and therefore its ring buffer and backlog, so what HAL
*said* survives a reconnect. The captions that produced it do not: observations are one-shot
broadcasts accumulated in the client, lost on reload. An agent that attaches after a cycle can read
the conclusion but not the evidence.

Deferred rather than accepted: the fix is the same ring-buffer-plus-backlog treatment narration
already has, and it is worth doing if Vision's output is ever disputed.

## Thin coverage on the two ffmpeg-facing modules

`capture.ts`'s device enumeration and `captioner.ts`'s HTTP client are exercised only through fakes;
neither has a direct test. Both are thin wrappers whose failure modes are the surrounding process and
network, which is the part a unit test would have to fake anyway.

The stream's own process lifecycle *is* covered now, and so is the real scheduler — the seam-only
gap that `docs/solutions/tests-that-lock-in-the-bug.md` warns about was closed rather than repeated.

## Not built

Face recognition, the change gate, and correlated narration across all three observation roles. Each
has its seam cut — R20 for the gate, R21 for identity — and none is started.
