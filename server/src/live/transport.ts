// The transport: the clock, the playlist advance, and the readouts they publish.
//
// The server owns the clock for the same reason `WorldRuntime` owns the clip
// clock — a World running unattended must take the same transitions it would
// with a page open (origin R3, AE7). The browser is the loudspeaker, not the
// timing authority: it measures a length the server cannot know and it corrects
// a drift the server cannot see, and both of those arrive as bounded reports
// rather than as commands.
//
// Two rules shape everything below.
//
// **Whole seconds only.** Remaining time is exposed in whole seconds and changes
// once a second (origin R24). The tick runs ten times a second so a boundary is
// crossed within a tenth of the second it names, well inside the quarter-second
// origin R25 asks for, but a readout push only happens when the whole-second
// picture actually changed. Pushing every tick would wake the machine ten times
// a second for nothing, and `setAudio` deliberately does not emit precisely so
// that a soundtrack cannot put a World into permanent transmission (origin R27).
//
// **Absent is a value.** `setAudio` replaces the readout map wholesale, and an
// absent value fails every clause `clauseHolds` evaluates. That is what lets an
// unmeasured BPM and an unmeasured length be *unknown* rather than zero — zero
// satisfies every below-threshold comparison an author is likely to write, which
// is the failure `docs/solutions/a-threshold-guard-written-as-a-negation-fails-open-on-nan.md`
// records and origin R34 names.

import type { ParameterValue, PlaylistTrack, TransportState } from "../../../shared/src/types.js";
import {
  AUDIO_BPM,
  AUDIO_LENGTH,
  AUDIO_PLAYING,
  AUDIO_REMAINING,
  AUDIO_TRACK,
  AUDIO_TRACKS,
  bpmOf,
  idleReadouts,
} from "../../../shared/src/audio.js";
import type { AudioStore } from "../storage/audio.js";
import { setTrackDuration, setTrackUnplayable } from "../storage/audio.js";

/**
 * How often the clock is read.
 *
 * Origin R25 requires a condition on remaining time to be evaluated within a
 * quarter-second of the second it names. Ten times a second leaves that margin
 * intact on a busy event loop, and costs nothing: a tick that changes no
 * whole-second value publishes nothing at all.
 */
export const TRANSPORT_TICK_MS = 100;

/**
 * The shortest track the transport will pace itself against.
 *
 * `MIN_CLIP_MS` in `runtime.ts`, arriving in a second place for the same reason.
 * A playlist index is hand-editable and travels with the store, so a
 * `durationMs` of 1 is reachable — and it would have the transport finish a
 * track, resolve the next one against the filesystem and publish, several times
 * a second, forever. A ceiling is not needed here: a length that is far too long
 * stalls one track rather than spinning.
 */
export const MIN_TRACK_MS = 1_000;

/**
 * How far a client's position report may disagree before it is refused.
 *
 * `reportClipEnd`'s refusal set is the model: a report that does not name what
 * is actually playing is discarded, and one that does is still only allowed to
 * *correct* rather than to drive. An `<audio>` element on loopback runs within a
 * few tens of milliseconds of the server's own clock and reports several times a
 * second, so a client two whole seconds out is not drifting — it is playing
 * something else, or replaying a stale report. Letting that one through would
 * hand the machine's evaluation clock to whichever tab was furthest behind.
 */
export const POSITION_TOLERANCE_MS = 2_000;

/**
 * How far a reported length may differ from the stored one before it is written.
 *
 * `DURATION_TOLERANCE_MS` in `ui/src/components/ClipPlayer.tsx`, and the same
 * number: a decoder's idea of a file's length wobbles in the last few
 * milliseconds between loads, and writing the index on each wobble would be an
 * index write and a broadcast on every play of every track.
 */
export const DURATION_TOLERANCE_MS = 150;

