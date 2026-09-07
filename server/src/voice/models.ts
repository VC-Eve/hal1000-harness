// Where the synthesiser's two files live, and what they must be.
//
// Kokoro is ~353MB across a graph and a voice pack. They are not committed and
// not vendored: they are fetched once, verified, and left in the data dir beside
// `worlds/` and `audio/` — the shape `recogniser/src/models.ts` already
// established for SFace, where a fetch that fails leaves the service reporting
// what is unavailable rather than refusing to boot.
//
// **On the digests.** These were computed from the files the voice oracle in
// `server/test/voice/fixtures/` was recorded against, not taken from a digest
// published by the upstream release. That is a weaker claim than it looks and is
// worth stating plainly: it establishes "these are the bytes that produced the
// oracle", which is what makes a fixture failure meaningful, and it establishes
// that a download arrived intact. It does **not** establish provenance — if the
// upstream release were replaced, a first fetch would fail the check rather than
// silently install different weights, but the check cannot tell a replaced
// release from a corrupted transfer. Replace these with upstream-published
// digests if that project ever starts publishing them.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export interface ModelSpec {
  file: string;
  /** sha256, lowercase hex. See the note above on what this does and does not prove. */
  sha256: string;
  bytes: number;
  url: string;
  /** For messages: what a person would call it. */
  label: string;
}

const RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0";

export const KOKORO_MODEL: ModelSpec = {
  file: "kokoro-v1.0.onnx",
  sha256: "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
  bytes: 325_532_387,
  url: `${RELEASE}/kokoro-v1.0.onnx`,
  label: "the Kokoro voice model",
};

export const KOKORO_VOICES: ModelSpec = {
  file: "voices-v1.0.bin",
  sha256: "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
  bytes: 28_214_398,
  url: `${RELEASE}/voices-v1.0.bin`,
  label: "the Kokoro voice pack",
};

export const VOICE_MODELS = [KOKORO_MODEL, KOKORO_VOICES] as const;

/**
 * Where the two files live.
 *
 * `HAL_VOICE_MODELS_DIR` points elsewhere — which is how a machine that already
 * holds a copy (this one does, in a sibling project) can be used without a
 * second 353MB download, and how the tests reach real files.
 */
export function voiceModelsDir(dataDir: string): string {
  return process.env.HAL_VOICE_MODELS_DIR ?? path.join(dataDir, "voice-models");
}

export function modelPath(dir: string, spec: ModelSpec): string {
  return path.join(dir, spec.file);
}

/**
 * Whether a file on disk is the one this spec names.
 *
 * Length first, because it is free and a truncated download is the common case;
 * the digest then decides. Both must hold — a file of the right length with the
 * wrong contents is exactly what a digest is for.
 */
export function matchesSpec(bytes: Uint8Array, spec: ModelSpec): boolean {
  if (bytes.byteLength !== spec.bytes) return false;
  return createHash("sha256").update(bytes).digest("hex") === spec.sha256;
}

/** Whether both files are present and correct, without reading them into memory twice. */
const verified = new Map<string, { size: number; mtimeMs: number }>();

export function modelReady(dir: string, spec: ModelSpec): boolean {
  try {
    const file = modelPath(dir, spec);
    const stat = fs.statSync(file);
    if (stat.size !== spec.bytes) return false;

    // The digest is computed once per file and then remembered against its size
    // and mtime. It has to be: this runs on the path of *every* spoken line as
    // well as every readiness probe, and hashing 353MB blocks the event loop for
    // ~260ms — measured — in a process that is also running a live state
    // machine's timers and an audio transport clock. Paying it per line would
    // stall the picture inside the adjust-hear-adjust loop the feature exists for.
    //
    // The security property survives. A digest here catches a bad download, not
    // a file being swapped underneath a running process: a replacement has a
    // different size or mtime and is hashed again, and anything able to write a
    // byte-identical-sized file with a preserved mtime can already edit this
    // process's code.
    const seen = verified.get(file);
    if (seen && seen.size === stat.size && seen.mtimeMs === stat.mtimeMs) return true;

    if (!matchesSpec(fs.readFileSync(file), spec)) return false;
    verified.set(file, { size: stat.size, mtimeMs: stat.mtimeMs });
    return true;
  } catch {
    return false;
  }
}

/** Forget what has been verified — after a fetch replaces a file, and in tests. */
export function forgetVerified(): void {
  verified.clear();
}

