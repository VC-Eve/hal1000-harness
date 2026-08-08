import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import {
  DETECT_SIZE,
  FrameError,
  MAX_PIXELS,
  decodeJpeg,
  letterboxOf,
  letterboxTensor,
  sampleBilinear,
  toSource,
  type Frame,
} from "../src/frame.js";

function solidJpeg(width: number, height: number, r = 120, g = 60, b = 200): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return Buffer.from(jpeg.encode({ data, width, height }, 100).data);
}

function solidFrame(width: number, height: number, r = 10, g = 20, b = 30): Frame {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return { width, height, rgb };
}

describe("decodeJpeg", () => {
  it("decodes to the true dimensions and drops alpha", () => {
    const frame = decodeJpeg(solidJpeg(64, 48));
    expect(frame.width).toBe(64);
    expect(frame.height).toBe(48);
    expect(frame.rgb.length).toBe(64 * 48 * 3);
  });

  it("preserves channel order through the decode", () => {
    const frame = decodeJpeg(solidJpeg(32, 32, 200, 100, 50));
    // JPEG is lossy, so this is an approximate check on a flat image.
    expect(frame.rgb[0]).toBeGreaterThan(180);
    expect(frame.rgb[1]).toBeGreaterThan(80);
    expect(frame.rgb[1]).toBeLessThan(120);
    expect(frame.rgb[2]).toBeLessThan(80);
  });

  it("raises a typed error for a body that is not a JPEG", () => {
    expect(() => decodeJpeg(Buffer.from("this is not an image"))).toThrow(FrameError);
  });

  it("raises a typed error for a truncated JPEG rather than producing a garbage tensor", () => {
    const full = solidJpeg(64, 64);
    expect(() => decodeJpeg(full.subarray(0, Math.floor(full.length / 3)))).toThrow(FrameError);
  });

  it("refuses a frame whose decoded pixel count exceeds the budget", () => {
    // The body cap in server.ts is on compressed bytes, which says nothing
    // about decoded size — a flat image compresses to almost nothing and
    // expands enormously. The budget is injectable so this tests the real
    // path without encoding a 200MB buffer.
    const image = solidJpeg(200, 200);
    expect(() => decodeJpeg(image, 1_000)).toThrow(FrameError);
    expect(() => decodeJpeg(image, 1_000)).toThrow(/40000 pixels|may not exceed/);
    expect(() => decodeJpeg(image, 100_000)).not.toThrow();
  });

  it("defaults to a budget larger than any camera frame but short of a bomb", () => {
    // A 4K frame must pass unremarked; the cap only refuses the pathological.
    expect(MAX_PIXELS).toBeGreaterThan(3840 * 2160);
    expect(MAX_PIXELS).toBeLessThan(200_000_000);
  });
});

describe("letterboxOf", () => {
  it("pads a landscape frame top and bottom only", () => {
    const box = letterboxOf(solidFrame(640, 480));
    expect(box.fit).toBeCloseTo(1, 6);
    expect(box.offsetX).toBe(0);
    expect(box.offsetY).toBe(80);
  });

  it("pads a portrait frame left and right only", () => {
    const box = letterboxOf(solidFrame(480, 640));
    expect(box.fit).toBeCloseTo(1, 6);
    expect(box.offsetY).toBe(0);
    expect(box.offsetX).toBe(80);
  });

  it("passes a square frame through untouched", () => {
    const box = letterboxOf(solidFrame(DETECT_SIZE, DETECT_SIZE));
    expect(box.fit).toBe(1);
    expect(box.offsetX).toBe(0);
    expect(box.offsetY).toBe(0);
  });

  it("scales down a frame larger than the detector input", () => {
    const box = letterboxOf(solidFrame(1920, 1080));
    expect(box.fit).toBeCloseTo(DETECT_SIZE / 1920, 6);
    expect(box.offsetX).toBe(0);
    expect(box.offsetY).toBeCloseTo((DETECT_SIZE - Math.round(1080 * (DETECT_SIZE / 1920))) / 2, 6);
  });
});