/**
 * The longest a track of unknown length holds the transport.
 *
 * The contract U4 handed down is that `durationMs === 0` means **not known**,
 * and it still holds: a number nobody read out of the file would become this
 * clock. So the transport does not advance against a fabricated length — but it
 * cannot wait forever either, or a World whose lengths are all unknown stops on
 * track one and the readouts never move again.
 *
 * This is now reached far less often than it was. `audio-tags.ts` reads an MP3's
 * length from its own frames at import, so the tracks arriving here unmeasured
 * are the ones whose headers did not parse rather than every MP3 in the library
 * — which is what made a set look stuck for thirty seconds a track. A client
 * also measures at first play and reports, and the number is then persisted in
 * the index. Reaching it advances the
 * playlist and marks nothing: the track is not unplayable, its length is simply
 * still unknown, and calling it unplayable would be inventing a fault out of not
 * knowing — the distinction `server/src/deadline.ts`'s callers already keep.
 */
export const UNMEASURED_GRACE_MS = 30_000;

/**
 * How far past a track's end the clock waits while a client is sounding it.
 *
 * The element is the authority on the end of a track it is actually playing,
 * and the clock is the fallback (`reportEnd`). But the two are not started
 * together: the server anchors the track and the browser only then fetches,
 * decodes and — on the first track — waits for the gesture, so the element is
 * behind the clock by however long that took and the tail of every track was
 * being cut off. This is the margin that lets the element's own `ended` win the
 * race in the ordinary case.
 *
 * Two seconds, because that is `POSITION_TOLERANCE_MS`: a client further behind
 * than that is one whose corrections the transport already refuses, so waiting
 * longer would be waiting on a report that will not be believed. The cost of
 * the wait is at most two seconds of silence at the end of a track whose `ended`
 * never arrives; the cost of not waiting is the last second of every track.
 *
 * **Applied only while a client is sounding.** With nothing attending there is
 * no element to hear from and no report coming, so the clock advances at the
 * total exactly as it always has — a World unattended must take the same
 * transitions at the same moments (origin R25, AE7).
 */
export const CLIENT_END_GRACE_MS = 2_000;

/** The longest length a client may report, so a hostile number cannot stall a track for a week. */
const MAX_TRACK_MS = 6 * 60 * 60 * 1_000;

const NOTHING_LOADED = "The transport is holding no track.";
const NOT_ENABLED = "Sound has not been enabled in the browser yet.";
const NO_TRACKS = "That playlist holds no tracks.";
const NONE_PLAYABLE = "No track in that playlist could be played.";

/**
 * Where the clock comes from.
 *
 * Injected before any behaviour was written, not fitted afterwards.
 * `docs/solutions/test-suite-flakes-under-load.md` records what this suite's
 * fixed sleeps cost, and every boundary assertion this transport owns — the
 * second a readout changes, the moment a track ends — is a question about time
 * that must be answered by advancing a fake clock rather than by waiting.
 */
export interface TransportTime {
  now(): number;
  /** Run `fn` every `ms`, and give back the way to stop it. */
  every(ms: number, fn: () => void): () => void;
}

export const systemTime: TransportTime = {
  now: () => Date.now(),
  every(ms, fn) {
    const timer = setInterval(fn, ms);
    // Unref'd like the runtime's clip wait: a transport left running must not
    // hold the process alive.
    timer.unref?.();
    return () => clearInterval(timer);
  },
};

export interface TransportOptions {
  /**
   * The readouts, whenever their whole-second picture changes.
   *
   * The service hands these to the open World's `setAudio`. Called on a change
   * and never otherwise — a caller that pushed on every tick would be waking the
   * machine ten times a second, which is exactly what the whole-second rule
   * exists to prevent.
   */
  onReadouts(readouts: Record<string, ParameterValue>): void;
  /** Transport state, for its own broadcast. Never `world-live`. */
  onChange(state: TransportState): void;
  time?: TransportTime;
}

/** What a transport command asks for. One closed set, so an agent can enumerate it. */
export type TransportCommand =
  | { command: "play" }
  | { command: "pause" }
  | { command: "next" }
  | { command: "previous" }
  | { command: "stop" }
  | { command: "seek"; positionMs: number }
  | { command: "volume"; volume: number }
  | { command: "attend" }
  | { command: "unattend" }
  | { command: "enable-sound" };

export type TransportResult = { ok: true } | { ok: false; error: string };

