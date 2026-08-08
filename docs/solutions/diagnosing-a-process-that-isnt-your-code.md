---
title: Before diagnosing behaviour, prove the running process and the open tab are actually your code
date: 2026-08-06
last_updated: 2026-08-07
category: pattern
tags: [windows, process-management, dev-loop, verification, stale-build, diagnosis]
module: server/src/app.ts, ui/dist
symptoms:
  - a shipped feature is entirely absent from the running app
  - the UI does not reflect a change that is definitely in the built bundle
  - "\"I stopped the server\" but the port is still listening"
  - a fix appears not to work, and re-applying it changes nothing
  - stale servers accumulate on incrementing ports across a session
  - an automated check passes against a process it did not start
  - a bug is reported for behaviour that was already fixed and committed
  - a server-side fix appears to do nothing, and the code plainly contains it
---

## Context

Three separate diagnoses in one session were aimed at a system that was not
running the code being diagnosed. Each cost real time, and none of them was a
code defect.

1. A monitors feature "wasn't working" — the browser tab was running a bundle
   from before the feature existed.
2. A verified fix "didn't take" — the server had been restarted, but the open
   tab still held the pre-fix JavaScript, and it was that tab driving the
   behaviour being measured.
3. Five smoke-test servers were left listening for hours after being "stopped".

The generalisable failure: **a running process and an open page are each a
snapshot of the code at the moment they started.** Neither follows the
filesystem. A test suite passing against source proves nothing about what a
long-lived process is executing.

## Guidance

### `pkill` does not reliably kill this stack on Windows

`pkill -f "node server"` matches nothing, because `npm start` runs
`tsx src/index.ts`, which spawns `node` with a command line containing
`tsx/dist/cli.mjs` — not the string being matched. Worse, a shell one-liner that
ends in `; echo stopped` prints `stopped` regardless, so the failure is silent
and looks like success.

Kill by what is actually holding the port, and verify afterwards:

```powershell
Get-NetTCPConnection -LocalPort 9000 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
# then confirm it is gone, rather than assuming
Get-NetTCPConnection -LocalPort 9000 -State Listen -ErrorAction SilentlyContinue
```

### Identify a process before trusting or killing it

`Win32_Process.CommandLine` distinguishes `npm start` (plain `tsx`, frozen at
the code on disk when it launched) from `npm run dev:server` (`tsx watch`, which
hot-reloads). `StartTime` tells you whether it predates the work you are
testing.

```powershell
Get-CimInstance Win32_Process -Filter "ProcessId = 1234" |
  Select-Object CommandLine, CreationDate
```

A process older than the commit you are testing cannot be running it. That one
check would have short-circuited two of the three diagnoses above.

### A server restart does not reload an open tab

Restarting the core re-reads `ui/dist` for *new* page loads. A tab that is
already open keeps its JavaScript until it is reloaded, and keeps driving the
server with the old code's behaviour. When measurements disagree with a fix,
check for connected browsers before doubting the fix:

```powershell
Get-NetTCPConnection -RemotePort 9000 -State Established |
  ForEach-Object { (Get-Process -Id $_.OwningProcess).ProcessName }
```

A `brave` or `msedge` process in that list means a page is participating in
whatever you are measuring.

### A server-side fix and a UI fix each need a different step, and neither is optional

The instances above are all about a *stale process*. A fifth, on 2026-08-07, is the same failure
arriving through two different doors, and it produced a bug report for behaviour that had already
been fixed.

The user reported "adding multiple images for the same person creates a new person instead". The
merge-by-name fix for exactly that had been written and committed. It had not been *restarted*:

```
enrolByName written:    20:39:33
running server started: 20:37:48
```

Two minutes. The running server predated the fix, so it did the old thing, and there was no way to
tell from the outside. Earlier the same session, the mirror-image case: a UI change was made and
`npm run build` was not run, so `npm run start` served a `ui/dist` from four hours earlier and the
whole feature appeared absent.

The two doors, and neither closes itself:

| Changed | Required before testing | Symptom if skipped |
|---|---|---|
| anything under `server/` or `shared/` | restart the server | old behaviour, reported as a bug |
| anything under `ui/` | `npm run build`, then restart | feature entirely absent from the app |

`npm run dev:server` + `npm run dev:ui` reload on change and have neither problem — the trap is
specific to `npm run start`, which serves a built bundle from a process started once.

**The diagnostic is a timestamp comparison, not a code read.** Before investigating a reported bug,
compare when the fix was written against when the process started:

```bash
ls -l --time-style=+%H:%M:%S server/src/vision/people.ts
pid=$(netstat -ano | grep LISTENING | grep ":9000 " | awk '{print $5}' | head -1)
powershell -NoProfile -Command "Get-Process -Id $pid | Select-Object -ExpandProperty StartTime"
```

If the process is older than the file, there is nothing to debug.

### Verify the running instance serves the code you think it does

Health endpoints report a static version string and cannot tell a stale build
from a current one. Probe for a capability the new code has and the old does
not — a new protocol message, a new field:

```js
ws.send(JSON.stringify({ type: "get-settings" }));
// new build carries `prompts` and `settings.monitorPrompt`; old build does not
```

### An automated check must prove it started the process it is measuring

The three cases above cost time and produced confusion. A fourth, from building
`scripts/screenshot.mjs`, is worse than confusion: it manufactures evidence.

The script boots a server on a fixed port, waits for it to answer, drives the UI
and saves PNGs. On Windows the child is spawned through a shell, so `child.kill()`
signalled the shell and left `node` holding the port. The next run's server then
exited immediately with the port in use — and the readiness probe, which only
asked "does anything answer on this port", was satisfied by the *previous* run's
instance. The tool screenshotted a stale build, reported success, and wrote files
that looked exactly like proof.

A liveness probe answers "is something listening", never "is this my process".
Close the gap on both ends:

```js
// Kill the tree, not the shell that was signalled.
spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]);

// Then refuse to trust a port this run did not claim.
if (server.exitCode !== null) {
  throw new Error(`Server exited immediately — port ${PORT} is held by an orphan.`);
}
```

The general rule: any tool whose output is used as evidence must fail loudly
when it cannot confirm it is measuring its own process. A verification tool that
can silently verify the wrong thing is worse than no verification tool, because
its artifacts are trusted.

## Why This Matters

Every one of these looked like a product bug. Two produced plausible wrong
theories that took real work to rule out, and the third quietly consumed
machine resources for hours.

The cost is asymmetric: confirming what a process is takes one command, while
diagnosing a defect that isn't there takes many — and can end in "fixing"
something that was never broken.

## When to Apply

Before diagnosing any behaviour observed in a running instance, and specifically
whenever:

- a change is definitely in the source but not visible in the app
- a fix appears not to have worked
- behaviour disagrees with a passing test suite
- anything is claimed to have been stopped, restarted, or cleaned up
- writing or trusting any tool that boots a process and reports on what it saw

## Examples

The check that would have prevented all three, in one command:

```powershell
Get-NetTCPConnection -LocalPort 9000 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $($_.OwningProcess)"
    "{0}  started {1}" -f $p.CommandLine, $p.CreationDate
  }
```

If the start time predates the work being tested, stop reading the code and
restart the process.
