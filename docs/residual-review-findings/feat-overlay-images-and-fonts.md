# Residual findings — overlay images, and a font list

What this feature knowingly leaves open. Written at build time rather than
discovered later, and each entry says why it was left rather than only that it
was.

## Deliberate

**An image the last slot stops naming stays on disk.** Removing it would be a
write triggered by an edit that did not ask for one, and on Windows a file the
browser is still rendering throws EBUSY. The route already refuses to serve
anything the World's slots do not reference, so an unreferenced file is
unreachable rather than exposed — it costs disk space and nothing else. The same
trade clips already make.

**Every pick re-copies.** Choosing the same file for a second slot in one World
copies it again under a suffixed name; there is no pick-from-what-this-World-
already-has. One import, one file, no identity to reason about — and the
suffixing is precisely why filename reasoning about image identity is
misleading here, so anything comparing images compares content, never names.

**Five Worlds means five copies of a logo.** Images live with the World because
the slot list does, which keeps a World a folder that can be zipped and moved.
Rebranding is therefore a re-import in each World. A shared cross-World image
library was considered and deferred; it would break the self-contained property
for images.

**Animation is whatever the file does.** A GIF, APNG or animated WebP loops as
the browser loops it, with no control over speed, play count or whether it runs.
The earlier brief's deferral of "animation of any kind" narrows to animation HAL
would have to drive — fades, transitions, entrances — which remain out.

## New surface, recorded

**The directory browser now enumerates images as well as videos.** The
directories it can reach are unchanged, and the reach itself was already
recorded as a new surface when clip browsing was built. What changed is that one
walk of a folder now answers both pickers. Worth knowing that a browse reveals
the presence and size of image files in any folder the operator points at, on a
protocol that already permits scheduling shell commands.

**An import has no size ceiling.** A very large source file is copied into the
World's `images/` and consumes disk. This mirrors clip import verbatim rather
than introducing anything new; neither has a ceiling, and adding one to images
alone would be an odd place to start.

**The image route is gated by `Host`, not by the per-boot token.** An `<img>`
presents no token and sends no Origin, and a missing Origin is allowed by design
so agents keep protocol access — so `allowsHost` is what defends the route. The
same accepted trade already made for the clip, audio and camera routes, and it
was re-derived for this route rather than inherited.

## Left undone

**The extension gate does not inspect bytes.** A renamed file — an executable
saved as `.png` — imports and is served with an image content type. The same
pattern as clips and audio, not widened here; SVG is excluded from the accepted
table, which is the one format where this would have mattered.

**`resolveClipPath` still says `clip`.** It confines to the World directory
rather than to `clips/`, which is why it resolves an image name unchanged. The
name will keep misleading readers until a rename touching every caller lands.

**The store's round-trip test is a confirmation, not a regression.** The plan
predicted that reverting the guard's kind branch would make it go red. It does
not: the load is lenient and keeps stored entries whole, so the store never drops
the new fields. The test still earns its place — it proves the chain — but it has
no red bar of its own, and the plan's claim that it did was wrong.

## Raised by the code review, and not fixed

Ten reviewers read the branch. What they found that was worth fixing was fixed;
these are the ones judged not worth building now, recorded so the next person
does not rediscover them as surprises.

**The picker and the clip browser share one store slot.** `state.clipLibrary` is
written by whichever of `ImagePicker` and `ClipBrowser` last browsed, so with
both open, navigating in one blanks the other back to "reading…". Opening the
picker no longer disturbs an open browser — it seeds from what is already there
— but a navigation still cross-blanks. A real fix needs the browse to carry who
asked, which is a protocol change for a two-panels-open-at-once case.

**A reorder from elsewhere can still redirect an open picker.** The editor closes
its own picker when the row moves or goes, but a `set-world-overlays` from a
second client or an agent, arriving while the picker is open, leaves the index
meaning a different slot. The server re-checks that the target is still a picture
slot, so the image cannot land on a caption — but it can land on a *different
picture slot*, replacing its image. Fixing it properly means carrying an
expectation in the message (the slot's current image, or its position) and
refusing on mismatch.

**Re-picking a file for the same slot orphans the previous copy.** Each pick
copies again under a suffixed name and the slot points at the new one; the old
file stays. This is the KTD8 trade appearing a second way, and it accumulates on
a slot the operator keeps changing their mind about.

**An over-long image name is truncated, not refused.** `cleanText` bounds the
name at `IMAGE_NAME_MAX`, so a hand-written or agent-written name past that
becomes a valid slot naming a file that does not exist. The import path cannot
reach this — `safeSegment` caps well below — so only a non-UI writer can.

**A World folder can carry two names that collide on Windows.** `images/Logo.png`
and `images/logo.png` are two files on a case-sensitive filesystem and one file
here, so a World zipped elsewhere and opened on Windows loses one.

**The two importers are duplicated, and nothing notices drift.** `importClip` and
`importOverlayImage` share `clipStem`, `exists` and `MAX_NAME_ATTEMPTS`; their
collision loops and `COPYFILE_EXCL`/EEXIST handling are the same code written
twice. The comment now says so plainly rather than claiming otherwise, but no
test would fail if a change landed in only one of them.

## Found while stabilising the suite

**A refusal is broadcast before the rollback finishes.** The
`import-overlay-image` handler reports its result from inside `apply`, and calls
`removeOverlayImage` after. So a client that receives the refusal and immediately
lists the World's `images/` can see the copy still there, for as long as one
`fs.rm` takes. Nothing is left behind — the removal does happen — but the
observable order is result-then-cleanup rather than cleanup-then-result. It
surfaced as a flaky test that read the directory the instant the answer landed.