/**
 * The one transport.
 *
 * It belongs to no World, exactly as a playlist does. That is the whole of
 * origin R3: a World arms its playlist only into an empty transport, and
 * switching Worlds or stopping one leaves playback alone. A paused track still
 * occupies the transport, so pausing does not open the gate — which is why the
 * gate asks whether a track is *held*, not whether one is sounding.
 */
export class AudioTransport {
  private readonly time: TransportTime;
  private cancel: (() => void) | null = null;

  private playlistId: string | null = null;
  private tracks: PlaylistTrack[] = [];
  /** Which track is held. `-1` is the empty transport, and the only thing the arming gate reads. */
  private index = -1;
  /** Position at the anchor. The live position is this plus elapsed, while sounding. */
  private baseMs = 0;
  private anchorAt = 0;
  private sounding = false;
  private volume = 1;
  private error: string | null = null;
  /**
   * Who is listening, and whether they may.
   *
   * Three states rather than a boolean, because "nobody is attached" and
   * "somebody is attached who has not clicked anything yet" ask for opposite
   * behaviour. Unattended, the transport plays: a World must take the same
   * transitions with every page closed (origin R25), and there is no gesture to
   * wait for. Attended and silent, a playlist armed from here is *held* — the
   * browser would refuse `play()` on an unmuted element anyway, and starting the
   * clock against sound nobody can hear would race the machine through a track
   * the room never heard (origin R5).
   *
   * Only the authority's declaration reaches this. A second tab attending would
   * otherwise gate a transport it is not allowed to sound.
   */
  private attendance: "none" | "silent" | "ready" = "none";
  /**
   * Whether the held track is waiting on a gesture rather than on an operator.
   *
   * The difference between "armed, say the word" and "paused, and the person
   * meant it". Without it the gesture would restart a track somebody had
   * deliberately paused, which is a click doing something nobody asked for.
   */
  private gateHeld = false;
  /**
   * Why the attending client cannot sound (origin R8).
   *
   * Held here rather than on the client so every client sees it — a read-only
   * tab showing a transport that claims to be playing, while the one tab that
   * could hear it has been refused by the browser, is the dishonest reading this
   * field exists to prevent.
   */
  private soundError: string | null = null;
  /**
   * Which advance is in flight.
   *
   * An advance resolves paths against the filesystem, so it spans awaits, and a
   * `next` arriving during one would otherwise land two tracks. The generation
   * discipline `WorldRuntime` uses for a superseded transition, for the same
   * reason.
   */
  private advancing = 0;
  /** How many times a track has been started, ever. Only its changes mean anything. */
  private generation = 0;
  /**
   * How many advances are resolving paths right now.
   *
   * The tick is ten times a second and an advance spans filesystem calls, so
   * without this the ticks that land during one would each start another,
   * superseding it — a track that ended would be re-resolved forever and never
   * begin. A command-driven `next` still supersedes; only the clock defers.
   */
  private settling = 0;

  private lastReadouts = "";
  private lastState = "";

  constructor(
    private readonly store: AudioStore,
    private readonly opts: TransportOptions,
  ) {
    this.time = opts.time ?? systemTime;
    this.anchorAt = this.time.now();
  }

  start(): void {
    if (this.cancel) return;
    this.cancel = this.time.every(TRANSPORT_TICK_MS, () => this.tick());
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }

  /** Which playlist is loaded, for a caller reporting on a command. */
  get loadedPlaylistId(): string | null {
    return this.playlistId;
  }

  /** Whether a track is held — the arming gate, and nothing else reads it. */
  get holdsTrack(): boolean {
    return this.index >= 0;
  }

  /**
   * Arm a World's playlist (origin R3).
   *
   * Refused while a track is held, and that refusal is the requirement rather
   * than a failure: switching to a World with another playlist must leave the
   * one playing alone (AE5). Answers whether it armed, so a caller can say so.
   */
  async arm(playlistId: string | null | undefined): Promise<boolean> {
    if (this.holdsTrack) return false;
    if (typeof playlistId !== "string" || playlistId.length === 0) return false;
    return this.load(playlistId);
  }

