/**
 * Measure a folder of real music and print what the detector concluded.
 *
 * This script is the acceptance test for origin R31, and it is a script rather
 * than a test on purpose. R31 says a detector may be used **only if** it covers
 * roughly 60–200 BPM and reports which octave it chose, on a library of drum &
 * bass, dub and breaks — and that if no in-process detector clears that bar the
 * feature ships with no detector rather than a wrong one. That is a claim about
 * real recordings, and there is no real music in this repository. A synthetic
 * click track is the easiest signal a beat tracker will ever be handed, so
 * measuring against one measures the generator; see
 * docs/solutions/a-measurement-on-synthetic-variants-measures-your-own-transform.md,
 * which records that exact mistake costing this project a shipped feature.
 *
 * So `server/test/live/tempo.test.ts` tests structure and lifecycle, and this
 * prints the numbers a person compares against tracks whose tempo they already
 * know.
 *
 * Usage:
 *
 *   npx tsx scripts/tempo-report.ts "D:/Music/Drum and Bass"
 *   npx tsx scripts/tempo-report.ts "D:/Music/DnB" --limit 40
 *   npx tsx scripts/tempo-report.ts "D:/Music/DnB" --json > tempo.json
 *
 * It reads only; nothing is copied, imported or written. `--limit` caps how many
 * files are measured (default 50) because a decode is seconds and a library is
 * thousands. Folders are walked recursively.
 *
 * Reading the output: `tracked` is the tempo `music-tempo`'s own beat stream was
 * running at, `bpm` is what reconciliation chose, and `octave` is the second as
 * a multiple of the first — so a row reading `tracked 87.0  bpm 174.1  octave
 * 2.00` is the detector saying out loud that it moved the reading up an octave,
 * which is the reporting R31 asks for. `alt` is the runner-up octave and its
 * weight. **The question to answer is whether the `bpm` column matches the
 * tempo you know each track to be.** If drum & bass lands in the 80s, R31 is not
 * met and the origin document's branch — ship no detector — is the answer.
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import { audioMime } from "../server/src/live/audio.js";
import { readAudioTags } from "../server/src/live/audio-tags.js";
import { measureFile } from "../server/src/live/tempo.js";

const DEFAULT_LIMIT = 50;
/** Deep enough for artist/album, shallow enough not to walk a whole drive. */
const MAX_DEPTH = 6;

interface Row {
  file: string;
  tagBpm: number | null;
  outcome: string;
  bpm: number | null;
  tracked: number | null;
  octave: number | null;
  weight: number | null;
  altBpm: number | null;
  altWeight: number | null;
  intervals: number | null;
  ms: number;
}

async function walk(folder: string, depth: number, into: string[], limit: number): Promise<void> {
  if (depth > MAX_DEPTH || into.length >= limit) return;
  const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (into.length >= limit) return;
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) await walk(full, depth + 1, into, limit);
    // The same gate the browser offers from and the byte route serves by.
    else if (entry.isFile() && audioMime(entry.name)) into.push(full);
  }
}

function num(value: number | null, places = 1): string {
  return value === null ? "—" : value.toFixed(places);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const folder = args.find((arg) => !arg.startsWith("--"));
  const json = args.includes("--json");
  const limitAt = args.indexOf("--limit");
  const asked = limitAt >= 0 ? Number(args[limitAt + 1]) : NaN;
  // An acceptance, so `--limit banana` falls back rather than becoming zero.
  const limit = Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : DEFAULT_LIMIT;

  if (!folder) {
    console.error("Usage: npx tsx scripts/tempo-report.ts <folder> [--limit N] [--json]");
    process.exitCode = 2;
    return;
  }

  const files: string[] = [];
  await walk(path.resolve(folder), 0, files, limit);
  if (files.length === 0) {
    console.error(`No .flac or .mp3 files under ${folder}`);
    process.exitCode = 1;
    return;
  }

  const rows: Row[] = [];
  for (const file of files) {
    const tags = await readAudioTags(file);
    const started = Date.now();
    const measurement = await measureFile(file);
    const ms = Date.now() - started;
    const reading = measurement.outcome === "measured" ? measurement.reading : null;
    const row: Row = {
      file: path.relative(path.resolve(folder), file) || path.basename(file),
      tagBpm: tags.bpm,
      outcome: measurement.outcome,
      bpm: reading?.bpm ?? null,
      tracked: reading?.tracked ?? null,
      octave: reading?.octave ?? null,
      weight: reading?.chosen.weight ?? null,
      altBpm: reading?.alternative?.bpm ?? null,
      altWeight: reading?.alternative?.weight ?? null,
      intervals: reading?.intervals ?? null,
      ms,
    };
    rows.push(row);
    if (!json) {
      console.log(
        [
          row.file.padEnd(46).slice(0, 46),
          `tag ${row.tagBpm === null ? "—" : num(row.tagBpm, 0).padStart(3)}`,
          `tracked ${num(row.tracked).padStart(6)}`,
          `bpm ${num(row.bpm).padStart(6)}`,
          `octave ${num(row.octave, 2).padStart(4)}`,
          `w ${num(row.weight, 2)}`,
          `alt ${num(row.altBpm).padStart(6)} w ${num(row.altWeight, 2)}`,
          `n ${String(row.intervals ?? "—").padStart(4)}`,
          `${row.ms}ms`,
          row.outcome === "measured" ? "" : `[${row.outcome}]`,
        ].join("  "),
      );
    }
  }

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const measured = rows.filter((row) => row.outcome === "measured");
  const flipped = measured.filter((row) => row.octave !== null && Math.abs(row.octave - 1) > 0.01);
  const agreeing = measured.filter(
    (row) => row.tagBpm !== null && row.bpm !== null && Math.abs(row.tagBpm - row.bpm) <= 2,
  );
  const tagged = measured.filter((row) => row.tagBpm !== null);
  console.log("");
  console.log(`${rows.length} files, ${measured.length} measured, ${flipped.length} octave-shifted`);
  // Only ever a partial oracle: most of the library has no tag, which is why
  // origin R30 says detection runs on import for nearly every track.
  console.log(
    `${tagged.length} had a usable BPM tag; ${agreeing.length} of those agree within 2 BPM`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
