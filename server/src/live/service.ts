import type { WebSocket } from "ws";
import type { ClientMessage, ClipRef, ServerMessage } from "../../../shared/src/types.js";
import { worldReports } from "../../../shared/src/world-geometry.js";
import {
  WorldStore,
  addEdge,
  addPosition,
  addScene,
  aimCamera,
  assignClip,
  declareParameter,
  movePosition,
  recordClipDuration,
  resolveClipPath,
  strikePairing,
  updateEdge,
  type LoadedWorld,
  type MutationResult,
} from "../storage/worlds.js";
import { WorldRuntime } from "./runtime.js";

// Structural hub interface so tests can fake it; WsHub satisfies this.
export interface WorldHub {
  broadcast(msg: ServerMessage): void;
  onMessage(handler: (msg: ClientMessage, client: WebSocket) => void): void;
  onConnection(greet: (client: WebSocket) => void): void;
  sendTo(client: WebSocket, msg: ServerMessage): void;
}

/**
 * The whole World domain on the protocol.
 *
 * Mirrors `MonitorService`: a structural hub, a handler registered with the
 * mandatory `.catch`, a greeter on the admitted-socket path, and a `handle()`
 * switch whose cases end by broadcasting. Every mutation the floorplan can make
 * arrives here (R30), because the plan view is one caller among others — an
 * agent holding the token authors a World with the same messages, and sets a
 * Parameter through the same path (AE5).
 *
 * Everything the service holds is keyed by World id. v1 opens one World at a
 * time, but a value that belongs to a World stored as though it belonged to the
 * app is exactly the shape that has to be untangled later; see
 * docs/solutions/splitting-a-singleton-leaves-every-lookup-keyed-to-the-old-one.md.
 */