  /**
   * Start a playlist over whatever is playing (origin R2, AE6).
   *
   * The one command the arming gate does not apply to: an operator asking for
   * this World's playlist while another is playing is asking for the swap.
   */
  async startPlaylist(playlistId: string | null | undefined): Promise<TransportResult> {
    if (typeof playlistId !== "string" || playlistId.length === 0) {
      return { ok: false, error: "That World names no playlist." };
    }
    const loaded = await this.load(playlistId);
    if (!loaded) return { ok: false, error: this.error ?? NO_TRACKS };
    return { ok: true };
  }

  private async load(playlistId: string): Promise<boolean> {
    const playlist = await this.store.load(playlistId).catch(() => null);
    if (!playlist) {
      // A World naming a playlist the store does not hold runs silently with the
      // readouts at their nothing-playing values (origin R15). Not an error the
      // transport carries: the World's reports already name it, and a transport
      // stuck displaying a fault about a World nobody is in any more is worse.
      this.playlistId = null;
      this.tracks = [];
      this.clearTrack(null);
      return false;
    }
    this.playlistId = playlist.id;
    this.tracks = playlist.tracks;
    this.index = -1;
    if (this.tracks.length === 0) {
      this.clearTrack(NO_TRACKS);
      return false;
    }
    await this.advanceFrom(0, 1);
    return this.holdsTrack;
  }

  async command(cmd: TransportCommand): Promise<TransportResult> {
    switch (cmd.command) {
      case "play":
        if (!this.holdsTrack) return { ok: false, error: NOTHING_LOADED };
        // Refused rather than silently ignored: an attending browser that has
        // had no gesture cannot make a sound, so starting the clock would leave
        // the readouts saying a track is playing that the room cannot hear.
        if (this.attendance === "silent") return { ok: false, error: NOT_ENABLED };
        if (!this.sounding) {
          this.baseMs = this.position();
          this.anchorAt = this.time.now();
          this.sounding = true;
        }
        this.publish(true);
        return { ok: true };

      case "pause":
        if (!this.holdsTrack) return { ok: false, error: NOTHING_LOADED };
        // The position is banked before the flag drops: a pause that left the
        // anchor live would have the track resume wherever the wall clock had
        // got to while nobody was listening.
        this.baseMs = this.position();
        this.sounding = false;
        // A deliberate pause is not an armed playlist: the gesture must not
        // start again what a person just stopped.
        this.gateHeld = false;
        this.publish(true);
        return { ok: true };

      case "next":
      case "previous": {
        if (!this.holdsTrack) return { ok: false, error: NOTHING_LOADED };
        const step = cmd.command === "next" ? 1 : -1;
        await this.advanceFrom(this.index + step, step);
        return this.holdsTrack ? { ok: true } : { ok: false, error: this.error ?? NONE_PLAYABLE };
      }

      case "stop":
        this.playlistId = null;
        this.tracks = [];
        this.clearTrack(null);
        return { ok: true };

      case "seek": {
        if (!this.holdsTrack) return { ok: false, error: NOTHING_LOADED };
        const asked = cmd.positionMs;
        // An acceptance, not a negation: `NaN` and `Infinity` both reach here
        // through `JSON.parse` and both must be refused rather than becoming
        // the clock.
        if (!(typeof asked === "number" && Number.isFinite(asked) && asked >= 0)) {
          return { ok: false, error: "That is not a position." };
        }
        const total = this.totalMs();
        this.baseMs = total > 0 ? Math.min(asked, total) : asked;
        this.anchorAt = this.time.now();
        this.publish(true);
        return { ok: true };
      }

      case "volume": {
        const asked = cmd.volume;
        if (!(typeof asked === "number" && Number.isFinite(asked))) {
          return { ok: false, error: "That is not a volume." };
        }
        this.volume = Math.min(Math.max(asked, 0), 1);
        this.publish(true);
        return { ok: true };
      }

      case "attend":
        this.attend();
        return { ok: true };

      // The loudspeaker has gone while its socket stayed open — a `<audio>`
      // element unmounted by a route or a panel switch. Invisible from here
      // otherwise: only a closing socket used to say it, so the transport went
      // on holding a grace period open for an `ended` nobody would send.
      case "unattend":
        this.release();
        return { ok: true };

      case "enable-sound":
        this.enableSound();
        return { ok: true };

      default:
        return { ok: false, error: "That is not a transport command." };
    }
  }

