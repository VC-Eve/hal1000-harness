import path from "node:path";
import os from "node:os";
import { promises as fsp } from "node:fs";
import type { WebSocket } from "ws";
import type {
  ClientMessage,
  ParameterValue,
  Playlist,
  PlaylistImpact,
  PlaylistTrack,
  ServerMessage,
  World,
} from "../../../shared/src/types.js";
import { MAX_BPM, MIN_BPM, usableBpm } from "../../../shared/src/audio.js";
import {
  AudioStore,
  MAX_TRACKS_PER_PLAYLIST,
  removeTrack,
  renamePlaylist,
  reorderTracks,
  setTrackBpm,
} from "../storage/audio.js";
import { importTrack, listAudioFolder } from "./audio-library.js";
import { TempoDetector, detectionEnabled } from "./tempo.js";
import { AudioTransport, systemTime, type TransportCommand, type TransportTime } from "./transport.js";

/** Said to a client that is showing the transport rather than sounding it. */
const NOT_AUTHORITY = "Another client is the audio authority.";

/**
 * What this service needs of the hub. `WorldHub` — and so `WsHub` — satisfies it.
 *
 * Narrower than `WorldHub` on purpose: this service registers no handler and no
 * greeter of its own. `WorldService` owns the wiring and calls in, because the
 * greeting is one ordered sequence and two independent greeters would interleave
 * it differently on every connection — an order a test pins today.
 */
export interface AudioHub {
  broadcast(msg: ServerMessage): void;
  sendTo(client: WebSocket, msg: ServerMessage): void;
}

/**
 * The three things the audio side has to ask of the World side.
 *
 * The seam is drawn here rather than by handing this service the World store,
 * because these are the only World-shaped questions the transport and the
 * playlist editor ask, and each has an answer only the World side can give:
 * which World is open and what playlist it names (a transport command), where
 * the readouts go (the running machine), and what an edit just cost (the graph,
 * over every manifest on disk). Anything wider and this service would be able to
 * mutate manifests, which is the thing the split exists to prevent.
 */
export interface WorldSide {
  /**
   * The World open now, or the one named if it is open. Null for anything else.
   *
   * `start-world-playlist` is the only transport command that asks — every other
   * one acts on whatever the transport already holds, whichever World is open,
   * because the transport belongs to none of them.
   */
  openWorld(worldId?: unknown): World | null;
  /** Hand the readouts to the machine that is running, if one is. */
  setReadouts(readouts: Record<string, ParameterValue>): void;
  /**
   * What an edit to this playlist costs the Worlds that play it, or null when
   * the manifests could not be read to find out.
   *
   * Null rather than an empty list on failure: an impact list assembled from
   * half the Worlds is a claim nobody could act on, and reporting *no* impact
   * because the store was unreadable is a guardrail that quietly stopped.
   */
  playlistImpacts(action: string, playlist: Playlist): Promise<PlaylistImpact[] | null>;
}

/**
 * Tracks, playlists and the transport on the protocol.
 *
 * Split out of `WorldService`, which this feature had taken past a thousand
 * lines and fifteen new `case` branches. The split follows the one this same
 * feature already made once: the transport *clock* went into `transport.ts` and
 * `WorldService` delegated to it, while the fifteen messages that drive that
 * clock stayed behind in the switch. This is the second half of that move.
 *
 * The line is the store. Everything here reads or writes the **audio** store —
 * `audio/` beside `worlds/`, its own confinement and its own lock — and nothing
 * here can reach a manifest. `set-world-playlist` is the case that proves the
 * rule and is *not* here: it is a World-manifest edit that happens to name a
 * playlist, so it goes through `WorldService.apply` like every other manifest
 * edit and then calls `arm` on the way out. Moving it because its name contains
 * "playlist" would have put a manifest write on this side of the line.
 *
 * The **audio authority** moved with the transport rather than staying with the
 * greeting. All five inbound messages it gates are audio ones, the grant rides
 * on the transport's own greeting, and nothing on the World side ever asks who
 * holds it — an election left behind would have been a field in one class
 * checked only by another.
 */
export class AudioService {
  /**
   * The transport: one clock, no World.
   *
   * Held here rather than by a runtime, which is origin R3 expressed as a
   * field. A transport owned by a World would stop when that World did, and
   * switching Worlds would take the music with it.
   */
  private readonly transport: AudioTransport;

