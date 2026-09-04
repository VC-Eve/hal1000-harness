// Tempo detection: the queue, the lifecycle, and the octave arithmetic.
//
// **What this file deliberately does not test.** Whether the detector gets real
// drum & bass right. That is origin R31 — a detector may be used only if it
// covers 60–200 and says which octave it chose, on a library of drum & bass, dub
// and breaks — and it is a claim about recordings, of which this repository has
// none. A synthetic click track is the easiest signal a beat tracker will ever
// be handed, so a test that generated one and asserted 174 would be measuring
// the generator; docs/solutions/a-measurement-on-synthetic-variants-measures-your-own-transform.md
// records that exact substitution costing this project a shipped feature. The
// answer to R31 comes from `scripts/tempo-report.ts` run against a real folder,
// and until it has been, R31 is open.
//
// So what is here is structure — what the queue does when the world changes
// underneath it — plus the reconciliation arithmetic, fed interval arrays
// written out by hand. That second one is a test of division, and its names say
// so.

import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { tmpDir } from "../tmp.js";
import { waitFor } from "../wait.js";
import { AudioStore } from "../../src/storage/audio.js";
import { AudioTransport } from "../../src/live/transport.js";
import { WorldRuntime } from "../../src/live/runtime.js";
import {
  MAX_CONCURRENT_MEASUREMENTS,
  TempoDetector,
  decodeToMono,
  measureFile,
  reconcileOctave,
  detectionEnabled,
} from "../../src/live/tempo.js";
import type { DecodedAudio, TempoJobResult } from "../../src/live/tempo.js";
import { AUDIO_BPM, bpmOf } from "../../../shared/src/audio.js";
import { WORLD_VERSION } from "../../../shared/src/worlds.js";
import type { PlaylistTrack, World } from "../../../shared/src/types.js";

let dir: string;

beforeEach(async () => {
  dir = await tmpDir("tempo");
});

/** A file in the store's `tracks/`, so a path naming it resolves. */
async function track(store: AudioStore, name: string, bytes = "not really audio"): Promise<PlaylistTrack> {
  await fs.mkdir(store.tracksDir(), { recursive: true });
  await fs.writeFile(path.join(store.tracksDir(), name), bytes, "utf8");
  return { path: `tracks/${name}`, name, durationMs: 180_000 };
}

/** Silence at a known rate. The analyser is stubbed in every test that uses it. */
const audio = (seconds = 30, sampleRate = 11_025): DecodedAudio => ({
  samples: new Float32Array(seconds * sampleRate),
  sampleRate,
});

/** A beat every `period` seconds for `count` beats, as the analyser would report them. */
const beats = (period: number, count: number): number[] =>
  Array.from({ length: count }, (_, n) => n * period);

/**
 * A store whose `update` calls are counted.
 *
 * Several tests below assert that **no index write happens**, and an absence is
 * the easiest assertion to pass by accident — asserting on the file's contents
 * would go green whether the write was skipped or merely refused. Counting the
 * calls is what distinguishes "the queue knew not to bother" from "the store
 * said no", which is the behaviour the generation counter exists for.
 */
function counting(store: AudioStore): { store: AudioStore; updates: string[] } {
  const updates: string[] = [];
  const original = store.update.bind(store);
  store.update = ((id, apply) => {
    updates.push(id);
    return original(id, apply);
  }) as AudioStore["update"];
  return { store, updates };
}

/** A decode that never finishes, and a way to see how many are in flight. */
function blocking() {
  let running = 0;
  let peak = 0;
  let open = false;
  let started = 0;
  const release: Array<() => void> = [];
  const decode = async (): Promise<DecodedAudio> => {
    running += 1;
    started += 1;
    peak = Math.max(peak, running);
    // Once released, everything queued behind runs straight through — otherwise
    // a queue draining after `releaseAll` would block on the next promise and
    // the wait for it to finish would never return.
    if (!open) await new Promise<void>((resolve) => release.push(resolve));
    running -= 1;
    return audio();
  };
  return {
    decode,
    peak: () => peak,
    started: () => started,
    releaseAll: () => {
      open = true;
      release.splice(0).forEach((resolve) => resolve());
    },
  };
}

