// The shared audio store, with nothing playing.
//
// U3 builds the storage half: tracks and named playlists beside `worlds/`, with
// confinement, atomic writes and per-playlist serialisation. Nothing here
// imports, serves or plays audio — that is U4, U5 and U6 — so every assertion
// below is about what survives a write, a restart, a concurrent write, or a
// World being deleted out from under it.

import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { tmpDir } from "../tmp.js";
import { waitFor } from "../wait.js";
import {
  AudioStore,
  MAX_TRACKS_PER_PLAYLIST,
  playlistSlug,
  removeTrack,
  renamePlaylist,
  reorderTracks,
  setTrackBpm,
} from "../../src/storage/audio.js";
import { WorldStore, setWorldPlaylist } from "../../src/storage/worlds.js";
import { WorldRuntime } from "../../src/live/runtime.js";
import { worldReports } from "../../../shared/src/world-graph.js";
import { bpmOf, idleReadouts, AUDIO_PLAYING } from "../../../shared/src/audio.js";
import type { Playlist, PlaylistTrack, World } from "../../../shared/src/types.js";

let dir: string;

beforeEach(async () => {
  dir = await tmpDir("audio-store");
});

/** A file in the store's `tracks/`, so a path that names it can be resolved. */
async function track(store: AudioStore, name: string): Promise<PlaylistTrack> {
  await fs.mkdir(store.tracksDir(), { recursive: true });
  await fs.writeFile(path.join(store.tracksDir(), name), "not really audio", "utf8");
  return { path: `tracks/${name}`, name, durationMs: 180_000 };
}

const indexFile = (id: string) => path.join(dir, "audio", "playlists", `${id}.json`);

describe("a playlist is a named, saved object", () => {
  it("survives a restart", async () => {
    // R9: it exists independently of any World, so the only thing keeping it is
    // the file. A second store over the same directory is the restart.
    const store = new AudioStore(dir);
    const created = await store.create("Warm Up");
    await store.addTracks(created.id, [await track(store, "one.flac")]);

    const reopened = await new AudioStore(dir).load(created.id);
    expect(reopened).toMatchObject({ id: created.id, name: "Warm Up" });
    expect(reopened!.tracks.map((t) => t.path)).toEqual(["tracks/one.flac"]);
  });

  it("keeps a key a newer build wrote through a reopen, an edit and another reopen", async () => {
    // The index is read-modify-written by this process, so it carries the hazard
    // docs/solutions/rebuilding-a-cache-field-by-field-turns-a-read-into-a-delete.md
    // records. A single round trip in one process would prove nothing.
    const store = new AudioStore(dir);
    const created = await store.create("Warm Up");
    const stored = JSON.parse(await fs.readFile(indexFile(created.id), "utf8")) as Playlist;
    await fs.writeFile(
      indexFile(created.id),
      JSON.stringify({ ...stored, crossfadeMs: 4000 }, null, 2),
      "utf8",
    );

    await new AudioStore(dir).update(created.id, (p) => renamePlaylist(p, "Warm Up Two"));

    const reopened = (await new AudioStore(dir).load(created.id)) as Playlist & { crossfadeMs?: number };
    expect(reopened.crossfadeMs).toBe(4000);
    expect(reopened.name).toBe("Warm Up Two");
  });

  it("refuses an id that is a Windows device name, and nudges a colliding name", async () => {
    // A playlist called `con` can no more be a file than a World called `con`
    // can be a directory, and a second playlist of the same name must not
    // overwrite the first's index.
    expect(playlistSlug("con")).toBe("con-playlist");
    expect(playlistSlug("NUL.set")).toBe("nul.set-playlist");

    const store = new AudioStore(dir);
    const device = await store.create("CON");
    expect(device.id).toBe("con-playlist");
    expect(await fs.stat(indexFile(device.id))).toBeTruthy();

    const first = await store.create("Warm Up");
    await store.addTracks(first.id, [await track(store, "one.flac")]);
    const second = await store.create("Warm up");

    expect(second.id).not.toBe(first.id);
    expect(second.id).toBe("warm-up-2");
    // The first one is still whole: a collision that overwrote would have left
    // its track behind in the file it just replaced.
    expect((await store.load(first.id))!.tracks).toHaveLength(1);
  });

  it("refuses a set over the cap rather than trimming it", async () => {
    const store = new AudioStore(dir);
    const created = await store.create("Long");
    const many = Array.from({ length: MAX_TRACKS_PER_PLAYLIST + 1 }, (_, i) => ({
      path: `tracks/t${i}.flac`,
      name: `t${i}`,
      durationMs: 1000,
    }));

    const result = await store.update(created.id, (p) => ({ ...p, tracks: many }));
    expect(result.ok).toBe(false);
    expect((await store.load(created.id))!.tracks).toEqual([]);
  });
});

