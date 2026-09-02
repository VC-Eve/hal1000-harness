import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { tmpDir } from "../tmp.js";
import {
  WorldStore,
  addEdge,
  addPosition,
  addScene,
  aimCamera,
  assignClip,
  declareParameter,
  movePosition,
  strikePairing,
  worldSlug,
} from "../../src/storage/worlds.js";
import { worldReports } from "../../../shared/src/world-geometry.js";
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

describe("creating a World", () => {
  it("writes a directory and a manifest", async () => {
    const store = new WorldStore(dir);
    const created = await store.create("Streamer Lounge");

    expect(created.world.id).toBe("streamer-lounge");
    expect(created.world.name).toBe("Streamer Lounge");
    const parsed = JSON.parse(await fs.readFile(manifest("streamer-lounge"), "utf8")) as World;
    expect(parsed.name).toBe("Streamer Lounge");
    await expect(fs.stat(path.join(dir, "worlds", "streamer-lounge", "clips"))).resolves.toBeTruthy();
  });

  it("gives a second World of the same name a distinct directory", async () => {
    const store = new WorldStore(dir);
    const first = await store.create("Lounge");
    const second = await store.create("Lounge");

    expect(second.world.id).not.toBe(first.world.id);
    expect(second.world.id).toBe("lounge-2");
  });

  it("does not let two names that fold onto one slug share a directory", async () => {
    const store = new WorldStore(dir);
    const first = await store.create("Lounge");
    const second = await store.create("LOUNGE");

    expect(second.world.id.toLowerCase()).not.toBe(first.world.id.toLowerCase());
  });

  it("produces a usable directory for a Windows reserved device name", async () => {
    const store = new WorldStore(dir);
    const created = await store.create("con");

    expect(worldSlug("con")).not.toBe("con");
    expect(created.world.id).toBe("con-world");
    expect(created.world.name).toBe("con");
    await expect(fs.stat(path.join(dir, "worlds", created.world.id))).resolves.toBeTruthy();
  });
});

describe("round-tripping", () => {
  it("carries positions, cameras, edges and parameters across a restart", async () => {
    const first = new WorldStore(dir);
    const { world } = await first.create("Lounge");
    const id = world.id;

    await first.mutate(id, (w) => addPosition(w, "couch", 0, 0));
    await first.mutate(id, (w) => addScene(w, "couch cam", { x: 0, y: -5, facing: 90, fov: 60, range: 20 }));
    await first.mutate(id, (w) => declareParameter(w, { name: "location", values: ["couch", "booth"], defaultValue: "couch" }));
    const seeded = (await first.load(id))!.world;
    await first.mutate(id, (w) =>
      assignClip(w, { kind: "state", sceneId: seeded.scenes[0]!.id, positionId: seeded.positions[0]!.id }, { path: "clips/idle.mp4", durationMs: 4000 }),
    );
    const withState = (await first.load(id))!.world;
    await first.mutate(id, (w) => addEdge(w, { kind: "pose", from: withState.states[0]!.id, to: withState.states[0]!.id }));

    const second = new WorldStore(dir);
    const loaded = (await second.load(id))!.world;
    expect(loaded.positions).toHaveLength(1);
    expect(loaded.positions[0]!.name).toBe("couch");
    expect(loaded.scenes[0]!.camera).toEqual({ x: 0, y: -5, facing: 90, fov: 60, range: 20 });
    expect(loaded.parameters[0]).toEqual({ name: "location", values: ["couch", "booth"], defaultValue: "couch" });
    expect(loaded.states[0]!.clip).toEqual({ path: "clips/idle.mp4", durationMs: 4000 });
    expect(loaded.edges).toHaveLength(1);
  });

  it("keeps an unknown key through a reopen, a mutation and another reopen", async () => {
    // Covers R3. A World is portable, so it will be opened by a build older
    // than the one that wrote it. A single round trip in one process proves
    // nothing — the cache read would be the cache just written — so this
    // reopens, mutates, and reopens again with a third instance.
    await seed("lounge", {
      id: "lounge",
      name: "Lounge",
      positions: [],
      scenes: [],
      states: [],
      edges: [],
      parameters: [],
      struck: [],
      soundtrack: { track: "future-era.mp3", gain: 0.4 },
    });

    const opener = new WorldStore(dir);
    await opener.mutate("lounge", (w) => addPosition(w, "couch", 1, 2));

    const third = new WorldStore(dir);
    const reloaded = (await third.load("lounge"))!.world as World & { soundtrack?: unknown };
    expect(reloaded.soundtrack).toEqual({ track: "future-era.mp3", gain: 0.4 });
    expect(reloaded.positions).toHaveLength(1);
  });

  it("survives every persisted field through the same cycle", async () => {
    const store = new WorldStore(dir);
    const { world } = await store.create("Lounge");
    const id = world.id;

    await store.mutate(id, (w) => addPosition(w, "couch", 1, 2));
    await store.mutate(id, (w) => addScene(w, "cam", { x: 0, y: 0, facing: 45, fov: 90, range: 30 }));
    const base = (await store.load(id))!.world;
    const sceneId = base.scenes[0]!.id;
    const positionId = base.positions[0]!.id;
    await store.mutate(id, (w) => assignClip(w, { kind: "state", sceneId, positionId }, { path: "clips/a.mp4", durationMs: 1000 }));
    await store.mutate(id, (w) => strikePairing(w, sceneId, positionId, true));
    await store.mutate(id, (w) => declareParameter(w, { name: "energy", values: ["low", "high"], defaultValue: "low" }));
    const withState = (await store.load(id))!.world;
    await store.mutate(id, (w) => addEdge(w, { kind: "pose", from: withState.states[0]!.id, to: withState.states[0]!.id }));

    const before = (await new WorldStore(dir).load(id))!.world;
    // One more unrelated mutation through a fresh store, then read with a third.
    await new WorldStore(dir).mutate(id, (w) => movePosition(w, positionId, 9, 9));
    const after = (await new WorldStore(dir).load(id))!.world;

    expect(after.scenes).toEqual(before.scenes);
    expect(after.states).toEqual(before.states);
    expect(after.edges).toEqual(before.edges);
    expect(after.parameters).toEqual(before.parameters);
    expect(after.struck).toEqual(before.struck);
    expect(after.name).toBe(before.name);
    expect(after.positions[0]).toMatchObject({ id: positionId, name: "couch", x: 9, y: 9 });
  });

  it("serializes two concurrent mutations so neither is lost", async () => {
    const store = new WorldStore(dir);
    const { world } = await store.create("Lounge");

    await Promise.all([
      store.mutate(world.id, (w) => addPosition(w, "couch", 0, 0)),
      store.mutate(world.id, (w) => addPosition(w, "booth", 5, 5)),
    ]);

    const names = (await new WorldStore(dir).load(world.id))!.world.positions.map((p) => p.name).sort();
    expect(names).toEqual(["booth", "couch"]);
  });
});

