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
export function modelReady(dir: string, spec: ModelSpec): boolean {
  try {
    const file = modelPath(dir, spec);
    if (fs.statSync(file).size !== spec.bytes) return false;
    return matchesSpec(fs.readFileSync(file), spec);
  } catch {
    return false;
  }
}