  /**
   * A loudspeaker is present, and has not been clicked yet (origin R5).
   *
   * Deliberately does not stop anything already sounding. A page opening while a
   * World has been running unattended must not silence the room — the gate is
   * about what *begins* from here on, and the honest report meanwhile is
   * `audible: false`, which is what says the sound is not this browser's.
   */
  attend(): void {
    // The guard is a publish dedupe and nothing more, which is worth saying
    // because it reads like an early return that would keep a stale `ready`.
    // It does not: `attend` from `ready` drops back to `silent`, and that is the
    // requirement rather than an accident. A fresh element has had no gesture
    // whatever the last one had — the browser's activation gate is per element —
    // so a re-announcement that inherited `ready` would be reported audible
    // while it sat silent behind that gate. A stale reading served confidently
    // is the trap `docs/solutions/exclusive-device-one-owner-many-consumers.md`
    // names, and the test named for a fresh element pins this.
    if (this.attendance === "silent") return;
    this.attendance = "silent";
    this.publish(true);
  }

  /** The gesture. What was armed and waiting begins here, and nothing else does. */
  enableSound(): void {
    this.attendance = "ready";
    // A fresh gesture is the client saying it can sound now, so the last
    // attempt's refusal is not news any more.
    this.soundError = null;
    this.resumeIfHeld();
    this.publish(true);
  }

  /**
   * The attending client has gone.
   *
   * The clock keeps running and the readouts keep moving, because a World with
   * no page open takes the same transitions (origin R25) — but `audible` drops,
   * because nothing is making a sound any more. Those two are separately
   * observable on purpose: the failure this shape produces is a stale reading
   * served confidently, and
   * `docs/solutions/exclusive-device-one-owner-many-consumers.md` records it
   * costing a system that captioned a frozen frame as though it were live.
   */
  release(): void {
    this.attendance = "none";
    this.soundError = null;
    // Nothing left to wait for a gesture from. A track armed against a page that
    // has since closed would otherwise sit at zero forever with the readouts
    // frozen beside it.
    this.resumeIfHeld();
    this.publish(true);
  }

  /**
   * The authority reporting that it cannot sound (origin R8).
   *
   * Recorded, not acted on: the clock is the server's, and a browser that cannot
   * decode a file is not a reason for the machine to stop evaluating. `null`
   * clears it.
   */
  reportFailure(error: unknown): void {
    const next =
      typeof error === "string" && error.trim().length > 0 ? error.trim().slice(0, 200) : null;
    if (next === this.soundError) return;
    this.soundError = next;
    this.publish(true);
  }

  private resumeIfHeld(): void {
    if (!this.gateHeld || !this.holdsTrack) return;
    this.gateHeld = false;
    this.anchorAt = this.time.now();
    this.sounding = true;
  }

  /**
   * A client's measurement of a track's real length.
   *
   * `report-clip-duration` and `recordClipDuration` are the pattern, deliberately:
   * the browser measures at first play and reports, and the server stores the
   * number it was given without inspecting any media itself. A length inside the
   * tolerance of what is already stored is a wobble between decodes rather than
   * news, and writing on each of those would be an index write and a broadcast
   * on every play of every track.
   *
   * Answers the playlist to broadcast when the index actually changed.
   */
  async reportDuration(
    playlistId: unknown,
    trackPath: unknown,
    durationMs: unknown,
  ): Promise<TransportResult> {
    if (playlistId !== this.playlistId) return { ok: false, error: "That is not the playlist playing." };
    if (typeof trackPath !== "string") return { ok: false, error: "That message named no track." };
    if (!(typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0 && durationMs <= MAX_TRACK_MS)) {
      return { ok: false, error: "That is not a length." };
    }
    const track = this.tracks.find((t) => t.path === trackPath);
    if (!track) return { ok: false, error: "That track is not in this playlist." };
    if (Math.abs(track.durationMs - durationMs) <= DURATION_TOLERANCE_MS) return { ok: true };

    // Guarded like every other store access in this file, and unlike this one
    // used to be: `writeJsonAtomic` rejects once its rename retries are spent —
    // a full disk, a file something else is holding — and an unguarded `await`
    // inside a handler turns that into an unhandled rejection the reporting
    // client never hears about. The failure becomes the caller's answer instead.
    const result = await this.store
      .update(this.playlistId!, (p) => setTrackDuration(p, trackPath, durationMs))
      .catch((err: unknown) => ({
        ok: false as const,
        error: `That length could not be written: ${err instanceof Error ? err.message : String(err)}`,
      }));
    if (!result.ok) return { ok: false, error: result.error };
    // The in-memory snapshot is replaced from what was written, never patched in
    // place: the index is re-read under its own lock inside `update`, so what
    // landed on disk is the authority on what the transport is now pacing.
    this.adopt(result.playlist.tracks);
    this.publish(true);
    return { ok: true };
  }