describe("clip confinement", () => {
  const withClip = (clipPath: string) => ({
    id: "lounge",
    name: "Lounge",
    positions: [],
    scenes: [],
    states: [{ id: "s1", sceneId: "sc1", positionId: "p1", clip: { path: clipPath, durationMs: 1000 } }],
    edges: [],
    parameters: [],
    struck: [],
  });

  it("reports a `..` path incomplete and leaves it in the file", async () => {
    await seed("lounge", withClip("../../elsewhere/secret.mp4"));
    const store = new WorldStore(dir);

    const loaded = (await store.load("lounge"))!;
    expect(loaded.incomplete).toEqual([
      { kind: "state", id: "s1", slot: "clip", path: "../../elsewhere/secret.mp4", reason: "escapes-world" },
    ]);

    const onDisk = JSON.parse(await fs.readFile(manifest("lounge"), "utf8")) as World;
    expect(onDisk.states[0]!.clip!.path).toBe("../../elsewhere/secret.mp4");
  });

  it("rejects an absolute clip path the same way", async () => {
    await seed("lounge", withClip(process.platform === "win32" ? "C:\\Windows\\system.mp4" : "/etc/passwd"));
    const loaded = (await new WorldStore(dir).load("lounge"))!;
    expect(loaded.incomplete[0]!.reason).toBe("escapes-world");
  });

  it("rejects a symlink inside clips/ that points outside the World", async () => {
    const outside = path.join(dir, "outside");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "real.mp4"), "video", "utf8");
    await seed("lounge", withClip("clips/link.mp4"));
    try {
      await fs.symlink(path.join(outside, "real.mp4"), path.join(dir, "worlds", "lounge", "clips", "link.mp4"), "file");
    } catch (err) {
      // Windows refuses symlink creation without developer mode or elevation.
      // Skipping is honest; asserting nothing would not be.
      if ((err as NodeJS.ErrnoException).code === "EPERM") return;
      throw err;
    }

    const loaded = (await new WorldStore(dir).load("lounge"))!;
    expect(loaded.incomplete[0]!.reason).toBe("escapes-world");
  });

  it("distinguishes a clip that is simply not there yet", async () => {
    await seed("lounge", withClip("clips/not-generated-yet.mp4"));
    const loaded = (await new WorldStore(dir).load("lounge"))!;
    expect(loaded.incomplete[0]!.reason).toBe("missing");
  });

  it("accepts a clip that is inside the World", async () => {
    await seed("lounge", withClip("clips/idle.mp4"));
    await fs.writeFile(path.join(dir, "worlds", "lounge", "clips", "idle.mp4"), "video", "utf8");
    const loaded = (await new WorldStore(dir).load("lounge"))!;
    expect(loaded.incomplete).toEqual([]);
  });
});

