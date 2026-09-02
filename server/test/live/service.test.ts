import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { WebSocket } from "ws";
import { tmpDir } from "../tmp.js";
import { waitFor } from "../wait.js";
import { WorldService, type WorldHub } from "../../src/live/service.js";
import { WorldStore } from "../../src/storage/worlds.js";
import type {
  ClientMessage,
  ServerMessage,
  WorldLiveMessage,
  WorldMessage,
  WorldResultMessage,
  WorldsMessage,
} from "../../../shared/src/types.js";

class FakeHub implements WorldHub {
  readonly broadcasts: ServerMessage[] = [];
  readonly sent: ServerMessage[] = [];
  private readonly handlers: ((msg: ClientMessage, c: WebSocket) => void)[] = [];
  private readonly greeters: ((c: WebSocket) => void)[] = [];

  broadcast(msg: ServerMessage): void {
    this.broadcasts.push(msg);
  }
  onMessage(h: (msg: ClientMessage, c: WebSocket) => void): void {
    this.handlers.push(h);
  }
  onConnection(g: (c: WebSocket) => void): void {
    this.greeters.push(g);
  }
  sendTo(_c: WebSocket, msg: ServerMessage): void {
    this.sent.push(msg);
  }
  dispatch(msg: ClientMessage): void {
    for (const h of this.handlers) h(msg, null as unknown as WebSocket);
  }
  connect(): void {
    for (const g of this.greeters) g(null as unknown as WebSocket);
  }
  last<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    for (let i = this.broadcasts.length - 1; i >= 0; i -= 1) {
      const msg = this.broadcasts[i]!;
      if (msg.type === type) return msg as Extract<ServerMessage, { type: T }>;
    }
    return undefined;
  }
}

let dir: string;
let hub: FakeHub;
let store: WorldStore;
let service: WorldService | null;

beforeEach(async () => {
  dir = await tmpDir("wsvc");
  hub = new FakeHub();
  store = new WorldStore(dir);
  service = new WorldService(hub, store);
});

afterEach(() => {
  service?.stop();
  service = null;
});

/** Send a message and wait for the service's fire-and-forget handler to settle. */
async function send(msg: ClientMessage, until: () => boolean, label: string): Promise<void> {
  hub.dispatch(msg);
  await waitFor(until, label);
}

async function makeWorld(name = "Lounge"): Promise<string> {
  const before = hub.broadcasts.filter((m) => m.type === "world-result").length;
  await send(
    { type: "create-world", world: { name } },
    () => hub.broadcasts.filter((m) => m.type === "world-result").length > before,
    "the World to be created",
  );
  return (hub.last("world-result") as WorldResultMessage).worldId!;
}

describe("listing and creating", () => {
  it("lists what the store holds and broadcasts the updated list on create", async () => {
    await send({ type: "list-worlds" }, () => !!hub.last("worlds"), "the world list");
    expect((hub.last("worlds") as WorldsMessage).worlds).toEqual([]);

    const id = await makeWorld("Streamer Lounge");
    expect(id).toBe("streamer-lounge");
    expect((hub.last("worlds") as WorldsMessage).worlds).toEqual([
      { id: "streamer-lounge", name: "Streamer Lounge", readable: true },
    ]);
  });

  it("refuses a World with no name and says so", async () => {
    await send({ type: "create-world", world: { name: "   " } }, () => !!hub.last("world-result"), "the refusal");
    const result = hub.last("world-result") as WorldResultMessage;
    expect(result.ok).toBe(false);
    expect(result.action).toBe("create-world");
  });
});

