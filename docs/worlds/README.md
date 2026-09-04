# World manifests, kept as backups

A World is a portable folder — a manifest plus a `clips/` directory — and it lives
in the data dir, not here. What is tracked here is the **manifest only**: the graph
an author built, without the video.

That split is deliberate. The manifest is small enough to diff and to keep history
for; the clips are not, and putting 95MB of video under `C:\GitHub\hal1000-harness`
puts it one careless `git add -A` away from `origin/main`. That has happened here
once already, with 7MB.

## Restoring one

The working copy belongs in the data dir — `%APPDATA%\hal1000\worlds\<id>\` on
Windows. Copy the manifest back as `world.json`, then put the clips it names into
that World's `clips/` folder.

**The clip names will not all match what is in `server/src/live/clips`.** Importing
the same file twice nudges the second name, so a manifest can reference
`…_-2.mp4`, `…_-3.mp4` and so on. Every one of those is a byte-identical copy of
the file with the base name — verified by content hash for `dj-booth` on
2026-09-03, where 18 of 91 referenced clips were duplicates of this kind. Restoring
means copying the source clip once per suffixed name the manifest asks for; the
World reports every path it cannot resolve, so the panel will tell you which.

## What is here

- `dj-booth.world.json` — the DJ Booth: 7 states, 18 transitions, and the
  Parameters `dancing`, `tired`, `dj`, `dj_swing` and `energy`. Backed up after it
  was found living in a temp directory that would have been swept.
