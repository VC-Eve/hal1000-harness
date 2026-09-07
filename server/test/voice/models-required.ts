// Loud skips for the suites that need the real 353MB Kokoro files.
//
// `recogniser/test/models-required.ts`'s shape and for its reason: the danger is
// not a suite that skips, it is a suite that reports success while having
// verified nothing. Every skip here prints what was skipped and how to make it
// run.
//
// These files are fetched on first use rather than committed, so a clean
// checkout genuinely cannot run these suites. Point `HAL_VOICE_MODELS_DIR` at a
// directory that already holds them — a machine with the sibling ComfyUI project
// has a copy — or start HAL once with network access and let it fetch.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe } from "vitest";
import { KOKORO_MODEL, KOKORO_VOICES, modelPath, modelReady } from "../../src/voice/models.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The fixtures the oracle recorded. Committed, so always present. */
export const FIXTURES = path.join(HERE, "fixtures");

/**
 * Where the tests look for the models.
 *
 * The same variable that points a running HAL at an existing copy points the
 * suite at one too. The fallback is a repo-local dot-directory rather than the
 * data dir, so a checkout can hold its own copy without a test reaching into the
 * user's real HAL data — `recogniser/test/models-required.ts`'s shape. Read
 * directly rather than through `voiceModelsDir`, which appends its own segment
 * to a data dir and would double it here.
 */
export const MODELS_DIR =
  process.env.HAL_VOICE_MODELS_DIR ?? path.join(HERE, "..", "..", "..", ".voice-models");

export const VOICES_READY = modelReady(MODELS_DIR, KOKORO_VOICES);
export const MODEL_READY = modelReady(MODELS_DIR, KOKORO_MODEL);

export const VOICES_PATH = modelPath(MODELS_DIR, KOKORO_VOICES);
export const MODEL_PATH = modelPath(MODELS_DIR, KOKORO_MODEL);

const HOW = `Set HAL_VOICE_MODELS_DIR to a directory holding them, or start HAL once with network access to fetch them. Looked in: ${MODELS_DIR}`;

export const NO_VOICES = `${KOKORO_VOICES.file} is missing or does not match its recorded digest. ${HOW}`;
export const NO_MODEL = `${KOKORO_MODEL.file} is missing or does not match its recorded digest. ${HOW}`;

function announce(what: string, why: string): void {
  console.warn(`\n  SKIPPED: ${what}\n  reason:  ${why}\n`);
}

/** `describe` that skips loudly with a stated reason. */
export function describeWhen(ready: boolean, reason: string, name: string, body: () => void): void {
  if (ready) {
    describe(name, body);
    return;
  }
  announce(name, reason);
  describe.skip(name, body);
}
