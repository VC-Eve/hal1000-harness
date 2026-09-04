# Residual findings — live audio soundtrack

Accepted knowingly, and written at the moment the trade was made rather than after a review found
it. This file opens with U5, the audio byte route (`docs/plans/2026-09-03-002-feat-live-audio-soundtrack-plan.md`),
and later units of the feature append to it.

The point of the file is that `/api/live/audio` is the **third** local media surface in this process
to make the same choice about authentication. The first one made it by accident and it was a P0
(`docs/solutions/loopback-binding-is-not-an-origin-check.md`); the second made it deliberately and
recorded it (`feat-live-scene-worlds.md`); this one was written against both. A trade repeated three
times without being written down each time stops being a trade and becomes a habit.

---

## The track route is a third unauthenticated local surface

**What.** `/api/live/audio` rests on the `Host` check alone. `allowsOrigin` answers true for a
missing `Origin` by design, so agents keep protocol access; an `<audio>` element sends no `Origin`
and cannot present the per-boot WS token that gates every other surface in this process. Both
predicates are called, in the clip route's order, and one of them is doing all the work.

**Why it shipped anyway.** It is exactly the trade `/api/live/clip` and `/api/vision/stream` already
make, and the alternative is a route an `<audio>` element cannot play from — which is the feature.
`allowsHost` is what closes the DNS-rebinding hole, and that hole is what would make the bytes
*readable* cross-origin rather than merely playable.

**What is still open, precisely.** Embedding is not stopped. Any page in any browser tab can put
`http://localhost:PORT/api/live/audio?track=tracks/…` in an `<audio>` element: Host is loopback,
Origin is absent, and the request is served. The samples are unreadable, but the element's
`load`/`error` events are an **existence oracle for track filenames** in the shared store — a page
can ask "does this machine hold `tracks/midnight-drive.flac`?" and be told, one guess at a time, and
the answer is about the user's music rather than about a World's internals. It is the same class of
exposure `feat-live-scene-worlds.md` records for World ids and manifest clip paths, over a namespace
whose names are more likely to be guessable, because they come from the filenames of released music.
`durationchange` on a successful load leaks the track's length too. The route can also be flooded.

`nosniff` and `no-store` are declared on every answer including the 206 and the HEAD, so a later
widening of `AUDIO_MIME` cannot turn a track into a same-origin document that could read the WS
token out of the served page — but that is a guard against a future mistake, not against this one.

**What would discharge it.** The per-boot token on local media surfaces generally. It is now owed
**three times** — `/api/vision/stream`, `/api/live/clip`, and this route — and is still owed, not
fixed. It is recorded against the Monitor origin work in `feat-ambient-log-monitors.md`; whatever
closes it there closes it here. The shape that would work for a media element is a token in the query
string minted per boot, which the page already has and a foreign page does not.

---

## Written against the recorded lesson, deliberately

**What.** `docs/solutions/loopback-binding-is-not-an-origin-check.md` records the case this route
could most easily have repeated: a new local media surface in this process that inherited none of the
checks the older surfaces carry, because the checks are applied per route here rather than by a
shared gate. Origin R18 exists for that reason and names that document as its evidence.

**How it was answered.** The guards were written first and the bytes second. Both predicates are
called rather than reimplemented; the method gate, the store accessor's 503, the lookup and
`parseRange` follow in the clip route's order; and the byte-serving tail is now one function
(`sendMedia`) shared by both routes, so a header added to one cannot be forgotten on the other. The
test suite asserts the Host refusal *before* the store is consulted, so a refused Host cannot
distinguish a track that exists from one that does not.

**What is left.** Nothing to discharge — this entry is here so the next local surface has a third
precedent to read rather than a second, and so "it matched the clip route" is a checkable claim.

---

## Confinement bounds what a playlist can name, not what the filesystem can mean

**What.** `AudioStore.resolveTrack` refuses an absolute path, a Windows drive-relative `C:foo` and
anything that leaves the store, then resolves both sides through `fs.realpath` so a symlink or
junction inside `tracks/` pointing outward is caught. It does **not** catch a hard link: a hard link
has no separate identity to resolve, because it *is* a second name for a file rather than a pointer
to one. A hard link in `tracks/` to any `.flac` or `.mp3` on the volume passes confinement, and if a
playlist index names it, this route serves it.

**Why it shipped anyway.** The same reason `feat-live-scene-worlds.md` gives for clips: creating one
needs local write access inside the data directory, which is a position from which there is nothing
left to defend. The correction worth carrying in a reader's head is the wording — confinement bounds
what a *playlist* can name, not what the filesystem can be made to mean.

**What would discharge it.** Comparing device and inode rather than resolved path, plus refusing a
`tracks/` directory that is itself a link. Neither is worth the Windows-portability cost today, and
whatever is decided for clips should be decided for tracks in the same change.

---

## Authorising a track reads every playlist index

**What.** `referencedTracks` walks every `playlists/*.json` and unions their track paths on **each**
request. A seeking `<audio>` element issues a range request per scrub, so a store with many playlists
does that many small JSON reads per seek.

**Why it shipped anyway.** It is the honest shape of the rule. A track belongs to no single playlist
— the store is shared (R9), the same file may be named by several indexes, and the element asking for
bytes knows a path and nothing else — so "some playlist names it" is genuinely a question about every
index. `lookupClip` sets the precedent by re-reading the manifest per request. A cache would be a
second copy of the authorisation rule, and the copy that lags is the one that leaks.

**What would discharge it.** A store-level index invalidated by the same lock that serialises playlist
writes, so the cache cannot outlive the write that changed it. Worth doing when a real store has
enough playlists to measure, not before.

---

## A track deleted mid-request truncates the response

**What.** The route stats the file, writes the headers including `content-length`, then opens the
stream. A file removed in between produces a short body rather than a clean error, because the status
line has already gone out.

**Why it shipped anyway.** Inherited verbatim from the clip route, where the same entry stands: a
narrow window, no hang and no crash, and closing it properly means opening the handle before writing
the headers — a restructure of `sendMedia` for a case that requires somebody deleting a track during
playback.

**What would discharge it.** Opening the handle first and taking the size from it, so the number
promised and the bytes available come from the same open file. Now a single fix for both routes,
which it was not before.

---

## Multi-range requests are answered with the whole file

**What.** `parseRange` matches one `bytes=a-b` form. A multi-range header fails the regex, is treated
as no range at all, and the route answers 200 with the whole track.

**Why it shipped anyway.** Legal per RFC 9110, and no browser issues multi-range for media playback.
Recorded again here only because a FLAC is larger than a clip, so "the whole file" costs more.

**What would discharge it.** A `multipart/byteranges` response, or an explicit test pinning the 200
so the behaviour is chosen rather than incidental.
