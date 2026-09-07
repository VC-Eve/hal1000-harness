---
title: Terminating a worker during a native call aborts the whole process
date: 2026-09-07
category: pattern
tags: [worker-threads, native-addons, onnxruntime, cancellation, deadline, process-crash, windows]
module: server/src/voice/synth.ts, server/src/live/tempo.ts
problem_type: crash
symptoms:
  - the process exits with 3221226505 / 0xC0000409 and no stack
  - worker.terminate() never resolves and no exit event fires
  - a deadline that should have bounded work took the whole server down instead
  - a test that stops a worker mid-task hangs until its timeout
---

# Terminating a worker during a native call aborts the process

`worker.terminate()` is safe for JavaScript. It is not safe while the thread is inside a native
call, and the failure is not an exception you can catch — it is the process dying.

## Measured

A worker holding an `onnxruntime-node` session, terminated **during** `session.run()`:

```
exit code 3221226505  (0xC0000409, STATUS_STACK_BUFFER_OVERRUN)
no 'exit' event, no 'error' event, terminate() never resolves,
no process 'exit' handler runs
```

The control — the same worker, session loaded, **no run in flight** — terminated cleanly with code
1 and fired every event you would expect. So it is not the session, the model size, or the addon
being loaded. It is specifically tearing down V8 while a native frame is on the stack.

## Why this bites the obvious design

The reason to put synchronous work on a worker thread is usually so a timer on the main thread can
bound it — that is exactly what `server/src/live/tempo.ts` does, and its comment says so: on the
event loop the deadline could not fire until the work it was bounding had already finished.

That precedent is safe because the tempo worker's expensive work is **synchronous JavaScript**.
Copying its shape for native work inherits the timer and loses the safety, and the resulting crash
looks nothing like a cancellation bug: no stack, no message, and on Windows a bare hex code.

## What to do instead

**Bound the input, not the wall clock.** If the work has a natural ceiling — a token limit, a frame
count, a file size — refuse anything above it before dispatch, and then there is nothing to cancel.
`server/src/voice/synth.ts` refuses a sequence longer than the model's own 510-token cap, so a run
is bounded by construction and no timer is needed.

**Make the unsafe call unreachable rather than documented.** The first draft of `synth.ts` wrote the
hazard into its file header in bold and gave `stop()` a comment saying it was safe only when nothing
was in flight. The very next thing written against it was a test that stopped over a live render; it
hung for two minutes. `stop()` now awaits the dispatched run before terminating, and `pump()` refuses
to dispatch while a stop is in progress. A comment is not a mechanism: a hazard you write down is
one you will hit.

**Settle the waiters before you decide anything.** A thread that dies while `stop()` is waiting on it
must still release that wait. An early `if (this.stopping) return;` at the top of the death handler
left the in-flight promise unresolved, so `stop()` never reached its `finally`, its `stopping` flag
latched true, every later start was refused for the life of the process, and shutdown hung. Reject
the waiters first, then decide whether the death was deliberate — *both* sets of waiters: the fix
moved the in-flight queue above the stop check and left the startup promise below it, which is the
same hang one line lower, reachable by stopping while the 325MB model is still loading.

**"Settle first" is not "settle unconditionally".** A round-two review found the other edge of the
same fix. Node emits `error` and then `exit` for one thread death, and a caller that retries in the
gap has a healthy replacement by the second event. Failing every waiter on that second event rejects
the *successor's* live request and clears the very wait `stop()` relies on. The identity check —
is this the thread I still hold? — has to come first, and only then the settling. A worker already
replaced had its waiters failed when it was replaced; there is nothing left for its death to do.

## If you genuinely need cancellation

Use a **child process**, not a worker thread. `kill()` on a separate process is safe whatever it is
doing, at the cost of shipping results over IPC rather than a structured clone. That trade is
written up in `docs/residual-review-findings/feat-live-character-speech.md` under the first entry,
including why it was not taken for speech.

## Related

- `server/src/live/tempo.ts` — the safe precedent, and why it is safe (synchronous JS, not native)
- `docs/residual-review-findings/feat-live-character-speech.md` — the accepted in-process crash risk
- `docs/solutions/exclusive-device-one-owner-many-consumers.md` — the other half of worker lifecycle:
  one owner, many consumers, and the bill arriving as process lifecycle
