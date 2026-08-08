// A JPEG in, a tensor YuNet accepts out, and the arithmetic to get back.
//
// The spike let ffmpeg do this with `scale=640:-1,pad=640:640:0:(640-ih)/2`
// and noted that going straight to rawvideo removes the JPEG-decoder
// dependency. That reasoning holds beside a camera; it does not hold for a
// sidecar R2 says may run on another machine, where requiring ffmpeg on the
// host is exactly the per-OS setup step R34 forbids. `jpeg-js` is pure
// JavaScript with no build step, so decoding in-process keeps the install to
// `npm install` on all three targets.
//
// The letterbox is not squashing. YuNet's 2023mar export takes a FIXED 640x640
// input (item 2 of the spike header), so aspect ratio has to be preserved on
// the way in or every face arrives distorted. The consequence worth knowing is
// that detection cost is constant regardless of camera resolution.
//
// Everything the caller sees is in the caller's own coordinates. The
// letterboxed space is an internal detail of talking to YuNet, and `toSource`
// is what keeps it internal.

import jpeg from "jpeg-js";
import ort from "onnxruntime-node";
import { bgrPlanes, setBgr, tensorFrom } from "./tensor.js";

// The detector's fixed input.
export const DETECT_SIZE = 640;

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

export interface Frame {
  width: number;
  height: number;
  // Tightly packed RGB, three bytes per pixel, row-major.
  rgb: Uint8Array;
}

// Maps between the caller's frame and the 640x640 the detector sees.
export interface Letterbox {
  fit: number;
  offsetX: number;
  offsetY: number;
}

// A JPEG's compressed size says nothing about its decoded size, so the body
// cap in `server.ts` is not a bound on memory. Detection letterboxes to a fixed
// 640x640 regardless, so nothing here benefits from a frame larger than a
// camera produces — this only refuses the pathological case. It matters once
// the process is bound off loopback, where the caller is no longer only HAL.
export const MAX_PIXELS = 40_000_000;

export function decodeJpeg(bytes: Buffer, maxPixels = MAX_PIXELS): Frame {
  let raw: { width: number; height: number; data: Uint8Array };
  try {
    // `useTArray` keeps this a typed array rather than a Buffer copy; the
    // decoder throws on a truncated or non-JPEG body, which is a typed error
    // here rather than a garbage tensor three functions later.
    raw = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 512 });
  } catch (err) {
    throw new FrameError(`Not a decodable JPEG: ${(err as Error).message}`);
  }
  if (!raw.width || !raw.height) throw new FrameError("JPEG decoded to an empty image.");
  if (raw.width * raw.height > maxPixels) {
    throw new FrameError(`A frame may not exceed ${maxPixels} pixels; got ${raw.width}x${raw.height}.`);
  }

  // jpeg-js hands back RGBA. Alpha is meaningless for a camera frame and
  // carrying it would make every downstream stride calculation four-wide for
  // no reason.
  const rgb = new Uint8Array(raw.width * raw.height * 3);
  for (let i = 0, o = 0; o < rgb.length; i += 4, o += 3) {
    rgb[o] = raw.data[i] ?? 0;
    rgb[o + 1] = raw.data[i + 1] ?? 0;
    rgb[o + 2] = raw.data[i + 2] ?? 0;
  }
  return { width: raw.width, height: raw.height, rgb };
}

export function letterboxOf(frame: Frame, size = DETECT_SIZE): Letterbox {
  const fit = Math.min(size / frame.width, size / frame.height);
  return {
    fit,
    // Centred on both axes. The spike padded only vertically because it also
    // controlled the capture size and knew the frame was already 640 wide; a
    // sidecar takes whatever it is sent.
    offsetX: (size - Math.round(frame.width * fit)) / 2,
    offsetY: (size - Math.round(frame.height * fit)) / 2,
  };
}

// Letterboxed coordinates back to the caller's. The inverse of what
// `letterboxTensor` does to the pixels, and the reason nothing downstream of
// detection has to know the padding exists.
export function toSource(box: Letterbox, x: number, y: number): [number, number] {
  return [(x - box.offsetX) / box.fit, (y - box.offsetY) / box.fit];
}

export function letterboxTensor(frame: Frame, size = DETECT_SIZE): { tensor: ort.Tensor; box: Letterbox } {
  const box = letterboxOf(frame, size);
  const planes = bgrPlanes(size, size);
  const plane = size * size;
  const scaledW = Math.round(frame.width * box.fit);
  const scaledH = Math.round(frame.height * box.fit);

  for (let y = 0; y < size; y++) {
    const sy = (y - box.offsetY) / box.fit;
    const inRow = y >= box.offsetY && y < box.offsetY + scaledH;
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      // Padding stays black in all three channels. A non-zero pad is a
      // phantom edge the detector will happily find structure in.
      if (!inRow || x < box.offsetX || x >= box.offsetX + scaledW) {
        setBgr(planes, plane, index, 0, 0, 0);
        continue;
      }
      const sx = (x - box.offsetX) / box.fit;
      const [r, g, b] = sampleBilinear(frame, sx, sy);
      setBgr(planes, plane, index, r, g, b);
    }
  }
  return { tensor: tensorFrom(planes, size, size), box };
}

// Bilinear sample with edge clamping, shared by the letterbox and the warp so
// there is one resampler to get right rather than two. Clamping rather than
// wrapping or erroring: a warp whose transform reaches slightly outside the
// frame should extend the edge, not read the opposite side of the image.
export function sampleBilinear(frame: Frame, x: number, y: number): [number, number, number] {
  const { width: w, height: h, rgb } = frame;
  const cx = Math.min(w - 1, Math.max(0, x));
  const cy = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;

  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const p00 = rgb[(y0 * w + x0) * 3 + c] ?? 0;
    const p10 = rgb[(y0 * w + x1) * 3 + c] ?? 0;
    const p01 = rgb[(y1 * w + x0) * 3 + c] ?? 0;
    const p11 = rgb[(y1 * w + x1) * 3 + c] ?? 0;
    const top = p00 + (p10 - p00) * fx;
    const bottom = p01 + (p11 - p01) * fx;
    out[c] = top + (bottom - top) * fy;
  }
  return out;
}
