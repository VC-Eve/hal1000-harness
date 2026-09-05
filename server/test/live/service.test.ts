import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { WebSocket } from "ws";
import { tmpDir } from "../tmp.js";
import { waitFor } from "../wait.js";
import { WorldService, type WorldHub } from "../../src/live/service.js";
import { WorldStore } from "../../src/storage/worlds.js";
import { AudioStore } from "../../src/storage/audio.js";
import type {
  ClientMessage,
  ClipLibraryMessage,
  PlaylistMessage,
  PlaylistResultMessage,
  PlaylistsMessage,
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
  private readonly closers: ((c: WebSocket) => void)[] = [];

  broadcast(msg: ServerMessage): void {
    this.broadcasts.push(msg);
  }
  private readonly observers = new WeakSet<WebSocket>();
  observe(client: WebSocket): void {
    this.observers.add(client);
  }
  isObserver(client: WebSocket | undefined): boolean {
    return client !== undefined && this.observers.has(client);
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
  service = new WorldService(hub, store, new AudioStore(dir));
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
    const broken = new WorldService(
      brokenHub,
      {
        ...store,
        mutate: () => Promise.reject(new Error("disk on fire")),
      } as unknown as WorldStore,
      new AudioStore(dir),
    );

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

  /** A World with one State holding one imported clip, whose duration is unmeasured. */
  async function withClip(): Promise<{ id: string; stateId: string }> {
    const id = await openWorld();
    const stateId = await withState(id);
    const source = path.join(dir, "takes", "couch.mp4");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "video", "utf8");
    await send(
      { type: "import-clip", worldId: id, sourcePath: source, owner: { kind: "state", id: stateId } },
      "the import",
    );
    return { id, stateId };
  }

  const storedDuration = async (id: string): Promise<number> =>
    (await store.load(id))!.world.states[0]!.clips[0]!.clips[0]!.durationMs;

  it("records a clip duration an ordinary client measured", async () => {
    // The baseline for the refusal below. Without it, a test asserting an
    // observer's write did not land would pass just as well against a build
    // where nobody's write lands.
    const { id } = await withClip();

    await send(
      { type: "report-clip-duration", worldId: id, path: "clips/couch.mp4", durationMs: 6250 },
      "the measurement",
    );

    expect(await storedDuration(id)).toBe(6250);
  });

  it("refuses a clip duration from a socket that only watches", async () => {
    // The load-bearing half of the observer's report refusal. Nothing
    // downstream deduplicates a duration and it is a manifest write, so unlike
    // the clip-end report there is no second guard behind this one.
    const { id } = await withClip();
    const before = await storedDuration(id);

    hub.dispatch({ type: "observe" });
    hub.dispatch({ type: "report-clip-duration", worldId: id, path: "clips/couch.mp4", durationMs: 6250 });
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The stored value, not merely that a result said no: the point is that
    // nothing was written.
    expect(await storedDuration(id)).toBe(before);
  });

  /** The generation the runtime is currently broadcasting. */
  const generation = (): number => (hub.last("world-live") as WorldLiveMessage).live.generation;

  it("advances the machine on an ordinary client's clip-end report", async () => {
    // The baseline the refusal below needs. A State with a clip actually
    // playing, so the report lands on a pending wait and is accepted — without
    // this, a test asserting an observer's report changed nothing would pass
    // against a build that ignores every report, which is what the first
    // version of it did.
    const { id } = await withClip();
    await waitFor(() => !!hub.last("world-live"), "the runtime to start");
    const live = (hub.last("world-live") as WorldLiveMessage).live;

    hub.dispatch({ type: "report-clip-end", worldId: id, stateId: live.stateId!, generation: live.generation });

    await waitFor(() => generation() > live.generation, "the loop to turn over early");
  });

  it("refuses a clip-end report from a socket that only watches", async () => {
    // Defence in depth rather than the only guard — `WorldRuntime.reportClipEnd`
    // discards a duplicate by triple already — so the triple here is the valid
    // one the test above proves is accepted. What differs is only who sent it.
    const { id } = await withClip();
    await waitFor(() => !!hub.last("world-live"), "the runtime to start");
    const live = (hub.last("world-live") as WorldLiveMessage).live;

    hub.dispatch({ type: "observe" });
    hub.dispatch({ type: "report-clip-end", worldId: id, stateId: live.stateId!, generation: live.generation });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(generation()).toBe(live.generation);
  });

  it("reopens the World that was last open", async () => {
    const id = await openWorld();
    service!.stop();

    const second = new FakeHub();
    const restored = new WorldService(second, new WorldStore(dir), new AudioStore(dir));
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

    await send({ type: "import-clip", worldId: id, sourcePath: source, owner: { kind: "state", id: stateId } }, "the import");

    // A run of one: an imported clip is its own gesture until the author links it.
    expect((await store.load(id))!.world.states[0]!.clips).toEqual([
      { clips: [{ path: "clips/couch.mp4", durationMs: 0 }] },
    ]);
    await expect(fs.stat(path.join(dir, "worlds", id, "clips", "couch.mp4"))).resolves.toBeTruthy();
  });

  it("appends a second import rather than replacing the first", async () => {
    // Importing another idle should give the State two idles to draw from, not
    // swap the one it had.
    const id = await openWorld();
    const stateId = await withState(id);
    await fs.mkdir(path.join(dir, "takes"), { recursive: true });
    for (const name of ["one.mp4", "two.mp4"]) {
      await fs.writeFile(path.join(dir, "takes", name), "video", "utf8");
      await send({ type: "import-clip", worldId: id, sourcePath: path.join(dir, "takes", name), owner: { kind: "state", id: stateId } }, `the ${name} import`);
    }

    const clips = (await store.load(id))!.world.states[0]!.clips;
    expect(clips.map((c) => c.clips[0]!.path)).toEqual(["clips/one.mp4", "clips/two.mp4"]);
  });

  it("imports into a transition's set as well as a State's", async () => {
    const id = await openWorld();
    const from = await withState(id, "couch");
    const to = await withState(id, "booth");
    await send({ type: "add-transition", worldId: id, transition: { from, to } }, "the transition");
    const transitionId = (await store.load(id))!.world.transitions[0]!.id;
    const source = path.join(dir, "takes", "walk.mp4");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "video", "utf8");

    await send(
      { type: "import-clip", worldId: id, sourcePath: source, owner: { kind: "transition", id: transitionId } },
      "the bridge import",
    );

    const transition = (await store.load(id))!.world.transitions[0]!;
    expect(transition.clips.map((c) => c.clips[0]!.path)).toEqual(["clips/walk.mp4"]);
  });

  it("refuses an import against a transition that is no longer there", async () => {
    const id = await openWorld();
    await withState(id);
    const source = path.join(dir, "takes", "walk.mp4");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "video", "utf8");

    await send(
      { type: "import-clip", worldId: id, sourcePath: source, owner: { kind: "transition", id: "gone" } },
      "the refusal",
    );

    expect(hub.results().at(-1)).toMatchObject({ action: "import-clip", ok: false });
    expect(await fs.readdir(path.join(dir, "worlds", id, "clips"))).toEqual([]);
  });

  it("refuses an import against a State that is no longer there, and copies nothing", async () => {
    // The copy used to happen first, leaving a file nothing names — unreachable
    // through the clip route, invisible in the graph, and still holding the
    // name a later import wanted.
    const id = await openWorld();
    await withState(id);
    const source = path.join(dir, "takes", "couch.mp4");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "video", "utf8");

    await send({ type: "import-clip", worldId: id, sourcePath: source, owner: { kind: "state", id: "gone" } }, "the refusal");

    expect(hub.results().at(-1)).toMatchObject({ action: "import-clip", ok: false });
    const clips = await fs.readdir(path.join(dir, "worlds", id, "clips"));
    expect(clips).toEqual([]);
  });

  it("refuses an import into a World that is not open", async () => {
    await openWorld("Lounge");
    await send({ type: "import-clip", worldId: "elsewhere", sourcePath: "x.mp4", owner: { kind: "state", id: "s" } }, "the refusal");
    expect(hub.results().at(-1)).toMatchObject({ action: "import-clip", ok: false });
  });

  it("refuses a file that is not a video, without assigning anything", async () => {
    const id = await openWorld();
    const stateId = await withState(id);
    const source = path.join(dir, "notes.txt");
    await fs.writeFile(source, "not a video", "utf8");

    await send({ type: "import-clip", worldId: id, sourcePath: source, owner: { kind: "state", id: stateId } }, "the refusal");

    expect(hub.results().at(-1)).toMatchObject({ ok: false, error: expect.stringMatching(/not a video/) });
    expect((await store.load(id))!.world.states[0]!.clips).toEqual([]);
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

describe("where browsing opens", () => {
  it("remembers the folder across a restart", async () => {
    // The whole point: a folder that reset to the home directory on every boot
    // made the author navigate back to their clips every time HAL restarted.
    const id = await openWorld();
    const takes = path.join(dir, "takes");
    await fs.mkdir(takes, { recursive: true });
    await fs.writeFile(path.join(takes, "one.mp4"), "video", "utf8");

    hub.dispatch({ type: "browse-clips", path: takes });
    await waitFor(() => hub.lastSent("clip-library")?.listing.folder === takes, "the listing");

    const remembered = await store.lastLibrary();
    expect(remembered).toBe(takes);
    expect(id).toBeTruthy();
  });

  it("does not remember a folder that could not be read", async () => {
    // A mistyped path must not become the place browsing opens next time.
    await openWorld();
    const takes = path.join(dir, "takes");
    await fs.mkdir(takes, { recursive: true });
    hub.dispatch({ type: "browse-clips", path: takes });
    await waitFor(() => hub.lastSent("clip-library")?.listing.folder === takes, "the good listing");

    const nowhere = path.join(dir, "nowhere-at-all");
    hub.dispatch({ type: "browse-clips", path: nowhere });
    await waitFor(() => !!hub.lastSent("clip-library")?.listing.error, "the refusal");

    expect(await store.lastLibrary()).toBe(takes);
  });

  it("forgets a remembered folder that is no longer a folder", async () => {
    // It names a place on a drive that may have been unplugged since. Opening
    // on an error would be worse than opening at home.
    const gone = path.join(dir, "gone");
    await fs.mkdir(gone, { recursive: true });
    await store.setLastLibrary(gone);
    await fs.rm(gone, { recursive: true });

    expect(await store.lastLibrary()).toBeNull();
  });
});

describe("playlists on the protocol", () => {
  /** Send a playlist message and wait for the reply that answers it. */
  async function sendPlaylist(msg: ClientMessage, label: string): Promise<PlaylistResultMessage> {
    const before = hub.broadcasts.filter((m) => m.type === "playlist-result").length;
    hub.dispatch(msg);
    await waitFor(
      () => hub.broadcasts.filter((m) => m.type === "playlist-result").length > before,
      label,
    );
    return hub.last("playlist-result") as PlaylistResultMessage;
  }

  it("creates, renames, reorders and deletes a playlist over the wire", async () => {
    // The whole surface is here rather than in the pane, because the pane is one
    // caller among others: an agent holding the token builds a playlist with the
    // same messages.
    const audio = new AudioStore(dir);
    const created = await sendPlaylist({ type: "create-playlist", name: "Warm Up" }, "the create");
    expect(created).toMatchObject({ ok: true, playlistId: "warm-up" });
    expect((hub.last("playlists") as PlaylistsMessage).playlists).toEqual([
      { id: "warm-up", name: "Warm Up", tracks: 0 },
    ]);

    await fs.mkdir(audio.tracksDir(), { recursive: true });
    for (const name of ["one.flac", "two.flac"]) {
      await fs.writeFile(path.join(audio.tracksDir(), name), "not really audio", "utf8");
    }
    await audio.addTracks("warm-up", [
      { path: "tracks/one.flac", name: "one.flac", durationMs: 1000 },
      { path: "tracks/two.flac", name: "two.flac", durationMs: 1000 },
    ]);

    await sendPlaylist({ type: "rename-playlist", playlistId: "warm-up", name: "Warm Up Two" }, "the rename");
    await sendPlaylist(
      { type: "reorder-playlist", playlistId: "warm-up", order: ["tracks/two.flac", "tracks/one.flac"] },
      "the reorder",
    );
    const reordered = (hub.last("playlist") as PlaylistMessage).playlist;
    expect(reordered.name).toBe("Warm Up Two");
    expect(reordered.tracks.map((t) => t.path)).toEqual(["tracks/two.flac", "tracks/one.flac"]);

    await sendPlaylist({ type: "remove-track", playlistId: "warm-up", path: "tracks/two.flac" }, "the removal");
    expect((hub.last("playlist") as PlaylistMessage).playlist.tracks).toHaveLength(1);

    expect(await sendPlaylist({ type: "remove-playlist", playlistId: "warm-up" }, "the delete")).toMatchObject({
      ok: true,
    });
    expect((hub.last("playlists") as PlaylistsMessage).playlists).toEqual([]);
    // The file it named is still there. Deleting an index is not deleting audio.
    await expect(fs.stat(path.join(audio.tracksDir(), "one.flac"))).resolves.toBeTruthy();
  });

  it("names a World's playlist, and reports one the store does not hold", async () => {
    const id = await openWorld();
    await send({ type: "set-world-playlist", worldId: id, playlistId: "warm-up" }, "the reference");

    expect(world().playlistId).toBe("warm-up");
    expect((hub.last("world") as WorldMessage).reports.missingPlaylist).toBe("warm-up");

    await sendPlaylist({ type: "create-playlist", name: "Warm Up" }, "the create");
    // The report is derived per broadcast rather than stored, so the reference
    // becomes true again with no edit to the World itself — here the next
    // unrelated mutation is what re-derives it.
    await withState(id);
    expect((hub.last("world") as WorldMessage).reports.missingPlaylist).toBeNull();
  });

  it("refuses a nonexistent playlist and a name it cannot use, with a reason", async () => {
    expect(await sendPlaylist({ type: "create-playlist", name: "   " }, "the empty name")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/needs a name/),
    });
    expect(
      await sendPlaylist({ type: "rename-playlist", playlistId: "nope", name: "x" }, "the missing playlist"),
    ).toMatchObject({ ok: false });
    expect(await sendPlaylist({ type: "remove-playlist", playlistId: "nope" }, "the missing delete")).toMatchObject({
      ok: false,
    });
  });
});
