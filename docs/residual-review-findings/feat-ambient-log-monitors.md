# Residual review findings — feat/ambient-log-monitors

Source: 10-reviewer code review of `0dd2d23..14939bc`, 32 files / ~3,500 lines.
Artifacts: `/tmp/compound-engineering/ce-code-review/20260806-003f2775e/`
User decision: merge to `main` with the P0 below accepted, remaining items deferred.

Thirteen findings were fixed and shipped in `14939bc`. What follows is what was **not** fixed.

## P0 — narrowed, not yet closed

**Status: mitigated by an origin allowlist. The complete fix is still outstanding.**

The original exposure and the reasoning are kept below because they explain why the current
mitigation is shaped the way it is.

**What changed.** `server/src/ws.ts` now accepts a browser origin only when its port matches the port
the server is actually listening on — in practice HAL's own UI. A loopback origin on any other port
is refused and logged. `HAL_DEV_ORIGIN` allows one extra origin for a non-standard setup, and Vite's
default dev origin is trusted only while the core runs under its own `dev` script
(`npm_lifecycle_event === "dev"`), so `npm start` never trusts it. Requests with no `Origin` are
still accepted: they are not browsers, a local process already has execution, and refusing them
would cost agent-native parity while closing nothing. Covered by four tests in
`server/test/boot.test.ts`.

**What is still open.** This narrows the window rather than shutting it. While `dev:ui` is running,
a page served from the Vite port would be trusted. The complete fix remains the per-boot token
described under "Fix direction" below, and it is worth doing next time the WS layer is touched.

**Why not a password.** Considered and rejected: the protection in either design comes from browser
origin isolation, not from a credential, so a password adds a login screen, hashing, session
lifetime, and a reset path while buying nothing the token does not. Agents cannot type passwords, so
agent-native parity would require a token regardless — making it password *plus* token rather than
instead of. Revisit only if HAL is ever exposed beyond loopback, where a password becomes one part
of a much larger piece of work.

---

### Original exposure (for context)

**Any page on any localhost port could schedule a shell command on this machine.**

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

## Closed after shipping

- **The severity heuristic was wrong in practice, and is now per-monitor.** The plan recorded
  "severity will be wrong in both directions" as an accepted risk. Observed on the real Ollama log
  within minutes of running: llama.cpp writes "checkpoint check failed" and "erased invalidated
  context" as routine slot output, so a monitor set to quiet interrupted roughly every thirty
  seconds. A Monitor now carries its own rule — shipped keywords, its own pattern, or never — and
  the Ollama suggestion ships with a pattern matching what actually indicates trouble. A stated
  level still wins over a pattern; an uncompilable pattern falls back to keywords rather than
  silencing the monitor.
- **The component-test gap is closed.** `ui/test/components/` runs under jsdom and covers what pure
  modules cannot: disabled states, what gets sent, and how often an effect runs. It exists because a
  mount effect depending on an unstable `send` shipped an unbounded request loop past 300 tests and
  a ten-reviewer review. See `docs/solutions/tests-that-lock-in-the-bug.md`.

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
