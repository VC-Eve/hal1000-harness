# Residual findings — live scene-worlds

Accepted knowingly, 2026-09-01, after a twelve-reviewer pass over the whole feature. Everything
actionable that pass found is fixed and committed; what follows is what was raised and deliberately
not changed, with the reason and what would discharge it.

Two of these — the embeddable clip route and the missing manifest version — were already anticipated
by the plan (`docs/plans/2026-09-01-001-feat-live-scene-worlds-plan.md`). The rest were found by
review.

**Second pass, 2026-09-02.** A twelve-reviewer review of the whole branch. Twenty-one findings were
fixed, each with a test that fails without its fix; what is added at the end of this file is what was
raised and knowingly left. One reported defect turned out not to be one: clearing a Trigger a
transition named but did not require *set* was already a no-op, because any satisfied clause naming a
Trigger it did not require set required it down.

**Revised 2026-09-02.** The camera model was replaced by a pure state machine
(`docs/plans/2026-09-02-001-feat-live-state-machine-plan.md`): Scenes, Positions, Cuts and cone
coverage are gone, and clips are now chosen by browsing the drive. The entries below have been
brought forward to the vocabulary and files that exist now. One was discharged by that work and says
so; one is new to it.

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

## The manifest has no version field — discharged 2026-09-02

**What.** A World folder is designed to be opened by a build older than the one that wrote it, and
carried no schema version.

**How it was discharged.** The state-machine rebuild is exactly the change this entry was waiting
for: `states` changed meaning rather than gaining a field, and a camera-era manifest parses under the
new shape as a machine with no States at all. `WORLD_VERSION` and a gate in `storage/worlds.ts` now
open a manifest from either side of the boundary read-only, naming which side it came from, and
refuse every mutation against it byte for byte. There is no migration branch: the two shapes describe
different things, and inventing States from Scene/Position pairings would be a guess presented as the
author's work.

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

## A State with no clip and only exit-time transitions is frozen, and nothing says so

**What.** A State with no clip has nothing to end, so its exit-time and clip-end wake-ups never
fire. If every outbound transition has *has exit time* set, the only way out is a Parameter change
that satisfies a transition which will never be offered. The machine stops and no report names it.

**Why it shipped anyway.** The fix is a new report rather than a change to an existing one —
`statesWithoutClip` already marks the State as needing a clip, so the symptom is visible on the graph
even though the cause is not spelled out.

**What would discharge it.** A fourth report: a State that is reachable, has no clip, and has no
transition that a Parameter change alone could take. It belongs beside `deadEnds` in
`shared/src/world-graph.ts` and would render as a node mark like the others.

---

## A dead-end sentence names one Parameter when the gap may need two

**What.** `deadEnds` walks the cross-product of Parameter values and reports a failing assignment one
Parameter at a time. When the real gap needs two values together, each half of that sentence is
individually untrue.

**Why it shipped anyway.** Naming the tuple is harder to act on than naming a value. The report is
phrased as a claim about a condition rather than a cause, and the code says so.

**What would discharge it.** Reporting the minimal failing assignment rather than every Parameter in
it — the smallest set of values that still has no transition out.

**Narrowed 2026-09-02.** The sweep now covers only Bool and Trigger Parameters and caps the value
space at 4096 combinations; Int and Float are unbounded and cannot be enumerated. The report says
which types it swept, so a World whose gap is in a numeric Parameter is told the report does not
cover it rather than being told it is clean.

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

---

## Browsing for a clip reads any folder the core can reach

**What.** `browse-clips` lists a folder anywhere on the machine, and `import-clip` copies a file from
anywhere into the World. Both take an absolute path from a protocol message, so any client on the
socket — a person at the UI or an agent — can enumerate directories outside HAL's data dir and learn
what is on the drive.

**Why it shipped anyway.** It is the feature. Picking a clip means finding one, and the files are
generated wherever the user's video tool puts them, which is not somewhere HAL gets to choose. The
socket is already gated by the per-boot token and the host/origin checks, so the reader is someone
who could already ask the core to do anything else it does. Listing is deliberately narrow: one level
at a time, capped at 500 entries, names and sizes only — never file contents, and only for extensions
the player can open. What crosses the boundary is the *copy*, and it lands inside the World, which is
the same confinement the clip route already enforces.

**What would discharge it.** A configured set of root folders the browser may start from, with
everything above them refused — which is only worth doing if HAL ever runs somewhere its operator is
not the person at the keyboard.

---

## A fault rests until something moves, and a missing clip can leave nothing that moves

**What.** `faulted()` clears the pending wait and does not re-arm one, which is deliberate — a World
that keeps playing while the destination clip is missing hides the thing the author needs to see. The
sharper case is that when the only way out of the faulted State waits on exit time, there is no timer
left to reach it and no Parameter change that would be evaluated, so restoring the file on disk does
not recover the World; it has to be reopened.

**Why it shipped anyway.** The rest state is the intended behaviour and is visible: the fault text is
broadcast and rendered. Recovery-by-retry is a design decision about how often to re-touch a
filesystem that just failed, and picking an interval here would be guessing.

**What would discharge it.** Either a bounded retry after a fault, or a "retry" control on the fault
banner that re-enters the current State — the second is probably better, because it puts the timing
in the hands of the person who just fixed the file.

---

## The dead-end sweep now refuses rather than slows, and says nothing when it does

**What.** `deadEnds` walks states x assignments x transitions. `MAX_VALUE_SPACE` bounded only the
assignments; the other two are unbounded, and the whole product is walked on every mutation and every
greeting. A cap on the product now short-circuits the report.

**Why it is a residual.** Past the cap the report returns empty, which is indistinguishable from "no
dead ends found" — the same shape of silence the `sweptTypes` field exists to avoid for Int and Float.

**What would discharge it.** A reason on the report — swept, skipped-because-too-large, or
not-applicable-to-these-types — rendered wherever the marks are, so an empty report always says which
kind of empty it is.

---

## `browse-clips` remembers one folder for the whole server

**What.** Listings are now answered to the socket that asked, so two tabs no longer replace each
other's view. `libraryRoot` — where browsing resumes when no path is given — is still one field on
the service, so the last folder *anyone* browsed is where the next person starts.

**Why it shipped anyway.** It is a convenience default, not state anything depends on, and the first
thing every client does is navigate. HAL is a single-operator harness; two people browsing different
drives at once is not a case it is built for.

**What would discharge it.** Keying the remembered folder per socket, which is only worth doing
alongside any other per-client state the protocol grows.

---

## A World deleted while open is only noticed when the machine next moves

**What.** The store refuses to write a manifest whose directory has gone, but a running `WorldRuntime`
holds the World in memory and keeps broadcasting. A State with no exit-time transition and no
Parameter-driven way out holds indefinitely against a World that is no longer on disk.

**Why it shipped anyway.** Deleting a World folder from underneath a running HAL is not something the
UI can do — there is no delete affordance on either side of the protocol — so this is reachable only
by editing the data dir by hand while HAL runs.

**What would discharge it.** Noticing at the point the manifest write fails and stopping the runtime
with a fault, rather than leaving it playing.