describe("nothing a playlist names resolves outside the store", () => {
  it("refuses an escaping path with a reason, and leaves the index alone", async () => {
    // R11. The reason matters: an agent told only "no" cannot tell a path it may
    // not use from a file that is not there yet.
    const store = new AudioStore(dir);
    const created = await store.create("Warm Up");
    const outside = path.join(dir, "outside.flac");
    await fs.writeFile(outside, "not really audio", "utf8");

    for (const bad of ["../outside.flac", outside, "C:outside.flac"]) {
      const result = await store.addTracks(created.id, [{ path: bad, name: "x", durationMs: 1 }]);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toMatch(/outside the audio store/);
    }

    expect((await store.load(created.id))!.tracks).toEqual([]);
  });

  it("distinguishes a track that is simply not there", async () => {
    const store = new AudioStore(dir);
    const created = await store.create("Warm Up");
    const result = await store.addTracks(created.id, [
      { path: "tracks/never-imported.flac", name: "x", durationMs: 1 },
    ]);
    expect(result.ok === false && result.error).toMatch(/not in the audio store/);
  });

  it("refuses a track reached through a symlink pointing out of the store", async (ctx) => {
    const store = new AudioStore(dir);
    const created = await store.create("Warm Up");
    const outside = path.join(dir, "outside.flac");
    await fs.writeFile(outside, "not really audio", "utf8");
    await fs.mkdir(store.tracksDir(), { recursive: true });
    try {
      await fs.symlink(outside, path.join(store.tracksDir(), "link.flac"));
    } catch {
      // Windows refuses symlink creation without the privilege. Skipped rather
      // than asserted-around, the way the World store's symlink test is.
      ctx.skip();
      return;
    }

    const result = await store.addTracks(created.id, [{ path: "tracks/link.flac", name: "x", durationMs: 1 }]);
    expect(result.ok).toBe(false);
  });

  it("writes a store-relative forward-slash path whatever separator arrived", async () => {
    // The index travels with the store, and a backslash written on Windows is
    // not a separator anywhere else.
    const store = new AudioStore(dir);
    const created = await store.create("Warm Up");
    const file = await track(store, "one.flac");
    await store.addTracks(created.id, [{ ...file, path: "tracks\\one.flac" }]);

    const raw = await fs.readFile(indexFile(created.id), "utf8");
    expect(raw).not.toContain("\\\\");
    expect((await store.load(created.id))!.tracks[0]!.path).toBe("tracks/one.flac");
  });
});

describe("every index write is serialised per playlist", () => {
  it("lands both of two concurrent writes", async () => {
    // U8 lands a BPM per track asynchronously against one index. Unserialised,
    // that is N read-modify-write cycles against one file: the last writer wins
    // and the rest vanish — docs/solutions/windows-hardening-patterns.md.
    const store = new AudioStore(dir);
    const created = await store.create("Warm Up");
    await store.addTracks(created.id, [await track(store, "one.flac"), await track(store, "two.flac")]);

    await Promise.all([
      store.update(created.id, (p) => setTrackBpm(p, "tracks/one.flac", 174)),
      store.update(created.id, (p) => setTrackBpm(p, "tracks/two.flac", 87)),
    ]);

    const reopened = (await new AudioStore(dir).load(created.id))!;
    expect(reopened.tracks.map((t) => bpmOf(t))).toEqual([
      { known: true, bpm: 174, source: "measured" },
      { known: true, bpm: 87, source: "measured" },
    ]);
  });
});

