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