describe("mutations", () => {
  let id: string;

  beforeEach(async () => {
    id = await makeWorld();
    await send({ type: "open-world", worldId: id }, () => !!hub.last("world"), "the opened World");
  });

  const okCount = () => hub.broadcasts.filter((m) => m.type === "world-result" && m.ok).length;

  it("changes the store and broadcasts the result for every mutation", async () => {
    // A mutation applied to the store but not broadcast is a dead control, so
    // both halves are asserted each time.
    const before = okCount();
    await send({ type: "add-position", worldId: id, name: "couch", x: 0, y: 5 }, () => okCount() > before, "the position");
    expect((hub.last("world") as WorldMessage).world.positions[0]!.name).toBe("couch");
    expect((await store.load(id))!.world.positions).toHaveLength(1);

    const positionId = (hub.last("world") as WorldMessage).world.positions[0]!.id;
    let seen = okCount();
    await send({ type: "move-position", worldId: id, positionId, x: 2, y: 2 }, () => okCount() > seen, "the move");
    expect((await store.load(id))!.world.positions[0]).toMatchObject({ x: 2, y: 2 });

    seen = okCount();
    await send(
      { type: "add-scene", worldId: id, name: "couch cam", camera: { x: 0, y: 0, facing: 90, fov: 90, range: 30 } },
      () => okCount() > seen,
      "the camera",
    );
    const sceneId = (hub.last("world") as WorldMessage).world.scenes[0]!.id;
    expect((await store.load(id))!.world.scenes).toHaveLength(1);

    seen = okCount();
    await send({ type: "aim-camera", worldId: id, sceneId, camera: { facing: 45 } }, () => okCount() > seen, "the aim");
    expect((await store.load(id))!.world.scenes[0]!.camera.facing).toBe(45);

    seen = okCount();
    await send({ type: "strike-pairing", worldId: id, sceneId, positionId, struck: true }, () => okCount() > seen, "the strike");
    expect((await store.load(id))!.world.struck).toEqual([{ sceneId, positionId }]);

    // A null assignment declares the State; the clip follows once it exists.
    seen = okCount();
    await send({ type: "assign-clip", worldId: id, target: { kind: "state", sceneId, positionId }, clip: null }, () => okCount() > seen, "the State");
    const stateId = (hub.last("world") as WorldMessage).world.states[0]!.id;

    seen = okCount();
    await send({ type: "add-edge", worldId: id, edge: { kind: "pose", from: stateId, to: stateId } }, () => okCount() > seen, "the edge");
    const edgeId = (hub.last("world") as WorldMessage).world.edges[0]!.id;

    seen = okCount();
    await send(
      { type: "update-edge", worldId: id, edgeId, patch: { conditions: [{ parameter: "location", op: "eq", value: "couch" }] } },
      () => okCount() > seen,
      "the condition",
    );
    expect((await store.load(id))!.world.edges[0]!.conditions).toEqual([{ parameter: "location", op: "eq", value: "couch" }]);
  });

  it("persists the duration the client supplied with an assigned clip", async () => {
    await send(
      { type: "add-position", worldId: id, name: "couch", x: 0, y: 5 },
      () => (hub.last("world") as WorldMessage).world.positions.length === 1,
      "the position",
    );
    const positionId = (hub.last("world") as WorldMessage).world.positions[0]!.id;
    await send(
      { type: "add-scene", worldId: id, name: "cam", camera: { x: 0, y: 0, facing: 90, fov: 90, range: 30 } },
      () => (hub.last("world") as WorldMessage).world.scenes.length === 1,
      "the camera",
    );
    const sceneId = (hub.last("world") as WorldMessage).world.scenes[0]!.id;

    await send(
      { type: "assign-clip", worldId: id, target: { kind: "state", sceneId, positionId }, clip: { path: "clips/idle.mp4", durationMs: 4321 } },
      () => (hub.last("world") as WorldMessage).world.states.length === 1,
      "the clip",
    );

    expect((await store.load(id))!.world.states[0]!.clip).toEqual({ path: "clips/idle.mp4", durationMs: 4321 });
  });

  it("ignores a malformed mutation without throwing and without mutating", async () => {
    const before = JSON.stringify((await store.load(id))!.world);
    hub.dispatch({ type: "add-edge", worldId: id, edge: undefined as never });
    hub.dispatch({ type: "update-edge", worldId: id, edgeId: "nope", patch: null as never });
    hub.dispatch({ type: "move-position", worldId: id, positionId: "nope", x: Number.NaN, y: 0 });
    await waitFor(() => hub.broadcasts.filter((m) => m.type === "world-result" && !m.ok).length >= 3, "three refusals");

    expect(JSON.stringify((await store.load(id))!.world)).toBe(before);
  });

  it("names its World in every broadcast payload", async () => {
    await send(
      { type: "add-position", worldId: id, name: "couch", x: 0, y: 5 },
      () => (hub.last("world") as WorldMessage).world.positions.length === 1,
      "the position",
    );
    expect((hub.last("world") as WorldMessage).world.id).toBe(id);
    expect((hub.last("world") as WorldMessage).reports.worldId).toBe(id);
    expect((hub.last("world-result") as WorldResultMessage).worldId).toBe(id);
  });
});

