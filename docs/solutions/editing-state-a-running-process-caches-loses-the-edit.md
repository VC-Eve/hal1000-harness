---
title: Editing state a running process caches loses the edit, and says nothing
date: 2026-08-07
category: bug
tags: [state, caching, migrations, data-loss, dev-loop, verification]
module: server/src/vision/people.ts, server/src/storage
problem_type: data_integrity
symptoms:
  - a hand-edit or migration to a JSON store appears to work and is later absent
  - a file on disk reverts to its previous contents with no error anywhere
  - the app shows stale data that a direct read of the file contradicts
  - a one-off data fix has to be applied twice
---

## Context

Five duplicate person records needed consolidating into two. The merge ran against
`vision-people.json`, verified its own output, and printed `records: 5 -> 2, faces: 8 -> 8`.

Minutes later the live roster still showed five records — with one of them holding an extra face.

`PeopleStore` loads the roster once and holds it in memory. HAL was running throughout. An enrolment
landed in the gap between the merge and the restart, `addFace` mutated the **cached** five-record
array, and `persist()` wrote that array back over the consolidated file. No error, no conflict, no
warning: last writer wins, and the last writer was holding a snapshot from before the edit.

The tell was not the file. The file looked wrong only if you knew what to expect. The tell was the
*live* roster disagreeing with what the migration had reported.

## Guidance

### Stop the process before touching state it owns

The rule is not "be careful", it is ordinal:

```bash
# 1. stop it, and confirm the port is actually free
# 2. edit / migrate / back up
# 3. start it
# 4. read the state back THROUGH the app, not off the disk
```

Step 4 is the one that catches this. A file read after step 2 proves nothing, because the clobber
happens later.

### Prefer going through the protocol to touching the file

Anything reachable over the WS protocol can be changed while the app runs, safely, because the app is
the single writer. A migration that has no protocol equivalent is a signal worth noticing: it means
the operation is one the app cannot do to itself, and the absence is often the real gap. The
consolidation here would have been better as a roster-merge message than as a script.

### An in-memory cache turns every external writer into a silent race

`PeopleStore`, `SettingsStore`, `CandidateStore` and `MonitorStore` all load once and write whole
files. That is the right design for a single-user local tool — right up to the moment a second writer
appears. Any store with `private cache` has this property, and none of them will tell you.

### Back up before, verify after — and verify the live view

The backup was taken and made the second attempt cheap. What was missing was the *after* check
against the running system rather than the file. Both halves are needed: the backup makes recovery
possible, the live read makes you aware you need it.

### Guard the invariant inside the migration

The merge refused to write if the total face count changed:

```
if (before !== after) { console.error('REFUSING: faces ' + before + ' -> ' + after); process.exit(1); }
```

That did its job — it would have caught a merge that dropped a face. It could not catch this,
because the loss happened *after* the write, outside the script entirely. A guard protects the
operation, not the window after it.

## Why This Matters

Silent is the operative word. A migration that fails loudly costs a retry. This one reported success,
and the only evidence was a live view that nobody would have compared against unless they were
already suspicious. On biometric data — where the file holds every face a user deliberately enrolled
— a silent revert is the failure mode that erodes trust in every subsequent migration.

## When to Apply

- Any hand-edit or script against `<data-dir>/*.json` while HAL is running.
- Any one-off data fix, including ones that feel too small to warrant stopping the app.
- Any time a migration reports success and the app then shows something else — check the cache before
  suspecting the migration.

## Examples

The full sequence, as it happened:

| Time | Event |
|---|---|
| 21:56 | merge script rewrites the file: 5 records -> 2, backup taken |
| ~21:57 | user names a face; running server mutates its cached 5-record roster |
| ~21:57 | `persist()` writes the stale roster back — the merge is gone |
| 21:58 | restart; live roster reads `Steve x4, Steve x1, Liam x2, Liam x1, Liam x1` |
| 21:59 | server stopped **first**, merge re-run, restart, live roster reads `Steve x5, Liam x4` |

Note the extra face survived both times — the second merge folded in the enrolment that had caused
the clobber. Nothing was lost in the end, which is exactly why this is worth writing down: the
near-miss looked like a non-event.
