// The reserved audio readouts, tested with no audio anywhere.
//
// U1 exists to be provable before a byte of FLAC is involved: the readouts are
// driven here by `setAudio` directly, which is exactly the seam the transport
// will use. Most of what matters is *absence* — the readouts must not reach the
// write path, must not reach the broadcast, and must not evaluate while the
// machine is holding. An absence assertion is the easiest kind to write green by
// accident, so each one below was seen red first.

import { describe, it, expect } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { WorldRuntime } from "../../src/live/runtime.js";
import { WorldStore, declareParameter } from "../../src/storage/worlds.js";
import { tmpDir } from "../tmp.js";
import { waitFor } from "../wait.js";
import { WORLD_VERSION } from "../../../shared/src/worlds.js";
import { clausesHold, conditionValues, worldReports } from "../../../shared/src/world-graph.js";
import {
  AUDIO_BPM,
  AUDIO_LENGTH,
  AUDIO_PLAYING,
  AUDIO_REMAINING,
  AUDIO_TRACK,
  AUDIO_TRACKS,
  idleReadouts,
  isReservedName,
  MIN_TRACK_MS,
  readoutsFrom,
} from "../../../shared/src/audio.js";
import type {
  ClipRef,
  ClipSequence,
  Condition,
  LiveState,
  Parameter,
  ParameterValue,
  Transition,
  TransportState,
  World,
  WorldState,
} from "../../../shared/src/types.js";

const clip = (name: string, durationMs = 4000): ClipRef => ({ path: `clips/${name}.mp4`, durationMs });
const solo = (name: string, durationMs = 4000): ClipSequence => ({ clips: [clip(name, durationMs)] });

const state = (id: string, clipName: string | null = id, durationMs = 4000): WorldState => ({
  id,
  name: id,
  clips: clipName ? [solo(clipName, durationMs)] : [],
  x: 0,
  y: 0,
});

