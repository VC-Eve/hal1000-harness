// decode -> detect -> warp -> embed, and nothing else.
//
// The two properties that matter here are both absences. Nothing is kept
// between calls: no cache keyed on frame content, no last-seen face, no
// rolling state of any kind. That is A3's "it tracks nothing between calls",
// and it is what lets R5 put appearance continuity in HAL rather than letting
// the sidecar quietly make that decision instead. And nothing is written to
// disk: a face that walks past leaves no trace here, which is the half of R29
// this process is responsible for.
//
// Inference is serialised. A face costs about 7.5ms against a cadence measured
// in seconds, so there is no throughput problem to solve, and serialising
// keeps ORT's CPU work from fanning out across concurrent requests to contend
// with chat and narration on the same machine.

import { Detector, type DetectedFace } from "./detect.js";
import { Embedder, EMBEDDING_DIMS } from "./embed.js";
import { decodeJpeg, type Frame } from "./frame.js";
import { ModelStore, SFACE, YUNET, type ModelState } from "./models.js";
import type { RecogniserConfig } from "./config.js";
import { warpToTemplate } from "./warp.js";

export interface FaceResult {
  box: { x: number; y: number; w: number; h: number };
  score: number;
  landmarks: { x: number; y: number }[];
  // Null when SFace is unavailable. Detection is the half that still works,
  // and R35's failure path is a reported state rather than a dead endpoint.
  embedding: number[] | null;
  // How well the landmarks fit the canonical template, in template pixels.
  // Exposed because a high residual means the alignment was poor and the
  // embedding is correspondingly less trustworthy — the caller deciding a
  // match deserves to see that rather than infer it.
  alignment: number;
}

export interface DetectResult {
  width: number;
  height: number;
  faces: FaceResult[];
}

export class BusyError extends Error {
  constructor(waiting: number) {
    super(`The recogniser already has ${waiting} requests waiting.`);
    this.name = "BusyError";
  }
}

export class Pipeline {
  private detector: Detector | null = null;
  private embedder: Embedder | null = null;
  private readonly store: ModelStore;
  // The single-flight lock: a promise chain rather than a queue object, so
  // there is no structure to drain on shutdown.
  private lane: Promise<unknown> = Promise.resolve();
  private waiting = 0;

  constructor(private readonly config: RecogniserConfig) {
    this.store = new ModelStore(config.modelsDir, config.fetchModels);
  }

  // Resolving models and creating sessions is startup work, done once. A
  // failure to load either model is a recorded state, not a throw: the process
  // still starts and still answers `/health`, because a recogniser that
  // refuses to boot tells HAL nothing about why.
  async start(): Promise<void> {
    if ((await this.store.ensure(YUNET)) === "ok") {
      this.detector = await Detector.load(this.store.pathFor(YUNET)).catch(() => null);
    }
    if ((await this.store.ensure(SFACE)) === "ok") {
      this.embedder = await Embedder.load(this.store.pathFor(SFACE)).catch(() => null);
    }
  }

  // What `/health` reports. Sessions are consulted, not just files: a model
  // that verified on disk but failed to load is not "ok", and saying so is the
  // difference between a probe that answers "is something listening" and one
  // that answers "can this do the thing".
  states(): { detector: ModelState; embedder: ModelState } {
    const detector = this.store.state(YUNET);
    const embedder = this.store.state(SFACE);
    return {
      detector: detector === "ok" && !this.detector ? "corrupt" : detector,
      embedder: embedder === "ok" && !this.embedder ? "corrupt" : embedder,
    };
  }

  async detect(jpegBytes: Buffer): Promise<DetectResult> {
    if (this.waiting >= this.config.maxWaiting) throw new BusyError(this.waiting);
    this.waiting++;
    const run = this.lane.then(() => this.runOnce(jpegBytes));
    // The lane must survive a failed request, or one bad frame wedges every
    // subsequent one behind a rejected promise.
    this.lane = run.catch(() => undefined);
    try {
      return await run;
    } finally {
      this.waiting--;
    }
  }

  private async runOnce(jpegBytes: Buffer): Promise<DetectResult> {
    const frame = decodeJpeg(jpegBytes);
    if (!this.detector) {
      throw new Error(`The detector is not loaded (${this.store.state(YUNET)}).`);
    }

    const detected = await this.detector.detect(
      frame,
      this.config.detectionThreshold,
      this.config.nmsThreshold,
    );

    const faces: FaceResult[] = [];
    // Sequential rather than concurrent: these share one ORT lane anyway, and
    // two people in frame is the common case rather than two hundred.
    for (const face of detected) {
      faces.push(await this.describe(frame, face));
    }
    return { width: frame.width, height: frame.height, faces };
  }

  private async describe(frame: Frame, face: DetectedFace): Promise<FaceResult> {
    const { tensor, transform } = warpToTemplate(frame, face.landmarks);
    let embedding: number[] | null = null;
    if (this.embedder) {
      embedding = await this.embedder.embed(tensor);
      if (embedding.length !== EMBEDDING_DIMS) {
        throw new Error(`Expected ${EMBEDDING_DIMS} dimensions, got ${embedding.length}.`);
      }
    }
    return {
      box: { x: face.x, y: face.y, w: face.w, h: face.h },
      score: face.score,
      landmarks: face.landmarks.map((p) => ({ x: p.x, y: p.y })),
      embedding,
      alignment: transform.residual,
    };
  }
}