describe("octave reconciliation (arithmetic over intervals, not a claim about audio)", () => {
  it("reports both octaves and their weights when the intervals are a half-time reading", () => {
    // Written out by hand: sixty intervals at 0.6897s — 87 BPM, the half-time
    // reading of 174 — and forty at 0.3448s, which is 174 itself. The double
    // candidate has less mass than the tracked one here, so the tracked one is
    // chosen; what matters is that both are named with their weights, which is
    // the half of origin R31 a bare number cannot satisfy.
    const reading = reconcileOctave([
      ...Array<number>(60).fill(60 / 87),
      ...Array<number>(40).fill(60 / 174),
    ]);

    expect(reading).not.toBeNull();
    expect(reading!.bpm).toBeCloseTo(87, 0);
    expect(reading!.octave).toBe(1);
    expect(reading!.chosen.weight).toBeCloseTo(0.6, 2);
    expect(reading!.alternative?.bpm).toBeCloseTo(174, 0);
    expect(reading!.alternative?.weight).toBeCloseTo(0.4, 2);
  });

  it("stays on the busier cluster when the mass is the other way round", () => {
    // The same two candidates, the mass reversed. The densest cluster is now the
    // short interval, so the tracker's own reading is 174 and 87 is the named
    // alternative — which is the answer to AE10 read from the other side.
    const reading = reconcileOctave([
      ...Array<number>(30).fill(60 / 87),
      ...Array<number>(70).fill(60 / 174),
    ]);

    expect(reading!.bpm).toBeCloseTo(174, 0);
    expect(reading!.octave).toBe(1);
    expect(reading!.chosen.weight).toBeCloseTo(0.7, 2);
    expect(reading!.alternative?.bpm).toBeCloseTo(87, 0);
    expect(reading!.alternative?.weight).toBeCloseTo(0.3, 2);
  });

  it("moves up an octave when the tracker's own reading is below the band", () => {
    // Intervals of 1.5s. The tracker is at 40 BPM, which is not a usable tempo,
    // so it is dropped and the double — 80 — is what is left. `octave` reads 2,
    // which is the whole of "reports which octave it chose": the number written
    // to the index is not the number the tracker produced, and the reading says
    // so rather than leaving a reader to divide.
    const reading = reconcileOctave(Array<number>(40).fill(1.5));

    expect(reading!.tracked).toBeCloseTo(40, 0);
    expect(reading!.bpm).toBeCloseTo(80, 0);
    expect(reading!.octave).toBe(2);
  });

  it("reports both octaves at equal weight when the intervals are split evenly", () => {
    // Fifty each, and no right answer. What matters is that the two candidates
    // come back carrying the same weight, so nothing downstream can read the
    // choice as confident — and that the reading is one of the two rather than
    // the average of them, which is a tempo nothing is playing.
    const reading = reconcileOctave([
      ...Array<number>(50).fill(60 / 87),
      ...Array<number>(50).fill(60 / 174),
    ]);

    expect(reading!.chosen.weight).toBeCloseTo(0.5, 2);
    expect(reading!.alternative?.weight).toBeCloseTo(0.5, 2);
    expect([87, 174].map((bpm) => Math.round(reading!.bpm) === bpm)).toContain(true);
  });

  it("drops an octave that falls outside 60–200 rather than reporting it", () => {
    // 120 BPM steady. Half of it is 60, which is in band; double is 240, which
    // is not, so only two candidates exist and the out-of-band one is not the
    // alternative.
    const reading = reconcileOctave(Array<number>(40).fill(0.5));

    expect(reading!.bpm).toBeCloseTo(120, 0);
    expect(reading!.candidates.map((c) => Math.round(c.bpm))).toEqual([120, 60]);
  });

  it("answers nothing rather than a number when a non-finite interval is all there is", () => {
    // An acceptance, so `NaN` and `Infinity` fail closed. The negation form —
    // `x < lo || x > hi` — is satisfied by neither and would let both through.
    expect(reconcileOctave([Number.NaN, Number.POSITIVE_INFINITY, -1, 0])).toBeNull();
    expect(reconcileOctave(Array<number>(40).fill(Number.NaN))).toBeNull();
  });

  it("answers nothing rather than a number from three beats", () => {
    expect(reconcileOctave([0.5, 0.5, 0.5])).toBeNull();
  });
});

