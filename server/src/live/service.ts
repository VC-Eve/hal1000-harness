import os from "node:os";
import type { WebSocket } from "ws";
import type { ClientMessage, ClipRef, ServerMessage } from "../../../shared/src/types.js";
import { worldReports } from "../../../shared/src/world-graph.js";
import {
  WorldStore,
  addState,
  addTransition,
  declareParameter,
  setWorldEffects,
  parameterAccepts,
  recordClipDuration,
  removeParameter,
  removeState,
  removeTransition,
  reorderTransitions,
  resolveClipPath,
  setDefaultState,
  setWorldPlaylist,
  updateState,
  updateTransition,
  type LoadedWorld,
  type MutationResult,
} from "../storage/worlds.js";
import {
  AudioStore,
  MAX_TRACKS_PER_PLAYLIST,
  removeTrack,
  renamePlaylist,
  reorderTracks,
} from "../storage/audio.js";
import type { PlaylistTrack } from "../../../shared/src/audio.js";
import { importClip, listFolder } from "./library.js";
import { importTrack, listAudioFolder } from "./audio-library.js";
import { AudioTransport, systemTime, type TransportCommand, type TransportTime } from "./transport.js";
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
  // Where browsing last was, once this session has browsed anywhere. Null until
  // then, because the answer to "where does browsing start" is on disk and
  // reading it is async — see `startingFolder`.
  //
  // Still not a setting: it is one person's place in a file tree, not a
  // preference worth broadcasting to every client on connect. It *is* persisted
  // now, which is a different question from broadcasting — a folder that reset
  // to the home directory on every boot made the author navigate back to their
  // clips every time HAL restarted.
  private libraryRoot: string | null = null;
  // The same, for audio. A separate field rather than a shared one: a clip
  // library and a music library are two places on the drive, and pointing the
  // track browser somewhere must not move the clip browser with it.
  //
  // Held for the session only, where the clip root is also written to disk.
  // Persisting it belongs to the audio store — `last-library.json` lives under
  // `worlds/` and is the World store's file — and that is a store change this
  // unit does not make. `HAL_AUDIO_LIBRARY` covers the first run, which is the
  // case the home directory answers worst.
  private audioRoot: string | null = null;
  // Silent once stopped. `stop()` halts the runtimes, but a handler already in
  // flight — an open queued behind another, a mutation mid-write — resolves
  // afterwards and would broadcast into a service nobody is listening to.
  private stopped = false;

  /**
   * The transport: one clock, no World.
   *
   * Held by the service rather than by a runtime, which is origin R3 expressed
   * as a field. A transport owned by a World would stop when that World did, and
   * switching Worlds would take the music with it.
   */
  private readonly transport: AudioTransport;

  constructor(
    private readonly hub: WorldHub,
    private readonly store: WorldStore,
    private readonly audio: AudioStore,
    time: TransportTime = systemTime,
  ) {
    this.transport = new AudioTransport(audio, {
      // Into the open World's readout map, and nowhere else. `setAudio` replaces
      // it wholesale and deliberately does not emit, so this is a wake at most
      // once a second rather than a broadcast.
      onReadouts: (readouts) => {
        const open = this.openId;
        if (open) this.runtimes.get(open)?.setAudio(readouts);
      },
      // Its own message, never `world-live`: that one carries whole machine
      // state, and a readout changing once a second must not put the machine
      // into permanent transmission (origin R27).
      onChange: (transport) => this.say({ type: "audio-transport-state", transport }),
      time,
    });
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
    this.transport.start();
    const last = await this.store.lastOpen();
    if (last) await this.open(last);
  }

  stop(): void {
    this.stopped = true;
    this.transport.stop();
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
    // The playlist list is greeted like the World list: a client that reconnects
    // mid-set must not have to ask before it can show what the store holds.
    this.hub.sendTo(client, await this.playlistsMessage());
    if (this.stopped) return;
    // The transport's own greeting, beside `world-live` rather than inside it. A
    // client that connects mid-track has to be told what is playing, and the
    // only place that is said is this message (origin R27).
    this.hub.sendTo(client, { type: "audio-transport-state", transport: this.transport.state() });
    if (this.stopped) return;
    // Sent before the open-World branch returns: the transport belongs to no
    // World, so a client connecting with nothing open still has to hear it.
    const open = this.openId;
    if (!open) return;
    const loaded = this.loaded.get(open);
    if (loaded) this.hub.sendTo(client, await this.worldMessage(loaded));
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

  private async playlistsMessage(): Promise<ServerMessage> {
    return { type: "playlists", playlists: await this.audio.list() };
  }

  /**
   * The ids the store holds, or null when it could not say.
   *
   * Null rather than an empty list on failure, because the reports read this to
   * decide whether a World's playlist reference is dangling: an unreadable store
   * directory would otherwise report every World's playlist as missing, which is
   * a fault invented out of not knowing.
   */
  private async playlistIds(): Promise<string[] | null> {
    return this.audio.ids().catch(() => null);
  }

  private async worldMessage(loaded: LoadedWorld): Promise<ServerMessage> {
    const playlists = await this.playlistIds();
    return {
      type: "world",
      world: loaded.world,
      readable: loaded.readable,
      ...(loaded.readOnlyReason ? { readOnlyReason: loaded.readOnlyReason } : {}),
      incomplete: loaded.incomplete,
      // Derived here rather than by the client, so an agent asking what is
      // wrong with a machine gets the same answer the graph draws.
      reports: worldReports(loaded.world, loaded.incomplete, playlists),
    };
  }

  private result(action: string, worldId: string | null, ok: boolean, error?: string): void {
    this.say({ type: "world-result", action, worldId, ok, ...(error ? { error } : {}) });
  }

  /** Whether a clip the runtime is about to play resolves inside its World. */
  /**
   * Where browsing opens when no folder is named.
   *
   * Three answers, in order: where this session last browsed, where the last
   * session ended, and `HAL_CLIP_LIBRARY` or the home directory. The env var
   * exists because the home directory is a poor guess for anyone who keeps a
   * clip library somewhere else, and an absolute path in the source would be
   * one machine's answer compiled into everybody's build.
   */
  private async startingFolder(): Promise<string> {
    if (this.libraryRoot !== null) return this.libraryRoot;
    const remembered = await this.store.lastLibrary().catch(() => null);
    if (remembered) return remembered;
    const configured = process.env.HAL_CLIP_LIBRARY?.trim();
    return configured && configured.length > 0 ? configured : os.homedir();
  }

  /** Where track browsing opens when no folder is named. */
  private audioStartingFolder(): string {
    if (this.audioRoot !== null) return this.audioRoot;
    const configured = process.env.HAL_AUDIO_LIBRARY?.trim();
    return configured && configured.length > 0 ? configured : os.homedir();
  }

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
    // Seeded with what is playing *now*, before anything is armed. A World
    // opened while another's track is running must evaluate against that track
    // rather than against silence — the machine is new, the music is not.
    runtime.setAudio(this.transport.readouts());
    this.say(await this.worldMessage(loaded));
    // Armed, not started: the transport refuses this while it holds a track, and
    // that refusal is origin R3 rather than a failure. A paused track still
    // holds it, so pausing does not open the gate either.
    void this.transport.arm(loaded.world.playlistId).catch((err: unknown) => {
      console.error(`transport arm error: ${message(err)}`);
    });
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
    if (worldId === this.openId) this.say(await this.worldMessage(result.loaded));
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

      case "set-world-effects":
        await this.apply("set-world-effects", msg.worldId, (w) => setWorldEffects(w, msg.effects));
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
        const folder =
          typeof msg.path === "string" && msg.path.length > 0 ? msg.path : await this.startingFolder();
        const listing = await listFolder(folder);
        // Remembered only when it worked, so a mistyped path does not become
        // the place browsing opens next time.
        if (!listing.error) {
          this.libraryRoot = listing.folder;
          // Written, not merely held: the point is that it survives a restart.
          // Failure is ignored — being unable to remember where the author was
          // is not a reason to refuse them the listing they asked for.
          await this.store.setLastLibrary(listing.folder).catch(() => {});
        }
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
        // Appended as a run of one, which is what a newly imported clip is:
        // the author links it to a neighbour afterwards if they want a gesture.
        const arrival = { clips: [{ path: copied.path, durationMs: 0 }] };
        // Checked before the append rather than after: an oversized set is now
        // refused outright, and a refusal after the copy would leave the file
        // in `clips/` with nothing naming it.
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

      case "audio-transport":
        await this.transportCommand(msg.command, msg.positionMs, msg.volume, msg.worldId);
        return;

      case "report-track-duration": {
        // Measured by the browser at first play, exactly as a clip's is: the
        // byte route serves only tracks a playlist already names, so nothing
        // here can probe a file at import time.
        const result = await this.transport.reportDuration(msg.playlistId, msg.path, msg.durationMs);
        if (result.ok) {
          const playlist = await this.audio.load(msg.playlistId).catch(() => null);
          // The index whole, so the editor's per-track length is right. Not the
          // summaries — a name and a count did not change, and this arrives once
          // per track.
          if (playlist) this.say({ type: "playlist", playlist });
        }
        this.playlistResult(
          "report-track-duration",
          typeof msg.playlistId === "string" ? msg.playlistId : null,
          result.ok,
          result.ok ? undefined : result.error,
        );
        return;
      }

      case "report-audio-position":
        // Never an error worth reporting, like `report-clip-end`: a stale or
        // out-of-tolerance report is the routine case the refusal set exists to
        // make identifiable, not a fault to broadcast several times a second.
        this.transport.reportPosition(msg.playlistId, msg.path, msg.positionMs);
        return;

      case "browse-audio": {
        const folder =
          typeof msg.path === "string" && msg.path.length > 0 ? msg.path : this.audioStartingFolder();
        const listing = await listAudioFolder(folder);
        // Remembered only when it worked, so a mistyped path does not become
        // the place browsing opens next time.
        if (!listing.error) this.audioRoot = listing.folder;
        // Answered to the socket that asked, never broadcast — the rule
        // `browse-clips` records: a listing sent to everyone replaced the
        // folder another tab was looking at, under its cursor.
        if (client && !this.stopped) this.hub.sendTo(client, { type: "audio-library", listing });
        return;
      }

      case "import-tracks":
        await this.importTracks(msg.playlistId, msg.sourcePaths);
        return;

      case "set-world-playlist":
        await this.apply("set-world-playlist", msg.worldId, (w) => setWorldPlaylist(w, msg.playlistId));
        return;

      case "list-playlists": {
        try {
          this.say(await this.playlistsMessage());
          // One index whole only when it was asked for. A listing is a name and
          // a count; sending every track of every playlist to answer "what is
          // there" is the broadcast volume the World list avoids the same way.
          if (typeof msg.playlistId === "string") {
            const playlist = await this.audio.load(msg.playlistId);
            if (!playlist) {
              this.playlistResult("list-playlists", msg.playlistId, false, "There is no playlist by that name.");
              return;
            }
            this.say({ type: "playlist", playlist });
          }
          this.playlistResult("list-playlists", msg.playlistId ?? null, true);
        } catch (err: unknown) {
          this.playlistResult("list-playlists", null, false, `The audio store could not be read: ${message(err)}`);
        }
        return;
      }

      case "create-playlist": {
        const name = typeof msg.name === "string" ? msg.name : "";
        if (name.trim().length === 0) {
          this.playlistResult("create-playlist", null, false, "A playlist needs a name.");
          return;
        }
        try {
          const created = await this.audio.create(name);
          this.say(await this.playlistsMessage());
          this.say({ type: "playlist", playlist: created });
          this.playlistResult("create-playlist", created.id, true);
        } catch (err: unknown) {
          this.playlistResult("create-playlist", null, false, `That playlist could not be created: ${message(err)}`);
        }
        return;
      }

      case "rename-playlist":
        await this.editPlaylist("rename-playlist", msg.playlistId, (p) => renamePlaylist(p, msg.name));
        return;

      case "reorder-playlist":
        await this.editPlaylist("reorder-playlist", msg.playlistId, (p) => reorderTracks(p, msg.order));
        return;

      case "remove-track":
        await this.editPlaylist("remove-track", msg.playlistId, (p) => removeTrack(p, msg.path));
        return;

      case "remove-playlist": {
        let removed = false;
        try {
          removed = await this.audio.remove(msg.playlistId);
        } catch (err: unknown) {
          this.playlistResult("remove-playlist", msg.playlistId ?? null, false, `That playlist could not be deleted: ${message(err)}`);
          return;
        }
        // The Worlds naming it are left naming it, deliberately: the reference
        // is the author's, and a World whose playlist has gone is the reported
        // case R15 already describes rather than a manifest to rewrite behind
        // their back.
        if (removed) this.say(await this.playlistsMessage());
        this.playlistResult(
          "remove-playlist",
          msg.playlistId ?? null,
          removed,
          removed ? undefined : "There is no playlist by that name.",
        );
        return;
      }

      default:
        return;
    }
  }

  /**
   * One transport command, and the answer to it.
   *
   * `start-world-playlist` is the one command that reaches past the arming gate
   * (origin R2, AE6): the operator asking for this World's playlist over
   * whatever is playing is asking for the swap. Every other command acts on
   * whatever the transport already holds, whichever World is open — the
   * transport belongs to none of them.
   */
  private async transportCommand(
    command: string,
    positionMs: unknown,
    volume: unknown,
    worldId: unknown,
  ): Promise<void> {
    const action = `audio-transport:${command}`;
    let result;
    if (command === "start-world-playlist") {
      const id = typeof worldId === "string" && worldId.length > 0 ? worldId : this.openId;
      const loaded = id ? this.loaded.get(id) : undefined;
      if (!loaded) {
        this.playlistResult(action, null, false, "That World is not open.");
        return;
      }
      result = await this.transport.startPlaylist(loaded.world.playlistId);
    } else {
      // Built here rather than passed through, so a command name this build does
      // not know is refused by name instead of falling into one it does.
      const cmd = transportCommandFor(command, positionMs, volume);
      if (!cmd) {
        this.playlistResult(action, this.transport.loadedPlaylistId, false, "That is not a transport command.");
        return;
      }
      result = await this.transport.command(cmd);
    }
    this.playlistResult(
      action,
      this.transport.loadedPlaylistId,
      result.ok,
      result.ok ? undefined : result.error,
    );
  }

  private playlistResult(
    action: string,
    playlistId: string | null,
    ok: boolean,
    error?: string,
    notes?: string[],
  ): void {
    this.say({
      type: "playlist-result",
      action,
      playlistId,
      ok,
      ...(error ? { error } : {}),
      ...(notes && notes.length > 0 ? { notes } : {}),
    });
  }

  /**
   * Copy a whole selection into the store and append it to one playlist.
   *
   * One message, one index write, in the order the client sent (origin R12).
   * The copies happen first because `addTracks` refuses a path whose file is
   * not already in the store — the store will not take the server's word for a
   * track existing, which is what keeps origin R11 true.
   *
   * A file that could not be copied does not sink the other nineteen: it is
   * named in `error` while everything that did copy is added, and the
   * `playlist` message that follows is the authority on what actually landed.
   * Refusing the whole commit would have an author with one unreadable file
   * pick the lot again.
   */
  private async importTracks(playlistId: unknown, sourcePaths: unknown): Promise<void> {
    const action = "import-tracks";
    if (typeof playlistId !== "string" || playlistId.length === 0) {
      this.playlistResult(action, null, false, "That message named no playlist.");
      return;
    }
    if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
      this.playlistResult(action, playlistId, false, "That message named no files.");
      return;
    }
    // Checked before a single byte is copied, the way an oversized clip set is:
    // a refusal after the copies would leave files in the store that no
    // playlist names.
    if (sourcePaths.length > MAX_TRACKS_PER_PLAYLIST) {
      this.playlistResult(
        action,
        playlistId,
        false,
        `A playlist holds at most ${MAX_TRACKS_PER_PLAYLIST} tracks.`,
      );
      return;
    }
    // Existence is checked up front for the same reason: copying into the store
    // for a playlist deleted a moment ago leaves orphans behind.
    let target;
    try {
      target = await this.audio.load(playlistId);
    } catch (err: unknown) {
      this.playlistResult(action, playlistId, false, `The audio store could not be read: ${message(err)}`);
      return;
    }
    if (!target) {
      this.playlistResult(action, playlistId, false, "There is no playlist by that name.");
      return;
    }

    const arrivals: PlaylistTrack[] = [];
    const notes: string[] = [];
    const failures: string[] = [];
    for (const source of sourcePaths) {
      const imported = await importTrack(this.audio.tracksDir(), source as string).catch(
        (err: unknown) => ({ ok: false as const, error: message(err) }),
      );
      if (!imported.ok) {
        failures.push(`${path.basename(String(source))}: ${imported.error}`);
        continue;
      }
      arrivals.push(imported.track);
      // A tag that was present and unusable is said out loud rather than
      // dropped (origin R29). The track is imported either way — its tempo is
      // simply not yet known, the third state `bpmOf` exists for, and U8
      // measures it.
      if (imported.ignored) notes.push(`${imported.track.name}: ${imported.ignored}`);
    }

    if (arrivals.length === 0) {
      this.playlistResult(action, playlistId, false, failures.join(" ") || "Nothing could be imported.");
      return;
    }

    let result;
    try {
      result = await this.audio.addTracks(playlistId, arrivals);
    } catch (err: unknown) {
      await this.removeTrackFiles(arrivals);
      this.playlistResult(action, playlistId, false, `That change could not be saved: ${message(err)}`);
      return;
    }
    if (!result.ok) {
      // The playlist can have gone, or filled up, in the time the copies took.
      // Take the files back out rather than leaving some nothing names.
      await this.removeTrackFiles(arrivals);
      this.playlistResult(action, playlistId, false, result.error);
      return;
    }

    this.say({ type: "playlist", playlist: result.playlist });
    this.say(await this.playlistsMessage());
    this.playlistResult(
      action,
      playlistId,
      failures.length === 0,
      failures.length > 0 ? failures.join(" ") : undefined,
      notes,
    );
  }

  /**
   * Take back files copied in but never added to any index.
   *
   * Best effort by design, like `removeClipFile`: failing to tidy up must not
   * become a second error on top of the one being reported. Only the files this
   * import just created are named, so nothing another playlist holds is at
   * risk.
   */
  private async removeTrackFiles(tracks: readonly PlaylistTrack[]): Promise<void> {
    for (const track of tracks) {
      const file = path.join(this.audio.tracksDir(), path.basename(track.path));
      await fsp.rm(file, { force: true }).catch(() => {});
    }
  }

  /**
   * Apply one index edit and broadcast the result — both halves, always.
   *
   * `apply`'s shape for the other store. An edit written to disk and not
   * broadcast is a dead control, and the summaries go out beside the index
   * because a rename and a removal both change what the picker should say.
   */
  private async editPlaylist(
    action: string,
    playlistId: string,
    edit: Parameters<AudioStore["update"]>[1],
  ): Promise<void> {
    if (typeof playlistId !== "string" || playlistId.length === 0) {
      this.playlistResult(action, null, false, "That message named no playlist.");
      return;
    }
    let result;
    try {
      result = await this.audio.update(playlistId, edit);
    } catch (err: unknown) {
      // Without this the rejection reaches the handler's logging `.catch` and
      // the client is told nothing at all — indistinguishable from a hang.
      this.playlistResult(action, playlistId, false, `That change could not be saved: ${message(err)}`);
      return;
    }
    if (!result.ok) {
      this.playlistResult(action, playlistId, false, result.error);
      return;
    }
    this.say({ type: "playlist", playlist: result.playlist });
    this.say(await this.playlistsMessage());
    this.playlistResult(action, playlistId, true);
  }
}

/** The command union for a name off the wire, or null for one this build has no case for. */
function transportCommandFor(
  command: string,
  positionMs: unknown,
  volume: unknown,
): TransportCommand | null {
  switch (command) {
    case "play":
    case "pause":
    case "next":
    case "previous":
    case "stop":
      return { command };
    case "seek":
      return { command, positionMs: positionMs as number };
    case "volume":
      return { command, volume: volume as number };
    default:
      return null;
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