export class WorldService {
  private readonly runtimes = new Map<string, WorldRuntime>();
  private readonly loaded = new Map<string, LoadedWorld>();
  private openId: string | null = null;
  // Opening spans several awaits, and two `open-world` messages arrive as fast
  // as a double-click. Serialized, because the second pass would otherwise
  // construct a runtime the map then overwrote — leaving an orphan nothing
  // could stop, broadcasting its World forever.
  private opening: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly hub: WorldHub,
    private readonly store: WorldStore,
  ) {
    // Catch everything: an escaped rejection from a fire-and-forget handler
    // would crash the process.
    hub.onMessage((msg) => {
      this.handle(msg).catch((err: unknown) => {
        console.error(`world handler error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    // On the admitted-socket path, not the raw connection event: an unadmitted
    // socket must receive nothing at all.
    hub.onConnection((client) => {
      void this.greet(client).catch(() => {});
    });
  }

  /** Reopen whatever was open when HAL last shut down (R4). */
  async start(): Promise<void> {
    const last = await this.store.lastOpen();
    if (last) await this.open(last);
  }

  stop(): void {
    for (const runtime of this.runtimes.values()) runtime.stop();
    this.runtimes.clear();
  }

  private async greet(client: WebSocket): Promise<void> {
    this.hub.sendTo(client, await this.worldsMessage());
    const open = this.openId;
    if (!open) return;
    const loaded = this.loaded.get(open);
    if (loaded) this.hub.sendTo(client, this.worldMessage(loaded));
    const runtime = this.runtimes.get(open);
    // A watcher joining mid-clip is given the current clip from its start
    // rather than an elapsed offset: the join it would be seeking into is a
    // frame nobody generated for it, and a clip is a few seconds long.
    if (runtime) this.hub.sendTo(client, { type: "world-live", live: runtime.live() });
  }

  private async worldsMessage(): Promise<ServerMessage> {
    return { type: "worlds", worlds: await this.store.list(), lastOpenId: this.openId ?? (await this.store.lastOpen()) };
  }

  private worldMessage(loaded: LoadedWorld): ServerMessage {
    return {
      type: "world",
      world: loaded.world,
      readable: loaded.readable,
      incomplete: loaded.incomplete,
      // Derived here rather than by the client, so an agent asking what is
      // wrong with a World gets the same answer the floorplan draws (R26–R28).
      reports: worldReports(loaded.world),
    };
  }

  private result(action: string, worldId: string | null, ok: boolean, error?: string): void {
    this.hub.broadcast({ type: "world-result", action, worldId, ok, ...(error ? { error } : {}) });
  }

  /** Whether a clip the runtime is about to play actually resolves inside its World. */
  private clipUsable(worldId: string): (clip: ClipRef) => Promise<boolean> {
    return async (clip) => {
      const dir = this.store.dirFor(worldId);
      if (!dir) return false;
      return (await resolveClipPath(dir, clip.path)).ok;
    };
  }

  private open(worldId: string): Promise<boolean> {
    const next = this.opening.then(
      () => this.openLocked(worldId),
      () => this.openLocked(worldId),
    );
    this.opening = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async openLocked(worldId: string): Promise<boolean> {
    const loaded = await this.store.load(worldId);
    if (!loaded) return false;

    // The pointer is written before any in-memory state moves: it is the one
    // step here that can fail on a real filesystem, and failing after `openId`
    // had already changed left a World named as open with no runtime behind it.
    await this.store.setLastOpen(worldId);

    // One World at a time in v1; the map is what makes lifting that a change of
    // policy rather than a change of shape.
    for (const [id, runtime] of this.runtimes) {
      if (id === worldId) continue;
      runtime.stop();
      this.runtimes.delete(id);
    }

    this.openId = worldId;
    this.loaded.set(worldId, loaded);

    let runtime = this.runtimes.get(worldId);
    if (!runtime) {
      runtime = new WorldRuntime(loaded.world, {
        onChange: (live) => this.hub.broadcast({ type: "world-live", live }),
        clipUsable: this.clipUsable(worldId),
      });
      this.runtimes.set(worldId, runtime);
      runtime.start();
    } else {
      runtime.setWorld(loaded.world);
    }
    this.hub.broadcast(this.worldMessage(loaded));
    return true;
  }

  /** Apply one manifest edit and broadcast the result — both halves, always. */
  private async apply(action: string, worldId: string, edit: Parameters<WorldStore["mutate"]>[1]): Promise<void> {
    if (typeof worldId !== "string" || worldId.length === 0) {
      this.result(action, null, false, "That message named no World.");
      return;
    }
    let result: MutationResult;
    try {
      result = await this.store.mutate(worldId, edit);
    } catch (err: unknown) {
      // Without this the rejection reaches the handler's logging `.catch` and
      // the client is told nothing at all — indistinguishable from a hang.
      this.result(action, worldId, false, `That change could not be saved: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!result.ok || !result.loaded) {
      this.result(action, worldId, false, result.error);
      return;
    }
    this.loaded.set(worldId, result.loaded);
    // A mutation applied to the store but not broadcast is a dead control, so
    // both halves happen here or neither does. Only for the World actually
    // open, though: broadcasting some other World as `world` would swap every
    // client's view out from under the one still playing.
    if (worldId === this.openId) this.hub.broadcast(this.worldMessage(result.loaded));
    this.runtimes.get(worldId)?.setWorld(result.loaded.world);
    this.result(action, worldId, true);
  }

  private async handle(msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "list-worlds":
        try {
          this.hub.broadcast(await this.worldsMessage());
        } catch (err: unknown) {
          this.result("list-worlds", null, false, `The Worlds folder could not be read: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;

      case "create-world": {
        const name = typeof msg.world?.name === "string" ? msg.world.name : "";
        if (name.trim().length === 0) {
          this.result("create-world", null, false, "A World needs a name.");
          return;
        }
        try {
          const created = await this.store.create(name);
          this.hub.broadcast(await this.worldsMessage());
          this.result("create-world", created.world.id, true);
        } catch (err: unknown) {
          this.result("create-world", null, false, `That World could not be created: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      case "open-world": {
        let opened = false;
        try {
          opened = await this.open(msg.worldId);
        } catch (err: unknown) {
          this.result("open-world", msg.worldId ?? null, false, `That World could not be opened: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        this.result("open-world", msg.worldId, opened, opened ? undefined : "There is no World by that name.");
        if (opened) this.hub.broadcast(await this.worldsMessage());
        return;
      }

      case "add-position":
        await this.apply("add-position", msg.worldId, (w) => addPosition(w, msg.name, msg.x, msg.y));
        return;

      case "move-position":
        await this.apply("move-position", msg.worldId, (w) => movePosition(w, msg.positionId, msg.x, msg.y));
        return;

      case "add-scene":
        await this.apply("add-scene", msg.worldId, (w) => addScene(w, msg.name, msg.camera));
        return;

      case "aim-camera":
        await this.apply("aim-camera", msg.worldId, (w) => aimCamera(w, msg.sceneId, msg.camera ?? {}));
        return;

      case "strike-pairing":
        await this.apply("strike-pairing", msg.worldId, (w) => strikePairing(w, msg.sceneId, msg.positionId, msg.struck !== false));
        return;

      case "add-edge":
        await this.apply("add-edge", msg.worldId, (w) => (msg.edge ? addEdge(w, msg.edge) : null));
        return;

      case "update-edge":
        await this.apply("update-edge", msg.worldId, (w) => updateEdgeSafely(w, msg.edgeId, msg.patch));
        return;

      case "assign-clip":
        await this.apply("assign-clip", msg.worldId, (w) => (msg.target ? assignClip(w, msg.target, msg.clip ?? null) : null));
        return;

      case "declare-parameter":
        await this.apply("declare-parameter", msg.worldId, (w) => (msg.parameter ? declareParameter(w, msg.parameter) : null));
        return;

      case "set-parameter": {
        const runtime = this.runtimes.get(msg.worldId);
        if (!runtime) {
          this.result("set-parameter", msg.worldId ?? null, false, "That World is not open.");
          return;
        }
        const ok = runtime.setParameter(msg.name, msg.value);
        this.result("set-parameter", msg.worldId, ok, ok ? undefined : "That Parameter has no such value.");
        return;
      }

      case "report-clip-duration":
        // Measured by the browser at first play, because the clip route serves
        // only clips the manifest already references and so cannot answer a
        // probe at assignment time.
        await this.apply("report-clip-duration", msg.worldId, (w) => recordClipDuration(w, msg.path, msg.durationMs));
        return;

      case "report-clip-end": {
        // Never an error worth reporting: a stale report is the routine case
        // this message's triple exists to make identifiable.
        this.runtimes.get(msg.worldId)?.reportClipEnd(msg.worldId, msg.stateId, msg.generation);
        return;
      }

      default:
        return;
    }
  }
}

// A patch arriving as a non-object would spread into the edge as nothing and
// look like a successful no-op; refusing it says so instead.
function updateEdgeSafely(world: Parameters<typeof updateEdge>[0], edgeId: string, patch: Parameters<typeof updateEdge>[2]) {
  if (typeof edgeId !== "string" || !patch || typeof patch !== "object") return null;
  return updateEdge(world, edgeId, patch);
}
