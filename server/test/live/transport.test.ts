// The server-owned transport: the clock, the advance, the arming gate.
//
// Not one wall-clock sleep in here, deliberately. Every assertion below is about
// a boundary — the second a readout changes, the moment a track ends, the
// tolerance a correction falls outside — and a boundary tested by sleeping is
// the flake class `docs/solutions/test-suite-flakes-under-load.md` records this
// suite paying for once already. The clock is injected, the tests move it, and
// `waitFor` covers the places where a real filesystem answers asynchronously.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { WebSocket } from "ws";
import { tmpDir } from "../tmp.js";
import { waitFor } from "../wait.js";
import { AudioStore } from "../../src/storage/audio.js";
import { WorldStore } from "../../src/storage/worlds.js";
import { WorldService, type WorldHub } from "../../src/live/service.js";
import { WorldRuntime } from "../../src/live/runtime.js";
import {
  AudioTransport,
  CLIENT_END_GRACE_MS,
  TRANSPORT_TICK_MS,
  UNMEASURED_GRACE_MS,
  type TransportTime,
} from "../../src/live/transport.js";
import { WORLD_VERSION } from "../../../shared/src/worlds.js";
import {
  AUDIO_BPM,
  AUDIO_LENGTH,
  AUDIO_PLAYING,
  AUDIO_REMAINING,
  AUDIO_TRACK,
  AUDIO_TRACKS,
} from "../../../shared/src/audio.js";
import type {
  AudioTransportStateMessage,
  ClientMessage,
  Condition,
  ParameterValue,
  Playlist,
  PlaylistTrack,
  ServerMessage,
  Transition,
  TransportState,
  World,
  WorldResultMessage,
  WorldState,
} from "../../../shared/src/types.js";

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/**
 * A clock the test moves.
 *
 * `jump` moves time without firing a tick and `advance` moves it in tick-sized
 * slices, which is the difference between "get to five minutes in" and "cross
 * this boundary". Both matter: stepping five minutes tick by tick is three
 * thousand pointless iterations, and jumping over a track's end would skip the
 * very moment under test.
 */
class FakeTime implements TransportTime {
  private t = 1_700_000_000_000;
  private timers: { fn: () => void }[] = [];

  now(): number {
    return this.t;
  }

  every(_ms: number, fn: () => void): () => void {
    const entry = { fn };
    this.timers.push(entry);
    return () => {
      this.timers = this.timers.filter((t) => t !== entry);
    };
  }

  /** Move the clock with nothing observing it. */
  jump(ms: number): void {
    this.t += ms;
  }