  /**
   * A client's position report — a bounded correction, never a command.
   *
   * `reportClipEnd`'s refusal set, applied to a number instead of an event: a
   * report that does not name the playlist and track actually playing is
   * discarded, one arriving while nothing is sounding is discarded, and one
   * disagreeing by more than the tolerance is discarded too. A client slightly
   * ahead resyncs the server; a client wildly out does not get to drive the
   * machine's evaluation clock.
   */
  reportPosition(playlistId: unknown, trackPath: unknown, positionMs: unknown): boolean {
    if (!this.sounding || !this.holdsTrack) return false;
    if (playlistId !== this.playlistId) return false;
    const track = this.current();
    if (!track || track.path !== trackPath) return false;
    if (!(typeof positionMs === "number" && Number.isFinite(positionMs) && positionMs >= 0)) return false;
    const total = this.totalMs();
    if (total > 0 && positionMs > total) return false;
    if (Math.abs(positionMs - this.position()) > POSITION_TOLERANCE_MS) return false;
    this.baseMs = positionMs;
    this.anchorAt = this.time.now();
    this.publish();
    return true;
  }

  /**
   * The sounding client's element has finished the track.
   *
   * `reportPosition`'s refusal set exactly — wrong playlist, wrong track,
   * nothing sounding — because the hazard is the same one: an element that has
   * since been given another source reporting the end of the track before last
   * would skip a track nobody heard. What differs is what an accepted report
   * does. A position is a correction the clock may still overrule; an end is the
   * element saying the music has stopped, and there is nothing left to pace, so
   * it advances at once.
   *
   * Answers whether it was believed, so a caller can tell a refusal from a
   * report about something that is no longer playing.
   */
  async reportEnd(playlistId: unknown, trackPath: unknown): Promise<boolean> {
    if (!this.sounding || !this.holdsTrack) return false;
    if (playlistId !== this.playlistId) return false;
    const track = this.current();
    if (!track || track.path !== trackPath) return false;
    await this.advanceFrom(this.index + 1, 1);
    return true;
  }

  /** What a condition would read right now — what the service seeds a fresh runtime with. */
  readouts(): Record<string, ParameterValue> {
    const track = this.current();
    // Nothing held is the nothing-playing set from `shared/src/audio.ts`, whole:
    // every readout present and every number zero, which is the contract origin
    // R23 states and the reports warn about.
    if (!track) return idleReadouts();

    const out: Record<string, ParameterValue> = {
      [AUDIO_PLAYING]: this.sounding,
      [AUDIO_TRACK]: this.index + 1,
      [AUDIO_TRACKS]: this.tracks.length,
    };
    const total = this.totalMs();
    if (total > 0) {
      out[AUDIO_LENGTH] = Math.round(total / 1_000);
      // Ceiling, so "5" covers the last five seconds rather than the last four:
      // an author writing `remaining lt 6` gets the move with six seconds of
      // music left, which is what they can hear.
      out[AUDIO_REMAINING] = Math.max(0, Math.ceil((total - this.position()) / 1_000));
    }
    // Both left absent while the length is unknown, rather than reported as
    // zero. Absent fails every clause; zero would satisfy every below-threshold
    // one, so an unmeasured MP3 would fire every `remaining` exit in the World
    // the moment it started.
    const bpm = bpmOf(track);
    if (bpm.known) out[AUDIO_BPM] = bpm.bpm;
    // Same rule for tempo, and the one origin R34 states outright.
    return out;
  }

