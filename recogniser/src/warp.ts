// The five-landmark warp — the thing the spike deliberately did not do.
//
// The spike cropped by bounding box and recorded the consequence: the same
// person, captured twice seconds apart with nothing but ordinary movement in
// between, embedded at 0.92 on one run and 0.61 on another, against 0.34 for a
// crop that is not a face at all. No threshold can live in that gap. The brief
// names the bounding-box crop as the likely cause, because a head turn changes
// the framing, and calls landmark alignment a prerequisite rather than an
// accuracy refinement.
//
// So: fit a similarity transform from YuNet's five landmarks onto the canonical
// template SFace was trained against, and sample the face through it. Four
// parameters — scale, rotation, translation — is the right amount of freedom.
// It corrects head roll and framing drift, and withholds the perspective
// freedom that would let one bad landmark distort the whole face.

import ort from "onnxruntime-node";
import { sampleBilinear, type Frame } from "./frame.js";
import type { Landmark } from "./detect.js";
import { bgrPlanes, setBgr, tensorFrom } from "./tensor.js";

export const WARP_SIZE = 112;

// The canonical five-point reference SFace and ArcFace were trained against,
// at 112x112. Ordered to match `LANDMARK_ORDER` in `detect.ts`: the first
// point is the left-most in the image, which is the subject's RIGHT eye, which
// is what YuNet emits first.
//
// If that correspondence were backwards, the warp would produce a horizontally
// mirrored face that embeds happily and scores plausibly against other
// mirrored crops — a failure invisible to any test that only checks a vector
// came back. `estimateSimilarity` returns a residual precisely so the
// correspondence is checkable: a correct pairing leaves a small one, a swapped
// pairing cannot be reconciled by any rotation and leaves a large one.
export const SFACE_TEMPLATE: ReadonlyArray<readonly [number, number]> = [
  [38.2946, 51.6963], // subject's right eye  (image left)
  [73.5318, 51.5014], // subject's left eye   (image right)
  [56.0252, 71.7366], // nose tip
  [41.5493, 92.3655], // right mouth corner   (image left)
  [70.7299, 92.2041], // left mouth corner    (image right)
];

// Maps source-frame coordinates onto the template. `rotation` and `scale` are
// derived rather than stored separately so the two can never disagree.
export interface Similarity {
  // The scaled rotation matrix, row-major: [[a, -b], [b, a]].
  a: number;
  b: number;
  tx: number;
  ty: number;
  scale: number;
  rotation: number;
  // Root-mean-square distance between the transformed landmarks and the
  // template, in template pixels. The correspondence check.
  residual: number;
}

// Closed-form least-squares fit of a 2D similarity, no iteration. Reflection is
// not in the solution space, which is deliberate: allowing it would let a
// mirrored landmark ordering fit perfectly and hide exactly the mistake the
// residual exists to expose.
export function estimateSimilarity(
  src: readonly Landmark[],
  dst: ReadonlyArray<readonly [number, number]> = SFACE_TEMPLATE,
): Similarity {
  if (src.length !== dst.length || src.length < 2) {
    throw new Error(`A similarity fit needs matching point sets of at least 2; got ${src.length} and ${dst.length}.`);
  }
  const n = src.length;

  let msx = 0;
  let msy = 0;
  let mdx = 0;
  let mdy = 0;
  for (let i = 0; i < n; i++) {
    msx += src[i]!.x;
    msy += src[i]!.y;
    mdx += dst[i]![0];
    mdy += dst[i]![1];
  }
  msx /= n;
  msy /= n;
  mdx /= n;
  mdy /= n;

  // `dot` accumulates the aligned component and `cross` the perpendicular one;
  // divided by the source's spread they are scale*cos and scale*sin.
  let dot = 0;
  let cross = 0;
  let spread = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i]!.x - msx;
    const sy = src[i]!.y - msy;
    const dx = dst[i]![0] - mdx;
    const dy = dst[i]![1] - mdy;
    dot += sx * dx + sy * dy;
    cross += sx * dy - sy * dx;
    spread += sx * sx + sy * sy;
  }
  if (spread === 0) throw new Error("Degenerate landmarks: every point is in the same place.");

  const a = dot / spread;
  const b = cross / spread;
  const tx = mdx - (a * msx - b * msy);
  const ty = mdy - (b * msx + a * msy);

  const transform: Similarity = {
    a,
    b,
    tx,
    ty,
    scale: Math.hypot(a, b),
    rotation: Math.atan2(b, a),
    residual: 0,
  };

  let sum = 0;
  for (let i = 0; i < n; i++) {
    const [x, y] = applySimilarity(transform, src[i]!.x, src[i]!.y);
    sum += (x - dst[i]![0]) ** 2 + (y - dst[i]![1]) ** 2;
  }
  transform.residual = Math.sqrt(sum / n);
  return transform;
}

export function applySimilarity(t: Similarity, x: number, y: number): [number, number] {
  return [t.a * x - t.b * y + t.tx, t.b * x + t.a * y + t.ty];
}

// Template coordinates back to source coordinates. This is the direction the
// resampling actually needs: every output pixel asks where in the frame it
// came from, so no output pixel can be left unwritten.
export function invertSimilarity(t: Similarity, x: number, y: number): [number, number] {
  const det = t.a * t.a + t.b * t.b;
  if (det === 0) throw new Error("A degenerate transform cannot be inverted.");
  const px = x - t.tx;
  const py = y - t.ty;
  return [(t.a * px + t.b * py) / det, (t.a * py - t.b * px) / det];
}

export interface WarpResult {
  tensor: ort.Tensor;
  transform: Similarity;
}

// Sampling is from the ORIGINAL frame, not the 640x640 the detector saw. The
// letterbox exists to fit YuNet's fixed input; running the crop through it too
// would throw away the camera's resolution for no reason, and a 112x112 face
// is small enough that every pixel of detail counts.
export function warpToTemplate(frame: Frame, landmarks: readonly Landmark[]): WarpResult {
  const transform = estimateSimilarity(landmarks);
  const planes = bgrPlanes(WARP_SIZE, WARP_SIZE);
  const plane = WARP_SIZE * WARP_SIZE;

  for (let y = 0; y < WARP_SIZE; y++) {
    for (let x = 0; x < WARP_SIZE; x++) {
      const [sx, sy] = invertSimilarity(transform, x, y);
      const [r, g, b] = sampleBilinear(frame, sx, sy);
      setBgr(planes, plane, y * WARP_SIZE + x, r, g, b);
    }
  }
  return { tensor: tensorFrom(planes, WARP_SIZE, WARP_SIZE), transform };
}
