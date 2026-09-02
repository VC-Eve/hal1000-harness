import os from "node:os";
import type { WebSocket } from "ws";
import type { ClientMessage, ClipRef, ServerMessage } from "../../../shared/src/types.js";
import { worldReports } from "../../../shared/src/world-graph.js";
import {
  WorldStore,
  addState,
  addTransition,
  declareParameter,
  parameterAccepts,
  recordClipDuration,
  removeParameter,
  removeState,
  removeTransition,
  reorderTransitions,
  resolveClipPath,
  setDefaultState,
  updateState,
  updateTransition,
  type LoadedWorld,
  type MutationResult,
} from "../storage/worlds.js";
import { importClip, listFolder } from "./library.js";
import path from "node:path";
import { promises as fsp } from "node:fs";
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
 * switch whose cases end by broadcasting. Every mutation the graph can make
 * arrives here, because the graph is one caller among others — an agent holding
 * the token authors a machine with the same messages.
 *
 * Everything the service holds is keyed by World id. v1 opens one World at a
 * time, but a value that belongs to a World stored as though it belonged to the
 * app is the shape that has to be untangled later; see
 * docs/solutions/splitting-a-singleton-leaves-every-lookup-keyed-to-the-old-one.md.
 */
export class WorldService {
  private readonly runtimes = new Map<string, WorldRuntime>();
  private readonly loaded = new Map<string, LoadedWorld>();
  private openId: string | null = null;
  // Opening spans several awaits, and two `open-world` messages arrive as fast
  // as a double-click. Serialized, because the second pass would otherwise
  // construct a runtime the map then overwrote — an orphan nothing could stop.
  private opening: Promise<unknown> = Promise.resolve();
  // Where browsing last was. Held here rather than in settings: it is a
  // convenience for this session, not a preference worth broadcasting to every
  // client on connect.
  private libraryRoot: string = os.homedir();
  // Silent once stopped. `stop()` halts the runtimes, but a handler already in
  // flight — an open queued behind another, a mutation mid-write — resolves
  // afterwards and would broadcast into a service nobody is listening to.
  private stopped = false;