describe("toSource", () => {
  it("round-trips a point through the letterbox for every aspect ratio", () => {
    for (const [w, h] of [
      [640, 480],
      [480, 640],
      [640, 640],
      [1920, 1080],
      [1280, 720],
    ] as const) {
      const box = letterboxOf(solidFrame(w, h));
      for (const [px, py] of [
        [0, 0],
        [w / 2, h / 2],
        [w - 1, h - 1],
        [12.5, 300.25],
      ] as const) {
        const lx = px * box.fit + box.offsetX;
        const ly = py * box.fit + box.offsetY;
        const [bx, by] = toSource(box, lx, ly);
        expect(bx).toBeCloseTo(px, 3);
        expect(by).toBeCloseTo(py, 3);
      }
    }
  });
});

describe("letterboxTensor", () => {
  it("emits [1, 3, 640, 640] with values left at 0-255", () => {
    const { tensor } = letterboxTensor(solidFrame(640, 480, 200, 150, 100));
    expect(tensor.dims).toEqual([1, 3, DETECT_SIZE, DETECT_SIZE]);
    const data = tensor.data as Float32Array;
    // A spread would blow the stack at 1.2M elements.
    let max = -Infinity;
    for (const v of data) if (v > max) max = v;
    // Not scaled to 0-1: both OpenCV Zoo models were exported expecting 0-255,
    // and a rescaled input runs happily and detects nothing.
    expect(max).toBeGreaterThan(1);
    expect(max).toBeLessThanOrEqual(255);
  });

  it("writes the planes in BGR order, not RGB", () => {
    // Pure red. In BGR the first plane is blue and must be empty in the image
    // region; the third plane must carry the red.
    const { tensor } = letterboxTensor(solidFrame(DETECT_SIZE, DETECT_SIZE, 255, 0, 0));
    const data = tensor.data as Float32Array;
    const plane = DETECT_SIZE * DETECT_SIZE;
    const centre = Math.floor(plane / 2);
    expect(data[centre]).toBeCloseTo(0, 3);
    expect(data[plane + centre]).toBeCloseTo(0, 3);
    expect(data[2 * plane + centre]).toBeCloseTo(255, 3);
  });

  it("leaves padding black in all three channels", () => {
    const { tensor } = letterboxTensor(solidFrame(640, 480, 255, 255, 255));
    const data = tensor.data as Float32Array;
    const plane = DETECT_SIZE * DETECT_SIZE;
    // Row 10 is inside the 80-pixel top pad.
    for (let c = 0; c < 3; c++) {
      for (let x = 0; x < DETECT_SIZE; x += 97) {
        expect(data[c * plane + 10 * DETECT_SIZE + x]).toBe(0);
      }
    }
    // Row 320 is in the image region and must not be black.
    expect(data[2 * plane + 320 * DETECT_SIZE + 320]).toBeGreaterThan(200);
  });

  it("places the image region where the letterbox says it is", () => {
    const { tensor, box } = letterboxTensor(solidFrame(480, 640, 0, 255, 0));
    const data = tensor.data as Float32Array;
    const plane = DETECT_SIZE * DETECT_SIZE;
    const row = 320 * DETECT_SIZE;
    // Just outside the left pad boundary is black; just inside is green.
    expect(data[plane + row + Math.round(box.offsetX) - 5]).toBe(0);
    expect(data[plane + row + Math.round(box.offsetX) + 5]).toBeGreaterThan(200);
  });
});

describe("sampleBilinear", () => {
  it("interpolates between neighbouring pixels", () => {
    const rgb = new Uint8Array([0, 0, 0, 100, 100, 100, 0, 0, 0, 100, 100, 100]);
    const frame: Frame = { width: 2, height: 2, rgb };
    expect(sampleBilinear(frame, 0.5, 0)[0]).toBeCloseTo(50, 5);
  });

  it("clamps at every edge rather than wrapping or reading out of bounds", () => {
    const frame = solidFrame(8, 8, 42, 42, 42);
    for (const [x, y] of [
      [-50, 4],
      [50, 4],
      [4, -50],
      [4, 50],
      [-99, -99],
      [99, 99],
    ] as const) {
      const [r, g, b] = sampleBilinear(frame, x, y);
      expect([r, g, b]).toEqual([42, 42, 42]);
    }
  });
});
