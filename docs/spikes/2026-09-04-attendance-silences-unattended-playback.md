# A page opening silences a World that was running unattended

Found by the adversarial reviewer during the code review of `2001c2d` (playlist
shuffle / click-to-play), sharpened and then **reproduced** here. Not fixed:
the repair changes the semantics of the gesture gate, which AE4 and AE7 pin, so
it is a plan of its own rather than a review fix.

Kept as a spike rather than as a test because **both cases below fail today**.
Committing them to `server/test/live/` would leave the suite red; committing
them with the assertions inverted would enshrine the bug as the contract.

## The defect

`attend()` in `server/src/live/transport.ts` says, in a comment written for it:

> Deliberately does not stop anything already sounding. A page opening while a
> World has been running unattended must not silence the room — the gate is
> about what *begins* from here on, and the honest report meanwhile is
> `audible: false`, which is what says the sound is not this browser's.

That holds for the moment the page opens, and stops holding at the next track.
`begin()` ends with:

```ts
const silent = this.attendance === "silent";
this.sounding = !silent;
this.gateHeld = silent;
```

`begin()` is reached by **every** route that starts a track — the tick at a
track's end, `next`, `previous`, `load`, and (since `2001c2d`) `play-track`. So
a browser that merely *opens* on an unattended, sounding World moves attendance
from `none` to `silent`, and the very next automatic advance sets
`sounding = false`. The clock stops, `audio.playing` goes false and
`audio.remaining` freezes for every World reading the readouts, and nobody
clicked anything.

The `play-track` case is worse only in that it answers `{ ok: true }` while
doing it.

## Reproduction

Both of these fail on `fcc6d49`. Drop into `server/test/live/` as a `.test.ts`
to re-run; the fixtures are lifted from `transport.test.ts`.

```ts
it("keeps sounding across the next automatic track advance", async () => {
  const list = await playlist("Set", [{ file: "a.flac", durationMs: 5_000 }, { file: "b.flac" }]);
  const rig = transport();
  await rig.transport.startPlaylist(list.id);
  await waitFor(() => rig.last().index === 0, "the first track to begin");
  expect(rig.last().playing).toBe(true);

  // A browser opens. `attend()` documents that it must not silence the room.
  rig.transport.command({ command: "attend" });
  expect(rig.last().playing).toBe(true);

  // The first track ends on its own. Nobody clicked anything.
  await time.advance(6_000);
  await waitFor(() => rig.last().index === 1, "the second track to begin");

  expect(rig.last().playing).toBe(true); // FAILS: false
});

it("keeps sounding when the operator clicks a track", async () => {
  const list = await playlist("Set", [{ file: "a.flac" }, { file: "b.flac" }]);
  const rig = transport();
  await rig.transport.startPlaylist(list.id);
  await waitFor(() => rig.last().index === 0, "the first track to begin");
  rig.transport.command({ command: "attend" });

  const result = await rig.transport.command({
    command: "play-track",
    playlistId: list.id,
    path: "tracks/b.flac",
  });
  expect(result).toEqual({ ok: true });   // passes — it reports success
  expect(rig.last().playing).toBe(true);  // FAILS: false
});
```

## Why it is not fixed here

The candidate repair is one clause — a transport that was *already* sounding
should not be silenced by a track change:

```ts
const silent = this.attendance === "silent" && !this.sounding;
```

It is small, and it is not obviously safe. `begin()` is also how an armed
playlist is held for the gesture (origin R5), how `startPlaylist` swaps over a
playing transport, and how the unattended clock advances (origin R25, AE7).
Three requirements meet in those two lines, and AE4 and AE7 both pin behaviour
that passes through them. It wants its own plan, its own reading of the origin
requirements, and its own tests — not a clause added during a review of an
unrelated feature.

## Related

- `docs/solutions/exclusive-device-one-owner-many-consumers.md` — the same
  subsystem's record of a stale reading served confidently. `audible` was
  designed against exactly this; the gap is that `playing` was not.
- `docs/plans/2026-09-04-001-feat-playlist-shuffle-and-track-selection-plan.md`
  — the change under review when this surfaced.
