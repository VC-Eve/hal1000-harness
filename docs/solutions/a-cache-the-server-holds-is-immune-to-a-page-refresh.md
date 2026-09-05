---
title: A cache the server holds is immune to a page refresh
date: 2026-09-04
category: pattern
tags: [caching, staleness, client-server, live-state, blind-spots, diagnosis]
module: server/src/live/transport.ts, server/src/live/audio-service.ts
problem_type: logic_error
symptoms:
  - the user says they refreshed, hard-refreshed, and nothing changed
  - one surface shows the new data and another shows the old, in the same browser
  - the stale surface is the one furthest from the edit, so the edit "looks saved"
  - a change-detection comparison is watching every field except the one that moved
---

## Context

Fifteen tracks were added to a playlist and the player went on looping the original two. The author
refreshed, hard-refreshed, and nothing changed — which is exactly the evidence that sends you to look
at the client.

The client was never wrong. The editor showed all seventeen the moment they landed, because it reads
the broadcast. The stale copy was on the **server**: the transport keeps its own in-memory snapshot of
the track list, taken when the playlist was armed, and refreshed it only after its *own* writes — a
duration report, an unplayable mark. An import, a reorder, a removal all wrote the index to disk and
broadcast it to every client, and nothing told the running transport anything had happened.

So a page refresh reloaded the half that was already correct, and proved it.

## Guidance

**When one surface is fresh and another is stale in the same browser, the stale one is being fed by
something a refresh does not restart.** A reload rebuilds the client. It does not touch a process that
has been running for six hours holding a snapshot it took when it started. The instinct to reload is
strong precisely because it usually works — and when it doesn't, "I already refreshed" reads as *this
is not a caching problem* when it is exactly a caching problem, one level further back.

The diagnostic that settles it in a minute: **ask each half separately what it thinks the data is.**

```
after arming with 2 tracks     : transport.tracks = 2
playlist on disk now           : 5 tracks
transport after the import     : transport.tracks = 2   <- the stale half, named
```

Three numbers. The disagreement is the answer, and it points at the process rather than the page.

**A long-lived server component that caches user-editable data owes that data a way in.** The
transport had `arm` (take a playlist), and it had two private paths that re-read after writing
something itself. It had no way for anyone else to say *this changed*. Every write site broadcast to
clients and none of them told the component sitting in the middle of the room.

Put the notification at the choke point rather than at each caller:

```ts
// One place. The transport first, the clients second, so the seventh caller
// added later cannot forget one of them.
private announcePlaylist(playlist: Playlist): void {
  this.transport.refreshed(playlist);
  this.say({ type: "playlist", playlist });
}
```

**Watch for the change-detection that hides the fix.** This transport suppresses broadcasts whose
state signature has not changed — a rule that exists so a readout ticking once a second does not
retransmit the world. The signature watched the held track's path, the index and the position. An
append changes **none of those**: same track playing, same index, same position, seventeen tracks
instead of two. The refresh had to be forced past the comparison, or the server would have held the
correct list and never mentioned it, and the pane would still have read "1 of 2".

A staleness fix that lands inside a de-duplicating broadcast is not finished until you have checked
that the thing that changed is something the de-duplication can see.

## Related

- `a-value-frozen-for-one-caller-is-stale-for-the-next.md` — the same staleness one scope down, where
  the frozen copy is a value handed between callers rather than a snapshot held across a session.
- `editing-state-a-running-process-caches-loses-the-edit.md` — the adjacent failure: there the running
  process overwrote the edit, here it merely ignored it.
- `rebuilding-a-cache-field-by-field-turns-a-read-into-a-delete.md` — the other way a cached copy of
  persisted data goes wrong, by being rebuilt rather than by going stale.
