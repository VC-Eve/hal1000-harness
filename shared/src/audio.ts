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