describe("a measurement's outcome", () => {
  it("is undecodable for a file no decoder will take", async () => {
    // The real decoder, on real bytes that are not audio. This is the one test
    // here that exercises the dependency itself.
    const file = path.join(dir, "garbage.flac");
    await fs.writeFile(file, Buffer.alloc(64 * 1024, 0x5a));

    expect(await measureFile(file)).toEqual({ outcome: "undecodable" });
  });

  it("is a timeout, not an undecodable, when the decode runs long", async () => {
    const measurement = await measureFile("anything.flac", {
      deadlineMs: 20,
      decode: () => new Promise<DecodedAudio>(() => {}),
    });

    expect(measurement).toEqual({ outcome: "timeout" });
  });

  it("is unmeasured when the analysis finds too few beats to mean anything", async () => {
    const measurement = await measureFile("anything.flac", {
      decode: async () => audio(),
      analyse: () => beats(0.5, 3),
    });

    expect(measurement).toEqual({ outcome: "unmeasured" });
  });
});

describe("the detection queue", () => {
  it("writes the measured tempo into the index", async () => {
    const store = new AudioStore(dir);
    const playlist = await store.create("Set");
    await store.addTracks(playlist.id, [await track(store, "one.flac")]);

    const results: TempoJobResult[] = [];
    const detector = new TempoDetector(store, {
      decode: async () => audio(),
      analyse: () => beats(60 / 174, 60),
      onResult: (result) => results.push(result),
    });
    detector.measure(playlist.id, "tracks/one.flac");
    await waitFor(() => detector.idle(), "the queue to drain");

    const saved = await store.load(playlist.id);
    expect(bpmOf(saved!.tracks[0])).toMatchObject({ known: true, source: "measured" });
    expect(saved!.tracks[0]!.bpm).toBeCloseTo(174, 0);
    expect(results[0]!.reading!.octave).toBe(1);
  });

  it("produces no index write for a track deleted mid-detection", async () => {
    const store = new AudioStore(dir);
    const playlist = await store.create("Set");
    await store.addTracks(playlist.id, [
      await track(store, "one.flac"),
      await track(store, "two.flac"),
    ]);
    const counted = counting(store);

    const gate = blocking();
    const results: TempoJobResult[] = [];
    const detector = new TempoDetector(store, {
      concurrency: 1,
      decode: gate.decode,
      analyse: () => beats(60 / 174, 60),
      onResult: (result) => results.push(result),
    });
    detector.measure(playlist.id, "tracks/one.flac");
    await waitFor(() => gate.started() === 1, "the decode to start");

    // The removal is an ordinary edit, and it is a write — so the count is
    // taken from here on.
    await store.update(playlist.id, (p) => ({
      ...p,
      tracks: p.tracks.filter((t) => t.path !== "tracks/one.flac"),
    }));
    const before = counted.updates.length;
    gate.releaseAll();
    await waitFor(() => detector.idle(), "the queue to drain");

    expect(counted.updates.length).toBe(before);
    expect(results[0]!.outcome).toBe("abandoned");
  });

  it("produces no index write for a playlist deleted mid-detection", async () => {
    const store = new AudioStore(dir);
    const playlist = await store.create("Set");
    await store.addTracks(playlist.id, [await track(store, "one.flac")]);
    const counted = counting(store);

    const gate = blocking();
    const results: TempoJobResult[] = [];
    const detector = new TempoDetector(store, {
      decode: gate.decode,
      analyse: () => beats(60 / 174, 60),
      onResult: (result) => results.push(result),
    });
    detector.measure(playlist.id, "tracks/one.flac");
    await waitFor(() => gate.started() === 1, "the decode to start");

    await store.remove(playlist.id);
    detector.forget(playlist.id);
    const before = counted.updates.length;
    gate.releaseAll();
    await waitFor(() => detector.idle(), "the queue to drain");

    expect(counted.updates.length).toBe(before);
    expect(results[0]!.outcome).toBe("abandoned");
  });

  it("marks an undecodable track unplayable and carries on to the next one", async () => {
    const store = new AudioStore(dir);
    const playlist = await store.create("Set");
    await store.addTracks(playlist.id, [
      await track(store, "bad.flac"),
      await track(store, "good.flac"),
    ]);

    const detector = new TempoDetector(store, {
      concurrency: 1,
      decode: async (file) => {
        if (file.endsWith("bad.flac")) throw new Error("no decoder will take this");
        return audio();
      },
      analyse: () => beats(60 / 128, 60),
    });
    detector.measure(playlist.id, "tracks/bad.flac");
    detector.measure(playlist.id, "tracks/good.flac");
    await waitFor(() => detector.idle(), "the queue to drain");

    const saved = await store.load(playlist.id);
    expect(saved!.tracks[0]).toMatchObject({ path: "tracks/bad.flac", unplayable: true });
    expect(bpmOf(saved!.tracks[0]).known).toBe(false);
    // The queue did not stall on the failure: the second track was measured.
    expect(saved!.tracks[1]!.bpm).toBeCloseTo(128, 0);
  });

  it("marks a track whose file has gone from the store unplayable", async () => {
    // R14's other arrival: the index still names it and its ordering is
    // untouched, but nothing will resolve it. Detection is often the first thing
    // to find out, because it is the first thing to go looking for the file.
    const store = new AudioStore(dir);
    const playlist = await store.create("Set");
    await store.addTracks(playlist.id, [await track(store, "gone.flac")]);
    await fs.rm(path.join(store.tracksDir(), "gone.flac"));

    const detector = new TempoDetector(store, { decode: async () => audio() });
    detector.measure(playlist.id, "tracks/gone.flac");
    await waitFor(() => detector.idle(), "the queue to drain");

    const saved = await store.load(playlist.id);
    expect(saved!.tracks[0]).toMatchObject({ path: "tracks/gone.flac", unplayable: true });
  });

  it("leaves a track that timed out unmeasured rather than unplayable", async () => {
    // The distinction `server/src/deadline.ts` insists each caller makes for
    // itself. The question asked was "what is its tempo", and running long on a
    // sleeping drive is no evidence at all about whether a browser can play it.
    const store = new AudioStore(dir);
    const playlist = await store.create("Set");
    await store.addTracks(playlist.id, [await track(store, "slow.flac")]);

    const results: TempoJobResult[] = [];
    const detector = new TempoDetector(store, {
      deadlineMs: 20,
      decode: () => new Promise<DecodedAudio>(() => {}),
      onResult: (result) => results.push(result),
    });
    detector.measure(playlist.id, "tracks/slow.flac");
    await waitFor(() => detector.idle(), "the queue to drain");

    const saved = await store.load(playlist.id);
    expect(saved!.tracks[0]!.unplayable).toBeUndefined();
    expect(bpmOf(saved!.tracks[0]).known).toBe(false);
    expect(results[0]!.outcome).toBe("timeout");
  });

  it("does not write over a hand-set tempo with a result already in flight", async () => {
    // Origin R32: an edited value wins over both tag and detection, including
    // when the edit lands during the decode it is racing.
    const store = new AudioStore(dir);
    const playlist = await store.create("Set");
    await store.addTracks(playlist.id, [await track(store, "one.flac")]);

    const gate = blocking();
    const detector = new TempoDetector(store, {
      decode: gate.decode,
      analyse: () => beats(60 / 128, 60),
    });
    detector.measure(playlist.id, "tracks/one.flac");
    await waitFor(() => gate.started() === 1, "the decode to start");

    await store.update(playlist.id, (p) => ({
      ...p,
      tracks: p.tracks.map((t) => ({ ...t, bpm: 174, bpmSource: "set" as const })),
    }));
    gate.releaseAll();
    await waitFor(() => detector.idle(), "the queue to drain");

    expect(await store.load(playlist.id).then((p) => p!.tracks[0])).toMatchObject({
      bpm: 174,
      bpmSource: "set",
    });
  });

  it("keeps twenty tracks playable and orderable while none of them has a tempo yet", async () => {
    // Origin R33. Nothing about import waits on detection: the index is
    // complete, every entry is playable, and every tempo is the third state.
    const store = new AudioStore(dir);
    const playlist = await store.create("Long Set");
    const arrivals: PlaylistTrack[] = [];
    for (let n = 0; n < 20; n += 1) arrivals.push(await track(store, `t${n}.flac`));
    await store.addTracks(playlist.id, arrivals);

    const gate = blocking();
    const detector = new TempoDetector(store, { decode: gate.decode, analyse: () => beats(0.5, 40) });
    detector.measureAll(playlist.id, arrivals);
    await waitFor(() => gate.started() === MAX_CONCURRENT_MEASUREMENTS, "decoding to start");

    const saved = await store.load(playlist.id);
    expect(saved!.tracks).toHaveLength(20);
    expect(saved!.tracks.every((t) => t.unplayable !== true)).toBe(true);
    expect(saved!.tracks.every((t) => bpmOf(t).known === false)).toBe(true);
    // Still orderable while the queue is full of them.
    const reordered = await store.update(playlist.id, (p) => ({
      ...p,
      tracks: [...p.tracks].reverse(),
    }));
    expect(reordered.ok).toBe(true);

    gate.releaseAll();
  });

  it("decodes no more than the concurrency ceiling at once", async () => {
    const store = new AudioStore(dir);
    const playlist = await store.create("Set");
    const arrivals: PlaylistTrack[] = [];
    for (let n = 0; n < 12; n += 1) arrivals.push(await track(store, `t${n}.flac`));
    await store.addTracks(playlist.id, arrivals);

    const gate = blocking();
    const detector = new TempoDetector(store, {
      concurrency: 3,
      decode: gate.decode,
      analyse: () => beats(0.5, 40),
    });
    detector.measureAll(playlist.id, arrivals);
    await waitFor(() => gate.started() === 3, "three decodes to start");

    // A fixed wait, because the assertion is a negative one: nothing more must
    // start, and there is no condition to poll for that.
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(gate.peak()).toBe(3);
    expect(detector.active()).toBe(3);
    expect(detector.pending()).toBe(9);

    gate.releaseAll();
    await waitFor(() => detector.idle(), "the queue to drain");
    expect(gate.peak()).toBe(3);
  });
});

