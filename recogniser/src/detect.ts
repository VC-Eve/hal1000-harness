// YuNet: frame in, faces out.
//
// The decode is transcribed from `docs/spikes/2026-08-07-face-recognition.mjs`
// rather than re-derived, because item 1 of that spike's header is the part
// that cost iterations. YuNet emits twelve separate tensors — cls, obj, bbox
// and kps at each of strides 8, 16 and 32 — with no post-processing baked into
// the graph. The score is the geometric mean of classification and objectness,
// and box coordinates are offsets from the grid cell in stride units, with
// width and height in log space.
//
// Everything leaving this module is in the caller's coordinates. The 640x640
// the model sees does not escape.

import ort from "onnxruntime-node";
import { DETECT_SIZE, letterboxTensor, toSource, type Frame } from "./frame.js";
import { SESSION_OPTIONS } from "./tensor.js";

// The subject's right eye first, which is the LEFT-most point in the image.
// This ordering is the highest-risk assumption in the whole pipeline: get it
// backwards and the warp produces a mirrored crop that embeds without
// complaint and scores plausibly against itself. `warp.ts` checks the
// correspondence against the canonical template rather than trusting this
// comment.
export const LANDMARK_ORDER = [
  "right-eye",
  "left-eye",
  "nose",
  "right-mouth-corner",
  "left-mouth-corner",
] as const;

export interface Landmark {
  x: number;
  y: number;
}

export interface DetectedFace {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  landmarks: Landmark[];
}

const STRIDES = [8, 16, 32] as const;

export class Detector {
  private constructor(private readonly session: ort.InferenceSession) {}

  // The session is created once and reused. The spike's warm-up comment records
  // that the first run pays graph init and allocator setup; a server that paid
  // that per request would spend more time constructing than inferring.
  static async load(modelPath: string): Promise<Detector> {
    const session = await ort.InferenceSession.create(modelPath, SESSION_OPTIONS);
    return new Detector(session);
  }

  async detect(frame: Frame, scoreThreshold: number, nmsThreshold: number): Promise<DetectedFace[]> {
    const { tensor, box } = letterboxTensor(frame);
    const inputName = this.session.inputNames[0];
    if (!inputName) throw new Error("The detector model exposes no input.");
    const outputs = await this.session.run({ [inputName]: tensor });

    const candidates = decodeYunet(outputs, DETECT_SIZE, DETECT_SIZE, scoreThreshold);
    const kept = nonMaxSuppress(candidates, nmsThreshold);

    return kept.map((face) => {
      const [x, y] = toSource(box, face.x, face.y);
      return {
        x,
        y,
        w: face.w / box.fit,
        h: face.h / box.fit,
        score: face.score,
        landmarks: face.landmarks.map((point) => {
          const [lx, ly] = toSource(box, point.x, point.y);
          return { x: lx, y: ly };
        }),
      };
    });
  }
}

// Exported for its own tests: the stride arithmetic is the part worth pinning
// down independently of whether a model file is available.
export function decodeYunet(
  outputs: Record<string, ort.Tensor>,
  width: number,
  height: number,
  threshold: number,
): DetectedFace[] {
  const faces: DetectedFace[] = [];
  for (const stride of STRIDES) {
    const cls = outputs[`cls_${stride}`]?.data as Float32Array | undefined;
    const obj = outputs[`obj_${stride}`]?.data as Float32Array | undefined;
    const bbox = outputs[`bbox_${stride}`]?.data as Float32Array | undefined;
    const kps = outputs[`kps_${stride}`]?.data as Float32Array | undefined;
    if (!cls || !obj || !bbox || !kps) continue;

    const cols = Math.floor(width / stride);
    const rows = Math.floor(height / stride);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const score = Math.sqrt(Math.max(0, cls[i] ?? 0) * Math.max(0, obj[i] ?? 0));
        if (score < threshold) continue;

        // Centre is an offset from the cell in stride units; extent is in log
        // space, so it exponentiates.
        const cx = (c + (bbox[i * 4] ?? 0)) * stride;
        const cy = (r + (bbox[i * 4 + 1] ?? 0)) * stride;
        const bw = Math.exp(bbox[i * 4 + 2] ?? 0) * stride;
        const bh = Math.exp(bbox[i * 4 + 3] ?? 0) * stride;

        const landmarks: Landmark[] = [];
        for (let k = 0; k < 5; k++) {
          landmarks.push({
            x: (c + (kps[i * 10 + k * 2] ?? 0)) * stride,
            y: (r + (kps[i * 10 + k * 2 + 1] ?? 0)) * stride,
          });
        }
        faces.push({ x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh, score, landmarks });
      }
    }
  }
  return faces;
}

// Greedy: strongest candidate wins, anything overlapping it above the
// threshold is the same face seen at another stride. Pooled across strides
// rather than run per-stride, because the duplicate this exists to remove is
// usually the same face found at two different scales.
export function nonMaxSuppress(faces: DetectedFace[], threshold: number): DetectedFace[] {
  const sorted = [...faces].sort((a, b) => b.score - a.score);
  const kept: DetectedFace[] = [];
  for (const face of sorted) {
    if (kept.some((k) => iou(k, face) > threshold)) continue;
    kept.push(face);
  }
  return kept;
}

export function iou(a: DetectedFace, b: DetectedFace): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}
