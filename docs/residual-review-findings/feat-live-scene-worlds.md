# Residual findings — live scene-worlds

Accepted knowingly, 2026-09-01, after a twelve-reviewer pass over the whole feature. Everything
actionable that pass found is fixed and committed; what follows is what was raised and deliberately
not changed, with the reason and what would discharge it.

Two of these — the embeddable clip route and the missing manifest version — were already anticipated
by the plan (`docs/plans/2026-09-01-001-feat-live-scene-worlds-plan.md`). The rest were found by
review.

---

## The clip route is a new unauthenticated local surface

**What.** `/api/live/clip` rests on the Host check alone. `allowsOrigin` answers true for a missing
`Origin` by design so agents keep protocol access, and a `<video>` element sends no `Origin` and
cannot present the per-boot WS token — so the token, which is the second gate everywhere else, does
not apply here.

**Why it shipped anyway.** It is the same accepted trade `/api/vision/stream` already makes, and
that route serves live video of the user rather than a pre-generated clip. `allowsHost` is what
closes the DNS-rebinding hole, which is what would make the bytes *readable* cross-origin.

**What is still open, precisely.** Embedding is not stopped. Any page can put
`http://localhost:PORT/api/live/clip?world=…&clip=…` in a `<video>`: Host is loopback, Origin is
absent, and the request is served. The pixels are unreadable, but the `load`/`error` events are an
existence oracle for World ids and manifest clip paths, and the route can be flooded. `nosniff` is
now declared, so a later widening of the video MIME table cannot turn a clip into a same-origin
document that could read the token — but that is a guard against a future mistake, not against this.

**What would discharge it.** The per-boot token on local media surfaces generally — still owed, and
already recorded against the Monitor origin work in `feat-ambient-log-monitors.md`. Whatever closes
it there closes it here.

---

## "Confined to its own World" has two edges it does not cover

**What.** `resolveClipPath` resolves both sides through `fs.realpath`, which follows symlinks and
junctions. It does not follow hard links: a hard link in `clips/` to any `.mp4` on the volume passes
confinement, because it *is* a second name for a file, not a pointer to one. Symlinking a World
*directory* likewise relocates the confinement root rather than escaping it.

**Why it shipped anyway.** Both need local write access inside the data directory, which is a
position from which there is nothing left to defend. The module comment reads as absolute, though,
and that is the part worth correcting in a reader's head: confinement bounds what a *manifest* can
name, not what the filesystem can be made to mean.

**What would discharge it.** Comparing device and inode rather than resolved path, plus refusing a
World directory that is itself a link. Neither is worth the Windows-portability cost today.

---

## The manifest has no version field

**What.** A World folder is designed to be opened by a build older than the one that wrote it, and
carries no schema version.

**Why it shipped anyway.** Recorded as a deliberate deferral in the plan's Open Questions. The
spread-rebuild makes *adding* a field safe in both directions, which is the only kind of change made
so far.

**What would discharge it.** The day a field changes meaning rather than being added, a version
number and a migration branch in `rebuild()` — before that change ships, not after.

---

## The per-World lock is per-process

**What.** `WorldStore` serializes mutations through an in-process promise chain. Two HAL instances
pointed at one data directory would both load, both apply, and both write — losing whichever edit
landed first, wholesale.

**Why it shipped anyway.** Pre-existing in shape: `ConversationStore` and `MonitorStore` have the
same property, and HAL is a single-user local tool that already refuses to start twice on one port.

**What would discharge it.** Recording the manifest's mtime at load and refusing the write if it
changed underneath, or a lock file per World directory. The mtime check is the cheap half and would
turn silent loss into a refusal.

---

## Multi-range requests are answered with the whole file

**What.** `parseRange` matches one `bytes=a-b` form. A multi-range header (`bytes=0-100,200-300`)
fails the regex, is treated as no range at all, and the route answers 200 with the entire clip.

**Why it shipped anyway.** Legal per RFC 9110 — a server may always answer 200 — and no browser
issues multi-range for `<video>` playback.

**What would discharge it.** A `multipart/byteranges` response, or an explicit test pinning the 200
so the behaviour is chosen rather than incidental. The test is the honest minimum.

---

## A fault leaves the World inert until something changes a Parameter

**What.** When a transition's clip will not resolve, the runtime reports the fault and rests. It does
not retry, and it does not re-arm when the missing file reappears — the World waits for the next
Parameter change.

**Why it shipped anyway.** This is the resolution taken for one of the plan's Open Questions ("what
the runtime does when it arrives at a State whose clip has gone missing since load"), and the
alternative is worse: a World that keeps dancing while the walk clip is missing hides the very thing
the author needs to see. Resting loudly beats looping quietly.

**What would discharge it.** Re-arming when the manifest changes — the store already knows when a
World was written, so a fault could clear on the next mutation. A judgement best made against a real
World, which is what the plan said about it too.

---

## A State with no clip and only clip-end edges is frozen, and nothing says so

**What.** A State with no clip has nothing to end, so the clip-end trigger never fires. If every
outbound edge waits for clip end, the only way out is a Parameter change that satisfies an edge
which will never be offered. The World stops and no report names it.

**Why it shipped anyway.** Found late, and the fix is a new report rather than a change to an
existing one — `missingClips` already names the pairing as needing a clip, so the symptom is visible
even though the cause is not spelled out.

**What would discharge it.** A fourth report: a State that is reachable, has no clip, and has no
edge that a Parameter change alone could take. It belongs beside the dead-end report in
`shared/src/world-geometry.ts` and would render as a mark like the others.

---

## A dead-end sentence names one Parameter when the gap may need two

**What.** `deadEnds` walks the cross-product of Parameter values, and reports a failing assignment
one Parameter at a time so the plan view can say "no way out for booth". When the real gap needs two
values together, each half of that sentence is individually untrue.

**Why it shipped anyway.** The alternative — naming the tuple — is what the requirement explicitly
did not ask for (AE3 names a value, not a combination), and a tuple is harder to act on. The report
is phrased as "no way out while location is booth", which is a claim about a condition rather than a
cause, and the code says so.

**What would discharge it.** Reporting the minimal failing assignment rather than every Parameter in
it — the smallest set of values that still has no edge out.

---

## Nothing enforces a minimum dwell

**What.** `reportClipEnd` rejects a report whose triple is stale. It does not reject one that arrives
absurdly early. A zero-length or unplayable clip fires `ended` immediately, so a watching browser can
walk the machine through the graph at round-trip speed, one broadcast per hop.

**Why it shipped anyway.** The server's own timer is the authority and is now clamped at both ends,
so a headless World cannot do this to itself; it takes a browser reporting in good faith about a
broken file. The clips this feature consumes are generated deliberately and checked by eye.

**What would discharge it.** Ignoring a clip-end report that arrives before some fraction of the
recorded duration has actually elapsed. Cheap, and it would also bound the damage from a clip whose
recorded duration is far too long.

---

## A clip deleted mid-request truncates the response

**What.** The route stats the file, writes the headers including `content-length`, and then opens the
stream. A file deleted in between produces a short body rather than a clean error, because the status
line has already gone out.

**Why it shipped anyway.** A narrow window, no hang and no crash, and the only way to close it
properly is to open the file before writing the headers — which is a restructure of the route for a
case that requires somebody deleting a clip during playback.

**What would discharge it.** Opening the handle first and taking the size from it, so the number
promised and the bytes available come from the same open file.