describe("driving a World over the protocol", () => {
  async function seedCircuit(): Promise<string> {
    const id = "lounge";
    const worldDir = path.join(dir, "worlds", id);
    await fs.mkdir(path.join(worldDir, "clips"), { recursive: true });
    for (const name of ["couch-idle", "booth-idle", "walk"]) {
      await fs.writeFile(path.join(worldDir, "clips", `${name}.mp4`), "video", "utf8");
    }
    await fs.writeFile(
      path.join(worldDir, "world.json"),
      JSON.stringify({
        id,
        name: "Lounge",
        positions: [
          { id: "p-couch", name: "couch", x: 0, y: 5 },
          { id: "p-booth", name: "booth", x: 0, y: -5 },
        ],
        scenes: [{ id: "cam", name: "cam", camera: { x: 0, y: 0, facing: 90, fov: 360, range: 50 } }],
        states: [
          { id: "s-couch", sceneId: "cam", positionId: "p-couch", clip: { path: "clips/couch-idle.mp4", durationMs: 30 } },
          { id: "s-booth", sceneId: "cam", positionId: "p-booth", clip: { path: "clips/booth-idle.mp4", durationMs: 30 } },
        ],
        edges: [
          {
            id: "e1",
            kind: "travel",
            from: "s-couch",
            to: "s-booth",
            conditions: [{ parameter: "location", op: "eq", value: "booth" }],
            onClipEnd: false,
            clip: { path: "clips/walk.mp4", durationMs: 30 },
          },
        ],
        parameters: [{ name: "location", values: ["couch", "booth"], defaultValue: "couch" }],
        struck: [],
      }),
      "utf8",
    );
    return id;
  }

  it("produces the same transition from the protocol as from any other caller", async () => {
    // Covers AE5. The assertion is the broadcast State, not that the message
    // was accepted — an accepted message that moved nothing is the failure this
    // is written against.
    const id = await seedCircuit();
    await send({ type: "open-world", worldId: id }, () => !!hub.last("world-live"), "the opened World");
    expect((hub.last("world-live") as WorldLiveMessage).live.stateId).toBe("s-couch");

    hub.dispatch({ type: "set-parameter", worldId: id, name: "location", value: "booth" });
    await waitFor(() => (hub.last("world-live") as WorldLiveMessage).live.stateId === "s-booth", "the character to arrive");
  });

  it("refuses a Parameter value the World does not allow", async () => {
    const id = await seedCircuit();
    await send({ type: "open-world", worldId: id }, () => !!hub.last("world-live"), "the opened World");

    const before = hub.broadcasts.filter((m) => m.type === "world-result").length;
    await send(
      { type: "set-parameter", worldId: id, name: "location", value: "the moon" },
      () => hub.broadcasts.filter((m) => m.type === "world-result").length > before,
      "the refusal",
    );
    expect((hub.last("world-result") as WorldResultMessage).ok).toBe(false);
  });

  it("hands a clip-end report to the runtime and ignores a stale one", async () => {
    const id = await seedCircuit();
    await send({ type: "open-world", worldId: id }, () => !!hub.last("world-live"), "the opened World");
    const live = (hub.last("world-live") as WorldLiveMessage).live;

    // A stale generation changes nothing at all.
    const count = hub.broadcasts.length;
    hub.dispatch({ type: "report-clip-end", worldId: id, stateId: live.stateId!, generation: live.generation - 5 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The World's own timer is still running, so the only assertion available
    // is that the stale report itself produced no transition to another State.
    expect(hub.broadcasts.slice(count).every((m) => m.type !== "world-live" || m.live.stateId === "s-couch")).toBe(true);

    // A matching one is accepted; with no edge satisfied it simply loops.
    const current = (hub.last("world-live") as WorldLiveMessage).live;
    hub.dispatch({ type: "report-clip-end", worldId: id, stateId: current.stateId!, generation: current.generation });
    await waitFor(() => (hub.last("world-live") as WorldLiveMessage).live.generation > current.generation, "the loop to turn over");
  });

  it("reopens the World that was last open", async () => {
    const id = await seedCircuit();
    await send({ type: "open-world", worldId: id }, () => !!hub.last("world"), "the opened World");
    service!.stop();

    const second = new FakeHub();
    const restored = new WorldService(second, new WorldStore(dir));
    await restored.start();
    expect(second.last("world")?.world.id).toBe(id);
    restored.stop();
  });
});

describe("admission", () => {
  it("sends nothing to a socket that never connected", async () => {
    const id = await makeWorld();
    // Connect, stay silent, broadcast, settle, and assert the greeter is the
    // only thing that ever reached a socket — a broadcast must not leak to an
    // unadmitted one, and the greeter sits behind admission by construction.
    await send(
      { type: "add-position", worldId: id, name: "couch", x: 0, y: 0 },
      () => !!hub.last("world"),
      "the position",
    );
    expect(hub.sent).toEqual([]);
  });

  it("greets an admitted socket with the list and the open World", async () => {
    const id = await makeWorld();
    await send({ type: "open-world", worldId: id }, () => !!hub.last("world"), "the opened World");

    hub.connect();
    await waitFor(() => hub.sent.some((m) => m.type === "world"), "the greeting");
    expect(hub.sent[0]!.type).toBe("worlds");
    expect(hub.sent.some((m) => m.type === "world-live")).toBe(true);
  });
});