/**
 * What to tell the user about the synthesiser's files.
 *
 * Deliberately about the files rather than about the thread: the thread starts
 * on the first line spoken, so "not started" is the normal state for a session
 * that has not spoken and would be a misleading thing to report as unready.
 *
 * `fetching` exists because a first run and a broken install are otherwise
 * indistinguishable from outside, and they call for opposite responses — wait,
 * or go and read a log.
 */
export type VoiceReadiness = "ok" | "fetching" | "unavailable" | "disabled";

/**
 * Which directories have a fetch running, so the leg can say so.
 *
 * Keyed by directory rather than one process-wide flag: `voiceReadiness(dir)`
 * and `ensureModels(dir)` both take one, so a single boolean meant a fetch into
 * one directory reported "fetching" for a readiness check about another. Rare in
 * production — there is one models directory — but the flag and the argument
 * disagreeing is the kind of thing that reads as correct until a test sets
 * `HAL_VOICE_MODELS_DIR` and it does not.
 */
const fetchingDirs = new Set<string>();

export function voiceReadiness(dir: string): VoiceReadiness {
  if (VOICE_MODELS.every((spec) => modelReady(dir, spec))) return "ok";
  return fetchingDirs.has(dir) ? "fetching" : "unavailable";
}

/**
 * Fetch whatever is missing, once, verifying as it goes.
 *
 * Streamed to the temp file while the digest is computed incrementally, rather
 * than `recogniser/src/models.ts`'s whole-body `arrayBuffer()`. That one is
 * sized for a 37MB model; at 353MB it would hold the body and its copy in HAL's
 * heap at once, and its 300s timeout would abort any connection slower than
 * about 1.2MB/s. There is no timeout here for that reason — a slow link is not
 * a failure — and the unique-temp-then-rename discipline is
 * `storage/atomic.ts`'s.
 *
 * Never throws. A failure leaves the service reporting `unavailable` with a
 * reason, the way the recogniser's failed fetch leaves it detecting but not
 * matching, because refusing to boot over a missing optional feature is worse
 * than saying what is missing.
 */
export async function ensureModels(
  dir: string,
  // The spec list, injected only so a test can drive this against a local
  // server with a body it controls. Production always uses the default: a
  // parameter is a smaller seam than exporting `fetchOne` and testing a copy of
  // its logic, which proves nothing about the code that runs.
  specs: readonly ModelSpec[] = VOICE_MODELS,
): Promise<VoiceReadiness> {
  if (specs.every((spec) => modelReady(dir, spec))) return "ok";
  if (process.env.HAL_VOICE_FETCH_MODELS === "0") return "unavailable";
  if (fetchingDirs.has(dir)) return "fetching";

  fetchingDirs.add(dir);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    for (const spec of specs) {
      if (modelReady(dir, spec)) continue;
      await fetchOne(dir, spec);
    }
  } catch {
    // Reported through the leg, not thrown. See the note above.
  } finally {
    fetchingDirs.delete(dir);
    // A fetch replaces files, so anything remembered about them is stale.
    forgetVerified();
  }
  return specs.every((spec) => modelReady(dir, spec)) ? "ok" : "unavailable";
}

async function fetchOne(dir: string, spec: ModelSpec): Promise<void> {
  const target = modelPath(dir, spec);
  const temp = `${target}.${process.pid}.${Date.now()}.part`;
  const response = await fetch(spec.url);
  if (!response.ok || !response.body) throw new Error(`${spec.file}: HTTP ${response.status}`);

  try {
    const hash = createHash("sha256");
    let bytes = 0;
    const handle = await fs.promises.open(temp, "w");
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        // Bounded as it arrives rather than only at the end: a body that keeps
        // coming would otherwise fill the disk before anything checked a length.
        if (bytes > spec.bytes) throw new Error(`${spec.file}: longer than its recorded size`);
        hash.update(chunk);
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }

    // Length and digest both, before the file is given its real name. A partial
    // download that happened to hash to something is not a thing, but a partial
    // download that is simply short is the common case and is cheaper to catch.
    if (bytes !== spec.bytes || hash.digest("hex") !== spec.sha256) {
      throw new Error(`${spec.file}: did not match its recorded digest`);
    }
    await fs.promises.rename(temp, target);
  } catch (err) {
    // Every failing exit takes the part file with it. Only the digest-mismatch
    // path used to, so a mid-stream abort left up to 325MB behind.
    await fs.promises.rm(temp, { force: true });
    throw err;
  }
}