describe("an unmeasured track reaches the machine as absent, not as zero", () => {
  it("leaves audio.bpm out of the readouts and unsatisfiable while it plays", async () => {
    // The end of R34, asked of the two halves together: the index says not-yet-
    // known, the transport leaves the readout out entirely, and a `lt` condition
    // — which a zero would satisfy — is not taken.
    const store = new AudioStore(dir);
    const playlist = await store.create("Set");
    await store.addTracks(playlist.id, [await track(store, "one.flac")]);

    const detector = new TempoDetector(store, {
      deadlineMs: 20,
      decode: () => new Promise<DecodedAudio>(() => {}),
    });
    detector.measure(playlist.id, "tracks/one.flac");
    await waitFor(() => detector.idle(), "the queue to drain");

    const transport = new AudioTransport(store, { onReadouts: () => {}, onChange: () => {} });
    expect(await transport.startPlaylist(playlist.id)).toEqual({ ok: true });
    const readouts = transport.readouts();
    expect(readouts[AUDIO_BPM]).toBeUndefined();

    const world: World = {
      version: WORLD_VERSION,
      id: "lounge",
      name: "Lounge",
      defaultStateId: "a",
      states: [
        { id: "a", name: "a", clips: [{ clips: [{ path: "clips/a.mp4", durationMs: 4000 }] }], x: 0, y: 0 },
        { id: "b", name: "b", clips: [{ clips: [{ path: "clips/b.mp4", durationMs: 4000 }] }], x: 0, y: 0 },
      ],
      transitions: [
        {
          id: "t",
          from: "a",
          to: "b",
          clips: [],
          conditions: [{ parameter: AUDIO_BPM, op: "lt", value: 100 }],
          hasExitTime: false,
          exitTime: 1,
          order: 0,
        },
      ],
      parameters: [],
    };
    const runtime = new WorldRuntime(world, { onChange: () => {} });
    runtime.start();
    await waitFor(() => runtime.live().stateId === "a", "the machine to enter a");
    runtime.setAudio(readouts);
    await new Promise((resolve) => setImmediate(resolve));

    expect(runtime.live().stateId).toBe("a");
    runtime.stop();
    transport.stop();
  });
});

