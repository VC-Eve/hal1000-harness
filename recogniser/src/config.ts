// How the sidecar is configured. Everything has a default that works on a
// fresh clone, because R34's "ordinary npm install" would be a hollow claim if
// the process then refused to start without being told five things.

import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_PORT = 8100;

// The captioner sits on 8099. Adjacent rather than arbitrary, so the two local
// model servers HAL points at read as a pair.
export const CAPTIONER_PORT_FOR_REFERENCE = 8099;

export interface RecogniserConfig {
  host: string;
  port: number;
  modelsDir: string;
  // Minimum YuNet score for a candidate to count as a face. 0.6 is what the
  // spike used; the face it found scored 0.93, so this clears comfortably.
  detectionThreshold: number;
  // Greedy NMS overlap above which two candidates are the same face.
  nmsThreshold: number;
  // Largest frame body accepted, before decoding. A 640x480 JPEG is tens of
  // kilobytes; this is generous enough for a 4K still and small enough that a
  // hostile body cannot exhaust memory ahead of the JPEG header being read.
  maxFrameBytes: number;
  // Requests already waiting on the single-flight lock before a new one is
  // refused outright. See `pipeline.ts` for why inference is serialised.
  maxWaiting: number;
  // Whether to attempt the one-time SFace download. Off in tests that must not
  // touch the network.
  fetchModels: boolean;
}

// A non-loopback bind is deliberately not reachable by typing a host string
// into one variable. `server/src/ws.ts` binds 127.0.0.1 only and AGENTS.md
// calls that a hard rule; the recogniser is a second endpoint carrying whole
// camera frames, so the default cannot be allowed to drift by accident.
const LOOPBACK = "127.0.0.1";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RecogniserConfig {
  const wantsExposure = env.HAL_RECOGNISER_ALLOW_REMOTE === "1";
  const host = wantsExposure ? (env.HAL_RECOGNISER_HOST ?? "0.0.0.0") : LOOPBACK;

  return {
    host,
    port: intFrom(env.HAL_RECOGNISER_PORT, DEFAULT_PORT),
    modelsDir: env.HAL_RECOGNISER_MODELS_DIR ?? path.join(HERE, "..", "models"),
    detectionThreshold: floatFrom(env.HAL_RECOGNISER_DETECTION_THRESHOLD, 0.6),
    nmsThreshold: floatFrom(env.HAL_RECOGNISER_NMS_THRESHOLD, 0.3),
    maxFrameBytes: intFrom(env.HAL_RECOGNISER_MAX_FRAME_BYTES, 16 * 1024 * 1024),
    maxWaiting: intFrom(env.HAL_RECOGNISER_MAX_WAITING, 4),
    fetchModels: env.HAL_RECOGNISER_FETCH_MODELS !== "0",
  };
}

function intFrom(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function floatFrom(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}
