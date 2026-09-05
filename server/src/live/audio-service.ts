import path from "node:path";
import os from "node:os";
import { promises as fsp } from "node:fs";
import type { WebSocket } from "ws";
import type {
  AudioTransportMessage,
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
  setPlaylistHeader,
  setTrackDescription,
  reorderTracks,
  setPlaylistShuffle,
  setTrackBpm,
} from "../storage/audio.js";
import { importTrack, listAudioFolder } from "./audio-library.js";
import { TempoDetector, detectionEnabled } from "./tempo.js";
import { AudioTransport, systemTime, type TransportCommand, type TransportTime } from "./transport.js";

/** Said to a client that is showing the transport rather than sounding it. */
const NOT_AUTHORITY = "Another client is the audio authority.";

/** The result action a take answers on, so a pane and an agent read one name. */
const TAKE_ACTION = "take-audio-authority";

/** Said to a caller with no socket, which is nothing the grant can be held by. */
const NO_SOCKET = "The audio authority is held by a connection, and this message arrived on none.";
const OBSERVER_REFUSED = "This connection only watches, so it cannot hold the audio authority.";

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
  /**
   * Whether this socket has declared that it only watches.
   *
   * Asked rather than tracked here because the World side needs the same
   * answer for the clip reports, and two services holding two copies of one
   * fact is how they come to disagree.
   */
  isObserver(client: WebSocket | undefined): boolean;
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
        if (result.playlist) this.announcePlaylist(result.playlist);
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
    // The gate is here, at the place a socket becomes a candidate, rather than
    // in `elect()` where it picks between them.
    //
    // Guarding the election alone was this feature's first design and it was a
    // hole, because nothing that hands out the grant consults `elect` first.
    // Two things reach it: this method, and `takeAuthority`, which pushes onto
    // `attending` itself and so carries its own check. `commands` looked like a
    // third, but it grants by calling straight back into here — so it needs no
    // check of its own, and was given one and then had it removed when no test
    // could be made to fail without it.
    //
    // See `docs/solutions/a-gate-that-checks-one-direction-is-half-a-gate.md`.
    if (this.hub.isObserver(client)) return;
    if (!this.attending.includes(client)) this.attending.push(client);
    this.elect(announce);
  }

  /**
   * A socket has declared that it only watches.
   *
   * If it is holding the grant when it says so, this is the same event as it
   * disconnecting as far as the transport is concerned — the sound is no
   * longer anybody's — so it takes the same path, and the clock keeps running
   * either way (origin R25).
   */
  observed(client: WebSocket): void {
    // Told, unlike the other two ways of losing the grant.
    //
    // `leave` says nothing to the socket it removes, and is right not to: it
    // runs on a close, where there is nobody to tell. `takeAuthority` says it
    // itself. This is the third way, and the only one where the loser is still
    // connected and still rendering a transport it has just stopped owning —
    // so without this it would sit there showing controls it can no longer
    // drive. The release inside `leave` happens first, so `audible` has already
    // dropped by the time anything is told.
    const held = this.authority === client;
    this.leave(client);
    if (held) this.tell(client, false);
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
   * Take the grant from whoever holds it (origin R6).
   *
   * The election could only ever *release* — on a disconnect — so a tab left
   * open in another window held the loudspeaker and every other client rendered
   * the transport read-only with nothing to do about it. From the operator's
   * side that is indistinguishable from the buttons being dead, which is the
   * report this whole round of fixes started from.
   *
   * Nothing arbitrates and nobody is asked. This is one person's machine and the
   * taker is the person at it; a grant that could be refused by an unattended
   * tab would be the same dead end with an extra step.
   *
   * The order of the three lines below is the whole of the superseded-owner
   * trap: the transport is released *before* the old holder is told anything, so
   * `audible` has already dropped and the clock has already stopped waiting on
   * an element that is about to stop reporting. Every report that tab has in
   * flight is refused from the moment `authority` moves, by the checks the
   * position, end and failure handlers already carry.
   */
  private takeAuthority(client: WebSocket | undefined): void {
    // No socket, nothing to grant. An agent has one — every message arrives on
    // a socket the token gate admitted — so this is the internal-call case
    // rather than the agent one, and refusing it by name beats silently
    // leaving the grant where it was.
    if (!client) {
      this.playlistResult(TAKE_ACTION, this.transport.loadedPlaylistId, false, NO_SOCKET);
      return;
    }
    // Refused by name rather than ignored. This is the second door to the
    // grant: it assigns `authority` directly and never asks `elect`, so a gate
    // that lived only there would leave the whole restriction one message wide.
    if (this.hub.isObserver(client)) {
      this.playlistResult(TAKE_ACTION, this.transport.loadedPlaylistId, false, OBSERVER_REFUSED);
      return;
    }
    if (!this.attending.includes(client)) this.attending.push(client);
    const previous = this.authority;
    if (previous === client) {
      // Already holds it. Said again rather than ignored: a client asking has a
      // read-only pane on screen, and silence would leave it there.
      this.tell(client, true);
      this.playlistResult(TAKE_ACTION, this.transport.loadedPlaylistId, true);
      return;
    }
    this.authority = client;
    // The loudspeaker that was is no longer attending anything. The clock keeps
    // running, exactly as it does when the holder disconnects (origin R25); what
    // stops is the claim that a room can hear it.
    if (previous) this.transport.release();
    if (previous) this.tell(previous, false);
    this.tell(client, true);
    this.playlistResult(TAKE_ACTION, this.transport.loadedPlaylistId, true);
  }

  /**
   * Grant the authority if it is going spare.
   *
   * An authority already in place is left alone — a client that is still
   * connected is not re-elected, and nothing here runs on a timer that could
   * cancel what it is supervising. The grant is told to the socket that got it
   * and to nobody else: it is the one fact about the transport that differs per
   * client. Nothing is told it *lost* the grant here, because the two ways of
   * losing one both say so themselves: a disconnected socket is told nothing
   * because there is nobody to tell, and a socket superseded by `takeAuthority`
   * is told `false` there, at the moment it happens. `tell` takes the boolean
   * rather than assuming it for that second case.
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
        await this.transportCommand(msg);
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
          if (playlist) this.announcePlaylist(playlist);
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

      case "take-audio-authority":
        this.takeAuthority(client);
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
            this.announcePlaylist(playlist);
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
          this.announcePlaylist(created);
          this.playlistResult("create-playlist", created.id, true);
        } catch (err: unknown) {
          this.playlistResult("create-playlist", null, false, `That playlist could not be created: ${message(err)}`);
        }
        return;
      }

      case "rename-playlist":
        await this.editPlaylist("rename-playlist", msg.playlistId, (p) => renamePlaylist(p, msg.name));
        return;

      // The overlay's words on the playlist side. No impact report: a description
      // makes nothing unsatisfiable and moves no position. The transport learns
      // through `announcePlaylist` like every other edit, and re-publishes its
      // state with the new words for every window, observers included.
      case "set-playlist-header":
        await this.editPlaylist("set-playlist-header", msg.playlistId, (p) =>
          setPlaylistHeader(p, msg.header),
        );
        return;

      case "set-track-description":
        await this.editPlaylist("set-track-description", msg.playlistId, (p) =>
          setTrackDescription(p, msg.path, msg.description),
        );
        return;

      case "reorder-playlist": {
        const after = await this.editPlaylist("reorder-playlist", msg.playlistId, (p) =>
          reorderTracks(p, msg.order),
        );
        if (after) await this.reportPlaylistImpact("reorder-playlist", after);
        return;
      }

      case "set-playlist-shuffle": {
        // The reorder's twin: it makes nothing unsatisfiable and changes what
        // every position-naming condition points at, so it asks the Worlds the
        // reorder question rather than the removal one.
        const after = await this.editPlaylist("set-playlist-shuffle", msg.playlistId, (p) =>
          setPlaylistShuffle(p, msg.shuffle),
        );
        if (after) await this.reportPlaylistImpact("set-playlist-shuffle", after);
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
        // Read before it is gone: the impact report is a question about *this*
        // playlist — which Worlds play it, and which of their conditions name a
        // position in it — and the store cannot answer it a moment later.
        const doomed = await this.store.load(msg.playlistId).catch(() => null);
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
        // What the deletion cost, on the same channel a track removal reports
        // on (origin R17). `missingPlaylist` already covers the after-state and
        // arrives when each affected World is next opened — during a set, hours
        // after the deletion. This is the same edit-time guardrail, and it is
        // told with no tracks left because that is what the Worlds are now
        // playing against: every position condition they hold is unreachable.
        if (removed && doomed) {
          await this.reportPlaylistImpact("remove-playlist", { ...doomed, tracks: [] });
        }
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
  private async transportCommand(msg: AudioTransportMessage): Promise<void> {
    const command = msg.command;
    const action = `audio-transport:${command}`;
    let result;
    if (command === "start-world-playlist") {
      const world = this.world.openWorld(msg.worldId);
      if (!world) {
        this.playlistResult(action, null, false, "That World is not open.");
        return;
      }
      result = await this.transport.startPlaylist(world.playlistId);
    } else {
      // Built here rather than passed through, so a command name this build does
      // not know is refused by name instead of falling into one it does.
      const cmd = transportCommandFor(msg);
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


  /**
   * Tell everyone a playlist changed — the transport first, then the clients.
   *
   * One place, because the transport holding a stale copy of the set it is
   * playing is invisible from the outside: the editor shows the new tracks, the
   * player loops the old ones, and refreshing the page cannot help because the
   * stale copy is on the server. Every broadcast of an index goes through here
   * so the seventh one cannot forget.
   */
  private announcePlaylist(playlist: Playlist): void {
    this.transport.refreshed(playlist);
    this.say({ type: "playlist", playlist });
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

    this.announcePlaylist(result.playlist);
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
    this.announcePlaylist(result.playlist);
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
function transportCommandFor(msg: AudioTransportMessage): TransportCommand | null {
  const command = msg.command;
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
      return { command, positionMs: msg.positionMs as number };
    case "volume":
      return { command, volume: msg.volume as number };
    // The one command carrying what it names rather than only an intent. Both
    // fields are required rather than defaulted: a `play-track` with neither is
    // a message this build cannot honour, and refusing it by name here is what
    // keeps the closed map closed.
    case "play-track":
      if (typeof msg.playlistId !== "string" || typeof msg.path !== "string") return null;
      return { command, playlistId: msg.playlistId, path: msg.path };
    default:
      return null;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
