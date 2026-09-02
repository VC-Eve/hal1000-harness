import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { tmpDir } from "../tmp.js";
import {
  WorldStore,
  addState,
  addTransition,
  declareParameter,
  parameterAccepts,
  recordClipDuration,
  removeParameter,
  resolveClipPath,
  removeState,
  removeTransition,
  reorderTransitions,
  setDefaultState,
  updateState,
  updateTransition,
  validWorldId,
  worldSlug,
} from "../../src/storage/worlds.js";
import { NODE_H, NODE_W, WORLD_VERSION } from "../../../shared/src/worlds.js";
import type { World } from "../../../shared/src/types.js";

let dir: string;

beforeEach(async () => {
  dir = await tmpDir("worlds");
});

const manifest = (id: string) => path.join(dir, "worlds", id, "world.json");

async function seed(id: string, value: unknown): Promise<void> {
  await fs.mkdir(path.join(dir, "worlds", id, "clips"), { recursive: true });
  await fs.writeFile(manifest(id), typeof value === "string" ? value : JSON.stringify(value, null, 2), "utf8");
}

const blank = (over: Record<string, unknown> = {}) => ({
  version: WORLD_VERSION,
  id: "lounge",
  name: "Lounge",
  defaultStateId: null,
  states: [],
  transitions: [],
  parameters: [],
  ...over,
});

/** Create a World with one State, and hand back both ids. */
async function withState(store: WorldStore, name = "Lounge") {
  const { world } = await store.create(name);
  await store.mutate(world.id, (w) => addState(w, { name: "couch", x: 10, y: 20 }));
  const loaded = (await store.load(world.id))!.world;
  return { worldId: world.id, stateId: loaded.states[0]!.id };
}

describe("creating a World", () => {
  it("writes a directory, a manifest and the current version", async () => {
    const store = new WorldStore(dir);
    const created = await store.create("Streamer Lounge");

    expect(created.world.id).toBe("streamer-lounge");
    const parsed = JSON.parse(await fs.readFile(manifest("streamer-lounge"), "utf8")) as World;
    expect(parsed.name).toBe("Streamer Lounge");
    expect(parsed.version).toBe(WORLD_VERSION);
    await expect(fs.stat(path.join(dir, "worlds", "streamer-lounge", "clips"))).resolves.toBeTruthy();
  });

  it("gives a second World of the same name a distinct directory", async () => {
    const store = new WorldStore(dir);
    const first = await store.create("Lounge");
    expect((await store.create("Lounge")).world.id).not.toBe(first.world.id);
  });

  it("never derives a slug the store then refuses to open", async () => {
    for (const name of ["Hal.. Room", "a..b", "....", "room...", "Lounge", "con", "..", "-x-"]) {
      expect(validWorldId(worldSlug(name)), `slug for ${JSON.stringify(name)}`).toBe(true);
    }
  });

  it("lists a World folder copied in with capitals, and does not collide with it", async () => {
    await seed("Lounge", blank({ id: "Lounge" }));
    const store = new WorldStore(dir);

    expect((await store.list()).map((s) => s.id)).toContain("Lounge");
    expect((await store.create("lounge")).world.id.toLowerCase()).not.toBe("lounge");
  });
});

