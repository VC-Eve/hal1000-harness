---
title: A key that omits what makes two things differ silently merges them
date: 2026-09-07
category: bug
tags: [identity, keys, react, maps, overlays, blind-spots, code-review]
module: ui/src/components/OverlayLayer.tsx
problem_type: logic_error
symptoms:
  - two elements that should behave differently move together, or one answers for both
  - the bug appears only when a duplicate exists, so every single-item test is green
  - a `Map` built in a loop silently keeps the last write and nothing reports the collision
  - the fix for keying-by-index introduces it, because a summary feels safer than an index
---

## Context

`OverlayLayer` keyed its per-slot fade state — `shown`, `painted`, and a map of pending timers — by
the slot's **index** in the list. A code review caught it: the same component's `failed` set is keyed
by image *name*, with a comment saying that an index means a different slot after a reorder. The
index key was the same mistake one field lower.

The fix keyed on a *summary* of the slot instead: `text|position|source|text` for a caption,
`image|position|image` for a picture. It read well, it survived a reorder, and it kept one key while
a `speech` slot's words changed sentence by sentence.

It also collided. Two slots saying **"ON AIR"** at bottom-left — one scoped to `s1` in red, one to
`s2` in green — produced the same key. The targets are built in a loop:

```ts
for (const entry of [...images, ...captions]) targets.set(entry.id, { drawn, fadeMs });
```

`Map.set` is last-write-wins, and every consumer then read one answer for both elements. Measured: in
State `s1` *neither* was drawn, and in `s2` **both** were — a caption on the projector while its own
States excluded the State the machine was in. That is the exact failure the fade fix in the same
commit existed to prevent, introduced by the fix for the fix.

Nothing reported it. The key looked more careful than an index, and every fade test used slots with
distinct words — which is precisely the population the key does not distinguish.

## Guidance

**Ask what the key omits, then ask what a collision does.** The summary omitted `states`,
`conditions`, `fadeMs`, `size`, `color`, `font`, `backing` and `opacity` — every field that decides
how a slot behaves. A key is a claim that two things with the same key are interchangeable; write the
claim down and check it against the fields you left out.

**A `Map` keyed by a lossy key does not fail, it merges.** There is no error, no warning and no
duplicate — the second write wins and the first entity quietly adopts the second's answer. If the
map's values drive behaviour rather than caching, a collision is a behavioural bug that looks like a
storage detail.

**Put everything in, then disambiguate what is genuinely identical.** The final key is the World id,
an ordinal among identical entries, and `JSON.stringify` of the whole stored slot. Any difference at
all is a different key; two slots stored identically get `#0` and `#1`. The cost — editing a slot
mid-fade restarts its fade — is the honest answer to "this is a different slot now", and far cheaper
than the collision.

**Include the container in the key when the container can change under you.** Two Worlds carry the
same three default slots, so a World switch collided too. Putting the World id in the key made a
switch produce keys nothing holds, which retired the old state through machinery that already
existed — and deleted a whole reset mechanism that had its own bug (see
`state-written-out-of-band-needs-a-reader-that-can-see-it.md`).

**Test the population the key exists to separate.** Every fade test used distinct text. A single test
with two slots sharing everything the key reads, differing only in `states`, would have caught this
in the commit that introduced it — and now does, in both directions.

## Related

- `docs/solutions/state-written-out-of-band-needs-a-reader-that-can-see-it.md` — the other P1 in the
  same fix commit, found by the same review round.
- `docs/solutions/splitting-a-singleton-leaves-every-lookup-keyed-to-the-old-one.md` — the same
  question asked of a cache rather than a render.
- `docs/residual-review-findings/feat-overlay-when.md` — what the two rounds left open.
