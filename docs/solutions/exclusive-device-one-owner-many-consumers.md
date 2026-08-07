---
title: An exclusive device gets one owner and many consumers — and the owner needs a lifecycle
date: 2026-08-06
category: pattern
tags: [process-lifecycle, ffmpeg, child-process, webcam, exclusive-resource, fan-out, races]
module: server/src/vision/stream.ts, server/src/vision/service.ts, server/src/http.ts
symptoms:
  - two copies of a spawned process are running when only one should be
  - a device reports as busy and the only holder is a process this app orphaned
  - a stale frame or reading keeps being served after the source died, with no fault raised
  - a restart backoff never applies because something else keeps restarting the thing first
---

# An exclusive device gets one owner and many consumers

A webcam can be opened by exactly one process. That single fact decides the architecture of
anything that wants to both show a live view and take stills from the same camera.

## The trap

The obvious build is a browser preview via `getUserMedia` beside a server-side capture. It looks
right and it destroys the capture: the browser takes the device, and the server's ffmpeg can no
longer open it. Worse, it fails quietly in the direction you are least likely to test — the preview
is the visible half, so you see a live picture next to a still that never updates again.

The same shape appears wherever a resource admits one holder: a serial port, an exclusive-lock file,
a single audio input.

## The shape that works

One long-running process owns the device, and everything else reads from it.

Here `CameraStream` holds one ffmpeg emitting MJPEG, and its frames fan out to two consumers: the
`multipart/x-mixed-replace` preview route in `server/src/http.ts`, and the interval capture in
`server/src/vision/service.ts`. A capture stopped being a process spawn and became a buffer read —
three seconds down to nothing.

## The part that actually costs you

Fan-out is easy. The bill arrives as process lifecycle, and every bug found in review lived there,
not in the frame splitting.

**A superseded child must not act.** `start()` with a changed device kills the old child and spawns
a new one. The old child's `close` fires *later* — by which time `this.child` is the new one. The
handler scheduled a restart anyway, so five seconds later a third process spawned and overwrote the
handle, orphaning a live process that still held the camera:

```ts
child.on("close", () => {
  if (this.child !== child) return;   // only the current child may restart
  this.child = null;
  this.latest = null;                 // the frame died with the process
  this.buffer = Buffer.alloc(0);      // don't splice a dead frame onto the next one
  this.scheduleRestart();
});
```

Every handler needs the same guard — `stdout`, `stderr`, `error` — or a dying process's trailing
bytes land in the live process's parser and its last complaint overwrites the live error state.

**A dead source must stop answering.** Keeping `latest` after the process exits meant `grabWhenReady()`
kept succeeding, so the system captioned a frozen scene as though it were live and raised no fault at
all. A stale reading served confidently is worse than an error.

**A supervision tick must not cancel the backoff it is supervising.** The service reconciles itself
with settings every two seconds and calls `start()` each time. `start()` only early-returned when a
child existed — so with the child dead and a five-second restart pending, it cleared the timer and
respawned immediately. The backoff never once applied:

```ts
if (this.device === device && (this.child || this.restartTimer)) return;
```

A pending restart counts as "already started". Anything less turns a deliberate backoff into a
spawn loop at the tick's frequency.

**Work that spans awaits needs a generation.** A capture awaits a frame grab and then a caption —
seconds to minutes — and the user can switch the feature off in between. A generation counter bumped
on teardown lets the resumed work discover the world it started in is gone, before it writes a file
into a directory that was just purged or repaints a status that shutdown already set.

## Testing it

Fake the *timing*, not just the outcome. These bugs only exist because a killed process reports its
exit asynchronously, so a fake whose `kill()` emits `close` synchronously hides every one of them:

```ts
kill() {
  this.killed = true;
  setTimeout(() => this.emit("close", 0), 0);
}
```

`server/test/vision/stream.test.ts` covers the four failures above and was checked against the
pre-fix code — three of them fail there. A regression test that has never seen the bug red is a
guess; see `tests-that-lock-in-the-bug.md`.

## When this applies

- Wrapping any single-holder OS resource behind a process that serves several consumers.
- Any supervised child with restart logic, especially when a periodic tick also calls `start()` for
  unrelated reasons.
- Any multi-await operation that an external state change can invalidate mid-flight.