const atomicState = (id: string, names: string[], durationMs = 4000): WorldState => ({
  id,
  name: id,
  clips: [{ clips: names.map((n) => clip(n, durationMs)) }],
  atomic: true,
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

interface Rig {
  runtime: WorldRuntime;
  seen: LiveState[];
  last(): LiveState;
}

function rig(w: World): Rig {
  const seen: LiveState[] = [];
  const runtime = new WorldRuntime(w, { onChange: (live) => seen.push(live) });
  runtime.start();
  return { runtime, seen, last: () => seen[seen.length - 1]! };
}

/**
 * A started runtime that has actually entered its default State.
 *
 * `start()` enters asynchronously, so a readout pushed in the same tick arrives
 * while `stateId` is still null and no transition is offered from anywhere. The
 * transport will not be in that position — a World is running before it plays
 * anything — so waiting here is the honest fixture rather than a workaround.
 */
async function running(w: World, at = w.defaultStateId): Promise<Rig> {
  const r = rig(w);
  await waitFor(() => r.runtime.live().stateId === at, `the machine to enter ${at}`);
  return r;
}

/** The readouts as they read while a track plays, overridden per test. */
const playing = (over: Record<string, number | boolean> = {}) => ({
  ...idleReadouts(),
  [AUDIO_PLAYING]: true,
  [AUDIO_LENGTH]: 300,
  [AUDIO_REMAINING]: 120,
  [AUDIO_BPM]: 174,
  [AUDIO_TRACK]: 1,
  [AUDIO_TRACKS]: 8,
  ...over,
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("reserved audio readouts", () => {
  describe("evaluation", () => {
    it("takes a transition when a readout change satisfies its condition", async () => {
      const r = await running(
        world({
          states: [state("a"), state("b")],
          transitions: [
            transition({
              id: "t",
              from: "a",
              to: "b",
              conditions: [cond(AUDIO_PLAYING, "is", true), cond(AUDIO_REMAINING, "lt", 5)],
            }),
          ],
        }),
      );

      r.runtime.setAudio(playing({ [AUDIO_REMAINING]: 4 }));

      await waitFor(() => r.runtime.live().stateId === "b", "the machine to reach b");
    });

    it("does not take an audio transition while nothing is playing", async () => {
      // Covers AE2. Every audio condition tests audio.playing, so silence — where
      // the numeric readouts are all zero, and zero satisfies every `lt` — must
      // not move the machine.
      const r = rig(
        world({
          states: [state("a"), state("b")],
          transitions: [
            transition({
              id: "t",
              from: "a",
              to: "b",
              conditions: [cond(AUDIO_PLAYING, "is", true), cond(AUDIO_REMAINING, "lt", 5)],
            }),
          ],
        }),
      );

      r.runtime.setAudio(idleReadouts());
      await settle();

      expect(r.runtime.live().stateId).toBe("a");
    });

    it("broadcasts nothing when a readout changes and no transition is satisfied", async () => {
      // The rule the once-a-tick design protects: a readout changing every second
      // must not put the machine into a permanent broadcast. There is no
      // transition here to take, so the correct number of new broadcasts is zero.
      const r = rig(world({ states: [state("a")], transitions: [] }));
      await settle();
      const before = r.seen.length;

      r.runtime.setAudio(playing({ [AUDIO_REMAINING]: 119 }));
      r.runtime.setAudio(playing({ [AUDIO_REMAINING]: 118 }));
      r.runtime.setAudio(playing({ [AUDIO_REMAINING]: 117 }));
      await settle();

      expect(r.seen.length).toBe(before);
    });

    it("never carries a readout in the broadcast state", async () => {
      const r = await running(
        world({
          states: [state("a"), state("b")],
          parameters: [{ name: "mood", type: "float", defaultValue: 1 } as Parameter],
          transitions: [
            transition({ id: "t", from: "a", to: "b", conditions: [cond(AUDIO_REMAINING, "lt", 5)] }),
          ],
        }),
      );

      r.runtime.setAudio(playing({ [AUDIO_REMAINING]: 4 }));
      await waitFor(() => r.runtime.live().stateId === "b", "the machine to reach b");

      for (const live of r.seen) {
        for (const name of Object.keys(live.parameters)) {
          expect(isReservedName(name)).toBe(false);
        }
        expect(live.parameters.mood).toBe(1);
      }
    });

    it("evaluates nothing while an atomic run holds, and evaluates on arrival", async () => {
      const r = await running(
        world({
          defaultStateId: "hold",
          states: [atomicState("hold", ["one", "two"]), state("b")],
          transitions: [
            transition({ id: "t", from: "hold", to: "b", conditions: [cond(AUDIO_REMAINING, "lt", 5)] }),
          ],
        }),
        "hold",
      );
      await waitFor(() => !r.runtime.idle, "the atomic run to be playing");

      r.runtime.setAudio(playing({ [AUDIO_REMAINING]: 4 }));
      await settle();
      expect(r.runtime.live().stateId).toBe("hold");

      // The run ends; the condition still holds, so the wait-free transition is
      // taken at the end of the run rather than never.
      r.runtime.step();
      await settle();
      r.runtime.step();
      await waitFor(() => r.runtime.live().stateId === "b", "the machine to leave the atomic run");
    });
  });

  describe("the write path", () => {
    it("refuses to set a reserved name from outside", () => {
      const r = rig(world({ states: [state("a")] }));
      expect(r.runtime.setParameter(AUDIO_BPM, 128)).toBe(false);
    });

    it("does not let an Effect write a readout", async () => {
      const r = rig(
        world({
          states: [state("a")],
          effects: [{ parameter: AUDIO_BPM, op: "add", operand: 1, intervalMs: 250 }],
        }),
      );
      r.runtime.setAudio(playing());
      await settle();

      expect(r.runtime.live().parameters[AUDIO_BPM]).toBeUndefined();
    });

    it("leaves a readout unsatisfiable when it is not being reported", async () => {
      // R34's shape: an unmeasured BPM is absent from the map rather than zero,
      // and an absent value fails every clause.
      const r = await running(
        world({
          states: [state("a"), state("b")],
          transitions: [
            transition({ id: "t", from: "a", to: "b", conditions: [cond(AUDIO_BPM, "lt", 100)] }),
          ],
        }),
      );

      const withoutBpm = playing();
      delete (withoutBpm as Record<string, unknown>)[AUDIO_BPM];
      r.runtime.setAudio(withoutBpm);
      await settle();

      expect(r.runtime.live().stateId).toBe("a");
    });
  });

  describe("reports", () => {
    it("names a numeric audio condition that does not test audio.playing", () => {
      // Covers AE1. The defect is in the graph, so the report is a property of
      // the World and does not depend on what is playing when it is asked.
      const reports = worldReports(
        world({
          states: [state("a"), state("b")],
          transitions: [
            transition({ id: "t", from: "a", to: "b", conditions: [cond(AUDIO_REMAINING, "lt", 5)] }),
          ],
        }),
      );

      expect(reports.audioWithoutPlaying).toContainEqual({
        owner: { kind: "transition", id: "t" },
        parameter: AUDIO_REMAINING,
      });
    });

    it("does not name a condition that tests audio.playing alongside", () => {
      const reports = worldReports(
        world({
          states: [state("a"), state("b")],
          transitions: [
            transition({
              id: "t",
              from: "a",
              to: "b",
              conditions: [cond(AUDIO_PLAYING, "is", true), cond(AUDIO_REMAINING, "lt", 5)],
            }),
          ],
        }),
      );

      expect(reports.audioWithoutPlaying).toEqual([]);
    });

    it("names a boolean operator used on a number", () => {
      // `is` is the boolean operator: clauseHolds reads it as
      // `actual === (value === true)`, so against a number the right-hand side
      // collapses to false and the clause asks whether a number equals false.
      // It can never hold, and the number in the clause is never looked at.
      // Reported for declared Parameters and reserved readouts alike, through
      // the same opsFor the picker offers from.
      const reports = worldReports(
        world({
          states: [state("a"), state("b")],
          parameters: [{ name: "energy", type: "int", defaultValue: 0 } as Parameter],
          transitions: [
            transition({ id: "t", from: "a", to: "b", conditions: [cond(AUDIO_REMAINING, "is", 90)] }),
            transition({ id: "u", from: "a", to: "b", conditions: [cond("energy", "isNot", 75)] }),
          ],
        }),
      );

      expect(reports.mismatchedOperators).toContainEqual({
        owner: { kind: "transition", id: "t" },
        parameter: AUDIO_REMAINING,
      });
      expect(reports.mismatchedOperators).toContainEqual({ owner: { kind: "transition", id: "u" }, parameter: "energy" });
    });

    it("does not name an operator the type actually offers", () => {
      const reports = worldReports(
        world({
          states: [state("a"), state("b")],
          parameters: [{ name: "ready", type: "bool", defaultValue: false } as Parameter],
          transitions: [
            transition({ id: "t", from: "a", to: "b", conditions: [cond(AUDIO_REMAINING, "gt", 90)] }),
            transition({ id: "u", from: "a", to: "b", conditions: [cond("ready", "is", true)] }),
            transition({ id: "v", from: "a", to: "b", conditions: [cond(AUDIO_PLAYING, "is", true)] }),
          ],
        }),
      );

      expect(reports.mismatchedOperators).toEqual([]);
    });

    it("names an equality comparison on a readout", () => {
      // Covers AE9. A crossing holds the machine for the whole length of its
      // bridge — since the ceiling stopped clamping, longer than MAX_BRIDGE_MS
      // if that is what was linked — so a condition true for one second is not
      // occasionally missed but reliably so.
      const reports = worldReports(
        world({
          states: [state("a"), state("b")],
          transitions: [
            transition({
              id: "t",
              from: "a",
              to: "b",
              conditions: [cond(AUDIO_PLAYING, "is", true), cond(AUDIO_REMAINING, "eq", 5)],
            }),
          ],
        }),
      );

      expect(reports.audioEquality).toContainEqual({ owner: { kind: "transition", id: "t" }, parameter: AUDIO_REMAINING });
    });

    it("does not name a threshold comparison as an equality", () => {
      const reports = worldReports(
        world({
          states: [state("a"), state("b")],
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

      expect(reports.audioEquality).toEqual([]);
    });

    it("does not report an Effect on a readout as dangling", () => {
      // The target exists; it is simply not writable. Reporting it as dangling
      // would send the author looking for a Parameter they never deleted.
      const reports = worldReports(
        world({
          states: [state("a")],
          effects: [{ parameter: AUDIO_BPM, op: "add", operand: 1, intervalMs: 250 }],
        }),
      );

      expect(reports.danglingEffects).toEqual([]);
    });

    it("leaves the dead-end sweep unchanged", () => {
      const reports = worldReports(world({ states: [state("a")] }));
      expect(reports.sweptTypes).toEqual(["bool", "trigger"]);
      expect(reports.deadEnds).toEqual([]);
    });
  });

  describe("declaring a reserved name over the protocol", () => {
    it("is refused rather than written and dropped later", () => {
      // The panel not offering it is not enough: the protocol is the contract,
      // and an accepted declaration that the next load silently drops is worse
      // than a refusal — the author uses the Parameter, restarts, and it is gone.
      const w = world({ states: [state("a")] });
      expect(declareParameter(w, { name: AUDIO_BPM, type: "float", defaultValue: 120 })).toBeNull();
    });

    it("still accepts an ordinary name", () => {
      const w = world({ states: [state("a")] });
      const next = declareParameter(w, { name: "mood", type: "float", defaultValue: 1 });
      expect((next?.parameters ?? []).map((p) => p.name)).toEqual(["mood"]);
    });
  });

  describe("a manifest that declares a reserved name", () => {
    it("drops the declaration, keeps it on disk, reports it, and stays writable", async () => {
      // Covers AE3. Read-only would be worse than the problem: the editor is the
      // only place the author could rename the offending Parameter.
      const dir = await tmpDir("audio-reserved");
      const store = new WorldStore(dir);
      const created = await store.create("Lounge");
      expect(created).not.toBeNull();
      const id = created!.world.id;

      const file = path.join(dir, "worlds", id, "world.json");
      await fs.writeFile(
        file,
        JSON.stringify({
          ...created!.world,
          parameters: [
            { name: AUDIO_BPM, type: "float", defaultValue: 120 },
            { name: "mood", type: "float", defaultValue: 1 },
          ],
        }),
        "utf8",
      );

      const loaded = await store.load(id);
      expect(loaded).not.toBeNull();

      const names = (loaded!.world.parameters ?? []).map((p) => p.name);
      expect(names).toEqual(["mood"]);
      expect(loaded!.readable).toBe(true);
      expect(loaded!.readOnlyReason).toBeUndefined();

      const reports = worldReports(loaded!.world);
      expect(reports.reservedDeclarations).toEqual([AUDIO_BPM]);

      const still = JSON.parse(await fs.readFile(file, "utf8")) as World;
      expect((still.parameters ?? []).map((p) => p.name)).toContain(AUDIO_BPM);
    });

    it("keeps the declaration on disk through an unrelated mutation", async () => {
      // The store rebuilds by spreading, and a dropped-on-load field must not
      // become a dropped-on-save one. See
      // docs/solutions/rebuilding-a-cache-field-by-field-turns-a-read-into-a-delete.md
      const dir = await tmpDir("audio-reserved-write");
      const store = new WorldStore(dir);
      const created = await store.create("Lounge");
      const id = created!.world.id;

      const file = path.join(dir, "worlds", id, "world.json");
      await fs.writeFile(
        file,
        JSON.stringify({
          ...created!.world,
          parameters: [{ name: AUDIO_TRACKS, type: "int", defaultValue: 3 }],
        }),
        "utf8",
      );

      await store.mutate(id, (w) => ({ ...w, name: "Lounge Two" }));

      const still = JSON.parse(await fs.readFile(file, "utf8")) as World;
      expect((still.parameters ?? []).map((p) => p.name)).toContain(AUDIO_TRACKS);
      expect(still.name).toBe("Lounge Two");
    });
  });
});

describe("one definition of a readout", () => {
  // The oracle. `readouts()` now delegates to `readoutsFrom`, so asserting the
  // two against each other would be `f(x) === f(x)` and could never fail. What
  // is frozen here is the *arithmetic* the transport used before the move —
  // the floor, the ceiling, the rounding and, above all, which keys are absent
  // — evaluated over the same TransportState the shared function reads.
  const frozen = (s: TransportState): Record<string, ParameterValue> => {
    if (s.index < 0 || s.path === null) return idleReadouts();
    const out: Record<string, ParameterValue> = {
      [AUDIO_PLAYING]: s.playing,
      [AUDIO_TRACK]: s.index + 1,
      [AUDIO_TRACKS]: s.tracks,
    };
    const stored = s.durationMs;
    const total =
      typeof stored === "number" && Number.isFinite(stored) && stored > 0
        ? Math.max(stored, MIN_TRACK_MS)
        : 0;
    if (total > 0) {
      out[AUDIO_LENGTH] = Math.round(total / 1_000);
      out[AUDIO_REMAINING] = Math.max(0, Math.ceil((total - s.positionMs) / 1_000));
    }
    if (s.bpm !== null) out[AUDIO_BPM] = s.bpm;
    return out;
  };

  const shape = (over: Partial<TransportState> = {}): TransportState => ({
    playlistId: "set",
    generation: 1,
    index: 0,
    path: "tracks/one.mp3",
    name: "one",
    header: null,
    description: null,
    playing: true,
    positionMs: 0,
    durationMs: 10_000,
    volume: 1,
    tracks: 3,
    shuffle: false,
    bpm: null,
    audible: true,
    ...over,
  });

  const matrix: Record<string, TransportState> = {
    "nothing held": shape({ index: -1, path: null, playing: false, durationMs: 0, tracks: 0 }),
    "held but not sounding": shape({ playing: false }),
    sounding: shape({ positionMs: 2_000 }),
    "unknown duration": shape({ durationMs: 0 }),
    // The two the first draft of the plan had no row for, and the reason the
    // derivation is not a plain field read: TransportState carries the *stored*
    // number, so a reader without the floor calls a 300ms track zero seconds
    // long while the machine calls it one.
    "shorter than the floor": shape({ durationMs: 300 }),
    "a duration of Infinity": shape({ durationMs: Number.POSITIVE_INFINITY }),
    "unknown tempo": shape({ bpm: null }),
    "a known tempo": shape({ bpm: 174 }),
    "the last seconds": shape({ positionMs: 9_400 }),
    "past the end": shape({ positionMs: 11_000 }),
    "the last track": shape({ index: 2, tracks: 3 }),
  };

  for (const [name, state] of Object.entries(matrix)) {
    it(`says the same as the frozen arithmetic: ${name}`, () => {
      // toEqual, not toMatchObject: a key this build reports and the frozen one
      // leaves absent is the failure that matters most, and absent is a value.
      expect(readoutsFrom(state)).toEqual(frozen(state));
    });
  }

  it("gives the whole idle set for nothing held, and for no transport at all", () => {
    expect(readoutsFrom(matrix["nothing held"])).toEqual(idleReadouts());
    expect(readoutsFrom(null)).toEqual(idleReadouts());
    expect(readoutsFrom(undefined)).toEqual(idleReadouts());
  });

  it("paces a track shorter than the floor at the floor", () => {
    expect(readoutsFrom(shape({ durationMs: 300 }))[AUDIO_LENGTH]).toBe(1);
    expect(readoutsFrom(shape({ durationMs: 300, positionMs: 0 }))[AUDIO_REMAINING]).toBe(1);
  });

  it("leaves length and remaining absent for an unmeasured track, never zero", () => {
    const out = readoutsFrom(shape({ durationMs: 0 }));
    expect(out).not.toHaveProperty(AUDIO_LENGTH);
    expect(out).not.toHaveProperty(AUDIO_REMAINING);
  });

  it("holds every clause on the values the runtime composes, in the runtime's order", () => {
    // A declared Parameter wins over a readout of the same name, on both sides.
    const values = conditionValues({ [AUDIO_PLAYING]: false }, { [AUDIO_PLAYING]: true });
    expect(clausesHold([{ parameter: AUDIO_PLAYING, op: "is", value: true }], values)).toBe(true);
  });

  it("treats no clauses and an empty list alike, and fails every clause on an absent value", () => {
    expect(clausesHold(undefined, {})).toBe(true);
    expect(clausesHold([], {})).toBe(true);
    for (const op of ["is", "isNot", "gt", "lt", "eq", "neq"] as const) {
      expect(clausesHold([{ parameter: "gone", op, value: 1 }], {})).toBe(false);
    }
  });
});
