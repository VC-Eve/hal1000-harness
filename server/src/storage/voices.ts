// The voice preset store: `voices.json` in the data dir.
//
// One small file rather than a directory of them. A preset is four fields and
// there will be a handful, so the per-file shape `playlists/` uses would buy
// nothing and cost a directory walk on every list.
//
// Presets are **global, not per World**. A World names a playlist and carries
// overlay slots, so a voice looks like it belongs there too; it does not. A
// preset is the character's voice, and the character is HAL rather than a show.
// Keeping them in one store also keeps the editor reachable from `/live`
// whatever World is open.
//
// Three hazards this store shares with `WorldStore` and `AudioStore`, and
// answers the same way. It is rebuilt by **spreading what was parsed** rather
// than by naming every field, because a key the file carries and a literal
// forgets is deleted on the next write — silently, permanently, and legally as
// far as the compiler is concerned. It is written through `writeJsonAtomic`. And
// every mutation is serialized, so two saves cannot interleave a read-modify-
// write over one file.

import path from "node:path";
import { promises as fs } from "node:fs";
import {
  cleanId,
  cleanLabel,
  cleanMix,
  cleanPreset,
  unknownVoices,
  usableSpeed,
  type VoicePreset,
} from "../../../shared/src/voices.js";
import { readJson, writeJsonAtomic } from "./atomic.js";

const FILE = "voices.json";

/**
 * How many presets one install may hold.
 *
 * Not a technical limit. A picker is unusable long before this and a bound stops
 * a hand-written or agent-written file making the editor unreachable.
 */
export const MAX_PRESETS = 100;

/**
 * The preset that ships (R6).
 *
 * Resolved at read time rather than written to disk on first boot, the shape
 * `shared/src/prompts.ts` uses for shipped defaults: a release that changes it
 * then reaches anyone who never edited it, and an install that has never opened
 * the editor still has a usable picker.
 *
 * The blend is two male voices at a 60/40 weighting, slightly under normal
 * speed. It is a starting point chosen to be plausibly HAL rather than a claim
 * about what HAL sounds like — that is what the editor is for, and the first
 * real use of the editor is expected to replace it.
 */
export const SHIPPED_PRESET: VoicePreset = {
  id: "hal",
  label: "HAL",
  mix: [
    { voice: "am_michael", weight: 0.6 },
    { voice: "bm_george", weight: 0.4 },
  ],
  speed: 0.95,
};

export type PresetResult = { ok: true; preset: VoicePreset } | { ok: false; error: string };

export class VoiceStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {}

  private get file(): string {
    return path.join(this.dir, FILE);
  }

  /**
   * Every preset, the shipped one first.
   *
   * A stored preset with the shipped id replaces it rather than sitting beside
   * it — the operator has edited the default, and showing both would offer two
   * entries with one name.
   */
  async list(): Promise<VoicePreset[]> {
    const stored = await this.read();
    const overridden = stored.some((preset) => preset.id === SHIPPED_PRESET.id);
    return overridden ? stored : [SHIPPED_PRESET, ...stored];
  }

  async get(id: string): Promise<VoicePreset | null> {
    const wanted = cleanId(id);
    if (wanted === undefined) return null;
    return (await this.list()).find((preset) => preset.id === wanted) ?? null;
  }

  /**
   * Save a preset, refusing what cannot be rendered.
   *
   * `available` is the voice pack's names. Validation needs them, so a save
   * cannot be accepted while the pack is unreadable: an unvalidatable preset in
   * the store is one that fails at the moment it is spoken, which is the worst
   * time to find out (R5).
   */
  save(input: unknown, available: readonly string[] | null): Promise<PresetResult> {
    return this.serialize(async () => {
      if (available === null) {
        return { ok: false, error: "The voice pack is not readable, so a preset cannot be checked." };
      }

      const preset = cleanPreset(input);
      if (!preset) return { ok: false, error: describeWhy(input) };

      const missing = unknownVoices(preset.mix, available);
      if (missing.length > 0) {
        // Named rather than counted: the operator picked these from a list, so
        // being told which one is unknown is the difference between a fix and a
        // guess.
        return {
          ok: false,
          error: `This voice pack has no ${missing.length === 1 ? "voice" : "voices"} called ${missing.join(", ")}.`,
        };
      }

      const stored = await this.read();
      const existing = stored.findIndex((candidate) => candidate.id === preset.id);
      if (existing < 0 && stored.length >= MAX_PRESETS) {
        return { ok: false, error: `There is room for ${MAX_PRESETS} voices and they are all used.` };
      }

      const next = [...stored];
      if (existing >= 0) next[existing] = preset;
      else next.push(preset);
      await this.write(next);
      return { ok: true, preset };
    });
  }

  /**
   * Remove a preset.
   *
   * Deleting the shipped preset's override restores the shipped one rather than
   * leaving a hole, which is what makes the override reversible.
   */
  remove(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.serialize(async () => {
      const wanted = cleanId(id);
      if (wanted === undefined) return { ok: false, error: "There is no voice by that name." };
      const stored = await this.read();
      const next = stored.filter((preset) => preset.id !== wanted);
      if (next.length === stored.length) return { ok: false, error: "There is no voice by that name." };
      await this.write(next);
      return { ok: true };
    });
  }

  /**
   * What is on disk, with anything unreadable dropped.
   *
   * Lenient on load and strict on write, with `cleanPreset` as the filter
   * between them: a file edited by hand into a shape the types cannot express
   * must not take the whole store down, and must not survive the next write
   * either. See
   * `docs/solutions/a-lenient-load-and-a-strict-write-need-a-filter-between-them.md`.
   */
  private async read(): Promise<VoicePreset[]> {
    const parsed = await readJson<unknown>(this.file);
    if (!Array.isArray(parsed)) return [];
    const out: VoicePreset[] = [];
    const seen = new Set<string>();
    for (const entry of parsed) {
      // Spread first, then re-add what has a default. Naming every field here
      // would delete any key the file carries that this build does not know.
      const preset = cleanPreset(entry);
      if (!preset || seen.has(preset.id)) continue;
      seen.add(preset.id);
      out.push({ ...(entry as object), ...preset });
    }
    return out.slice(0, MAX_PRESETS);
  }

  private async write(presets: VoicePreset[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await writeJsonAtomic(this.file, presets);
  }

  /** Every mutation in order, so two saves cannot interleave a read and a write. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * Why a preset was refused, in the operator's terms.
 *
 * `cleanPreset` answers null for any of four reasons and a single "that is not a
 * voice" would leave the editor unable to say what to change. Re-derived here
 * rather than returned from the guard, so the guard stays a predicate.
 */
function describeWhy(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "That is not a voice.";
  }
  const raw = input as Record<string, unknown>;
  if (cleanLabel(raw.label) === undefined) return "A voice needs a name.";
  if (cleanId(raw.id) === undefined) return "That name cannot be used as an identifier.";
  if (cleanMix(raw.mix) === null) {
    return "A voice needs at least one stock voice in its mix, with a weight above zero and no repeats.";
  }
  if (usableSpeed(raw.speed) === null) return "Speed must be between 0.5 and 2.";
  return "That is not a voice.";
}
