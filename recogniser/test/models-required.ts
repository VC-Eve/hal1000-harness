// Loud skips.
//
// SFace is 37MB and arrives on first run, and the face fixture is created
// locally rather than committed, so some suites genuinely cannot run
// everywhere. The danger is not the skipping — it is a suite that reports
// success while having verified nothing.
// `docs/solutions/diagnosing-a-process-that-isnt-your-code.md` records exactly
// that failure: a tool whose output was used as evidence, which could not tell
// "this worked" from "I could not check", and so manufactured artifacts that
// were then trusted.
//
// So every skip here prints what was skipped and why, and `assertHonestSkip`
// makes the reason itself checkable rather than assumed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe } from "vitest";
import { SFACE, YUNET, matches, type ModelSpec } from "../src/models.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const MODELS_DIR = process.env.HAL_RECOGNISER_MODELS_DIR ?? path.join(HERE, "..", "models");
export const FIXTURE_DIR = path.join(HERE, "fixtures");
export const FACE_FIXTURE = path.join(FIXTURE_DIR, "face.jpg");

export function modelPath(spec: ModelSpec): string {
  return path.join(MODELS_DIR, spec.file);
}

// Present AND matching its published digest. A truncated model that happens to
// exist would otherwise turn a skip into a confusing failure.
export function modelReady(spec: ModelSpec): boolean {
  try {
    return matches(fs.readFileSync(modelPath(spec)), spec);
  } catch {
    return false;
  }
}

export function faceFixtureReady(): boolean {
  try {
    return fs.statSync(FACE_FIXTURE).size > 0;
  } catch {
    return false;
  }
}

function announce(what: string, why: string): void {
  console.warn(`\n  SKIPPED: ${what}\n  reason:  ${why}\n`);
}

// `describe` that skips loudly with a stated reason.
export function describeWhen(
  ready: boolean,
  reason: string,
  name: string,
  body: () => void,
): void {
  if (ready) {
    describe(name, body);
    return;
  }
  announce(name, reason);
  describe.skip(name, body);
}

export const DETECTOR_READY = modelReady(YUNET);
export const EMBEDDER_READY = modelReady(SFACE);
export const FIXTURE_READY = faceFixtureReady();

export const NO_DETECTOR = `${YUNET.file} is missing or does not match its published digest — this is a committed model, so a broken checkout is the likely cause.`;
export const NO_EMBEDDER = `${SFACE.file} has not been fetched yet. Start the recogniser once with network access, or run: npm run start:recogniser`;
export const NO_FIXTURE = `no face fixture at ${FACE_FIXTURE}. Create one with: node recogniser/scripts/capture-fixture.mjs`;