  /**
   * Tempo detection, running behind every import.
   *
   * Held here rather than created per import so its concurrency bound means
   * something: two imports of twenty tracks each must be forty queued jobs
   * against one ceiling, not two pools of two (origin R30, R33).
   */
  private readonly tempo: TempoDetector;

  /**
   * The one client that may drive the transport and make a sound (origin R6).
   *
   * A socket rather than a flag on a socket: identity is the check, and a
   * property on an object handed to a client is a property a client could set —
   * the reasoning `WsHub`'s admitted set already records.
   */
  private authority: WebSocket | null = null;

  /**
   * Every admitted socket, in arrival order, so the authority can pass on.
   *
   * This service keeps its own list rather than asking the hub for one: the
   * hub's clients are whoever is connected, and what matters here is whoever was
   * *greeted*, which is the admitted set the token gate produces.
   */
  private readonly attending: WebSocket[] = [];

  /**
   * Where track browsing last was, this session.
   *
   * A separate field from the clip library's, not a shared one: a clip library
   * and a music library are two places on the drive, and pointing the track
   * browser somewhere must not move the clip browser with it.
   *
   * Held for the session only, where the clip root is also written to disk.
   * Persisting it belongs to the audio store — `last-library.json` lives under
   * `worlds/` and is the World store's file — and that is a store change this
   * unit does not make. `HAL_AUDIO_LIBRARY` covers the first run, which is the
   * case the home directory answers worst.
   */
  private audioRoot: string | null = null;

  /** Silent once stopped, exactly as `WorldService` is, and for the same reason. */
  private stopped = false;

