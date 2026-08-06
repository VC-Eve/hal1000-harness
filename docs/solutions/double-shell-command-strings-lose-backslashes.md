---
title: A command string crossing two shells loses its backslashes before the second one parses it
date: 2026-08-06
category: bug
tags: [windows, powershell, cmd, child_process, shell-escaping, regex, silent-corruption]
module: server/src/monitors/catalog.ts, server/src/monitors/runner.ts
symptoms:
  - every letter "s" missing from command output ("start type" renders as " tart type")
  - a -replace or regex in a PowerShell -Command string matches the wrong thing
  - command succeeds, exit code is 0, output is subtly wrong rather than absent
  - no error anywhere; only reading the output closely reveals it
---

## Problem

The Windows event-log monitor formatted its output with a PowerShell `-replace` to collapse
newlines:

```
Get-WinEvent -LogName System | ForEach-Object { "$($_.Message -replace '\s+',' ')" }
```

Run through `child_process.exec`, every message came back with the letter `s` deleted. "The start
type of the Background Intelligent Transfer Service service was changed" arrived as "The tart type
of the Background Intelligent Tran fer ervice ervice wa changed".

## Root cause

The string crosses **two** interpreters before PowerShell's regex engine sees it:

1. It is a JavaScript string literal — `"\\s+"` in source becomes `\s+` in memory.
2. `child_process.exec` hands that to the platform shell. On Windows that is `cmd.exe`, which does
   its own quoting pass over the `-Command "..."` argument and consumes the backslash.
3. PowerShell finally parses `'s+'` — a valid regex matching one or more literal `s` characters.

So `-replace '\s+',' '` silently became "replace every run of the letter s with a space". Nothing
errors: the command exits 0 and produces plausible-looking output. Only comparing it against the
real log reveals the corruption.

The general shape: **any command string that is authored as a JS/TS literal, passed through a shell,
and then parsed by a second interpreter loses backslash escapes at the first boundary.** The second
interpreter never sees them. This applies to `powershell -Command`, `sh -c`, `bash -lc`, `wsl`, and
anything else that re-parses an argument.

## Fix

Express the characters without backslashes. PowerShell has character codes:

```
$_.Message.Replace([char]13,' ').Replace([char]10,' ')   # CR, LF
... -join [char]9                                        # tab
```

`server/src/monitors/catalog.ts` uses this form, and `server/test/monitors/catalog.test.ts` asserts
the command contains no `\s` at all so the regression cannot return quietly.

## Prevention

- When building a command string that a second interpreter will parse, prefer character codes,
  `[char]N`, `$([char]0x0A)`, or the target language's own escape mechanism over backslash escapes.
- Assert on the constructed command string in a test. Shape assertions are cheap and this class of
  bug produces no error to catch.
- Run the command once and read the output against a known-good source before trusting it. This bug
  was invisible in the command string and obvious the moment the first three lines were compared to
  the actual event log.
- Suspect it whenever output is subtly wrong rather than missing — silent corruption with a zero
  exit code is the signature.
