// Shared fixtures for the suites that need a real face.
//
// Everything here derives from the one locally-captured frame. Variants are
// synthesised rather than captured so the tests are deterministic and need the
// camera exactly once.

import fs from "node:fs";
import jpeg from "jpeg-js";
import { sampleBilinear, type Frame } from "../src/frame.js";
import { FACE_FIXTURE } from "./models-required.js";

export function loadFace(): Frame {
  const bytes = fs.readFileSync(FACE_FIXTURE);
  const raw = jpeg.decode(bytes, { useTArray: true });
  const rgb = new Uint8Array(raw.width * raw.height * 3);
  for (let i = 0, o = 0; o < rgb.length; i += 4, o += 3) {
    rgb[o] = raw.data[i]!;
    rgb[o + 1] = raw.data[i + 1]!;
    rgb[o + 2] = raw.data[i + 2]!;
  }
  return { width: raw.width, height: raw.height, rgb };
}

export function faceJpeg(): Buffer {
  return fs.readFileSync(FACE_FIXTURE);
}

export function encodeJpeg(frame: Frame, quality = 92): Buffer {
  const data = Buffer.alloc(frame.width * frame.height * 4);
  for (let i = 0, o = 0; i < frame.width * frame.height; i++, o += 3) {
    data[i * 4] = frame.rgb[o]!;
    data[i * 4 + 1] = frame.rgb[o + 1]!;
    data[i * 4 + 2] = frame.rgb[o + 2]!;
    data[i * 4 + 3] = 255;
  }
  return Buffer.from(jpeg.encode({ data, width: frame.width, height: frame.height }, quality).data);
}

export function blankFrame(width: number, height: number, value = 128): Frame {
  const rgb = new Uint8Array(width * height * 3).fill(value);
  return { width, height, rgb };
}

// Two copies of the fixture side by side: two faces in one frame, which is
// what R4's per-face unit has to survive.
export function sideBySide(frame: Frame): Frame {
  const width = frame.width * 2;
  const rgb = new Uint8Array(width * frame.height * 3);
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const src = (y * frame.width + x) * 3;
      for (const dx of [0, frame.width]) {
        const dst = (y * width + x + dx) * 3;
        rgb[dst] = frame.rgb[src]!;
        rgb[dst + 1] = frame.rgb[src + 1]!;
        rgb[dst + 2] = frame.rgb[src + 2]!;
      }
    }
  }
  return { width, height: frame.height, rgb };
}

// Roll, scale and shift the whole frame — the framing changes a head turn
// produces, which is what the bounding-box crop could not absorb.
export function reframe(frame: Frame, degrees: number, scale: number, dx: number, dy: number): Frame {
  const rad = (degrees * Math.PI) / 180;
  const cx = frame.width / 2;
  const cy = frame.height / 2;
  const rgb = new Uint8Array(frame.width * frame.height * 3);
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const px = (x - cx - dx) / scale;
      const py = (y - cy - dy) / scale;
      const sx = cx + px * Math.cos(-rad) - py * Math.sin(-rad);
      const sy = cy + px * Math.sin(-rad) + py * Math.cos(-rad);
      const [r, g, b] = sampleBilinear(frame, sx, sy);
      const i = (y * frame.width + x) * 3;
      rgb[i] = r;
      rgb[i + 1] = g;
      rgb[i + 2] = b;
    }
  }
  return { width: frame.width, height: frame.height, rgb };
}
