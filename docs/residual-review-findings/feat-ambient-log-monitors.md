# Residual review findings — feat/ambient-log-monitors

Source: 10-reviewer code review of `0dd2d23..14939bc`, 32 files / ~3,500 lines.
Artifacts: `/tmp/compound-engineering/ce-code-review/20260806-003f2775e/`
User decision: merge to `main` with the P0 below accepted, remaining items deferred.

Thirteen findings were fixed and shipped in `14939bc`. What follows is what was **not** fixed.

## Accepted risk — P0, unmitigated

**Any page on any localhost port can schedule a shell command on this machine.**

`server/src/ws.ts` admits a WebSocket connection when the `Origin` hostname is `localhost` or
`127.0.0.1`, on **any port**, and admits any client sending no `Origin` at all. That guard was
written when the protocol could only read conversations and change settings.

Monitors added `add-monitor`, which accepts a `MonitorSource` of kind `command` and schedules it
through the platform shell. The combination means a page served from any other local port — another
dev server, a local tool's web UI, anything opened in a browser while HAL is running — can open the
socket and obtain code execution as the user.

This is an escalation introduced by this feature, not a pre-existing condition. It was surfaced
before merge, and merging with it open was a deliberate decision.

**Why the obvious fix does not work.** Narrowing the allowlist to HAL's own port breaks
`npm run dev:ui`: Vite proxies the WebSocket upgrade and forwards its own origin, so the dev
workflow would be rejected.

**Fix direction when this is picked up.** A per-boot secret: generate it at startup, write it to the
data dir, inject it into the served UI, and require it as a WS subprotocol or first-message
handshake before any handler runs. That closes the browser vector without touching the loopback
bind or the origin check, and it survives the Vite proxy because the token travels with the client
rather than the origin.

**Cheaper interim option, if the full handshake is not wanted yet.** Gate `command`-kind sources
specifically — a monitor whose source is a command stays inert until confirmed out of band (for
example a token printed to the server console). File-tail monitors are materially weaker as a
vector, since a new monitor seeks to end-of-file and yields nothing from a static secret file.

## Deferred, with reasons

- **Process-tree kill on command timeout.** `exec`'s timeout kills the shell but not reliably its
  grandchildren on Windows, so a habitually-timing-out command could orphan processes. Flagged by
  security and reliability, both at 50% confidence. Needs `taskkill /pid <pid> /T /F` plumbing and a
  test asserting the descendant is gone; the shipped suggestions are short-lived, so the exposure is
  narrow.
- **No coverage of the real scheduler.** Every `MonitorService` test drives `pollNow()` or `sweep()`
  directly, so the per-monitor `setInterval` and the sweep timer are unproven. Needs fake timers.
  See `docs/solutions/tests-that-lock-in-the-bug.md` — this is the third shape described there.
- **The file-tail state machine is still duplicated.** `readByteRange` is now shared between
  `FileMonitorRunner` and `ClaudeCodeWatcher`, but the offset, decoder, and partial-line policy are
  not. They will drift; a Windows fix applied to one will silently not apply to the other. Unifying
  them means restructuring a well-tested watcher and belongs on its own.
- **`--since` incremental filtering for journald.** Dropped from the shipped suggestions because the
  timestamp format could not be verified from Windows, and a wrong format makes the monitor silently
  blind rather than noisy. `journalctl -n 200` plus line-identity dedup is the current approach; the
  cost is a slightly larger read per poll.
- **Command dedup is permanent.** A line identical to one still inside the 500-entry window is never
  re-reported, so a failure that repeats verbatim is announced once. Correct for a re-emitting
  window; arguably wrong for a recurring fault that deserves a reminder.
- **`MonitorEvent` lives in the wire contract but never crosses it.** Only server modules use it.
  Belongs in `server/src/monitors/monitor.ts`.

## Notable residual risks (report-only)

- Command strings persist in plaintext in `monitors.json` and are broadcast to every connected WS
  client. A credential embedded in a command is exposed to anything that can read the data dir or
  open the socket. The UI gives no warning.
- Monitored log content enters the model prompt verbatim, so a log line carrying prompt-injection
  text can steer narration. Bounded: output renders as React text and drives no tool use.
- `dev:ino` file identity is unreliable where Node reports `ino` 0 (some Windows volumes, SMB
  shares). The `size < offset` branch covers most rotations, so exposure is narrow.
- No idle-stream timeout on provider calls. A stalled stream pins a monitor's `narrating` flag and
  grows its buffer. Pre-existing in the provider layer, now reachable per monitor.
- The `shared/` workspace-identity residual from v1 is materially worse: this feature added ~75
  lines to `shared/src/types.ts` and roughly a dozen new hand-computed `../` import sites. The
  mechanical fix gets more expensive the longer it waits.

## Operational validation

Local single-user tool, no deployment surface. Healthy signals: `npm start` serves and
`/api/health` returns `{ok:true}`; console stays free of `monitor handler error`, `monitor sweep
error`, and `monitor <id> poll error`. Failure signals worth watching: repeated status entries from
one monitor (should now be transition-only), and monitor narration lagging visibly behind chat under
load. Rollback: `git revert` of `14939bc`; monitors live in `monitors.json` in the per-OS data dir
and survive any rollback.