describe("a manifest that cannot be trusted", () => {
  it("loads a non-finite camera and covers no Positions with it", async () => {
    await seed("lounge", {
      id: "lounge",
      name: "Lounge",
      positions: [{ id: "p1", name: "couch", x: 1, y: 0 }],
      scenes: [{ id: "sc1", name: "cam", camera: { x: 0, y: 0, facing: Number.NaN, fov: 90, range: 10 } }],
      states: [],
      edges: [],
      parameters: [],
      struck: [],
    });
    // JSON has no NaN, so the seeded file carries null — which is the shape a
    // hand-edited or older manifest actually produces.
    const loaded = (await new WorldStore(dir).load("lounge"))!;
    const reports = worldReports(loaded.world);

    expect(reports.unusableCameras).toEqual(["sc1"]);
    expect(reports.coverage).toEqual([]);
    expect(reports.uncoveredPositions).toEqual(["p1"]);
  });

  it("leaves a malformed manifest listable and reports it unreadable", async () => {
    await seed("lounge", '{ "name": "Lounge", }');
    const store = new WorldStore(dir);

    const loaded = (await store.load("lounge"))!;
    expect(loaded.readable).toBe(false);
    expect(await store.list()).toEqual([{ id: "lounge", name: "lounge", readable: false }]);
  });

  it("refuses a mutation against it and changes not one byte", async () => {
    const text = '{ "name": "Lounge", }';
    await seed("lounge", text);
    const store = new WorldStore(dir);

    const result = await store.mutate("lounge", (w) => addPosition(w, "couch", 0, 0));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not be read/);
    expect(await fs.readFile(manifest("lounge"), "utf8")).toBe(text);
  });
});

describe("the last-open pointer", () => {
  it("survives a restart", async () => {
    const store = new WorldStore(dir);
    const { world } = await store.create("Lounge");
    await store.setLastOpen(world.id);

    expect(await new WorldStore(dir).lastOpen()).toBe(world.id);
  });

  it("degrades to nothing when it names a World that is gone", async () => {
    const store = new WorldStore(dir);
    const { world } = await store.create("Lounge");
    await store.setLastOpen(world.id);
    await fs.rm(path.join(dir, "worlds", world.id), { recursive: true, force: true });

    expect(await new WorldStore(dir).lastOpen()).toBeNull();
  });
});

describe("a half-built World", () => {
  it("loads and is playable with one Scene, one clip and no edges", async () => {
    // Covers AE4.
    const store = new WorldStore(dir);
    const { world } = await store.create("Lounge");
    await store.mutate(world.id, (w) => addPosition(w, "couch", 0, 0));
    await store.mutate(world.id, (w) => addScene(w, "cam", { x: 0, y: -5, facing: 90, fov: 90, range: 20 }));
    const base = (await store.load(world.id))!.world;
    await fs.writeFile(path.join(dir, "worlds", world.id, "clips", "idle.mp4"), "video", "utf8");
    await store.mutate(world.id, (w) =>
      assignClip(w, { kind: "state", sceneId: base.scenes[0]!.id, positionId: base.positions[0]!.id }, { path: "clips/idle.mp4", durationMs: 4000 }),
    );

    const loaded = (await new WorldStore(dir).load(world.id))!;
    expect(loaded.readable).toBe(true);
    expect(loaded.incomplete).toEqual([]);
    expect(loaded.world.states[0]!.clip!.path).toBe("clips/idle.mp4");
    expect(loaded.world.edges).toEqual([]);
  });
});

describe("refusals", () => {
  it("refuses an unknown World", async () => {
    const result = await new WorldStore(dir).mutate("nope", (w) => addPosition(w, "couch", 0, 0));
    expect(result.ok).toBe(false);
  });

  it("refuses an id that is not a plain path segment", async () => {
    const store = new WorldStore(dir);
    expect(store.dirFor("../escape")).toBeNull();
    expect(await store.load("../escape")).toBeNull();
  });

  it("refuses a camera patch that would make the cone unreadable", async () => {
    const store = new WorldStore(dir);
    const { world } = await store.create("Lounge");
    await store.mutate(world.id, (w) => addScene(w, "cam", { x: 0, y: 0, facing: 0, fov: 90, range: 10 }));
    const sceneId = (await store.load(world.id))!.world.scenes[0]!.id;

    const result = await store.mutate(world.id, (w) => aimCamera(w, sceneId, { range: Number.NaN }));
    expect(result.ok).toBe(false);
    expect((await store.load(world.id))!.world.scenes[0]!.camera.range).toBe(10);
  });
});