  state(): TransportState {
    const track = this.current();
    const tempo = track ? bpmOf(track) : null;
    return {
      playlistId: this.playlistId,
      generation: this.generation,
      index: this.index,
      path: track?.path ?? null,
      name: track?.name ?? null,
      playing: this.sounding,
      positionMs: Math.round(this.position()),
      // The stored number, not the paced one: a client needs to know the length
      // is still unknown so it can measure and report it.
      durationMs: track?.durationMs ?? 0,
      volume: this.volume,
      tracks: this.tracks.length,
      // Read through `bpmOf` and null for a track nothing has established one
      // for — never `0`, which is the value every below-threshold condition is
      // satisfied by. The readout map leaves the name absent for the same
      // reason, and a client showing the number has to be able to tell "no
      // tempo known" from "no beats".
      bpm: tempo?.known ? tempo.bpm : null,
      // Sounding is the clock; audible is whether a room can hear it. Both are
      // reported, because a client that could only see the first would show a
      // World running unattended as though somebody were listening to it.
      audible: this.attendance === "ready" && this.sounding && this.soundError === null,
      ...(this.error ? { error: this.error } : {}),
      ...(this.soundError ? { soundError: this.soundError } : {}),
    };
  }

  // -------------------------------------------------------------------------

  /**
   * Whether a client is attending, cleared to sound, and not refusing to.
   *
   * `audible`'s two client-side terms, without the `sounding` one: this asks
   * whether an element is expected to report the end of a track, and a client
   * that has told us it was blocked will never send one.
   */
  private soundingClient(): boolean {
    return this.attendance === "ready" && this.soundError === null;
  }

  private current(): PlaylistTrack | null {
    return this.index >= 0 ? (this.tracks[this.index] ?? null) : null;
  }

  /** The length the clock paces against, or 0 for a length nobody has measured. */
  private totalMs(): number {
    const track = this.current();
    if (!track) return 0;
    const stored = track.durationMs;
    if (!(typeof stored === "number" && Number.isFinite(stored) && stored > 0)) return 0;
    return Math.max(stored, MIN_TRACK_MS);
  }

  private position(): number {
    return this.sounding ? this.baseMs + (this.time.now() - this.anchorAt) : this.baseMs;
  }

  private tick(): void {
    if (this.settling > 0) return;
    if (!this.holdsTrack || !this.sounding) {
      this.publish();
      return;
    }
    const total = this.totalMs();
    const at = this.position();
    // The element gets its margin only when there is an element: unattended,
    // this is the same comparison it has always been.
    const end = total + (this.soundingClient() ? CLIENT_END_GRACE_MS : 0);
    if (total > 0 ? at >= end : at >= UNMEASURED_GRACE_MS) {
      void this.advanceFrom(this.index + 1, 1).catch((err: unknown) => {
        console.error(`transport error: ${err instanceof Error ? err.message : String(err)}`);
      });
      return;
    }
    this.publish();
  }

  /**
   * Find the next track that actually resolves, and start it.
   *
   * Bounded to one pass over the playlist, and that bound is the whole guard. A
   * playlist whose files have all gone would otherwise skip forever at
   * filesystem speed — the same unbounded-walk shape
   * `docs/residual-review-findings/feat-live-scene-worlds.md` records under
   * "Nothing enforces a minimum dwell", where a clip that ends instantly walks
   * the machine through the graph at round-trip speed. One pass, then stop and
   * say so.
   *
   * The playlist wraps: a set is a loop, and stopping at the end would take the
   * readouts to their nothing-playing values in the middle of one.
   */
  private async advanceFrom(from: number, step: number): Promise<void> {
    const generation = (this.advancing += 1);
    this.settling += 1;
    try {
      await this.walk(from, step, generation);
    } finally {
      this.settling -= 1;
    }
  }

