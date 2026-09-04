---
title: A scratch data dir is safe until you invite the user to author in it
date: 2026-09-03
category: workflow
tags: [data-loss, scratchpad, env-override, agent-workflow, recovery, verification, backup]
module: server/src/paths.ts, docs/worlds
problem_type: workflow_issue
symptoms:
  - the app's picker is empty and the default data dir was never created
  - work the user did inside an agent-started instance cannot be found anywhere
  - a filesystem search for the app's state turns up only test fixtures
  - the only trace of where it went is an env override in a shell command from an earlier session
---

An agent started HAL with `HAL_DATA_DIR` pointed at its own scratchpad, built a World
in that instance at the user's request, and handed over the URL. A day later the World
picker was empty and the user asked where their World had gone. It was 95MB of
authored work — 7 States, 18 transitions, 5 Parameters, 104 clips — sitting in a
directory the harness deletes when the job is cleaned up.

Nothing malfunctioned. `dataDir()` in `server/src/paths.ts` read the override and
honoured it exactly as designed, and `AGENTS.md` describes `HAL_DATA_DIR` as a test
env override. The whole failure is in *when the decision was made* and *when it was
not re-made*.

## The isolation was right, and then it outlived its reason

The session transcripts make the sequence exact.

The agent set the pattern deliberately and for a good reason: "SW's instance is live
on 9000, so I won't touch `ui/dist`. Verifying against a separate core on 9100 plus
Vite dev instead." Every verification pass after that ran a second core against
`…\Temp\claude\<project>\<session-id>\scratchpad\haldata`. That is exactly what the
override exists for — a test run must not write into `%APPDATA%\hal1000`.

Sixteen hours later the user asked, "can you create a scene using the files we have
saved to create an example world." The agent built the DJ Booth World *in that same
still-running instance* and handed it over: "The DJ Booth World is built from your
eight clips and running. Open `http://localhost:5173/live` and pick it."

At that moment the instance stopped being a test rig and became the user's tool. The
data-dir decision was never re-made. The only mention of a scratchpad data dir in the
entire session was a status bullet hours earlier, in a different context, phrased as a
verification detail — never as a statement about where the user's work would live.

The habit then carried into the next session unquestioned. By then the user was
reporting real usage symptoms ("sometimes on long transitions I notice it will
occasionally cut the end"), which is what using-it-as-your-tool sounds like.

**The rule:** an isolation choice is scoped to a purpose, not to a session. When the
instance's role changes — the moment you invite the user to open it, or author
anything in it on their behalf — the data-dir decision has to be made again, not
inherited. Two questions were conflated into one: *is this safe for the user's
existing data?* (yes, that is what isolation bought) and *is this safe for data the
user is about to create?* (no, and nobody asked).

The user cannot see the difference. Nothing in the UI says which data dir a tab is
bound to, so an isolated instance and the real one are indistinguishable to the only
person who would care. The burden sits entirely on whoever set the override.

## Finding it again: sort by size, not by name

The search that found it was `world.json` across `%APPDATA%`, `%LOCALAPPDATA%`,
Documents, Desktop and the repo. Every hit was a scratch directory, and the name
`world.json` separated nothing — several scratch Worlds were even called `dj-booth`.

Size separated it instantly. Every generated test World in this repo writes a manifest
of 1–3KB. The user's was **28,465 bytes**. Take the outlier.

```powershell
Get-ChildItem -Path $env:APPDATA, $env:LOCALAPPDATA, "$env:USERPROFILE\Documents" `
  -Recurse -Filter world.json -ErrorAction SilentlyContinue |
  Sort-Object Length -Descending | Select-Object Length, LastWriteTime, FullName
```

Recover by **copy**, never by move — a botched recovery must not be a second loss. The
scratchpad original was left in place.

Then verify through the running app rather than off disk: the recovered World was
confirmed by asking the live instance over its WebSocket protocol to list Worlds, which
answered `DJ Booth (id dj-booth, readable: true)`. Green checks are not evidence; the
server saying it is there is. See
[editing-state-a-running-process-caches-loses-the-edit.md](editing-state-a-running-process-caches-loses-the-edit.md),
which is the same instinct applied to a different loss.

## Verify recovered files by content, because names lie here

The manifest referenced 91 clips. A name-based comparison against the repo's tracked
clips in `server/src/live/clips` reported **18 missing** — which would have meant real,
irrecoverable video loss.

It was a false alarm, and the reason is a HAL behaviour worth knowing: the clip importer
appends `_-2`, `_-3` on a filename collision, so importing the same file twice produces
names that exist only inside that World. Hashing every referenced clip found all 91
byte-identical to files already in the repo. Nothing was ever at risk except the 28KB
manifest.

```powershell
$repo = @{}
Get-ChildItem C:\GitHub\hal1000-harness\server\src\live\clips -Filter *.mp4 -Recurse |
  ForEach-Object { $repo[(Get-FileHash $_.FullName -Algorithm SHA256).Hash] = $_.Name }
# every referenced clip whose CONTENT is absent from the repo — empty means nothing lost
```

The name-based answer and the content-based answer disagreed and only one was true.
Any feature that renames on collision makes filename reasoning about file identity
actively misleading rather than merely imprecise — the filesystem-level case of the
principle in
[byte-identity-needs-an-oracle-recorded-first.md](byte-identity-needs-an-oracle-recorded-first.md).

## Back up the irreplaceable slice, not the bulk

Knowing the 95MB was reproducible and the 28KB was not is what made the backup
decision obvious: the manifest went into git at `docs/worlds/dj-booth.world.json`, the
video stayed out. Committing media to "back it up" would repeat, at thirteen times the
size, the accident this repo has already had — a `git add -A <path>` that pushed ~7MB
of the user's clips to `origin/main`.

Identify the irreplaceable slice before backing anything up. Here it was 0.03% of the
bytes.

One limitation, recorded in `docs/worlds/README.md` so a future restore does not
stumble on it: 18 of the 91 referenced names exist only inside the World, so restoring
from the manifest alone means copying a source clip once per suffixed name it asks for.

## What to do instead

- Before starting a server the user might touch, decide *and say* which data dir it
  writes to. Handing over a URL without that sentence is the whole failure.
- If the user will author in it, do not override the data dir at all — let it write
  where their work belongs.
- Treat anything under `%LOCALAPPDATA%\Temp\claude\…` as already deleted, not as
  temporary. Before a session ends, check whether the user created anything in a
  scratch-backed instance and copy it out.
- When re-using a running instance for a new purpose, re-derive the setup decisions
  rather than inheriting them. "It was safe for what I was doing then" is not an answer
  about what it is being used for now.

## Related

- [a-removed-precondition-blinds-every-test-that-set-it.md](a-removed-precondition-blinds-every-test-that-set-it.md)
  — its smoke recipe recommends exactly this override. Right for an unattended smoke,
  and sharp-edged the moment a human is handed the instance.
- [editing-state-a-running-process-caches-loses-the-edit.md](editing-state-a-running-process-caches-loses-the-edit.md)
  — the sibling failure: user data lost with no error, and verification through the
  live view rather than the file.
- [diagnosing-a-process-that-isnt-your-code.md](diagnosing-a-process-that-isnt-your-code.md)
  — prove the running process is your code; this extends the same ordinal to its state.
- `docs/residual-review-findings/feat-live-scene-worlds.md` records the opposite hazard,
  two instances sharing one data dir and overwriting each other. Divergent data dirs are
  the other half of that risk: nothing is overwritten, and the work is simply invisible.
