---
title: Windows hardening — rename retries for atomic writes, loopback binding, unique temp names
date: 2026-08-02
category: pattern
tags: [windows, nodejs, atomic-write, EPERM, EBUSY, EADDRINUSE, filesystem]
module: server/src/storage/atomic.ts, server/src/app.ts
symptoms:
  - intermittent EPERM/EBUSY on fs.rename over an existing file on Windows
  - EADDRINUSE not surfacing reliably when binding the same port twice
  - corrupted JSON when two writes to the same file overlap
---

## Patterns (all implemented in this repo)

1. **Atomic JSON writes need a bounded rename retry on Windows.** Defender and indexers
   intermittently hold destination files, failing `fs.rename` with EPERM/EBUSY/EACCES even
   when nothing is "wrong". `writeJsonAtomic` retries the rename up to 5× with 50ms delay,
   retrying only those codes; other errors throw immediately and the temp file is removed.

2. **Temp file names must be unique per write, not per process.** A deterministic temp name
   (`file.pid.tmp`) collides when two writes to the same target overlap inside one process —
   the second `writeFile` truncates the first writer's temp, and one rename steals the file.
   Append a random component (`crypto.randomUUID().slice(0,8)`), and serialize logical
   read-modify-write cycles per entity (see ConversationStore's per-id promise-chain lock).

3. **Bind localhost servers to `127.0.0.1` explicitly, never the default `::`.** Windows
   dual-stack binding makes double-bind detection unreliable (the second bind may not fail
   cleanly), and loopback-only is the right security default for single-user local tools.
   Note `~` is not expanded by Node on any platform — always `os.homedir()`.

## Prevention

Treat these as defaults for any Node service that must run on Windows, not as fixes to
rediscover: retry-wrapped renames, randomized temp names + per-entity write serialization,
and explicit loopback binds.