  constructor(
    private readonly hub: WorldHub,
    private readonly store: WorldStore,
  ) {
    // Catch everything: an escaped rejection from a fire-and-forget handler
    // would crash the process.
    hub.onMessage((msg, client) => {
      this.handle(msg, client).catch((err: unknown) => {
        console.error(`world handler error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    // On the admitted-socket path, not the raw connection event: an unadmitted
    // socket must receive nothing at all.
    hub.onConnection((client) => {
      void this.greet(client).catch((err: unknown) => {
        // Logged rather than swallowed: a client that got no greeting sees an
        // empty World list and nothing saying why.
        console.error(`world greet error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  }

  /** Reopen whatever was open when HAL last shut down. */
  async start(): Promise<void> {
    const last = await this.store.lastOpen();
    if (last) await this.open(last);
  }

  stop(): void {
    this.stopped = true;
    for (const runtime of this.runtimes.values()) runtime.stop();
    this.runtimes.clear();
  }

  /** Every outbound message goes through here, so stopping silences all of them. */
  private say(msg: ServerMessage): void {
    if (this.stopped) return;
    this.hub.broadcast(msg);
  }

  private async greet(client: WebSocket): Promise<void> {
    // The same gate `say` applies. A socket admitted moments before `stop()`,
    // with its greeting still in flight, would otherwise be spoken to after the
    // service considers itself silent.
    if (this.stopped) return;
    this.hub.sendTo(client, await this.worldsMessage());
    if (this.stopped) return;
    const open = this.openId;
    if (!open) return;
    const loaded = this.loaded.get(open);
    if (loaded) this.hub.sendTo(client, this.worldMessage(loaded));
    const runtime = this.runtimes.get(open);
    // A watcher joining mid-clip is given the current clip from its start
    // rather than an elapsed offset: the frame it would be seeking into is one
    // nobody generated for it, and a clip is a few seconds long.
    if (runtime) this.hub.sendTo(client, { type: "world-live", live: runtime.live() });
  }

  private async worldsMessage(): Promise<ServerMessage> {
    return {
      type: "worlds",
      worlds: await this.store.list(),
      lastOpenId: this.openId ?? (await this.store.lastOpen()),
    };
  }

  private worldMessage(loaded: LoadedWorld): ServerMessage {
    return {
      type: "world",
      world: loaded.world,
      readable: loaded.readable,
      ...(loaded.readOnlyReason ? { readOnlyReason: loaded.readOnlyReason } : {}),
      incomplete: loaded.incomplete,
      // Derived here rather than by the client, so an agent asking what is
      // wrong with a machine gets the same answer the graph draws.
      reports: worldReports(loaded.world, loaded.incomplete),
    };
  }

  private result(action: string, worldId: string | null, ok: boolean, error?: string): void {
    this.say({ type: "world-result", action, worldId, ok, ...(error ? { error } : {}) });
  }

  /** Whether a clip the runtime is about to play resolves inside its World. */
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
    if (this.stopped) return false;
    const loaded = await this.store.load(worldId);
    if (!loaded) return false;

    // The pointer is written before any in-memory state moves: it is the one
    // step here that can fail on a real filesystem, and failing after `openId`
    // had already changed left a World named as open with no runtime behind it.
    await this.store.setLastOpen(worldId);
    // Re-checked after every await: an open queued behind `stop()` would
    // otherwise build a running runtime into the map `stop()` had just cleared,
    // leaving a machine nothing can reach to stop it again.
    if (this.stopped) return false;

    // One World at a time; the map is what makes lifting that a change of
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
        onChange: (live) => this.say({ type: "world-live", live }),
        clipUsable: this.clipUsable(worldId),
      });
      this.runtimes.set(worldId, runtime);
      runtime.start();
    } else {
      runtime.setWorld(loaded.world);
    }
    this.say(this.worldMessage(loaded));
    return true;
  }

  /** Apply one manifest edit and broadcast the result — both halves, always. */
  private async apply(action: string, worldId: string, edit: Parameters<WorldStore["mutate"]>[1]): Promise<boolean> {
    if (typeof worldId !== "string" || worldId.length === 0) {
      this.result(action, null, false, "That message named no World.");
      return false;
    }
    let result: MutationResult;
    try {
      result = await this.store.mutate(worldId, edit);
    } catch (err: unknown) {
      // Without this the rejection reaches the handler's logging `.catch` and
      // the client is told nothing at all — indistinguishable from a hang.
      this.result(action, worldId, false, `That change could not be saved: ${message(err)}`);
      return false;
    }
    if (!result.ok || !result.loaded) {
      this.result(action, worldId, false, result.error);
      return false;
    }
    // Nothing written, so nothing to tell anyone but the caller. Broadcasting a
    // World that did not change costs every client a re-render and a reports
    // pass for a message that says what they already have.
    if (result.unchanged) {
      this.result(action, worldId, true);
      return true;
    }
    this.loaded.set(worldId, result.loaded);
    // A mutation applied to the store but not broadcast is a dead control, so
    // both halves happen here or neither does. Only for the World actually
    // open, though: broadcasting some other World as `world` would swap every
    // client's view out from under the one still playing.
    if (worldId === this.openId) this.say(this.worldMessage(result.loaded));
    this.runtimes.get(worldId)?.setWorld(result.loaded.world);
    this.result(action, worldId, true);
    return true;
  }

  private async handle(msg: ClientMessage, client?: WebSocket): Promise<void> {
    switch (msg.type) {
      case "list-worlds":
        try {
          this.say(await this.worldsMessage());
        } catch (err: unknown) {
          this.result("list-worlds", null, false, `The Worlds folder could not be read: ${message(err)}`);
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
          this.say(await this.worldsMessage());
          this.result("create-world", created.world.id, true);
        } catch (err: unknown) {
          this.result("create-world", null, false, `That World could not be created: ${message(err)}`);
        }
        return;
      }

      case "open-world": {
        let opened = false;
        try {
          opened = await this.open(msg.worldId);
        } catch (err: unknown) {
          this.result("open-world", msg.worldId ?? null, false, `That World could not be opened: ${message(err)}`);
          return;
        }
        this.result("open-world", msg.worldId, opened, opened ? undefined : "There is no World by that name.");
        if (opened) this.say(await this.worldsMessage());
        return;
      }

      case "add-state":
        await this.apply("add-state", msg.worldId, (w) => (msg.state ? addState(w, msg.state) : null));
        return;

      case "update-state":
        await this.apply("update-state", msg.worldId, (w) =>
          msg.patch && typeof msg.patch === "object" ? updateState(w, msg.stateId, msg.patch) : null,
        );
        return;

      case "remove-state":
        await this.apply("remove-state", msg.worldId, (w) => removeState(w, msg.stateId));
        return;

      case "set-default-state":
        await this.apply("set-default-state", msg.worldId, (w) => setDefaultState(w, msg.stateId));
        return;

      case "add-transition":
        await this.apply("add-transition", msg.worldId, (w) =>
          msg.transition ? addTransition(w, msg.transition) : null,
        );
        return;

      case "update-transition":
        await this.apply("update-transition", msg.worldId, (w) =>
          msg.patch && typeof msg.patch === "object" ? updateTransition(w, msg.transitionId, msg.patch) : null,
        );
        return;

      case "remove-transition":
        await this.apply("remove-transition", msg.worldId, (w) => removeTransition(w, msg.transitionId));
        return;

      case "reorder-transitions":
        await this.apply("reorder-transitions", msg.worldId, (w) =>
          reorderTransitions(w, msg.from, msg.fromAny === true, msg.order),
        );
        return;

      case "declare-parameter":
        await this.apply("declare-parameter", msg.worldId, (w) =>
          msg.parameter ? declareParameter(w, msg.parameter) : null,
        );
        return;

      case "remove-parameter":
        await this.apply("remove-parameter", msg.worldId, (w) => removeParameter(w, msg.name));
        return;

      case "set-parameter": {
        const runtime = this.runtimes.get(msg.worldId);
        const loaded = this.loaded.get(msg.worldId);
        if (!runtime || !loaded) {
          this.result("set-parameter", msg.worldId ?? null, false, "That World is not open.");
          return;
        }
        // Checked against the declared type before it reaches the runtime, so
        // the refusal names the reason rather than the machine silently
        // ignoring a value it could not use.
        if (!parameterAccepts(loaded.world, msg.name, msg.value)) {
          this.result("set-parameter", msg.worldId, false, "That Parameter cannot hold that value.");
          return;
        }
        const ok = runtime.setParameter(msg.name, msg.value);
        this.result("set-parameter", msg.worldId, ok, ok ? undefined : "That Parameter is not declared.");
        return;
      }

      case "report-clip-duration":
        // Measured by the browser at first play, because the clip route serves
        // only clips the manifest already references and so cannot answer a
        // probe at assignment time.
        await this.apply("report-clip-duration", msg.worldId, (w) => recordClipDuration(w, msg.path, msg.durationMs));
        return;

      case "report-clip-end":
        // Never an error worth reporting: a stale report is the routine case
        // this message's triple exists to make identifiable.
        this.runtimes.get(msg.worldId)?.reportClipEnd(msg.worldId, msg.stateId, msg.generation);
        return;

      case "browse-clips": {
        const folder = typeof msg.path === "string" && msg.path.length > 0 ? msg.path : this.libraryRoot;
        const listing = await listFolder(folder);
        // Remembered only when it worked, so a mistyped path does not become
        // the place browsing opens next time.
        if (!listing.error) this.libraryRoot = listing.folder;
        // Answered to the socket that asked, not broadcast. Browsing is one
        // person navigating: sending every listing to everyone replaced the
        // folder another tab was looking at, under its cursor, and the next
        // click there imported a file nobody chose.
        if (client && !this.stopped) this.hub.sendTo(client, { type: "clip-library", listing });
        return;
      }

      case "import-clip": {
        const dir = this.store.dirFor(msg.worldId);
        if (!dir || msg.worldId !== this.openId) {
          this.result("import-clip", msg.worldId ?? null, false, "That World is not open.");
          return;
        }
        // Checked before the copy, not after. A file in `clips/` that nothing
        // names is unreachable through the clip route and invisible in the
        // graph, and it still takes the name a later import wanted.
        const owner = msg.owner;
        // Named rather than inferred. Anything that is not one of the two kinds
        // fell through to the State branch and came back as "That State is no
        // longer in this World" — a true-sounding answer to a question nobody
        // asked, which sends an agent looking in the wrong place.
        if (owner?.kind !== "state" && owner?.kind !== "transition") {
          this.result("import-clip", msg.worldId, false, "That message did not say what to add the clip to.");
          return;
        }
        const open = this.loaded.get(msg.worldId);
        const present =
          owner?.kind === "transition"
            ? open?.world.transitions.some((t) => t.id === owner.id)
            : open?.world.states.some((state) => state.id === owner?.id);
        if (!present) {
          this.result(
            "import-clip",
            msg.worldId,
            false,
            owner?.kind === "transition"
              ? "That transition is no longer in this World."
              : "That State is no longer in this World.",
          );
          return;
        }
        const copied = await importClip(dir, msg.sourcePath);
        if (!copied.ok) {
          this.result("import-clip", msg.worldId, false, copied.error);
          return;
        }
        // Assigned in the same breath as the copy: a file sitting in `clips/`
        // that no State names is not reachable through the clip route, so
        // stopping halfway would leave the author with an invisible file.
        // Appended to the set rather than replacing it: importing a second
        // idle should give the State two idles, not swap the first one out.
        const arrival = { path: copied.path, durationMs: 0 };
        const assigned = await this.apply("import-clip", msg.worldId, (w) => {
          if (owner.kind === "transition") {
            const transition = w.transitions.find((t) => t.id === owner.id);
            if (!transition) return null;
            return updateTransition(w, owner.id, { clips: [...transition.clips, arrival] });
          }
          const state = w.states.find((st) => st.id === owner.id);
          if (!state) return null;
          return updateState(w, owner.id, { clips: [...state.clips, arrival] });
        });
        // The State can still have gone in the gap the copy took. Take the file
        // back out rather than leaving one nothing names.
        if (!assigned) await removeClipFile(dir, copied.path);
        return;
      }

      default:
        return;
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Take back a clip that was copied in but never assigned.
 *
 * Best effort by design: failing to tidy up must not turn into a second error
 * on top of the one the caller is already reporting.
 */
async function removeClipFile(worldDir: string, relative: string): Promise<void> {
  const name = path.basename(relative);
  await fsp.rm(path.join(worldDir, "clips", name), { force: true }).catch(() => {});
}