describe("the version gate", () => {
  it("opens a manifest from the camera layout read-only and says why", async () => {
    // The shipped layout: `states` held Scene/Position pairings and there was
    // no version at all. Read as this shape it produces a machine with no
    // States, so the store refuses rather than showing an empty graph.
    await seed("lounge", {
      id: "lounge",
      name: "Lounge",
      positions: [{ id: "p", name: "couch", x: 0, y: 0 }],
      scenes: [{ id: "c", name: "cam", camera: { x: 0, y: 0, facing: 0, fov: 90, range: 10 } }],
      states: [{ id: "s", sceneId: "c", positionId: "p", clip: null }],
      edges: [],
      parameters: [],
      struck: [],
    });
    const store = new WorldStore(dir);

    const loaded = (await store.load("lounge"))!;
    expect(loaded.readable).toBe(false);
    expect(loaded.readOnlyReason).toMatch(/earlier layout/);
    expect((await store.list())[0]).toEqual({ id: "lounge", name: "Lounge", readable: false });
  });

  it("opens a manifest from a newer build read-only and says why", async () => {
    await seed("lounge", blank({ version: WORLD_VERSION + 1 }));
    const loaded = (await new WorldStore(dir).load("lounge"))!;

    expect(loaded.readable).toBe(false);
    expect(loaded.readOnlyReason).toMatch(/newer build/);
  });

  it("refuses every mutation against a World it will not write, byte for byte", async () => {
    await seed("lounge", blank({ version: 1 }));
    const before = await fs.readFile(manifest("lounge"), "utf8");
    const store = new WorldStore(dir);

    const result = await store.mutate("lounge", (w) => addState(w, { name: "couch", x: 0, y: 0 }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/earlier layout/);
    expect(await fs.readFile(manifest("lounge"), "utf8")).toBe(before);
  });

  it("opens a manifest at the current version normally", async () => {
    await seed("lounge", blank());
    const loaded = (await new WorldStore(dir).load("lounge"))!;
    expect(loaded.readable).toBe(true);
    expect(loaded.readOnlyReason).toBeUndefined();
  });
});

describe("round-tripping", () => {
  it("keeps an unknown key through a reopen, a mutation and another reopen", async () => {
    // A World is portable, so it will be opened by a build older than the one
    // that wrote it. A single round trip in one process proves nothing — the
    // cache read would be the cache just written.
    await seed("lounge", blank({ soundtrack: { track: "future-era.mp3", gain: 0.4 } }));

    await new WorldStore(dir).mutate("lounge", (w) => addState(w, { name: "couch", x: 1, y: 2 }));

    const reloaded = (await new WorldStore(dir).load("lounge"))!.world as World & { soundtrack?: unknown };
    expect(reloaded.soundtrack).toEqual({ track: "future-era.mp3", gain: 0.4 });
    expect(reloaded.states).toHaveLength(1);
  });

  it("carries a State's name, clip and node position across a restart", async () => {
    const store = new WorldStore(dir);
    const { worldId, stateId } = await withState(store);
    await store.mutate(worldId, (w) =>
      updateState(w, stateId, { name: "couch idle", clip: { path: "clips/idle.mp4", durationMs: 4000 } }),
    );

    const loaded = (await new WorldStore(dir).load(worldId))!.world;
    expect(loaded.states[0]).toMatchObject({
      name: "couch idle",
      x: 10,
      y: 20,
      clip: { path: "clips/idle.mp4", durationMs: 4000 },
    });
  });

  it("carries a transition's conditions, exit time, mute, solo and order across a restart", async () => {
    const store = new WorldStore(dir);
    const { worldId, stateId } = await withState(store);
    await store.mutate(worldId, (w) =>
      declareParameter(w, { name: "ready", type: "bool", defaultValue: false }),
    );
    await store.mutate(worldId, (w) => addTransition(w, { from: stateId, to: stateId, exitTime: 0.75 }));
    const id = (await store.load(worldId))!.world.transitions[0]!.id;
    await store.mutate(worldId, (w) =>
      updateTransition(w, id, {
        conditions: [{ parameter: "ready", op: "is", value: true }],
        muted: true,
        solo: true,
      }),
    );

    const loaded = (await new WorldStore(dir).load(worldId))!.world;
    expect(loaded.transitions[0]).toMatchObject({
      exitTime: 0.75,
      muted: true,
      solo: true,
      order: 0,
      conditions: [{ parameter: "ready", op: "is", value: true }],
    });
  });

  it("carries a typed Parameter across a restart", async () => {
    const store = new WorldStore(dir);
    const { world } = await store.create("Lounge");
    await store.mutate(world.id, (w) => declareParameter(w, { name: "energy", type: "float", defaultValue: 0.4 }));

    expect((await new WorldStore(dir).load(world.id))!.world.parameters[0]).toEqual({
      name: "energy",
      type: "float",
      defaultValue: 0.4,
    });
  });

  it("serializes two concurrent mutations so neither is lost", async () => {
    const store = new WorldStore(dir);
    const { world } = await store.create("Lounge");
    await Promise.all([
      store.mutate(world.id, (w) => addState(w, { name: "couch", x: 0, y: 0 })),
      store.mutate(world.id, (w) => addState(w, { name: "booth", x: 5, y: 5 })),
    ]);

    const names = (await new WorldStore(dir).load(world.id))!.world.states.map((s) => s.name).sort();
    expect(names).toEqual(["booth", "couch"]);
  });
});

describe("States", () => {
  it("makes the first State the default", async () => {
    const store = new WorldStore(dir);
    const { worldId, stateId } = await withState(store);
    expect((await store.load(worldId))!.world.defaultStateId).toBe(stateId);
  });

  it("never places a State exactly on top of another", async () => {
    // Two nodes at the same coordinates are drawn on top of each other, so only
    // the upper one can be clicked — and the lower one cannot be dragged out
    // from under it, which makes the World unfixable through the graph.
    const store = new WorldStore(dir);
    const { world } = await store.create("Lounge");
    for (const name of ["a", "b", "c"]) {
      await store.mutate(world.id, (w) => addState(w, { name, x: 100, y: 100 }));
    }

    // Distinct corners are not enough — the boxes themselves must not overlap,
    // or the lower one is still unreachable under the upper one.
    const placed = (await store.load(world.id))!.world.states;
    for (const a of placed) {
      const covered = placed.filter(
        (b) => b !== a && Math.abs(b.x - a.x) < NODE_W && Math.abs(b.y - a.y) < NODE_H,
      );
      expect(covered, `${a.name} at ${a.x},${a.y}`).toEqual([]);
    }
  });

  it("honours a position that is already clear", async () => {
    const store = new WorldStore(dir);
    const { world } = await store.create("Lounge");
    await store.mutate(world.id, (w) => addState(w, { name: "a", x: 100, y: 100 }));
    await store.mutate(world.id, (w) => addState(w, { name: "b", x: 400, y: 300 }));

    expect((await store.load(world.id))!.world.states[1]).toMatchObject({ x: 400, y: 300 });
  });

  it("does not move the default when a second State is added", async () => {
    const store = new WorldStore(dir);
    const { worldId, stateId } = await withState(store);
    await store.mutate(worldId, (w) => addState(w, { name: "booth", x: 0, y: 0 }));
    expect((await store.load(worldId))!.world.defaultStateId).toBe(stateId);
  });

  it("removes the transitions that referenced a deleted State", async () => {
    const store = new WorldStore(dir);
    const { worldId, stateId } = await withState(store);
    await store.mutate(worldId, (w) => addState(w, { name: "booth", x: 0, y: 0 }));
    const other = (await store.load(worldId))!.world.states.find((s) => s.id !== stateId)!.id;
    await store.mutate(worldId, (w) => addTransition(w, { from: stateId, to: other }));
    await store.mutate(worldId, (w) => addTransition(w, { from: other, to: other }));

    await store.mutate(worldId, (w) => removeState(w, stateId));

    const loaded = (await store.load(worldId))!.world;
    // The self-transition on the surviving State is untouched; the one that
    // pointed at the deleted State is gone rather than left dangling.
    expect(loaded.transitions.map((t) => t.from)).toEqual([other]);
    expect(loaded.defaultStateId).toBe(other);
  });

  it("refuses a node position that is not a number", async () => {
    const store = new WorldStore(dir);
    const { worldId, stateId } = await withState(store);
    expect((await store.mutate(worldId, (w) => updateState(w, stateId, { x: Number.NaN }))).ok).toBe(false);
    expect((await store.load(worldId))!.world.states[0]!.x).toBe(10);
  });

  it("refuses a default that names no State", async () => {
    const store = new WorldStore(dir);
    const { worldId } = await withState(store);
    expect((await store.mutate(worldId, (w) => setDefaultState(w, "nope"))).ok).toBe(false);
  });
});

describe("transitions", () => {
  it("numbers each new transition after its siblings, per source", async () => {
    const store = new WorldStore(dir);
    const { worldId, stateId } = await withState(store);
    await store.mutate(worldId, (w) => addTransition(w, { from: stateId, to: stateId }));
    await store.mutate(worldId, (w) => addTransition(w, { from: stateId, to: stateId }));
    await store.mutate(worldId, (w) => addTransition(w, { fromAny: true, to: stateId }));

    const t = (await store.load(worldId))!.world.transitions;
    expect(t.filter((x) => !x.fromAny).map((x) => x.order)).toEqual([0, 1]);
    // The Any State group numbers from zero on its own.
    expect(t.find((x) => x.fromAny)!.order).toBe(0);
  });

  it("clamps an exit time that is not a fraction", async () => {
    const store = new WorldStore(dir);
    const { worldId, stateId } = await withState(store);
    await store.mutate(worldId, (w) => addTransition(w, { from: stateId, to: stateId, exitTime: 4 }));
    expect((await store.load(worldId))!.world.transitions[0]!.exitTime).toBe(1);
  });

  it("takes hasExitTime only from a literal true or false", async () => {
    const store = new WorldStore(dir);
    const { worldId, stateId } = await withState(store);
    await store.mutate(worldId, (w) => addTransition(w, { from: stateId, to: stateId }));
    const id = (await store.load(worldId))!.world.transitions[0]!.id;

    // "maybe" is truthy; taking it for its truthiness would silently change
    // what the transition waits for.
    await store.mutate(worldId, (w) => updateTransition(w, id, { hasExitTime: "maybe" as never }));
    expect((await store.load(worldId))!.world.transitions[0]!.hasExitTime).toBe(false);
  });

  it("reorders a source's transitions and refuses a partial order", async () => {
    const store = new WorldStore(dir);
    const { worldId, stateId } = await withState(store);
    await store.mutate(worldId, (w) => addTransition(w, { from: stateId, to: stateId }));
    await store.mutate(worldId, (w) => addTransition(w, { from: stateId, to: stateId }));
    const ids = (await store.load(worldId))!.world.transitions.map((t) => t.id);

    expect((await store.mutate(worldId, (w) => reorderTransitions(w, stateId, false, [ids[1]!, ids[0]!]))).ok).toBe(true);
    const after = (await store.load(worldId))!.world.transitions;
    expect(after.find((t) => t.id === ids[1]!)!.order).toBe(0);

    // A partial list would leave the unnamed ones at an order nobody chose.
    expect((await store.mutate(worldId, (w) => reorderTransitions(w, stateId, false, [ids[0]!]))).ok).toBe(false);
    // As would one naming a transition from somewhere else.
    expect((await store.mutate(worldId, (w) => reorderTransitions(w, stateId, false, ["x", "y"]))).ok).toBe(false);
  });

  it("refuses a transition whose destination does not exist", async () => {
    const store = new WorldStore(dir);
    const { worldId, stateId } = await withState(store);
    expect((await store.mutate(worldId, (w) => addTransition(w, { from: stateId, to: "nope" }))).ok).toBe(false);
  });

  it("removes a transition", async () => {
    const store = new WorldStore(dir);
    const { worldId, stateId } = await withState(store);
    await store.mutate(worldId, (w) => addTransition(w, { from: stateId, to: stateId }));
    const id = (await store.load(worldId))!.world.transitions[0]!.id;

    expect((await store.mutate(worldId, (w) => removeTransition(w, id))).ok).toBe(true);
    expect((await store.load(worldId))!.world.transitions).toEqual([]);
  });
});

describe("Parameters", () => {
  it("corrects a default the declared type cannot hold", async () => {
    const store = new WorldStore(dir);
    const { world } = await store.create("Lounge");
    await store.mutate(world.id, (w) => declareParameter(w, { name: "n", type: "int", defaultValue: 2.7 }));
    expect((await store.load(world.id))!.world.parameters[0]!.defaultValue).toBe(2);
  });

  it("refuses a type it does not know", async () => {
    const store = new WorldStore(dir);
    const { world } = await store.create("Lounge");
    const result = await store.mutate(world.id, (w) =>
      declareParameter(w, { name: "n", type: "colour" as never, defaultValue: 0 }),
    );
    expect(result.ok).toBe(false);
  });

  it("corrects a condition whose operator the Parameter's type does not allow", async () => {
    const store = new WorldStore(dir);
    const { worldId, stateId } = await withState(store);
    await store.mutate(worldId, (w) => declareParameter(w, { name: "ready", type: "bool", defaultValue: false }));
    await store.mutate(worldId, (w) => addTransition(w, { from: stateId, to: stateId }));
    const id = (await store.load(worldId))!.world.transitions[0]!.id;

    await store.mutate(worldId, (w) =>
      updateTransition(w, id, { conditions: [{ parameter: "ready", op: "gt", value: 3 }] }),
    );

    // `gt` is not a Bool operator, and 3 is not a Bool value.
    expect((await store.load(worldId))!.world.transitions[0]!.conditions[0]).toEqual({
      parameter: "ready",
      op: "is",
      value: false,
    });
  });

  it("keeps a clause naming a Parameter that does not exist yet", async () => {
    // The author may be about to declare it; silently deleting their work is
    // the failure this store guards against.
    const store = new WorldStore(dir);
    const { worldId, stateId } = await withState(store);
    await store.mutate(worldId, (w) => addTransition(w, { from: stateId, to: stateId }));
    const id = (await store.load(worldId))!.world.transitions[0]!.id;

    await store.mutate(worldId, (w) =>
      updateTransition(w, id, { conditions: [{ parameter: "later", op: "is", value: true }] }),
    );
    expect((await store.load(worldId))!.world.transitions[0]!.conditions).toHaveLength(1);
  });

  it("removes the clauses that read a deleted Parameter", async () => {
    // A clause naming a Parameter that no longer exists can never hold, which
    // would silently disable its transition.
    const store = new WorldStore(dir);
    const { worldId, stateId } = await withState(store);
    await store.mutate(worldId, (w) => declareParameter(w, { name: "ready", type: "bool", defaultValue: false }));
    await store.mutate(worldId, (w) => addTransition(w, { from: stateId, to: stateId }));
    const id = (await store.load(worldId))!.world.transitions[0]!.id;
    await store.mutate(worldId, (w) =>
      updateTransition(w, id, { conditions: [{ parameter: "ready", op: "is", value: true }] }),
    );

    await store.mutate(worldId, (w) => removeParameter(w, "ready"));

    const loaded = (await store.load(worldId))!.world;
    expect(loaded.parameters).toEqual([]);
    expect(loaded.transitions[0]!.conditions).toEqual([]);
  });

  it("answers whether a value may be assigned", async () => {
    const store = new WorldStore(dir);
    const { world } = await store.create("Lounge");
    await store.mutate(world.id, (w) => declareParameter(w, { name: "ready", type: "bool", defaultValue: false }));
    const loaded = (await store.load(world.id))!.world;

    expect(parameterAccepts(loaded, "ready", true)).toBe(true);
    expect(parameterAccepts(loaded, "ready", 1)).toBe(false);
    expect(parameterAccepts(loaded, "missing", true)).toBe(false);
  });
});

describe("clips", () => {
  it("clamps an absurd duration where it enters", async () => {
    // setTimeout truncates its delay to 32 bits, so an unbounded duration is
    // not a long wait — it is a 1ms one, with a broadcast storm behind it.
    const store = new WorldStore(dir);
    const { worldId, stateId } = await withState(store);
    await store.mutate(worldId, (w) =>
      updateState(w, stateId, { clip: { path: "clips/idle.mp4", durationMs: 2 ** 40 } }),
    );

    const stored = (await store.load(worldId))!.world.states[0]!.clip!;
    expect(stored.durationMs).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(stored.durationMs).toBeGreaterThan(0);
  });

  it("corrects every State naming a measured clip, and accepts an unchanged one", async () => {
    const store = new WorldStore(dir);
    const { worldId, stateId } = await withState(store);
    await store.mutate(worldId, (w) => updateState(w, stateId, { clip: { path: "clips/idle.mp4", durationMs: 0 } }));

    expect((await store.mutate(worldId, (w) => recordClipDuration(w, "clips/idle.mp4", 4321))).ok).toBe(true);
    expect((await store.load(worldId))!.world.states[0]!.clip!.durationMs).toBe(4321);
    // A second tab measuring the same clip reports the same number. That is not
    // a failed change, and rendering it as one put an error in front of both.
    expect((await store.mutate(worldId, (w) => recordClipDuration(w, "clips/idle.mp4", 4321))).ok).toBe(true);
  });

  it("reports a clip path that escapes the World and leaves it in the file", async () => {
    await seed("lounge", blank({
      states: [{ id: "s", name: "couch", clip: { path: "../../elsewhere.mp4", durationMs: 1 }, x: 0, y: 0 }],
    }));

    const loaded = (await new WorldStore(dir).load("lounge"))!;
    expect(loaded.incomplete).toEqual([
      { stateId: "s", path: "../../elsewhere.mp4", reason: "escapes-world" },
    ]);
    const onDisk = JSON.parse(await fs.readFile(manifest("lounge"), "utf8")) as World;
    expect(onDisk.states[0]!.clip!.path).toBe("../../elsewhere.mp4");
  });

  it("distinguishes a clip that is simply not there yet", async () => {
    await seed("lounge", blank({
      states: [{ id: "s", name: "couch", clip: { path: "clips/soon.mp4", durationMs: 1 }, x: 0, y: 0 }],
    }));
    expect((await new WorldStore(dir).load("lounge"))!.incomplete[0]!.reason).toBe("missing");
  });
});

describe("a manifest that has been hand-edited badly", () => {
  it("loads a manifest whose arrays hold nulls instead of throwing", async () => {
    await seed("lounge", blank({ states: [null, { id: "s", name: "a", clip: null, x: 0, y: 0 }], transitions: [null] }));
    const store = new WorldStore(dir);

    const loaded = (await store.load("lounge"))!;
    expect(loaded.readable).toBe(true);
    expect(loaded.world.states).toHaveLength(1);
    expect(await store.list()).toEqual([{ id: "lounge", name: "Lounge", readable: true }]);
  });

  it("keeps an entry that is merely missing fields", async () => {
    await seed("lounge", blank({ states: [{ note: "half-authored" }] }));
    await new WorldStore(dir).mutate("lounge", (w) => addState(w, { name: "couch", x: 0, y: 0 }));

    const after = (await new WorldStore(dir).load("lounge"))!.world;
    expect(after.states).toContainEqual({ note: "half-authored" });
  });

  it("leaves a malformed manifest listable and refuses to write to it", async () => {
    const text = '{ "name": "Lounge", }';
    await seed("lounge", text);
    const store = new WorldStore(dir);

    expect((await store.load("lounge"))!.readable).toBe(false);
    expect((await store.mutate("lounge", (w) => addState(w, { name: "a", x: 0, y: 0 }))).ok).toBe(false);
    expect(await fs.readFile(manifest("lounge"), "utf8")).toBe(text);
  });

  it("refuses a mutation against a World whose directory has been deleted", async () => {
    const store = new WorldStore(dir);
    const { world } = await store.create("Lounge");
    await fs.rm(path.join(dir, "worlds", world.id), { recursive: true, force: true });

    expect((await store.mutate(world.id, (w) => addState(w, { name: "a", x: 0, y: 0 }))).ok).toBe(false);
    await expect(fs.stat(path.join(dir, "worlds", world.id))).rejects.toThrow();
  });
});

describe("the last-open pointer", () => {
  it("survives a restart and degrades when the World is gone", async () => {
    const store = new WorldStore(dir);
    const { world } = await store.create("Lounge");
    await store.setLastOpen(world.id);
    expect(await new WorldStore(dir).lastOpen()).toBe(world.id);

    await fs.rm(path.join(dir, "worlds", world.id), { recursive: true, force: true });
    expect(await new WorldStore(dir).lastOpen()).toBeNull();
  });
});

describe("the symlink half of clip confinement", () => {
  // The guard its own comment leads with. Without these, deleting either
  // `realpath` call in resolveClipPath left the whole suite green.
  const linkable = async (target: string, link: string): Promise<boolean> =>
    fs
      .symlink(target, link)
      .then(() => true)
      .catch(() => false);

  it("refuses a clip that is a symlink pointing out of the World", async () => {
    const store = new WorldStore(dir);
    const { world } = await store.create("Lounge");
    const worldDir = path.join(dir, "worlds", world.id);
    const outside = path.join(dir, "elsewhere.mp4");
    await fs.writeFile(outside, "video", "utf8");

    if (!(await linkable(outside, path.join(worldDir, "clips", "escape.mp4")))) return;

    const resolved = await resolveClipPath(worldDir, "clips/escape.mp4");
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.reason).toBe("escapes-world");
  });

  it("still resolves a clip reached through a symlinked World directory", async () => {
    // The root is realpath'd too, so a World opened through a link compares
    // like with like rather than refusing every clip it holds.
    const store = new WorldStore(dir);
    const { world } = await store.create("Lounge");
    const worldDir = path.join(dir, "worlds", world.id);
    await fs.writeFile(path.join(worldDir, "clips", "idle.mp4"), "video", "utf8");

    const linked = path.join(dir, "linked-world");
    if (!(await linkable(worldDir, linked))) return;

    const resolved = await resolveClipPath(linked, "clips/idle.mp4");
    expect(resolved.ok).toBe(true);
  });
});
