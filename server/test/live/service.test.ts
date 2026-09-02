import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { WebSocket } from "ws";
import { tmpDir } from "../tmp.js";
import { waitFor } from "../wait.js";
import { WorldService, type WorldHub } from "../../src/live/service.js";
import { WorldStore } from "../../src/storage/worlds.js";
import type {
  ClientMessage,
  ClipLibraryMessage,
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
  /** A stand-in socket, so a handler that answers one client can be observed. */
  readonly client = { id: "test-client" } as unknown as WebSocket;

  dispatch(msg: ClientMessage): void {
    for (const h of this.handlers) h(msg, this.client);
  }
  connect(): void {
    for (const g of this.greeters) g(this.client);
  }
  /** The newest message answered to one socket rather than broadcast. */
  lastSent<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const msg = this.sent[i]!;
      if (msg.type === type) return msg as Extract<ServerMessage, { type: T }>;
    }
    return undefined;
  }
  last<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    for (let i = this.broadcasts.length - 1; i >= 0; i -= 1) {
      const msg = this.broadcasts[i]!;
      if (msg.type === type) return msg as Extract<ServerMessage, { type: T }>;
    }
    return undefined;
  }
  results(): WorldResultMessage[] {
    return this.broadcasts.filter((m): m is WorldResultMessage => m.type === "world-result");
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

/** Send a message and wait for the fire-and-forget handler to settle. */
async function send(msg: ClientMessage, label: string): Promise<void> {
  const before = hub.results().length;
  hub.dispatch(msg);
  await waitFor(() => hub.results().length > before, label);
}

const world = () => (hub.last("world") as WorldMessage).world;

async function openWorld(name = "Lounge"): Promise<string> {
  await send({ type: "create-world", world: { name } }, "the World to be created");
  const id = hub.results().at(-1)!.worldId!;
  await send({ type: "open-world", worldId: id }, "the World to open");
  return id;
}

async function withState(worldId: string, name = "couch"): Promise<string> {
  await send({ type: "add-state", worldId, state: { name, x: 0, y: 0 } }, `the ${name} State`);
  return world().states.find((s) => s.name === name)!.id;
}

describe("listing and creating", () => {
  it("lists what the store holds and broadcasts the updated list on create", async () => {
    hub.dispatch({ type: "list-worlds" });
    await waitFor(() => !!hub.last("worlds"), "the world list");
    expect((hub.last("worlds") as WorldsMessage).worlds).toEqual([]);

    await send({ type: "create-world", world: { name: "Streamer Lounge" } }, "the create");
    expect((hub.last("worlds") as WorldsMessage).worlds).toEqual([
      { id: "streamer-lounge", name: "Streamer Lounge", readable: true },
    ]);
  });

  it("refuses a World with no name and says so", async () => {
    await send({ type: "create-world", world: { name: "   " } }, "the refusal");
    expect(hub.results().at(-1)).toMatchObject({ action: "create-world", ok: false });
  });

  it("carries the read-only reason for a World from an older layout", async () => {
    await fs.mkdir(path.join(dir, "worlds", "old"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "worlds", "old", "world.json"),
      JSON.stringify({ id: "old", name: "Old", states: [], edges: [] }),
      "utf8",
    );

    await send({ type: "open-world", worldId: "old" }, "the open");
    expect((hub.last("world") as WorldMessage).readable).toBe(false);
    expect((hub.last("world") as WorldMessage).readOnlyReason).toMatch(/earlier layout/);
  });
});

describe("authoring over the protocol", () => {
  let id: string;

  beforeEach(async () => {
    id = await openWorld();
  });

  it("changes the store and broadcasts the result for every mutation", async () => {
    // A mutation applied to the store but not broadcast is a dead control, so
    // both halves are asserted each time.
    const stateId = await withState(id);
    expect((await store.load(id))!.world.states).toHaveLength(1);
    expect(world().defaultStateId).toBe(stateId);

    await send({ type: "update-state", worldId: id, stateId, patch: { name: "couch idle", x: 42 } }, "the update");
    expect((await store.load(id))!.world.states[0]).toMatchObject({ name: "couch idle", x: 42 });

    const second = await withState(id, "booth");
    await send({ type: "set-default-state", worldId: id, stateId: second }, "the default");
    expect((await store.load(id))!.world.defaultStateId).toBe(second);

    await send({ type: "add-transition", worldId: id, transition: { from: stateId, to: second } }, "the transition");
    const transitionId = world().transitions[0]!.id;
    expect((await store.load(id))!.world.transitions).toHaveLength(1);

    await send(
      { type: "declare-parameter", worldId: id, parameter: { name: "ready", type: "bool", defaultValue: false } },
      "the parameter",
    );
    await send(
      {
        type: "update-transition",
        worldId: id,
        transitionId,
        patch: { conditions: [{ parameter: "ready", op: "is", value: true }], muted: true },
      },
      "the transition patch",
    );
    expect((await store.load(id))!.world.transitions[0]).toMatchObject({
      muted: true,
      conditions: [{ parameter: "ready", op: "is", value: true }],
    });

    await send({ type: "add-transition", worldId: id, transition: { from: stateId, to: second } }, "a second");
    const ids = world().transitions.map((t) => t.id);
    await send({ type: "reorder-transitions", worldId: id, from: stateId, order: [ids[1]!, ids[0]!] }, "the reorder");
    expect((await store.load(id))!.world.transitions.find((t) => t.id === ids[1]!)!.order).toBe(0);

    await send({ type: "remove-transition", worldId: id, transitionId }, "the removal");
    expect((await store.load(id))!.world.transitions).toHaveLength(1);

    await send({ type: "remove-parameter", worldId: id, name: "ready" }, "the parameter removal");
    expect((await store.load(id))!.world.parameters).toEqual([]);

    await send({ type: "remove-state", worldId: id, stateId }, "the state removal");
    expect((await store.load(id))!.world.states.map((s) => s.id)).toEqual([second]);
  });

  it("ignores a malformed mutation without throwing and without mutating", async () => {
    const stateId = await withState(id);
    const before = JSON.stringify((await store.load(id))!.world);

    await send({ type: "add-transition", worldId: id, transition: undefined as never }, "a refusal");
    await send({ type: "update-state", worldId: id, stateId, patch: null as never }, "a refusal");
    await send({ type: "reorder-transitions", worldId: id, from: stateId, order: ["nope"] }, "a refusal");

    expect(hub.results().slice(-3).every((r) => !r.ok)).toBe(true);
    expect(JSON.stringify((await store.load(id))!.world)).toBe(before);
  });

  it("names its World in every broadcast payload", async () => {
    await withState(id);
    expect(world().id).toBe(id);
    expect((hub.last("world") as WorldMessage).reports.worldId).toBe(id);
    expect(hub.results().at(-1)!.worldId).toBe(id);
  });

  it("tells the client when the store throws rather than only logging it", async () => {
    // A rejected mutation used to reach the handler's logging catch and stop
    // there, which is indistinguishable from a hang for whoever sent it.
    const brokenHub = new FakeHub();
    const broken = new WorldService(brokenHub, {
      ...store,
      mutate: () => Promise.reject(new Error("disk on fire")),
    } as unknown as WorldStore);

    brokenHub.dispatch({ type: "add-state", worldId: id, state: { name: "x", x: 0, y: 0 } });
    await waitFor(() => brokenHub.results().length > 0, "a reported failure");

    expect(brokenHub.results().at(-1)).toMatchObject({ ok: false, error: expect.stringMatching(/disk on fire/) });
    broken.stop();
  });

  it("opens one World once when two open messages race", async () => {
    hub.dispatch({ type: "open-world", worldId: id });
    hub.dispatch({ type: "open-world", worldId: id });
    await waitFor(() => hub.results().filter((r) => r.action === "open-world").length >= 3, "both opens to settle");

    service!.stop();
    const after = hub.broadcasts.length;
    // A stopped service is silent. An orphaned runtime would keep going.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(hub.broadcasts.length).toBe(after);
  });
});

describe("driving a machine over the protocol", () => {
  it("produces a transition from the protocol, and refuses a value the type cannot hold", async () => {
    const id = await openWorld();
    const a = await withState(id, "a");
    const b = await withState(id, "b");
    await send(
      { type: "declare-parameter", worldId: id, parameter: { name: "go", type: "bool", defaultValue: false } },
      "the parameter",
    );
    await send(
      { type: "add-transition", worldId: id, transition: { from: a, to: b, hasExitTime: false } },
      "the transition",
    );
    const transitionId = world().transitions[0]!.id;
    await send(
      {
        type: "update-transition",
        worldId: id,
        transitionId,
        patch: { conditions: [{ parameter: "go", op: "is", value: true }] },
      },
      "the condition",
    );

    // The assertion is the broadcast State, not that the message was accepted.
    hub.dispatch({ type: "set-parameter", worldId: id, name: "go", value: true });
    await waitFor(() => (hub.last("world-live") as WorldLiveMessage).live.stateId === b, "the machine to move");

    await send({ type: "set-parameter", worldId: id, name: "go", value: 3 }, "the refusal");
    expect(hub.results().at(-1)).toMatchObject({ action: "set-parameter", ok: false });
  });

  it("ignores a clip-end report naming a stale generation", async () => {
    const id = await openWorld();
    await withState(id, "a");
    await waitFor(() => !!hub.last("world-live"), "the runtime to start");
    const live = (hub.last("world-live") as WorldLiveMessage).live;

    const before = hub.broadcasts.length;
    hub.dispatch({ type: "report-clip-end", worldId: id, stateId: live.stateId!, generation: live.generation - 5 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(hub.broadcasts.length).toBe(before);
  });

  it("reopens the World that was last open", async () => {
    const id = await openWorld();
    service!.stop();

    const second = new FakeHub();
    const restored = new WorldService(second, new WorldStore(dir));
    await restored.start();
    expect(second.last("world")?.world.id).toBe(id);
    restored.stop();
  });
});

describe("the clip library", () => {
  it("answers a browse to the socket that asked, and not to everyone", async () => {
    // Browsing is one person navigating. Broadcasting every listing replaced
    // the folder another tab was looking at, under its cursor.
    const takes = path.join(dir, "takes");
    await fs.mkdir(takes, { recursive: true });
    await fs.writeFile(path.join(takes, "couch.mp4"), "video", "utf8");

    hub.dispatch({ type: "browse-clips", path: takes });
    await waitFor(() => !!hub.lastSent("clip-library"), "the listing");

    expect((hub.lastSent("clip-library") as ClipLibraryMessage).listing.clips.map((c) => c.name)).toEqual([
      "couch.mp4",
    ]);
    expect(hub.last("clip-library")).toBeUndefined();
  });

  it("reports a folder it cannot read, and does not remember it", async () => {
    const takes = path.join(dir, "takes");
    await fs.mkdir(takes, { recursive: true });

    const listing = () => (hub.lastSent("clip-library") as ClipLibraryMessage | undefined)?.listing;

    hub.dispatch({ type: "browse-clips", path: takes });
    await waitFor(() => listing()?.folder === takes, "the good listing");

    hub.dispatch({ type: "browse-clips", path: path.join(dir, "nowhere") });
    await waitFor(() => !!listing()?.error, "the failure");

    // Browsing with no path returns to the last folder that worked, not the
    // one that failed.
    hub.dispatch({ type: "browse-clips" });
    await waitFor(() => listing()?.folder === takes && !listing()?.error, "the remembered folder");
  });

  it("copies a picked clip into the World and assigns it in one step", async () => {
    // Covers AE6. Stopping halfway would leave a file in clips/ that no State
    // names — and so one the clip route will not serve.
    const id = await openWorld();
    const stateId = await withState(id);
    const source = path.join(dir, "takes", "couch.mp4");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "video", "utf8");

    await send({ type: "import-clip", worldId: id, sourcePath: source, stateId }, "the import");

    expect((await store.load(id))!.world.states[0]!.clip).toEqual({ path: "clips/couch.mp4", durationMs: 0 });
    await expect(fs.stat(path.join(dir, "worlds", id, "clips", "couch.mp4"))).resolves.toBeTruthy();
  });

  it("refuses an import into a World that is not open", async () => {
    await openWorld("Lounge");
    await send({ type: "import-clip", worldId: "elsewhere", sourcePath: "x.mp4", stateId: "s" }, "the refusal");
    expect(hub.results().at(-1)).toMatchObject({ action: "import-clip", ok: false });
  });

  it("refuses a file that is not a video, without assigning anything", async () => {
    const id = await openWorld();
    const stateId = await withState(id);
    const source = path.join(dir, "notes.txt");
    await fs.writeFile(source, "not a video", "utf8");

    await send({ type: "import-clip", worldId: id, sourcePath: source, stateId }, "the refusal");

    expect(hub.results().at(-1)).toMatchObject({ ok: false, error: expect.stringMatching(/not a video/) });
    expect((await store.load(id))!.world.states[0]!.clip).toBeNull();
  });
});

describe("admission", () => {
  it("sends nothing to a socket that was never admitted", async () => {
    const id = await openWorld();
    await withState(id);
    expect(hub.sent).toEqual([]);
  });

  it("greets an admitted socket with the list, the World and where it is", async () => {
    const id = await openWorld();
    await withState(id);

    hub.connect();
    await waitFor(() => hub.sent.some((m) => m.type === "world"), "the greeting");

    expect(hub.sent[0]!.type).toBe("worlds");
    expect(hub.sent.some((m) => m.type === "world-live")).toBe(true);
  });
});