  private async walk(from: number, step: number, generation: number): Promise<void> {
    const n = this.tracks.length;
    if (n === 0) {
      this.clearTrack(NO_TRACKS);
      return;
    }
    let candidate = from;
    for (let tried = 0; tried < n; tried += 1) {
      const at = ((candidate % n) + n) % n;
      const track = this.tracks[at]!;
      const resolved = await this.store.resolveTrack(track.path).catch(() => ({ ok: false as const }));
      // Superseded while the filesystem answered — a `next` arrived, or the
      // World was stopped. The generation check is what stops two advances both
      // landing a track.
      if (this.advancing !== generation) return;
      if (resolved.ok) {
        // A file that came back is playable again. Recorded, so the state a
        // reader sees is about the store as it is rather than as it once was.
        if (track.unplayable === true) await this.markPlayable(track.path, false);
        if (this.advancing !== generation) return;
        this.begin(at);
        return;
      }
      // The entry stays in the playlist untouched apart from the flag (origin
      // R14): a track that cannot be played is still the author's ordering work.
      await this.markPlayable(track.path, true);
      if (this.advancing !== generation) return;
      candidate += step;
    }
    this.clearTrack(NONE_PLAYABLE);
  }

  private begin(index: number): void {
    this.index = index;
    // Bumped on every start, including a re-start of the track already held.
    // A playlist of one wraps onto itself, so `path` does not change and a
    // client keyed on the file alone has nothing telling it to play again — it
    // sat finished while the clock ran. `LiveState.generation` exists for
    // exactly this and is bumped on each turn of a loop for the same reason.
    this.generation += 1;
    this.baseMs = 0;
    this.anchorAt = this.time.now();
    // Held rather than started when a browser is attending with no gesture yet:
    // origin R5 asks for the playlist to be *armed*, and an armed playlist that
    // advanced would be through its first track before anyone clicked.
    const silent = this.attendance === "silent";
    this.sounding = !silent;
    this.gateHeld = silent;
    this.error = null;
    this.publish(true);
  }

  private clearTrack(error: string | null): void {
    // Bumped so an advance still waiting on the filesystem cannot land a track
    // into a transport that has since been stopped.
    this.advancing += 1;
    this.index = -1;
    this.baseMs = 0;
    this.anchorAt = this.time.now();
    this.sounding = false;
    this.gateHeld = false;
    this.error = error;
    this.publish(true);
  }

  private async markPlayable(trackPath: string, unplayable: boolean): Promise<void> {
    const id = this.playlistId;
    if (!id) return;
    const result = await this.store
      .update(id, (p) => setTrackUnplayable(p, trackPath, unplayable))
      .catch(() => null);
    if (result?.ok) this.adopt(result.playlist.tracks);
  }

  /** Take a freshly written index as the truth, keeping the held track by path. */
  private adopt(tracks: PlaylistTrack[]): void {
    const held = this.current();
    this.tracks = tracks;
    if (!held) return;
    const at = tracks.findIndex((t) => t.path === held.path);
    // A track removed from under the transport leaves the index pointing at
    // whatever slid into its place, which would be a silent swap. Held at -1
    // instead; the next tick has nothing to advance and the readouts go idle.
    this.index = at;
    if (at < 0) this.sounding = false;
  }

  /**
   * Publish what changed, and only what changed.
   *
   * Two comparisons rather than one, because the two consumers are answered on
   * different terms. `onChange` is a broadcast and may be forced by a discrete
   * event — a pause, a seek, a volume — so a client hears about it at once.
   * `onReadouts` is never forced: it wakes the state machine, and a volume
   * change is not something a World evaluates on. That asymmetry is origin R24
   * and R27 in one place, and losing it is how a soundtrack ends up waking the
   * machine ten times a second.
   */
  private publish(force = false): void {
    const readouts = this.readouts();
    const readoutKey = JSON.stringify(readouts);
    if (readoutKey !== this.lastReadouts) {
      this.lastReadouts = readoutKey;
      this.opts.onReadouts(readouts);
    }
    const state = this.state();
    // Sub-second position is deliberately outside the signature: it moves ten
    // times a second and no client displays it, so including it would broadcast
    // the whole transport ten times a second for a number nobody reads.
    const stateKey = JSON.stringify({ ...state, positionMs: Math.floor(state.positionMs / 1_000) });
    if (force || stateKey !== this.lastState) {
      this.lastState = stateKey;
      this.opts.onChange(state);
    }
  }
}
