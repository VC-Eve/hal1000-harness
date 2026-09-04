// The reserved audio readouts: what a World can condition on without declaring
// anything.
//
// One registration point, like `shared/src/effects.ts`, so the condition picker,
// the Effect target rule, the reports, the store's drop rule and the runtime all
// learn a new readout from the same edit. The alternative — six names written out
// at each of those sites — is the shape
// docs/solutions/extending-a-catalogue-is-not-auditing-it.md is about.

import type { ParameterType, ParameterValue } from "./worlds.js";

/**
 * The prefix that makes a name the machine's rather than the author's.
 *
 * A qualifier rather than a collision rule. Reserved names are a set that grows:
 * a seventh readout added later must not silently take a name some existing World
 * already chose, and the only way to promise that is to own a namespace up front
 * rather than to arbitrate case by case.
 *
 * The dot is doing real work. It reads as a namespace, it groups the readouts
 * together wherever names are sorted, and no Parameter written before this
 * existed can contain one — the panel has always offered a free-text name, but a
 * dotted name has never meant anything, so nothing is being taken away.
 */
export const AUDIO_QUALIFIER = "audio.";

export const AUDIO_PLAYING = "audio.playing";
export const AUDIO_BPM = "audio.bpm";
export const AUDIO_REMAINING = "audio.remaining";
export const AUDIO_LENGTH = "audio.length";
export const AUDIO_TRACK = "audio.track";
export const AUDIO_TRACKS = "audio.tracks";

/** One readout: what it is called, what it holds, and what it reads while silent. */
export interface AudioReadout {
  name: string;
  type: ParameterType;
  /**
   * The value while nothing is playing.
   *
   * Zero for every number, and that is a trap the reports exist to cover: zero is
   * the *smallest* value, so `audio.remaining lt 5` is satisfied by silence. A
   * sentinel maximum would dodge it for `lt` and re-create it for `gt`, so the
   * honest fix is not a magic number but telling the author that a numeric
   * condition without an `audio.playing` clause holds while nothing plays.
   */
  idle: ParameterValue;
}

export const AUDIO_READOUTS: readonly AudioReadout[] = [
  { name: AUDIO_PLAYING, type: "bool", idle: false },
  { name: AUDIO_BPM, type: "float", idle: 0 },
  { name: AUDIO_REMAINING, type: "int", idle: 0 },
  { name: AUDIO_LENGTH, type: "int", idle: 0 },
  { name: AUDIO_TRACK, type: "int", idle: 0 },
  { name: AUDIO_TRACKS, type: "int", idle: 0 },
];

const BY_NAME = new Map(AUDIO_READOUTS.map((readout) => [readout.name, readout]));

/**
 * Whether a name belongs to the machine.
 *
 * Tests the qualifier, not the six known names. A manifest declaring
 * `audio.tempo` is claiming a name this build has not defined *yet*, and letting
 * it through would make the seventh readout a breaking change for exactly the
 * World that guessed its name.
 */
export function isReservedName(name: unknown): boolean {
  return typeof name === "string" && name.startsWith(AUDIO_QUALIFIER);
}

/** The readout by that name, or undefined for a name outside the set. */
export function readoutFor(name: string): AudioReadout | undefined {
  return BY_NAME.get(name);
}

/**
 * What the readouts hold while nothing is playing.
 *
 * A fresh object per call: this becomes the runtime's readout map, and a shared
 * one would let two Worlds write each other's values.
 */
export function idleReadouts(): Record<string, ParameterValue> {
  const out: Record<string, ParameterValue> = {};
  for (const readout of AUDIO_READOUTS) out[readout.name] = readout.idle;
  return out;
}

// ---------------------------------------------------------------------------
// Playlists
//
// The shape on disk in the shared audio store, and the shape on the wire. Here
// rather than in `worlds.ts` because a playlist belongs to no World: several may
// name the same one, and deleting a World takes none of it (R13).
// ---------------------------------------------------------------------------

/**
 * The tempo range a BPM value must fall in to mean anything (origin R31).
 *
 * The band the detector this feature is built on covers, and the band a hand
 * edit and a file's own tag are held to as well — a tag is no more trustworthy
 * than a detector. Bounds here rather than at each of the three entry points,
 * because three copies is how a tag ends up accepted at a value an edit refuses.
 */
export const MIN_BPM = 60;
export const MAX_BPM = 200;

/** Where a track's BPM came from. Absent means nobody has established one yet. */
export type BpmSource = "measured" | "set";

/**
 * One track in a playlist.
 *
 * `path` is relative to the audio store and written with forward slashes: the
 * index travels between machines exactly as a World manifest does, and a
 * backslash written on Windows is not a separator anywhere else.
 */
export interface PlaylistTrack {
  path: string;
  /** What to show. The filename it was imported under, until someone renames it. */
  name: string;
  durationMs: number;
  /**
   * The tempo, when one is established.
   *
   * Absent or null means **not yet known**, which is a third state and not a
   * value — never `0`, and never `NaN`. Zero satisfies every below-threshold
   * comparison an author writes, and `typeof NaN === "number"` so nothing
   * downstream would object to it either; see
   * docs/solutions/a-threshold-guard-written-as-a-negation-fails-open-on-nan.md
   * and origin R34. Read it through `bpmOf` rather than directly.
   */
  bpm?: number | null;
  /** Which of the two known states `bpm` is in. Meaningless while `bpm` is unset. */
  bpmSource?: BpmSource;
  /**
   * Set when the track is known not to play — its file has gone, or no decoder
   * will take it. The entry stays in the playlist untouched (R14): a track that
   * cannot be played is still the author's ordering work.
   */
  unplayable?: boolean;
}

/** A named, saved, ordered list of tracks (R9). Its id is a filename in the store. */
export interface Playlist {
  id: string;
  name: string;
  tracks: PlaylistTrack[];
}

/** What a picker lists, without reading every index whole. */
export interface PlaylistSummary {
  id: string;
  name: string;
  tracks: number;
}

/** A track's tempo, or that nobody has established one. */
export type BpmState = { known: false } | { known: true; bpm: number; source: BpmSource };

/**
 * A number that may be used as a tempo, or null.
 *
 * Written as an acceptance — `x >= lo && x <= hi`, negated once around the
 * whole thing — rather than as `x < lo || x > hi`. The negation form is
 * satisfied by nothing and so lets `NaN` and `Infinity` straight through, which
 * is the failure
 * docs/solutions/a-threshold-guard-written-as-a-negation-fails-open-on-nan.md
 * records. `JSON.parse` produces both: a hand-edited `1e999` is `Infinity`.
 */
export function usableBpm(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!(Number.isFinite(value) && value >= MIN_BPM && value <= MAX_BPM)) return null;
  return value;
}

/**
 * What is known about a track's tempo.
 *
 * The one place `bpm` is read, so a stored `0`, a stored string and a stored
 * `Infinity` all resolve to "not yet known" wherever the question is asked
 * rather than at whichever call site remembered to check.
 */
export function bpmOf(track: PlaylistTrack | null | undefined): BpmState {
  const bpm = usableBpm(track?.bpm);
  if (bpm === null) return { known: false };
  return { known: true, bpm, source: track?.bpmSource === "set" ? "set" : "measured" };
}