  constructor(
    private readonly hub: AudioHub,
    private readonly store: AudioStore,
    private readonly world: WorldSide,
    time: TransportTime = systemTime,
  ) {
    this.transport = new AudioTransport(store, {
      // Into the open World's readout map, and nowhere else. `setAudio` replaces
      // it wholesale and deliberately does not emit, so this is a wake at most
      // once a second rather than a broadcast.
      onReadouts: (readouts) => this.world.setReadouts(readouts),
      // Its own message, never `world-live`: that one carries whole machine
      // state, and a readout changing once a second must not put the machine
      // into permanent transmission (origin R27).
      onChange: (transport) => this.say({ type: "audio-transport-state", transport }),
      time,
    });
    this.tempo = new TempoDetector(store, {
      // Off until the operator turns it on. The detector is built and tested;
      // what has not happened is the measurement R31 makes the condition of
      // using it, and a plausible wrong tempo is worse than none.
      enabled: detectionEnabled(),
      // Only a job that actually wrote something is worth saying anything
      // about. A measurement abandoned because its playlist was deleted, or a
      // decode that ran past its deadline, changed no index — broadcasting one
      // would have every client redraw a playlist that did not move.
      onResult: (result) => {
        if (result.playlist) this.say({ type: "playlist", playlist: result.playlist });
      },
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle, and what the World side calls in for
  // -------------------------------------------------------------------------

  start(): void {
    this.transport.start();
  }

  stop(): void {
    this.stopped = true;
    this.transport.stop();
  }

  /** What is playing now, for a World that has just opened onto it. */
  readouts(): Record<string, ParameterValue> {
    return this.transport.readouts();
  }

  /**
   * Arm a playlist behind whatever is playing.
   *
   * Fire and forget with the mandatory `.catch`, because both callers — opening
   * a World and pointing one at a playlist — have already answered the client
   * by the time this runs. The transport refuses this while it holds a track,
   * and that refusal is origin R3 rather than a failure.
   */
  arm(playlistId: string | null | undefined): void {
    void this.transport.arm(playlistId).catch((err: unknown) => {
      console.error(`transport arm error: ${message(err)}`);
    });
  }

  /**
   * The ids the store holds, or null when it could not say.
   *
   * Null rather than an empty list on failure, because the World reports read
   * this to decide whether a World's playlist reference is dangling: an
   * unreadable store directory would otherwise report every World's playlist as
   * missing, which is a fault invented out of not knowing.
   */
  async playlistIds(): Promise<string[] | null> {
    return this.store.ids().catch(() => null);
  }

  /**
   * The audio half of the greeting, in its order.
   *
   * Called from the middle of `WorldService.greet` rather than from a greeter of
   * its own: the order of a connection's first four messages is a fact clients
   * and a test both depend on, and two independent greeters would decide it by
   * whichever awaited fewer times.
   */
  async greet(client: WebSocket): Promise<void> {
    if (this.stopped) return;
    // The playlist list is greeted like the World list: a client that reconnects
    // mid-set must not have to ask before it can show what the store holds.
    this.hub.sendTo(client, { type: "playlists", playlists: await this.store.list() });
    if (this.stopped) return;
    // The transport's own greeting, beside `world-live` rather than inside it. A
    // client that connects mid-track has to be told what is playing, and the
    // only place that is said is this message (origin R27).
    this.hub.sendTo(client, { type: "audio-transport-state", transport: this.transport.state() });
    // And whether this socket is the one allowed to sound it. Part of the
    // greeting rather than something a client asks for: a connect-time replay is
    // a push by another name, and a client told nothing would have to guess —
    // which, for a grant, means two tabs both guessing yes.
    this.tell(client, this.authority === client);
  }

  // -------------------------------------------------------------------------
  // The audio authority (origin R6)
  //
  // One owner, many consumers — the shape
  // `docs/solutions/exclusive-device-one-owner-many-consumers.md` names, and its
  // four traps are what these three methods and `commands` are written against.
  // -------------------------------------------------------------------------

  /**
   * A socket was admitted. It takes the authority only if nobody holds it.
   *
   * `announce` is false on the connection path because the greeting says it a
   * moment later, in its proper order — a grant sent ahead of the World list
   * would have the first thing a client ever hears be about a transport it has
   * not been told exists.
   */
  attend(client: WebSocket, announce: boolean): void {
    if (!this.attending.includes(client)) this.attending.push(client);
    this.elect(announce);
  }

  /**
   * A socket has gone.
   *
   * The authority leaving stops the *sound* and passes the grant on; it does not
   * stop the clock, because a World with no page open takes the same transitions
   * it would with one (origin R25). Those are two separate states in
   * `AudioTransport` for exactly this moment.
   */
  leave(client: WebSocket): void {
    const at = this.attending.indexOf(client);
    if (at >= 0) this.attending.splice(at, 1);
    if (this.authority !== client) return;
    this.authority = null;
    this.transport.release();
    this.elect(true);
  }

  /**
   * Grant the authority if it is going spare.
   *
   * An authority already in place is left alone — a client that is still
   * connected is not re-elected, and nothing here runs on a timer that could
   * cancel what it is supervising. The grant is told to the socket that got it
   * and to nobody else: it is the one fact about the transport that differs per
   * client. Nothing is told it *lost* the grant, because the only way to lose
   * one today is to disconnect — a client that could lose it while still
   * connected would need `tell(client, false)` here, which is why `tell` takes
   * the boolean rather than assuming it.
   */
  private elect(announce: boolean): void {
    if (this.authority) return;
    const next = this.attending[0];
    if (!next) return;
    this.authority = next;
    if (announce) this.tell(next, true);
  }

  private tell(client: WebSocket, authority: boolean): void {
    if (this.stopped) return;
    this.hub.sendTo(client, { type: "audio-authority", authority });
  }

  /**
   * Whether this socket may drive the transport.
   *
   * The election is checked on the *inbound* command and not only on the
   * outbound state, because a gate that checks one direction is half a gate
   * (`docs/solutions/a-gate-that-checks-one-direction-is-half-a-gate.md`): a
   * client rendering the transport read-only would otherwise still be able to
   * drive the thing it is only supposed to display.
   *
   * With nobody holding it, the asking socket takes it. That is not a hole — the
   * socket is admitted, so it holds this boot's token — and it is what keeps an
   * agent able to work the transport with no browser open at all, which the
   * agent-native parity rule requires.
   */
  private commands(client: WebSocket | undefined): boolean {
    if (!client) return true;
    if (this.authority === client) return true;
    if (this.authority) return false;
    // Nothing follows this to say so, unlike the connection path, so the grant
    // is announced here.
    this.attend(client, true);
    return this.authority === client;
  }

  // -------------------------------------------------------------------------
  // The protocol
  // -------------------------------------------------------------------------

  /** Every outbound message goes through here, so stopping silences all of them. */
  private say(msg: ServerMessage): void {
    if (this.stopped) return;
    this.hub.broadcast(msg);
  }

  /**
   * Handle one message, if it is one of this service's.
   *
   * Reached from `WorldService`'s own `default`, so the two switches together
   * are one switch: a name neither has a case for falls out of both, exactly as
   * it fell out of the single one.
   */
  async handle(msg: ClientMessage, client?: WebSocket): Promise<void> {
    switch (msg.type) {
      case "audio-transport":
        if (!this.commands(client)) {
          this.playlistResult(
            `audio-transport:${msg.command}`,
            this.transport.loadedPlaylistId,
            false,
            NOT_AUTHORITY,
          );
          return;
        }
        await this.transportCommand(msg.command, msg.positionMs, msg.volume, msg.worldId);
        return;

      case "report-track-duration": {
        // From the authority alone. A client that is not sounding the track has
        // not measured it either, so a length from anywhere else is a claim
        // about a file this client never decoded.
        if (client && this.authority !== client) {
          this.playlistResult("report-track-duration", null, false, NOT_AUTHORITY);
          return;
        }
        // Measured by the browser at first play, exactly as a clip's is: the
        // byte route serves only tracks a playlist already names, so nothing
        // here can probe a file at import time.
        const result = await this.transport.reportDuration(msg.playlistId, msg.path, msg.durationMs);
        if (result.ok) {
          const playlist = await this.store.load(msg.playlistId).catch(() => null);
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
        // The superseded owner must not act, and this is the handler where that
        // is easiest to forget: a tab that lost the authority keeps its element
        // running for a beat and keeps reporting. Refused here, or the machine's
        // evaluation clock is driven by whichever tab is no longer playing.
        if (client && this.authority !== client) return;
        // Never an error worth reporting, like `report-clip-end`: a stale or
        // out-of-tolerance report is the routine case the refusal set exists to
        // make identifiable, not a fault to broadcast several times a second.
        this.transport.reportPosition(msg.playlistId, msg.path, msg.positionMs);
        return;

      case "report-track-end":
        // The same gate the position report has, and for the sharper version of
        // the same reason: a superseded tab's element keeps running for a beat
        // and its `ended` would advance a playlist somebody else is sounding.
        if (client && this.authority !== client) return;
        // Never an error worth reporting, like `report-clip-end`: a report that
        // names a track the transport has already left is the routine case the
        // refusal set exists to identify, not a fault to broadcast.
        await this.transport.reportEnd(msg.playlistId, msg.path);
        return;

      case "report-audio-failure":
        // Same rule (origin R8): only the client that is supposed to be making
        // the sound gets to say it cannot. A losing tab's blocked `play()` would
        // otherwise put a fault on every client's transport.
        if (client && this.authority !== client) return;
        this.transport.reportFailure(msg.error);
        return;

      case "browse-audio": {
        const folder =
          typeof msg.path === "string" && msg.path.length > 0 ? msg.path : this.startingFolder();
        // The filter goes to the server because the cap is here: filtered in
        // the client it could only ever narrow what the cap had already let
        // through, which left everything past it unreachable.
        const listing = await listAudioFolder(folder, msg.filter);
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

      case "list-playlists": {
        try {
          this.say(await this.playlistsMessage());
          // One index whole only when it was asked for. A listing is a name and
          // a count; sending every track of every playlist to answer "what is
          // there" is the broadcast volume the World list avoids the same way.
          if (typeof msg.playlistId === "string") {
            const playlist = await this.store.load(msg.playlistId);
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
          const created = await this.store.create(name);
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

      case "reorder-playlist": {
        const after = await this.editPlaylist("reorder-playlist", msg.playlistId, (p) =>
          reorderTracks(p, msg.order),
        );
        if (after) await this.reportPlaylistImpact("reorder-playlist", after);
        return;
      }

      case "remove-track": {
        const after = await this.editPlaylist("remove-track", msg.playlistId, (p) =>
          removeTrack(p, msg.path),
        );
        if (after) await this.reportPlaylistImpact("remove-track", after);
        return;
      }

      case "set-track-bpm": {
        // Refused rather than clamped, and refused here as well as in the field
        // that offered it (origin R32): the pane is one caller among others, and
        // an agent sending 740 must be told the same thing the field says. A
        // clamp would pace a World against a tempo nobody chose.
        if (msg.bpm !== null && usableBpm(msg.bpm) === null) {
          this.playlistResult(
            "set-track-bpm",
            msg.playlistId ?? null,
            false,
            `A tempo has to be between ${MIN_BPM} and ${MAX_BPM} BPM. That one is not.`,
          );
          return;
        }
        // `set`, so the playlist can say the value is the author's — and so a
        // detection landing later does not quietly overwrite it.
        await this.editPlaylist("set-track-bpm", msg.playlistId, (p) =>
          setTrackBpm(p, msg.path, msg.bpm, "set"),
        );
        return;
      }

      case "remove-playlist": {
        let removed = false;
        try {
          removed = await this.store.remove(msg.playlistId);
        } catch (err: unknown) {
          this.playlistResult("remove-playlist", msg.playlistId ?? null, false, `That playlist could not be deleted: ${message(err)}`);
          return;
        }
        // The Worlds naming it are left naming it, deliberately: the reference
        // is the author's, and a World whose playlist has gone is the reported
        // case R15 already describes rather than a manifest to rewrite behind
        // their back.
        if (removed) this.say(await this.playlistsMessage());
        // Detection queued for it has nowhere to write any more. The generation
        // bump is what stops a decode already in flight from taking the deleted
        // playlist's write lock on its way back.
        if (removed) this.tempo.forget(msg.playlistId);
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

  /** Where track browsing opens when no folder is named. */
  private startingFolder(): string {
    if (this.audioRoot !== null) return this.audioRoot;
    const configured = process.env.HAL_AUDIO_LIBRARY?.trim();
    return configured && configured.length > 0 ? configured : os.homedir();
  }

  private async playlistsMessage(): Promise<ServerMessage> {
    return { type: "playlists", playlists: await this.store.list() };
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
      const world = this.world.openWorld(worldId);
      if (!world) {
        this.playlistResult(action, null, false, "That World is not open.");
        return;
      }
      result = await this.transport.startPlaylist(world.playlistId);
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
      target = await this.store.load(playlistId);
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
      const imported = await importTrack(this.store.tracksDir(), source as string).catch(
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
      result = await this.store.addTracks(playlistId, arrivals);
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
    // **After** the index is written and broadcast, never before (origin R33).
    // Every arrival is already in the playlist, playable and orderable; a tempo
    // lands later on its own `playlist` message, or never.
    this.tempo.measureAll(playlistId, arrivals);
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
      const file = path.join(this.store.tracksDir(), path.basename(track.path));
      await fsp.rm(file, { force: true }).catch(() => {});
    }
  }

  /**
   * Apply one index edit and broadcast the result — both halves, always.
   *
   * `WorldService.apply`'s shape for the other store. An edit written to disk
   * and not broadcast is a dead control, and the summaries go out beside the
   * index because a rename and a removal both change what the picker should say.
   */
  private async editPlaylist(
    action: string,
    playlistId: string,
    edit: Parameters<AudioStore["update"]>[1],
  ): Promise<Playlist | null> {
    if (typeof playlistId !== "string" || playlistId.length === 0) {
      this.playlistResult(action, null, false, "That message named no playlist.");
      return null;
    }
    let result;
    try {
      result = await this.store.update(playlistId, edit);
    } catch (err: unknown) {
      // Without this the rejection reaches the handler's logging `.catch` and
      // the client is told nothing at all — indistinguishable from a hang.
      this.playlistResult(action, playlistId, false, `That change could not be saved: ${message(err)}`);
      return null;
    }
    if (!result.ok) {
      this.playlistResult(action, playlistId, false, result.error);
      return null;
    }
    this.say({ type: "playlist", playlist: result.playlist });
    this.say(await this.playlistsMessage());
    this.playlistResult(action, playlistId, true);
    return result.playlist;
  }

  /**
   * What an edit to a playlist just cost the Worlds that play it (origin R17).
   *
   * Said at the moment of the edit, to everyone, rather than left to each
   * World's own reports. A report inside World B is true and arrives when B is
   * next opened, which during a set is long after the removal that stranded its
   * conditions — R17 exists because that is too late to be a guardrail.
   *
   * The answer comes from the World side, because it is a question about
   * manifests and this service cannot reach one. Sent even when it is empty,
   * because an empty answer is the one that clears the previous edit's warning
   * — and not sent at all when the World side could not find out, because a
   * silent absence is honest where a half-assembled list is not.
   */
  private async reportPlaylistImpact(action: string, playlist: Playlist): Promise<void> {
    const impacts = await this.world.playlistImpacts(action, playlist);
    if (!impacts) return;
    this.say({ type: "playlist-impact", playlistId: playlist.id, action, impacts });
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
    // The three the browser says about itself. They go through the same closed
    // map as the rest so a name this build does not know is still refused by
    // name rather than falling into one it does.
    case "attend":
    case "unattend":
    case "enable-sound":
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