  /** Move the clock, firing every tick that falls due. */
  async advance(ms: number): Promise<void> {
    let left = ms;
    while (left > 0) {
      const step = Math.min(left, TRANSPORT_TICK_MS);
      this.t += step;
      left -= step;
      for (const timer of [...this.timers]) timer.fn();
      // A microtask turn per tick, so a publish that woke the machine has run
      // before the next one. Not a sleep: nothing here waits on a duration.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let dir: string;
let audio: AudioStore;
let time: FakeTime;
let transports: AudioTransport[] = [];

beforeEach(async () => {
  dir = await tmpDir("transport");
  audio = new AudioStore(dir);
  time = new FakeTime();
  transports = [];
});

afterEach(() => {
  for (const transport of transports) transport.stop();
  transports = [];
});

/** A playlist whose files actually exist in the store, in the order given. */
async function playlist(
  name: string,
  tracks: { file: string; durationMs?: number; bpm?: number }[],
): Promise<Playlist> {
  const created = await audio.create(name);
  await fs.mkdir(audio.tracksDir(), { recursive: true });
  const arrivals: PlaylistTrack[] = [];
  for (const track of tracks) {
    await fs.writeFile(path.join(audio.tracksDir(), track.file), "not really audio", "utf8");
    arrivals.push({
      path: `tracks/${track.file}`,
      name: track.file,
      durationMs: track.durationMs ?? 300_000,
      ...(track.bpm === undefined ? {} : { bpm: track.bpm, bpmSource: "measured" as const }),
    });
  }
  const result = await audio.addTracks(created.id, arrivals);
  if (!result.ok) throw new Error(result.error);
  return result.playlist;
}

interface Rig {
  transport: AudioTransport;
  readouts: Record<string, ParameterValue>[];
  states: TransportState[];
  last(): TransportState;
}

function transport(): Rig {
  const readouts: Record<string, ParameterValue>[] = [];
  const states: TransportState[] = [];
  const t = new AudioTransport(audio, {
    onReadouts: (r) => readouts.push(r),
    onChange: (s) => states.push(s),
    time,
  });
  transports.push(t);
  t.start();
  return { transport: t, readouts, states, last: () => t.state() };
}

// A World, minimally.

const clip = (name: string, durationMs = 60_000) => ({ path: `clips/${name}.mp4`, durationMs });
const state = (id: string, clipName: string | null = id, durationMs = 60_000): WorldState => ({
  id,
  name: id,
  clips: clipName ? [{ clips: [clip(clipName, durationMs)] }] : [],
  x: 0,
  y: 0,
});
const transition = (over: Partial<Transition> & Pick<Transition, "id" | "to">): Transition => ({
  clips: [],
  conditions: [],
  hasExitTime: false,
  exitTime: 1,
  order: 0,
  ...over,
});
const cond = (parameter: string, op: Condition["op"], value: Condition["value"]): Condition => ({
  parameter,
  op,
  value,
});

function world(over: Partial<World> = {}): World {
  return {
    version: WORLD_VERSION,
    id: "lounge",
    name: "Lounge",
    defaultStateId: "a",
    states: [],
    transitions: [],
    parameters: [],
    ...over,
  };
}

/**
 * A started machine, sitting in its default State.
 *
 * `start()` enters asynchronously, so a readout pushed in the same turn arrives
 * while `stateId` is still null and nothing is offered from anywhere. The
 * transport is never in that position — a World is running before it plays
 * anything — so waiting here is the honest fixture rather than a workaround.
 */
async function machine(w: World): Promise<WorldRuntime> {
  const runtime = new WorldRuntime(w, { onChange: () => {} });
  runtime.start();
  await waitFor(() => runtime.live().stateId === w.defaultStateId, "the machine to enter its default State");
  return runtime;
}

/** A transport whose readouts go straight into one machine, as the service wires it. */
function wired(runtime: WorldRuntime): AudioTransport {
  const t = new AudioTransport(audio, {
    onReadouts: (r) => runtime.setAudio(r),
    onChange: () => {},
    time,
  });
  transports.push(t);
  t.start();
  return t;
}

// ---------------------------------------------------------------------------

describe("the clock and the readouts", () => {
  it("changes remaining time exactly once per second of advance", async () => {
    const list = await playlist("Set", [{ file: "a.flac", durationMs: 300_000 }]);
    const rig = transport();
    await rig.transport.arm(list.id);
    await waitFor(() => rig.last().index === 0, "the first track to begin");

    const before = rig.readouts.length;
    await time.advance(3_000);
    const pushes = rig.readouts.slice(before);
    expect(pushes.length).toBe(3);
    expect(pushes.map((r) => r[AUDIO_REMAINING])).toEqual([299, 298, 297]);
  });

  it("pushes nothing when the advance leaves the whole-second value equal", async () => {
    const list = await playlist("Set", [{ file: "a.flac", durationMs: 300_000 }]);
    const rig = transport();
    await rig.transport.arm(list.id);
    await waitFor(() => rig.last().index === 0, "the first track to begin");

    const before = rig.readouts.length;
    await time.advance(600);
    expect(rig.readouts.length).toBe(before);
  });

  it("broadcasts a volume change without waking the machine for it", async () => {
    const list = await playlist("Set", [{ file: "a.flac", durationMs: 300_000 }]);
    const rig = transport();
    await rig.transport.arm(list.id);
    await waitFor(() => rig.last().index === 0, "the first track to begin");

    const readouts = rig.readouts.length;
    const states = rig.states.length;
    await rig.transport.command({ command: "volume", volume: 0.4 });
    // The broadcast is forced so a client hears at once; the readout push is
    // never forced, because volume is not something a World evaluates on.
    expect(rig.states.length).toBe(states + 1);
    expect(rig.readouts.length).toBe(readouts);
  });

  it("reports the readouts a playing track has, and nothing-playing when stopped", async () => {
    const list = await playlist("Set", [
      { file: "a.flac", durationMs: 300_000, bpm: 174 },
      { file: "b.flac" },
    ]);
    const rig = transport();
    await rig.transport.arm(list.id);
    await waitFor(() => rig.last().index === 0, "the first track to begin");

    expect(rig.transport.readouts()).toEqual({
      [AUDIO_PLAYING]: true,
      [AUDIO_TRACK]: 1,
      [AUDIO_TRACKS]: 2,
      [AUDIO_LENGTH]: 300,
      [AUDIO_REMAINING]: 300,
      [AUDIO_BPM]: 174,
    });

    await rig.transport.command({ command: "stop" });
    expect(rig.transport.readouts()).toEqual({
      [AUDIO_PLAYING]: false,
      [AUDIO_BPM]: 0,
      [AUDIO_REMAINING]: 0,
      [AUDIO_LENGTH]: 0,
      [AUDIO_TRACK]: 0,
      [AUDIO_TRACKS]: 0,
    });
  });

  it("leaves audio.bpm absent while a playing track's tempo is unknown", async () => {
    const list = await playlist("Set", [{ file: "a.flac" }]);
    const rig = transport();
    await rig.transport.arm(list.id);
    await waitFor(() => rig.last().index === 0, "the first track to begin");

    expect(AUDIO_BPM in rig.transport.readouts()).toBe(false);

    // And absent is not zero: a below-threshold condition is not satisfied by a
    // tempo nobody has measured (origin R34).
    const runtime = await machine(
      world({
        states: [state("a"), state("b")],
        transitions: [
          transition({ id: "t", from: "a", to: "b", conditions: [cond(AUDIO_BPM, "lt", 100)] }),
        ],
      }),
    );
    runtime.setAudio(rig.transport.readouts());
    await new Promise((resolve) => setImmediate(resolve));
    expect(runtime.live().stateId).toBe("a");
    runtime.stop();
  });
});

describe("audio-conditioned transitions", () => {
  it("covers AE7: moves at the remaining-time boundary, mid-clip, with no client attached", async () => {
    const list = await playlist("Set", [{ file: "a.flac", durationMs: 300_000 }]);
    const runtime = await machine(
      world({
        states: [state("a", "a", 60_000), state("b")],
        transitions: [
          transition({
            id: "t",
            from: "a",
            to: "b",
            conditions: [cond(AUDIO_PLAYING, "is", true), cond(AUDIO_REMAINING, "lt", 6)],
          }),
        ],
      }),
    );
    const t = wired(runtime);
    await t.arm(list.id);
    await waitFor(() => t.state().index === 0, "the first track to begin");

    // Six seconds left: the boundary has not been crossed, and the clip is
    // nowhere near its end either.
    time.jump(293_000);
    await time.advance(1_000);
    expect(runtime.live().stateId).toBe("a");

    // Five seconds left.
    await time.advance(1_000);
    await waitFor(() => runtime.live().stateId === "b", "the audio-conditioned transition");
    expect(t.state().positionMs).toBeLessThan(300_000);
    runtime.stop();
  });

  it("covers AE8: takes the transition on arrival when the boundary passed during a bridge", async () => {
    const list = await playlist("Set", [{ file: "a.flac", durationMs: 300_000 }]);
    const runtime = await machine(
      world({
        parameters: [{ name: "go", type: "bool", defaultValue: false }],
        states: [state("a"), state("mid"), state("b")],
        transitions: [
          transition({
            id: "cross",
            from: "a",
            to: "mid",
            conditions: [cond("go", "is", true)],
            clips: [{ clips: [clip("bridge", 1_000)] }],
            order: 0,
          }),
          transition({
            id: "t",
            from: "mid",
            to: "b",
            conditions: [cond(AUDIO_PLAYING, "is", true), cond(AUDIO_REMAINING, "lt", 6)],
            order: 1,
          }),
        ],
      }),
    );
    const t = wired(runtime);
    await t.arm(list.id);
    await waitFor(() => t.state().index === 0, "the first track to begin");

    runtime.setParameter("go", true);
    await waitFor(() => !runtime.idle, "the bridge to be in flight");

    // The boundary passes while the crossing holds the machine: nothing is
    // evaluated, and the readout push is recorded rather than acted on.
    time.jump(295_100);
    await time.advance(200);
    expect(runtime.live().stateId).toBe("a");

    // Arrival. The threshold that opened during the bridge is still true.
    runtime.step();
    await waitFor(() => runtime.live().stateId === "b", "the transition on arrival");
    runtime.stop();
  });
});

describe("the playlist advance", () => {
  it("advances on the end of a track with nothing attached", async () => {
    const list = await playlist("Set", [
      { file: "a.flac", durationMs: 3_000 },
      { file: "b.flac", durationMs: 3_000 },
    ]);
    const rig = transport();
    await rig.transport.arm(list.id);
    await waitFor(() => rig.last().index === 0, "the first track to begin");

    await time.advance(3_000);
    await waitFor(() => rig.last().index === 1, "the second track to begin");
    expect(rig.last().path).toBe("tracks/b.flac");
    expect(rig.last().positionMs).toBe(0);
  });

  it("covers AE11: plays past a missing file and leaves its entry marked unplayable", async () => {
    const list = await playlist("Set", [
      { file: "a.flac" },
      { file: "b.flac" },
      { file: "c.flac" },
      { file: "d.flac" },
    ]);
    await fs.rm(path.join(audio.tracksDir(), "c.flac"));

    const rig = transport();
    await rig.transport.arm(list.id);
    await waitFor(() => rig.last().index === 0, "the first track to begin");
    await rig.transport.command({ command: "next" });
    await rig.transport.command({ command: "next" });

    expect(rig.last().path).toBe("tracks/d.flac");
    const after = await audio.load(list.id);
    expect(after!.tracks.map((t) => t.path)).toEqual([
      "tracks/a.flac",
      "tracks/b.flac",
      "tracks/c.flac",
      "tracks/d.flac",
    ]);
    expect(after!.tracks[2]!.unplayable).toBe(true);
  });

  it("stops rather than spinning when no track in the playlist can be played", async () => {
    const list = await playlist("Set", [{ file: "a.flac" }, { file: "b.flac" }]);
    await fs.rm(path.join(audio.tracksDir(), "a.flac"));
    await fs.rm(path.join(audio.tracksDir(), "b.flac"));

    const rig = transport();
    await rig.transport.arm(list.id);

    expect(rig.last().index).toBe(-1);
    expect(rig.last().playing).toBe(false);
    expect(rig.last().error).toMatch(/could be played/);
    // And the clock does not keep trying: with nothing held there is nothing to
    // advance, so a hundred ticks produce no further work.
    const before = rig.states.length;
    await time.advance(10_000);
    expect(rig.states.length).toBe(before);
  });

  it("does not restart the advance on every tick while the filesystem is still answering", async () => {
    const list = await playlist("Set", [
      { file: "a.flac", durationMs: 1_000 },
      { file: "b.flac" },
    ]);
    // A store that takes longer to answer than a tick — a network drive, or a
    // spun-down disk. Without the in-flight guard every tick starts another
    // advance and supersedes the one already walking, so the track that ended
    // never begins the next one.
    const calls = { n: 0 };
    const slow: AudioStore = Object.create(audio);
    slow.resolveTrack = async (rel: unknown) => {
      calls.n += 1;
      for (let i = 0; i < 100; i += 1) await new Promise((resolve) => setImmediate(resolve));
      return audio.resolveTrack(rel);
    };
    const t = new AudioTransport(slow, { onReadouts: () => {}, onChange: () => {}, time });
    transports.push(t);
    t.start();
    await t.arm(list.id);
    await waitFor(() => t.state().index === 0, "the first track to begin");

    const before = calls.n;
    await time.advance(3_000);
    await waitFor(() => t.state().index === 1, "the second track to begin");
    expect(calls.n - before).toBe(1);
  });

  it("paces a hand-edited one-millisecond track against the floor rather than spinning", async () => {
    const list = await playlist("Set", [
      { file: "a.flac", durationMs: 1 },
      { file: "b.flac" },
    ]);
    const rig = transport();
    await rig.transport.arm(list.id);
    await waitFor(() => rig.last().index === 0, "the first track to begin");

    // The floor is visible in the readouts before it is visible in the advance,
    // and that assertion is the deterministic half: without it the length rounds
    // to zero seconds and the track ends on the first tick.
    expect(rig.transport.readouts()[AUDIO_LENGTH]).toBe(1);

    await time.advance(300);
    // A fixed wait, and the one shape AGENTS.md keeps it for: this is a negative
    // assertion — "nothing advanced yet" — and there is no condition to poll.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rig.last().index).toBe(0);

    await time.advance(800);
    await waitFor(() => rig.last().index === 1, "the floor to expire");
  });
});

describe("a length nobody has measured", () => {
  it("does not advance against a fabricated length, and starts on a reported one", async () => {
    const list = await playlist("Set", [
      { file: "a.mp3", durationMs: 0 },
      { file: "b.mp3", durationMs: 0 },
    ]);
    const rig = transport();
    await rig.transport.arm(list.id);
    await waitFor(() => rig.last().index === 0, "the first track to begin");

    await time.advance(2_000);
    expect(rig.last().index).toBe(0);
    // Unknown, not zero: both are absent from the readouts, so a `remaining`
    // condition is not satisfied by a track whose length nobody knows.
    expect(AUDIO_REMAINING in rig.transport.readouts()).toBe(false);
    expect(AUDIO_LENGTH in rig.transport.readouts()).toBe(false);

    const reported = await rig.transport.reportDuration(list.id, "tracks/a.mp3", 240_000);
    expect(reported.ok).toBe(true);
    expect(rig.transport.readouts()[AUDIO_LENGTH]).toBe(240);
    expect(rig.transport.readouts()[AUDIO_REMAINING]).toBe(238);
    expect((await audio.load(list.id))!.tracks[0]!.durationMs).toBe(240_000);
  });

  it("gives up on an unmeasured track rather than stalling the playlist forever", async () => {
    const list = await playlist("Set", [
      { file: "a.mp3", durationMs: 0 },
      { file: "b.mp3", durationMs: 60_000 },
    ]);
    const rig = transport();
    await rig.transport.arm(list.id);
    await waitFor(() => rig.last().index === 0, "the first track to begin");

    time.jump(UNMEASURED_GRACE_MS - 1_000);
    await time.advance(1_100);
    await waitFor(() => rig.last().index === 1, "the grace to expire");
    // Not marked unplayable: nobody measured it, which is not the same as
    // knowing it will not play.
    expect((await audio.load(list.id))!.tracks[0]!.unplayable).toBeUndefined();
  });

  it("refuses a length that is not one, and a report for another playlist", async () => {
    const list = await playlist("Set", [{ file: "a.mp3", durationMs: 0 }]);
    const rig = transport();
    await rig.transport.arm(list.id);
    await waitFor(() => rig.last().index === 0, "the first track to begin");

    expect((await rig.transport.reportDuration(list.id, "tracks/a.mp3", Number.NaN)).ok).toBe(false);
    expect((await rig.transport.reportDuration(list.id, "tracks/a.mp3", 0)).ok).toBe(false);
    expect((await rig.transport.reportDuration("other", "tracks/a.mp3", 1_000)).ok).toBe(false);
    expect((await audio.load(list.id))!.tracks[0]!.durationMs).toBe(0);
  });
});

describe("a position correction", () => {
  it("adjusts the clock inside the tolerance and is refused outside it", async () => {
    const list = await playlist("Set", [{ file: "a.flac", durationMs: 300_000 }]);
    const rig = transport();
    await rig.transport.arm(list.id);
    await waitFor(() => rig.last().index === 0, "the first track to begin");
    await time.advance(10_000);
    expect(rig.last().positionMs).toBe(10_000);

    expect(rig.transport.reportPosition(list.id, "tracks/a.flac", 11_500)).toBe(true);
    expect(rig.last().positionMs).toBe(11_500);

    // Wildly out: refused, and the clock is where it was.
    expect(rig.transport.reportPosition(list.id, "tracks/a.flac", 90_000)).toBe(false);
    expect(rig.last().positionMs).toBe(11_500);
  });

  it("refuses a correction that does not name what is actually playing", async () => {
    const list = await playlist("Set", [
      { file: "a.flac", durationMs: 300_000 },
      { file: "b.flac", durationMs: 300_000 },
    ]);
    const rig = transport();
    await rig.transport.arm(list.id);
    await waitFor(() => rig.last().index === 0, "the first track to begin");
    await time.advance(10_000);

    expect(rig.transport.reportPosition(list.id, "tracks/b.flac", 10_100)).toBe(false);
    expect(rig.transport.reportPosition("other", "tracks/a.flac", 10_100)).toBe(false);
    expect(rig.transport.reportPosition(list.id, "tracks/a.flac", Number.NaN)).toBe(false);
    expect(rig.transport.reportPosition(list.id, "tracks/a.flac", -50)).toBe(false);
    expect(rig.last().positionMs).toBe(10_000);

    // And nothing at all while the transport is paused: a paused track is not
    // drifting, so a report about it is stale by construction.
    await rig.transport.command({ command: "pause" });
    expect(rig.transport.reportPosition(list.id, "tracks/a.flac", 10_100)).toBe(false);
  });
});

describe("an end report from the element", () => {
  /** A transport with a client attending and cleared to sound, as a browser leaves it. */
  async function sounding(id: string): Promise<Rig> {
    const rig = transport();
    rig.transport.attend();
    rig.transport.enableSound();
    await rig.transport.arm(id);
    await waitFor(() => rig.last().index === 0, "the first track to begin");
    return rig;
  }

  it("advances the moment the sounding client says the track finished", async () => {
    const list = await playlist("Set", [
      { file: "a.flac", durationMs: 300_000 },
      { file: "b.flac", durationMs: 300_000 },
    ]);
    const rig = await sounding(list.id);
    await time.advance(2_000);

    expect(await rig.transport.reportEnd(list.id, "tracks/a.flac")).toBe(true);
    // Not at the total, not after a grace: the element is the authority on the
    // end of a track it is actually playing.
    expect(rig.last().index).toBe(1);
    expect(rig.last().path).toBe("tracks/b.flac");
    expect(rig.last().positionMs).toBe(0);
  });

  it("refuses a report that does not name what is actually playing", async () => {
    const list = await playlist("Set", [
      { file: "a.flac", durationMs: 300_000 },
      { file: "b.flac", durationMs: 300_000 },
    ]);
    const rig = await sounding(list.id);

    // The track before last, from an element that has since been given another
    // source: the refusal set exists so this cannot skip a track nobody heard.
    expect(await rig.transport.reportEnd(list.id, "tracks/b.flac")).toBe(false);
    expect(await rig.transport.reportEnd("other", "tracks/a.flac")).toBe(false);
    expect(await rig.transport.reportEnd(list.id, null)).toBe(false);
    expect(rig.last().index).toBe(0);

    // And nothing while the transport is paused: a paused track has not ended.
    await rig.transport.command({ command: "pause" });
    expect(await rig.transport.reportEnd(list.id, "tracks/a.flac")).toBe(false);
    expect(rig.last().index).toBe(0);
  });

  it("gives the element a margin past the total before the clock takes over", async () => {
    const list = await playlist("Set", [
      { file: "a.flac", durationMs: 5_000 },
      { file: "b.flac", durationMs: 5_000 },
    ]);
    const rig = await sounding(list.id);

    // Past the end by the server's reckoning, and still on the same track: the
    // browser started decoding after the server anchored it, so it is behind by
    // however long the fetch and the gesture took, and advancing here is what
    // cut the tail off every track.
    await time.advance(5_500);
    // A fixed wait, and the shape AGENTS.md keeps it for: this is a negative
    // assertion — "the advance did not happen" — and an advance resolves paths
    // against the filesystem, so there is no condition to poll for its absence.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rig.last().index).toBe(0);

    // The margin is bounded: an `ended` that never arrives costs it and no more.
    await time.advance(CLIENT_END_GRACE_MS);
    await waitFor(() => rig.last().index === 1, "the clock to take over");
  });

  it("does not delay an advance with nothing attending", async () => {
    const list = await playlist("Set", [
      { file: "a.flac", durationMs: 3_000 },
      { file: "b.flac", durationMs: 3_000 },
    ]);
    const rig = transport();
    await rig.transport.arm(list.id);
    await waitFor(() => rig.last().index === 0, "the first track to begin");

    // No element, no report coming, so no margin: a World with no page open
    // takes the same transitions at the same moments (origin R25, AE7).
    await time.advance(3_000);
    await waitFor(() => rig.last().index === 1, "the second track to begin");
  });

  it("does not wait on a client that has said it cannot sound", async () => {
    const list = await playlist("Set", [
      { file: "a.flac", durationMs: 3_000 },
      { file: "b.flac", durationMs: 3_000 },
    ]);
    const rig = await sounding(list.id);
    // A browser that refused to play will never fire `ended`, so waiting for one
    // is waiting for nothing (origin R8).
    rig.transport.reportFailure("The browser blocked it.");

    await time.advance(3_000);
    await waitFor(() => rig.last().index === 1, "the second track to begin");
  });
});

// ---------------------------------------------------------------------------
// The arming gate, over the protocol
// ---------------------------------------------------------------------------

class FakeHub implements WorldHub {
  readonly broadcasts: ServerMessage[] = [];
  readonly sent: ServerMessage[] = [];
  /**
   * What each socket was told, separately.
   *
   * The authority is granted per socket, so a fake that only pooled what was
   * sent could not tell "both tabs were told they own it" from "one was". Two
   * stand-in sockets rather than one, for the same reason.
   */
  readonly perClient = new Map<WebSocket, ServerMessage[]>();
  private readonly handlers: ((msg: ClientMessage, c: WebSocket) => void)[] = [];
  private readonly greeters: ((c: WebSocket) => void)[] = [];
  private readonly closers: ((c: WebSocket) => void)[] = [];
  readonly client = { id: "test-client" } as unknown as WebSocket;
  readonly second = { id: "second-client" } as unknown as WebSocket;

  broadcast(msg: ServerMessage): void {
    this.broadcasts.push(msg);
  }
  onMessage(h: (msg: ClientMessage, c: WebSocket) => void): void {
    this.handlers.push(h);
  }
  onConnection(g: (c: WebSocket) => void): void {
    this.greeters.push(g);
  }
  onClose(c: (client: WebSocket) => void): void {
    this.closers.push(c);
  }
  sendTo(client: WebSocket, msg: ServerMessage): void {
    this.sent.push(msg);
    const list = this.perClient.get(client) ?? [];
    list.push(msg);
    this.perClient.set(client, list);
  }
  dispatch(msg: ClientMessage, from: WebSocket = this.client): void {
    for (const h of this.handlers) h(msg, from);
  }
  connect(client: WebSocket = this.client): void {
    for (const g of this.greeters) g(client);
  }
  disconnect(client: WebSocket = this.client): void {
    for (const c of this.closers) c(client);
  }
  /** The last thing this socket was told about the grant, or undefined for never. */
  authority(client: WebSocket): boolean | undefined {
    const list = this.perClient.get(client) ?? [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const msg = list[i]!;
      if (msg.type === "audio-authority") return msg.authority;
    }
    return undefined;
  }
  results(): (WorldResultMessage | Extract<ServerMessage, { type: "playlist-result" }>)[] {
    return this.broadcasts.filter(
      (m): m is WorldResultMessage | Extract<ServerMessage, { type: "playlist-result" }> =>
        m.type === "world-result" || m.type === "playlist-result",
    );
  }
  worldResults(): WorldResultMessage[] {
    return this.broadcasts.filter((m): m is WorldResultMessage => m.type === "world-result");
  }
  transport(): TransportState | undefined {
    for (let i = this.broadcasts.length - 1; i >= 0; i -= 1) {
      const msg = this.broadcasts[i]!;
      if (msg.type === "audio-transport-state") return (msg as AudioTransportStateMessage).transport;
    }
    return undefined;
  }
}

// Shared by the two service-level describes below, which drive the same service
// through the same hub and differ only in what they are asking about.
let hub: FakeHub;
let service: WorldService | null;

function startService(): void {
  hub = new FakeHub();
  service = new WorldService(hub, new WorldStore(dir), audio, time);
}

function stopService(): void {
  service?.stop();
  service = null;
}

async function send(msg: ClientMessage, label: string, from?: WebSocket): Promise<void> {
  const before = hub.results().length;
  hub.dispatch(msg, from);
  await waitFor(() => hub.results().length > before, label);
}

/** A World named for its playlist, opened. */
async function openWith(name: string, playlistId: string | null): Promise<string> {
  await send({ type: "create-world", world: { name } }, `${name} to be created`);
  const id = hub.worldResults().at(-1)!.worldId!;
  if (playlistId) {
    await send({ type: "set-world-playlist", worldId: id, playlistId }, `${name}'s playlist`);
  }
  await send({ type: "open-world", worldId: id }, `${name} to open`);
  return id;
}

describe("playback is independent of World lifecycle", () => {
  beforeEach(startService);
  afterEach(stopService);

  it("plays tracks added to the playlist it is already holding", async () => {
    // The transport keeps its own snapshot of the set, taken when it was armed,
    // and used to refresh it only after its *own* writes. So a playlist added to
    // while it played went on looping whatever it was armed with — and no client
    // refresh could help, because the stale copy is on the server. Reported from
    // real use: "I added 15 more songs and it's still only looping the original
    // two."
    const set = await playlist("DJ Booth1", [{ file: "one.flac" }, { file: "two.flac" }]);
    await service!.start();
    await openWith("Booth", set.id);
    await waitFor(() => hub.transport()?.playing === true, "the set to begin");
    expect(hub.transport()?.tracks).toBe(2);

    // Written the way an import writes it, then announced the way every
    // playlist edit is announced.
    await fs.writeFile(path.join(audio.tracksDir(), "three.flac"), "not really audio", "utf8");
    const grown = await audio.addTracks(set.id, [
      { path: "tracks/three.flac", name: "three.flac", durationMs: 300_000 },
    ]);
    expect(grown.ok).toBe(true);
    await send({ type: "list-playlists", playlistId: set.id }, "the index to be announced");

    await waitFor(() => hub.transport()?.tracks === 3, "the transport to see the new track");
    // Still on the track it was playing, by path — an append must not move it.
    expect(hub.transport()?.path).toBe("tracks/one.flac");
  });

  it("says it started again when a playlist of one comes round", async () => {
    // The wrap works and always did: index 0 to index 0. What was missing is any
    // way for a client to *know*. The path is unchanged, so an element keyed on
    // the file alone sits finished while the clock runs — which is what "no
    // looping" looked like from the outside. `LiveState.generation` solves the
    // same problem for clips by bumping on every turn of a loop.
    const set = await playlist("Solo", [{ file: "one.flac", durationMs: 4_000 }]);
    await service!.start();
    await openWith("Booth", set.id);
    await waitFor(() => hub.transport()?.playing === true, "the track to begin");

    const first = hub.transport()!;
    expect(first.index).toBe(0);

    await time.advance(4_100);
    await waitFor(() => (hub.transport()?.generation ?? 0) > first.generation, "the track to come round");

    const second = hub.transport()!;
    expect(second.index).toBe(0);
    expect(second.path).toBe(first.path);
    expect(second.generation).toBeGreaterThan(first.generation);
  });

  it("starts a playlist named on the World that is already open", async () => {
    // The flow every author actually uses: open a World, build a set, point the
    // World at it. Every other test here names the playlist *before* opening,
    // which is why they all passed while this did not work at all — the manifest
    // was written and the transport stayed at index -1, with nothing to say why
    // and reopening the World the only way through.
    const set = await playlist("Set", [{ file: "one.flac" }]);
    await service!.start();
    const id = await openWith("Booth", null);

    await send({ type: "set-world-playlist", worldId: id, playlistId: set.id }, "the World to name it");

    await waitFor(() => hub.transport()?.playing === true, "the named playlist to begin");
    expect(hub.transport()?.playlistId).toBe(set.id);
    expect(hub.transport()?.index).toBe(0);
  });

  it("does not cut off a track already playing when a World is pointed elsewhere", async () => {
    // The other half of the same rule. Arming refuses while a track is held, so
    // naming a playlist mid-set is a change that takes effect when the music
    // stops rather than one that stops it (origin R3).
    const playing = await playlist("Warmup", [{ file: "a.flac" }]);
    const other = await playlist("Peak", [{ file: "b.flac" }]);
    await service!.start();
    const id = await openWith("Booth", playing.id);
    await waitFor(() => hub.transport()?.path === "tracks/a.flac", "the first track to begin");

    await send({ type: "set-world-playlist", worldId: id, playlistId: other.id }, "the World to be repointed");
    await time.advance(2_000);

    expect(hub.transport()?.path).toBe("tracks/a.flac");
    expect(hub.transport()?.playlistId).toBe(playing.id);
  });

  it("covers AE5: switching Worlds arms nothing and leaves the track playing", async () => {
    const a = await playlist("Warmup", [{ file: "a.flac" }]);
    const b = await playlist("Peak", [{ file: "b.flac" }]);
    await service!.start();

    await openWith("Alpha", a.id);
    await waitFor(() => hub.transport()?.path === "tracks/a.flac", "Alpha's track to begin");
    await time.advance(2_000);

    await openWith("Beta", b.id);
    // A moment of ticks, so an arm that was going to happen has had every
    // chance to. A negative assertion has no condition to poll, which is the one
    // case a wait is measured rather than polled.
    await time.advance(1_000);

    expect(hub.transport()?.playlistId).toBe(a.id);
    expect(hub.transport()?.path).toBe("tracks/a.flac");
    expect(hub.transport()?.playing).toBe(true);
    expect(hub.transport()!.positionMs).toBeGreaterThan(2_000);
  });

  it("covers AE6: starting World B's playlist stops A's track and begins B's first", async () => {
    const a = await playlist("Warmup", [{ file: "a.flac" }]);
    const b = await playlist("Peak", [{ file: "b.flac" }, { file: "c.flac" }]);
    await service!.start();

    await openWith("Alpha", a.id);
    await waitFor(() => hub.transport()?.path === "tracks/a.flac", "Alpha's track to begin");
    const beta = await openWith("Beta", b.id);

    await send(
      { type: "audio-transport", command: "start-world-playlist", worldId: beta },
      "the playlist swap",
    );
    await waitFor(() => hub.transport()?.path === "tracks/b.flac", "Beta's first track");
    expect(hub.transport()?.playlistId).toBe(b.id);
    expect(hub.transport()?.index).toBe(0);
  });

  it("does not open the arming gate by pausing", async () => {
    const a = await playlist("Warmup", [{ file: "a.flac" }]);
    const b = await playlist("Peak", [{ file: "b.flac" }]);
    await service!.start();

    await openWith("Alpha", a.id);
    await waitFor(() => hub.transport()?.path === "tracks/a.flac", "Alpha's track to begin");
    await send({ type: "audio-transport", command: "pause" }, "the pause");
    expect(hub.transport()?.playing).toBe(false);

    await openWith("Beta", b.id);
    await time.advance(1_000);
    // Still Alpha's track, still paused: a paused track occupies the transport.
    expect(hub.transport()?.playlistId).toBe(a.id);
    expect(hub.transport()?.playing).toBe(false);
  });

  it("arms into an empty transport once it has been stopped", async () => {
    const a = await playlist("Warmup", [{ file: "a.flac" }]);
    const b = await playlist("Peak", [{ file: "b.flac" }]);
    await service!.start();

    await openWith("Alpha", a.id);
    await waitFor(() => hub.transport()?.path === "tracks/a.flac", "Alpha's track to begin");
    await send({ type: "audio-transport", command: "stop" }, "the stop");

    await openWith("Beta", b.id);
    await waitFor(() => hub.transport()?.path === "tracks/b.flac", "Beta's track to begin");
  });

  it("greets a connecting client with the transport, beside world-live and never inside it", async () => {
    const a = await playlist("Warmup", [{ file: "a.flac" }]);
    await service!.start();
    await openWith("Alpha", a.id);
    await waitFor(() => hub.transport()?.path === "tracks/a.flac", "Alpha's track to begin");

    hub.sent.length = 0;
    hub.connect();
    // Both, not one and then an assumption about the other. Waiting only for the
    // transport greeting and then asserting `world-live` had already arrived is
    // a race on greeting order: it passes whenever the two land in one turn and
    // fails when they do not, which is how this test failed once in four full
    // runs and passed in isolation every time.
    await waitFor(
      () =>
        hub.sent.some((m) => m.type === "audio-transport-state") &&
        hub.sent.some((m) => m.type === "world-live"),
      "both greetings",
    );
    const live = hub.sent.find((m) => m.type === "world-live");
    expect(live).toBeDefined();
    expect(JSON.stringify(live)).not.toMatch(/tracks\/a\.flac/);
  });

  it("does not broadcast world-live for a readout change alone", async () => {
    const a = await playlist("Warmup", [{ file: "a.flac", durationMs: 300_000 }]);
    await service!.start();
    await openWith("Alpha", a.id);
    await waitFor(() => hub.transport()?.path === "tracks/a.flac", "Alpha's track to begin");

    const before = hub.broadcasts.filter((m) => m.type === "world-live").length;
    await time.advance(5_000);
    expect(hub.broadcasts.filter((m) => m.type === "world-live").length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The audio authority (origin R4, R5, R6, R8)
//
// One owner, many consumers. Every assertion here is about the lifecycle rather
// than the fan-out, because that is where every bug in this shape has lived —
// `docs/solutions/exclusive-device-one-owner-many-consumers.md` records four of
// them, and a superseded owner still acting is the first.
// ---------------------------------------------------------------------------

describe("the audio authority", () => {
  beforeEach(startService);
  afterEach(stopService);

  /** Connect a socket and wait for the greeting to have said where it stands. */
  async function join(client: WebSocket, expected: boolean): Promise<void> {
    hub.connect(client);
    await waitFor(() => hub.authority(client) === expected, `${String(expected)} for a connecting client`);
  }

  it("grants the first client and tells the second it is only watching", async () => {
    await service!.start();
    await join(hub.client, true);
    await join(hub.second, false);

    // The grant rides on the greeting, beside the transport state rather than
    // inside it: the transport is the same everywhere, the grant is not.
    const greeting = hub.perClient.get(hub.second) ?? [];
    expect(greeting.some((m) => m.type === "audio-transport-state")).toBe(true);
    expect(greeting.filter((m) => m.type === "audio-authority")).toHaveLength(1);
    // And nothing moved the grant: the first client still holds it.
    expect(hub.authority(hub.client)).toBe(true);
  });

  it("refuses a transport command from a client that is not the authority", async () => {
    const a = await playlist("Warmup", [{ file: "a.flac" }]);
    await service!.start();
    await join(hub.client, true);
    await join(hub.second, false);
    await openWith("Alpha", a.id);
    await waitFor(() => hub.transport()?.path === "tracks/a.flac", "the track to begin");

    await send({ type: "audio-transport", command: "pause" }, "the refusal", hub.second);
    const refused = hub.results().at(-1)!;
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/authority/);
    // The read-only client drove nothing: the track is still playing.
    expect(hub.transport()?.playing).toBe(true);

    // The authority's identical command is obeyed, so this is about who asked
    // rather than about the command.
    await send({ type: "audio-transport", command: "pause" }, "the pause");
    expect(hub.transport()?.playing).toBe(false);
  });

  it("refuses a position correction from a client that is not the authority", async () => {
    const a = await playlist("Warmup", [{ file: "a.flac", durationMs: 300_000 }]);
    await service!.start();
    await join(hub.client, true);
    await join(hub.second, false);
    await openWith("Alpha", a.id);
    await waitFor(() => hub.transport()?.path === "tracks/a.flac", "the track to begin");
    await time.advance(10_000);
    expect(hub.transport()?.positionMs).toBe(10_000);

    hub.dispatch(
      { type: "report-audio-position", playlistId: a.id, path: "tracks/a.flac", positionMs: 11_500 },
      hub.second,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(hub.transport()?.positionMs).toBe(10_000);

    // From the client that is actually sounding it, the same correction lands.
    hub.dispatch({
      type: "report-audio-position",
      playlistId: a.id,
      path: "tracks/a.flac",
      positionMs: 11_500,
    });
    await waitFor(() => hub.transport()?.positionMs === 11_500, "the authority's correction");
  });

  it("refuses an end report from a client that is not the authority", async () => {
    const a = await playlist("Warmup", [
      { file: "a.flac", durationMs: 300_000 },
      { file: "b.flac", durationMs: 300_000 },
    ]);
    await service!.start();
    await join(hub.client, true);
    await join(hub.second, false);
    await openWith("Alpha", a.id);
    await waitFor(() => hub.transport()?.path === "tracks/a.flac", "the track to begin");

    // A superseded tab's element keeps running for a beat and keeps firing.
    hub.dispatch({ type: "report-track-end", playlistId: a.id, path: "tracks/a.flac" }, hub.second);
    await new Promise((resolve) => setImmediate(resolve));
    expect(hub.transport()?.path).toBe("tracks/a.flac");

    // From the client that is actually sounding it, the same report advances.
    hub.dispatch({ type: "report-track-end", playlistId: a.id, path: "tracks/a.flac" });
    await waitFor(() => hub.transport()?.path === "tracks/b.flac", "the authority's end report");
  });

  it("covers AE4: arms without advancing until the gesture, and starts on it", async () => {
    const a = await playlist("Warmup", [{ file: "a.flac", durationMs: 300_000 }]);
    await service!.start();
    await join(hub.client, true);
    // A browser announcing itself as the loudspeaker, with no click yet.
    await send({ type: "audio-transport", command: "attend" }, "the loudspeaker");

    await openWith("Alpha", a.id);
    await waitFor(() => hub.transport()?.index === 0, "the playlist to arm");
    // Armed, not started: the track is held, nothing is sounding, and nothing is
    // audible either.
    expect(hub.transport()?.playing).toBe(false);
    expect(hub.transport()?.audible).toBe(false);

    await time.advance(3_000);
    expect(hub.transport()?.positionMs).toBe(0);

    await send({ type: "audio-transport", command: "enable-sound" }, "the gesture");
    expect(hub.transport()?.playing).toBe(true);
    expect(hub.transport()?.audible).toBe(true);
    await time.advance(2_000);
    expect(hub.transport()!.positionMs).toBeGreaterThanOrEqual(2_000);
  });

  it("stops the sound when the authority goes, and leaves the clock advancing", async () => {
    const a = await playlist("Warmup", [{ file: "a.flac", durationMs: 300_000 }]);
    await service!.start();
    await join(hub.client, true);
    await send({ type: "audio-transport", command: "attend" }, "the loudspeaker");
    await openWith("Alpha", a.id);
    await waitFor(() => hub.transport()?.index === 0, "the playlist to arm");
    await send({ type: "audio-transport", command: "enable-sound" }, "the gesture");
    await time.advance(4_000);
    expect(hub.transport()?.audible).toBe(true);

    hub.disconnect();
    await waitFor(() => hub.transport()?.audible === false, "the sound to stop");

    // The clock is the server's and keeps running: a World with no page open
    // takes the same transitions it would with one (origin R25).
    expect(hub.transport()?.playing).toBe(true);
    const at = hub.transport()!.positionMs;
    await time.advance(3_000);
    expect(hub.transport()!.positionMs).toBeGreaterThanOrEqual(at + 3_000);
    // Which is the point of the pair: the position is not a stale number being
    // served confidently, it is a live one nobody can hear.
  });

  it("passes the grant on when the holder leaves, and obeys the new holder", async () => {
    const a = await playlist("Warmup", [{ file: "a.flac" }]);
    await service!.start();
    await join(hub.client, true);
    await join(hub.second, false);
    await openWith("Alpha", a.id);
    await waitFor(() => hub.transport()?.path === "tracks/a.flac", "the track to begin");

    hub.disconnect();
    await waitFor(() => hub.authority(hub.second) === true, "the grant to pass on");

    await send({ type: "audio-transport", command: "pause" }, "the new holder's pause", hub.second);
    expect(hub.results().at(-1)!.ok).toBe(true);
    expect(hub.transport()?.playing).toBe(false);
  });

  it("hands the grant to a client that takes it, and refuses the one it took it from", async () => {
    const a = await playlist("Warmup", [{ file: "a.flac", durationMs: 300_000 }]);
    await service!.start();
    await join(hub.client, true);
    await join(hub.second, false);
    await send({ type: "audio-transport", command: "attend" }, "the loudspeaker");
    await openWith("Alpha", a.id);
    await waitFor(() => hub.transport()?.index === 0, "the playlist to arm");
    await send({ type: "audio-transport", command: "enable-sound" }, "the gesture");
    expect(hub.transport()?.audible).toBe(true);

    // The second tab takes it. Nothing arbitrates: this is one machine, and the
    // client asking is the person sitting at it. Without this the grant could
    // only ever be *released*, so a tab forgotten in another window held the
    // loudspeaker and every other pane was read-only with no way out.
    await send({ type: "take-audio-authority" }, "the take", hub.second);
    expect(hub.authority(hub.second)).toBe(true);
    // The superseded holder is told, at the moment it happens, rather than left
    // showing live controls for a transport it no longer drives.
    expect(hub.authority(hub.client)).toBe(false);
    // And it stops sounding: the clock runs on (origin R25) while `audible`
    // drops, because nothing is making a sound until the new holder says it is.
    expect(hub.transport()?.playing).toBe(true);
    expect(hub.transport()?.audible).toBe(false);

    // Every report the superseded tab has in flight is refused from here on —
    // the first of the four traps in
    // `docs/solutions/exclusive-device-one-owner-many-consumers.md`.
    await time.advance(10_000);
    const at = hub.transport()!.positionMs;
    hub.dispatch(
      { type: "report-audio-position", playlistId: a.id, path: "tracks/a.flac", positionMs: at + 1_500 },
      hub.client,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(hub.transport()?.positionMs).toBe(at);
    await send({ type: "audio-transport", command: "pause" }, "the old holder's refusal", hub.client);
    expect(hub.results().at(-1)!.error).toMatch(/authority/);
    expect(hub.transport()?.playing).toBe(true);

    // The new holder drives it, and its gesture is what makes a sound again.
    await send({ type: "audio-transport", command: "attend" }, "the new loudspeaker", hub.second);
    await send({ type: "audio-transport", command: "enable-sound" }, "the new gesture", hub.second);
    expect(hub.transport()?.audible).toBe(true);
  });

  it("carries a blocked-sound failure to every client, apart from the transport's own fault", async () => {
    const a = await playlist("Warmup", [{ file: "a.flac", durationMs: 300_000 }]);
    await service!.start();
    await join(hub.client, true);
    await join(hub.second, false);
    await send({ type: "audio-transport", command: "attend" }, "the loudspeaker");
    await openWith("Alpha", a.id);
    await waitFor(() => hub.transport()?.index === 0, "the playlist to arm");
    await send({ type: "audio-transport", command: "enable-sound" }, "the gesture");

    // A tab that is not sounding anything cannot put a fault on everyone's
    // transport.
    hub.dispatch({ type: "report-audio-failure", error: "not mine to report" }, hub.second);
    await new Promise((resolve) => setImmediate(resolve));
    expect(hub.transport()?.soundError).toBeUndefined();

    hub.dispatch({ type: "report-audio-failure", error: "The browser blocked it." });
    await waitFor(() => hub.transport()?.soundError !== undefined, "the failure to reach the transport");
    // Its own field: the transport-level `error` is about a playlist with
    // nothing playable in it, which is a different fault with a different fix.
    expect(hub.transport()?.error).toBeUndefined();
    // And the sound is honestly reported as not happening, while the clock runs.
    expect(hub.transport()?.audible).toBe(false);
    expect(hub.transport()?.playing).toBe(true);

    hub.dispatch({ type: "report-audio-failure", error: null });
    await waitFor(() => hub.transport()?.audible === true, "the failure to clear");
  });
});

describe("a loudspeaker that comes and goes", () => {
  /** A transport with a client attending, cleared to sound, and playing. */
  async function sounding(id: string): Promise<Rig> {
    const rig = transport();
    rig.transport.attend();
    rig.transport.enableSound();
    await rig.transport.arm(id);
    await waitFor(() => rig.last().index === 0, "the first track to begin");
    return rig;
  }

  it("has had no gesture when a fresh element announces itself", async () => {
    const list = await playlist("Set", [{ file: "a.flac", durationMs: 300_000 }]);
    const rig = await sounding(list.id);
    expect(rig.last().audible).toBe(true);

    // The same socket, a new element: a route change or a panel closing
    // unmounted the last one and what came back has never been clicked. The
    // browser's activation gate is per element, so an `attend` that kept the
    // previous one's `ready` would have the transport reporting a room that can
    // hear a track nothing is playing.
    //
    // This one passes against the code as it stood — `attend` already dropped a
    // `ready` back to `silent`, and its early return only skips a redundant
    // publish. It is here because a review read that guard as the bug and the
    // property was pinned nowhere, so the next reader of it has an answer.
    rig.transport.attend();
    expect(rig.last().audible).toBe(false);
    // The clock is untouched by any of it, which is the other half: a World
    // unattended takes the same transitions (origin R25).
    expect(rig.last().playing).toBe(true);
  });

  it("stops waiting for an `ended` once the element says it has gone", async () => {
    const list = await playlist("Set", [
      { file: "a.flac", durationMs: 3_000 },
      { file: "b.flac", durationMs: 3_000 },
    ]);
    const rig = await sounding(list.id);

    expect(await rig.transport.command({ command: "unattend" })).toEqual({ ok: true });
    expect(rig.last().audible).toBe(false);

    // No element, so no margin: the grace exists for a browser running behind
    // the clock, and there is no browser. Waiting it out on every track after a
    // player unmounted is the cost of the server never being told.
    await time.advance(3_000);
    await waitFor(() => rig.last().index === 1, "the clock to advance at the total");
  });

  it("answers a length it could not write rather than rejecting", async () => {
    const list = await playlist("Set", [{ file: "a.flac", durationMs: 300_000 }]);
    const rig = await sounding(list.id);

    // What a full disk looks like from here: `writeJsonAtomic` gives up after
    // its rename retries and the rejection comes back through `update`. The
    // caller is a client waiting to be told whether its measurement landed, so
    // the failure has to be an answer — an unguarded `await` in a handler is an
    // unhandled rejection and a client that is told nothing at all.
    const spy = vi.spyOn(audio, "update").mockRejectedValue(new Error("ENOSPC: no space left on device"));
    try {
      const result = await rig.transport.reportDuration(list.id, "tracks/a.flac", 200_000);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain("ENOSPC");
    } finally {
      spy.mockRestore();
    }
    // And the transport is still pacing the length it had, not a half-written one.
    expect(rig.last().durationMs).toBe(300_000);
  });

  it("carries the held track's tempo, and null for one nothing has measured", async () => {
    const list = await playlist("Set", [
      { file: "a.flac", durationMs: 300_000, bpm: 174 },
      { file: "b.flac", durationMs: 300_000 },
    ]);
    const rig = await sounding(list.id);
    // The one readout a client cannot derive from the rest of the state, and the
    // reason the panel could not show it: the readouts are deliberately absent
    // from the World broadcast (origin R27), so the transport message is the
    // only place it can arrive.
    expect(rig.last().bpm).toBe(174);

    await rig.transport.command({ command: "next" });
    await waitFor(() => rig.last().index === 1, "the second track");
    // Null, never 0: zero is the tempo every below-threshold condition an author
    // writes is satisfied by.
    expect(rig.last().bpm).toBeNull();
  });
});