describe("a BPM that is not a tempo is not a value", () => {
  it("keeps a NaN an importer hands it out of the index entirely", async () => {
    const store = new AudioStore(dir);
    const created = await store.create("Warm Up");
    const file = await track(store, "one.flac");
    await store.addTracks(created.id, [{ ...file, bpm: Number.NaN, bpmSource: "measured" }]);

    const entry = JSON.parse(await fs.readFile(indexFile(created.id), "utf8")).tracks[0];
    expect(entry).not.toHaveProperty("bpm");
    expect(bpmOf((await store.load(created.id))!.tracks[0])).toEqual({ known: false });
  });

  it("reads a zero, a non-finite number and a string from a parsed index as not yet known", async () => {
    // Origin R34 and
    // docs/solutions/a-threshold-guard-written-as-a-negation-fails-open-on-nan.md:
    // `0` satisfies every below-threshold comparison, and `1e999` parses to
    // Infinity while `typeof` still says "number", so JSON.parse objects to
    // neither.
    const store = new AudioStore(dir);
    const created = await store.create("Warm Up");
    await fs.writeFile(
      indexFile(created.id),
      `{"id":"${created.id}","name":"Warm Up","tracks":[
        {"path":"tracks/a.flac","name":"a","durationMs":1,"bpm":0},
        {"path":"tracks/b.flac","name":"b","durationMs":1,"bpm":1e999},
        {"path":"tracks/c.flac","name":"c","durationMs":1,"bpm":"174"},
        {"path":"tracks/d.flac","name":"d","durationMs":1,"bpm":740},
        {"path":"tracks/e.flac","name":"e","durationMs":1,"bpm":174,"bpmSource":"set"}
      ]}`,
      "utf8",
    );

    const loaded = (await store.load(created.id))!;
    expect(loaded.tracks.map((t) => bpmOf(t).known)).toEqual([false, false, false, false, true]);
    expect(bpmOf(loaded.tracks[4])).toEqual({ known: true, bpm: 174, source: "set" });
  });

  it("refuses an out-of-range edit and clears back to unknown rather than to zero", async () => {
    const store = new AudioStore(dir);
    const created = await store.create("Warm Up");
    await store.addTracks(created.id, [await track(store, "one.flac")]);

    expect((await store.update(created.id, (p) => setTrackBpm(p, "tracks/one.flac", 740))).ok).toBe(false);
    expect((await store.update(created.id, (p) => setTrackBpm(p, "tracks/one.flac", 0))).ok).toBe(false);
    // The one a negation lets straight through: `NaN < 60 || NaN > 200` is false,
    // so a bound written that way accepts it and `typeof NaN === "number"` means
    // nothing downstream objects either. A tag read as `parseFloat("")` is
    // exactly this, and it arrives here in U4.
    expect((await store.update(created.id, (p) => setTrackBpm(p, "tracks/one.flac", Number.NaN))).ok).toBe(false);
    expect((await store.update(created.id, (p) => setTrackBpm(p, "tracks/one.flac", Number.POSITIVE_INFINITY))).ok).toBe(
      false,
    );

    await store.update(created.id, (p) => setTrackBpm(p, "tracks/one.flac", 174, "set"));
    await store.update(created.id, (p) => setTrackBpm(p, "tracks/one.flac", null));

    const reopened = (await new AudioStore(dir).load(created.id))!;
    expect(bpmOf(reopened.tracks[0])).toEqual({ known: false });
    // Cleared, not zeroed: a persisted `0` would satisfy `audio.bpm lt 100`
    // forever after.
    expect(JSON.parse(await fs.readFile(indexFile(created.id), "utf8")).tracks[0]).not.toHaveProperty("bpm");
  });
});

describe("ordering and removal", () => {
  it("reorders by path and refuses an order that is not the whole list", async () => {
    const store = new AudioStore(dir);
    const created = await store.create("Warm Up");
    await store.addTracks(created.id, [
      await track(store, "one.flac"),
      await track(store, "two.flac"),
      await track(store, "three.flac"),
    ]);

    expect((await store.update(created.id, (p) => reorderTracks(p, ["tracks/two.flac"]))).ok).toBe(false);
    expect(
      (await store.update(created.id, (p) => reorderTracks(p, ["tracks/two.flac", "tracks/two.flac", "tracks/one.flac"])))
        .ok,
    ).toBe(false);

    await store.update(created.id, (p) =>
      reorderTracks(p, ["tracks/three.flac", "tracks/one.flac", "tracks/two.flac"]),
    );
    expect((await new AudioStore(dir).load(created.id))!.tracks.map((t) => t.name)).toEqual([
      "three.flac",
      "one.flac",
      "two.flac",
    ]);
  });

  it("removes one track and leaves its file in the store", async () => {
    const store = new AudioStore(dir);
    const created = await store.create("Warm Up");
    await store.addTracks(created.id, [await track(store, "one.flac")]);

    await store.update(created.id, (p) => removeTrack(p, "tracks/one.flac"));
    expect((await store.load(created.id))!.tracks).toEqual([]);
    // Another playlist may name it, and collecting unreferenced tracks is
    // deferred work rather than something to do by accident here.
    expect(await fs.stat(path.join(store.tracksDir(), "one.flac"))).toBeTruthy();
  });

  it("deletes an index and leaves the tracks alone", async () => {
    const store = new AudioStore(dir);
    const created = await store.create("Warm Up");
    await store.addTracks(created.id, [await track(store, "one.flac")]);

    expect(await store.remove(created.id)).toBe(true);
    expect(await store.remove(created.id)).toBe(false);
    expect(await store.load(created.id)).toBeNull();
    expect(await fs.stat(path.join(store.tracksDir(), "one.flac"))).toBeTruthy();
  });
});