describe("the decoders themselves", () => {
  it("refuse bytes that are not audio", async () => {
    const file = path.join(dir, "not-audio.mp3");
    await fs.writeFile(file, "this is text", "utf8");
    await expect(decodeToMono(file)).rejects.toThrow();
  });
});

describe("whether detection runs at all", () => {
  // Origin R31 makes a measurement the condition of using a detector, and that
  // measurement has not been taken against the material this exists for. The
  // mechanism is finished; the permission is not, so the application asks.
  it("is off when nothing has turned it on", () => {
    expect(detectionEnabled({})).toBe(false);
    expect(detectionEnabled({ HAL_TEMPO_DETECTION: "" })).toBe(false);
    expect(detectionEnabled({ HAL_TEMPO_DETECTION: "0" })).toBe(false);
    expect(detectionEnabled({ HAL_TEMPO_DETECTION: "no" })).toBe(false);
  });

  it("is on when it has been", () => {
    expect(detectionEnabled({ HAL_TEMPO_DETECTION: "1" })).toBe(true);
    expect(detectionEnabled({ HAL_TEMPO_DETECTION: "true" })).toBe(true);
    expect(detectionEnabled({ HAL_TEMPO_DETECTION: "TRUE" })).toBe(true);
  });

  it("measures nothing while it is off", async () => {
    // The track has to actually exist in the store, or detection bails at the
    // file check and the decoder is never reached whether the gate is there or
    // not — a test that passes with its own mechanism removed.
    const store = new AudioStore(dir);
    const entry = await track(store, "gate.flac");
    const playlist = await store.create("Gate");
    await store.addTracks(playlist!.id, [entry]);

    const seen: string[] = [];
    const off = new TempoDetector(store, {
      enabled: false,
      decode: async () => {
        seen.push("decoded");
        return audio();
      },
      analyse: () => [0, 0.5, 1, 1.5],
    });
    off.measureAll(playlist!.id, [entry]);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([]);

    // The same detector with the gate open reaches the decoder, which is what
    // makes the assertion above about the gate rather than about the fixture.
    const on = new TempoDetector(store, {
      enabled: true,
      decode: async () => {
        seen.push("decoded");
        return audio();
      },
      analyse: () => [0, 0.5, 1, 1.5],
    });
    on.measureAll(playlist!.id, [entry]);
    await waitFor(() => seen.length > 0, "the open detector to decode");
  });
});
