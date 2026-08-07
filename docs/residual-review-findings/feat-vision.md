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

Accepted for now. The shipped caption prompt asks the captioner not to count objects, which removes
the largest single source of false change; the rest is lived with. The next lever, if it becomes
annoying, is collapsing near-identical captions before the summariser sees them — a change gate on
text rather than pixels. R20 keeps that insertion point open.

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
while Vision is off rather than opening a camera to satisfy a request. The route inherits the
server's loopback binding and has no auth of its own — anything that can reach the port can watch the
camera, which is the same trust boundary as the rest of the HTTP surface.

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

## Not built

Face recognition, the change gate, and correlated narration across all three observation roles. Each
has its seam cut — R20 for the gate, R21 for identity — and none is started.
