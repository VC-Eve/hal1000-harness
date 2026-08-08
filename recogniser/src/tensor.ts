// The tensor layout both OpenCV Zoo models were exported expecting: BGR, NCHW,
// values left at 0-255.
//
// Item 4 of the spike's header exists because getting any of those three wrong
// runs happily and detects nothing. There is no error to catch and no shape
// mismatch to trip over — the model simply returns confident nonsense. So the
// conversion lives in one place, is used by both the letterbox and the warp,
// and is asserted against synthetic pixels with known channel values.

import ort from "onnxruntime-node";

// These models list their weights as graph inputs, which makes ORT emit one
// warning per initializer — hundreds of lines. In a spike that buries the
// result; in a long-running server it is a log flood.
ort.env.logLevel = "fatal";

export const SESSION_OPTIONS = { logSeverityLevel: 4 as const, graphOptimizationLevel: "all" as const };

// Three contiguous planes: all of B, then all of G, then all of R.
export function bgrPlanes(width: number, height: number): Float32Array {
  return new Float32Array(3 * width * height);
}

export function setBgr(
  planes: Float32Array,
  plane: number,
  index: number,
  r: number,
  g: number,
  b: number,
): void {
  planes[index] = b;
  planes[plane + index] = g;
  planes[2 * plane + index] = r;
}

export function tensorFrom(planes: Float32Array, width: number, height: number): ort.Tensor {
  return new ort.Tensor("float32", planes, [1, 3, height, width]);
}