describe("a World and the store are separate things", () => {
  it("loses no track and no playlist when a World is deleted", async () => {
    // R13. A World is a folder the user may simply delete, so this is what
    // deleting one actually is rather than an API call.
    const audio = new AudioStore(dir);
    const playlist = await audio.create("Warm Up");
    await audio.addTracks(playlist.id, [await track(audio, "one.flac")]);

    const worlds = new WorldStore(dir);
    const created = await worlds.create("Lounge");
    await worlds.mutate(created.world.id, (w) => setWorldPlaylist(w, playlist.id));

    await fs.rm(worlds.dirFor(created.world.id)!, { recursive: true, force: true });

    expect(await new AudioStore(dir).load(playlist.id)).toMatchObject({ id: playlist.id });
    expect(await fs.stat(path.join(audio.tracksDir(), "one.flac"))).toBeTruthy();
  });

  it("runs a World naming a playlist the store does not hold, and reports the reference", async () => {
    // Covers AE12 / R15. The ordinary case for a World folder copied from
    // another machine: it loads, it runs, the reports name the reference, and
    // the reference is still in the manifest afterwards.
    const worlds = new WorldStore(dir);
    const audio = new AudioStore(dir);
    const created = await worlds.create("Lounge");
    const id = created.world.id;
    await worlds.mutate(id, (w) => ({
      ...w,
      playlistId: "warm-up",
      defaultStateId: "a",
      states: [{ id: "a", name: "a", clips: [], x: 0, y: 0 }],
    }));

    const loaded = (await worlds.load(id))!;
    expect(loaded.readable).toBe(true);
    expect(loaded.world.playlistId).toBe("warm-up");

    const reports = worldReports(loaded.world, loaded.incomplete, await audio.ids());
    expect(reports.missingPlaylist).toBe("warm-up");

    // Silently: the readouts are still their nothing-playing values, and the
    // machine reaches its default State with no audio anywhere.
    const runtime = new WorldRuntime(loaded.world, { onChange: () => {} });
    runtime.start();
    await waitFor(() => runtime.live().stateId === "a", "the machine to enter its State");
    expect(idleReadouts()[AUDIO_PLAYING]).toBe(false);
    runtime.stop();

    // And an unrelated edit does not quietly drop the reference on the way past.
    await worlds.mutate(id, (w) => ({ ...w, name: "Lounge Two" }));
    const onDisk = JSON.parse(
      await fs.readFile(path.join(worlds.dirFor(id)!, "world.json"), "utf8"),
    ) as World;
    expect(onDisk.playlistId).toBe("warm-up");
  });

  it("claims nothing about a playlist reference when nobody asked the store", async () => {
    // A report is a claim. "I have no list of playlists" is not evidence that a
    // reference is dangling — the same discipline as a clip check that times out
    // reporting nothing rather than reporting a missing clip.
    const world = {
      version: 4,
      id: "lounge",
      name: "Lounge",
      defaultStateId: null,
      states: [],
      transitions: [],
      parameters: [],
      playlistId: "warm-up",
    } as unknown as World;

    expect(worldReports(world).missingPlaylist).toBeNull();
    expect(worldReports(world, [], []).missingPlaylist).toBe("warm-up");
    expect(worldReports(world, [], ["warm-up"]).missingPlaylist).toBeNull();
  });

  it("takes a playlist reference off a World without touching the store", async () => {
    const audio = new AudioStore(dir);
    const playlist = await audio.create("Warm Up");
    const worlds = new WorldStore(dir);
    const created = await worlds.create("Lounge");

    await worlds.mutate(created.world.id, (w) => setWorldPlaylist(w, playlist.id));
    await worlds.mutate(created.world.id, (w) => setWorldPlaylist(w, null));

    expect((await worlds.load(created.world.id))!.world.playlistId).toBeNull();
    expect(await audio.load(playlist.id)).not.toBeNull();
    // Shape-checked, not existence-checked: a World may name a playlist this
    // store does not hold, and a path segment is refused whatever the store has.
    expect(setWorldPlaylist(created.world, "../escape")).toBeNull();
  });
});
