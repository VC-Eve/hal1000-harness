import { describe, expect, it } from "vitest";
import {
  SFACE_TEMPLATE,
  WARP_SIZE,
  applySimilarity,
  estimateSimilarity,
  warpToTemplate,
} from "../src/warp.js";
import type { Frame } from "../src/frame.js";
import type { Landmark } from "../src/detect.js";

// The geometry has to be right before the model is worth running, and none of
// it needs a model to check. These run everywhere, always.

const TEMPLATE_POINTS: Landmark[] = SFACE_TEMPLATE.map(([x, y]) => ({ x, y }));

function rotate(points: Landmark[], degrees: number, about = { x: 56, y: 72 }): Landmark[] {
  const t = (degrees * Math.PI) / 180;
  return points.map((p) => ({
    x: about.x + (p.x - about.x) * Math.cos(t) - (p.y - about.y) * Math.sin(t),
    y: about.y + (p.x - about.x) * Math.sin(t) + (p.y - about.y) * Math.cos(t),
  }));
}

function scalePoints(points: Landmark[], factor: number, about = { x: 56, y: 72 }): Landmark[] {
  return points.map((p) => ({
    x: about.x + (p.x - about.x) * factor,
    y: about.y + (p.y - about.y) * factor,
  }));
}

function translate(points: Landmark[], dx: number, dy: number): Landmark[] {
  return points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

describe("estimateSimilarity", () => {
  it("recovers the identity when the landmarks already sit on the template", () => {
    const t = estimateSimilarity(TEMPLATE_POINTS, SFACE_TEMPLATE);
    expect(t.scale).toBeCloseTo(1, 5);
    expect(t.rotation).toBeCloseTo(0, 5);
    expect(t.tx).toBeCloseTo(0, 4);
    expect(t.ty).toBeCloseTo(0, 4);
  });

  it("recovers a 15 degree roll", () => {
    // The source is the template rolled by 15; the transform that maps source
    // onto the template must therefore roll back by 15.
    const t = estimateSimilarity(rotate(TEMPLATE_POINTS, 15), SFACE_TEMPLATE);
    expect((t.rotation * 180) / Math.PI).toBeCloseTo(-15, 3);
    expect(t.scale).toBeCloseTo(1, 4);
  });

  it("recovers a uniform scale without inventing rotation", () => {
    const t = estimateSimilarity(scalePoints(TEMPLATE_POINTS, 2), SFACE_TEMPLATE);
    expect(t.scale).toBeCloseTo(0.5, 5);
    expect(t.rotation).toBeCloseTo(0, 5);
  });

  it("recovers a pure translation", () => {
    const t = estimateSimilarity(translate(TEMPLATE_POINTS, 40, -25), SFACE_TEMPLATE);
    expect(t.scale).toBeCloseTo(1, 5);
    expect(t.rotation).toBeCloseTo(0, 5);
    const [x, y] = applySimilarity(t, 40, -25);
    expect(x).toBeCloseTo(0, 4);
    expect(y).toBeCloseTo(0, 4);
  });

  it("maps a rolled-and-scaled landmark set back onto the template", () => {
    const src = scalePoints(rotate(TEMPLATE_POINTS, -20), 1.7);
    const t = estimateSimilarity(src, SFACE_TEMPLATE);
    src.forEach((point, i) => {
      const [x, y] = applySimilarity(t, point.x, point.y);
      const target = SFACE_TEMPLATE[i]!;
      expect(x).toBeCloseTo(target[0], 3);
      expect(y).toBeCloseTo(target[1], 3);
    });
  });

  it("refuses a landmark set that is not five points", () => {
    expect(() => estimateSimilarity(TEMPLATE_POINTS.slice(0, 4), SFACE_TEMPLATE)).toThrow();
  });

  it("distinguishes a mirrored correspondence by its residual", () => {
    // This is the guard that matters. Swapping the eye pair and the mouth pair
    // is exactly the mistake a wrong template ordering makes, and the result
    // still looks like a face — so the only thing that catches it is that the
    // best-fit similarity cannot reconcile the two, leaving a large residual.
    const correct = estimateSimilarity(TEMPLATE_POINTS, SFACE_TEMPLATE);
    const mirrored: Landmark[] = [
      TEMPLATE_POINTS[1]!,
      TEMPLATE_POINTS[0]!,
      TEMPLATE_POINTS[2]!,
      TEMPLATE_POINTS[4]!,
      TEMPLATE_POINTS[3]!,
    ];
    const wrong = estimateSimilarity(mirrored, SFACE_TEMPLATE);
    expect(correct.residual).toBeLessThan(0.5);
    expect(wrong.residual).toBeGreaterThan(10);
  });
});

describe("warpToTemplate", () => {
  // A frame with a horizontal red-to-blue ramp and a vertical green ramp, so
  // any pixel's value identifies where in the frame it was sampled from.
  function rampFrame(width: number, height: number): Frame {
    const rgb = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        rgb[i] = Math.round((x / (width - 1)) * 255);
        rgb[i + 1] = Math.round((y / (height - 1)) * 255);
        rgb[i + 2] = 255 - Math.round((x / (width - 1)) * 255);
      }
    }
    return { width, height, rgb };
  }

  it("emits a 112x112 BGR NCHW tensor at 0-255", () => {
    const frame = rampFrame(300, 200);
    const { tensor } = warpToTemplate(frame, TEMPLATE_POINTS);
    expect(tensor.dims).toEqual([1, 3, WARP_SIZE, WARP_SIZE]);

    const data = tensor.data as Float32Array;
    expect(data.length).toBe(3 * WARP_SIZE * WARP_SIZE);
    for (const v of data) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
    let max = -Infinity;
    for (const v of data) if (v > max) max = v;
    // Not normalised to 0-1: a pipeline that scaled these would still run and
    // would still return vectors, just useless ones.
    expect(max).toBeGreaterThan(1);
  });

  it("writes the planes in BGR order, not RGB", () => {
    // A frame that is pure red everywhere. In BGR NCHW the first plane is
    // blue, so it must be zero and the last plane must be 255.
    const width = 200;
    const height = 200;
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) rgb[i * 3] = 255;

    const { tensor } = warpToTemplate({ width, height, rgb }, TEMPLATE_POINTS);
    const data = tensor.data as Float32Array;
    const plane = WARP_SIZE * WARP_SIZE;
    expect(data[Math.floor(plane / 2)]).toBeCloseTo(0, 3);
    expect(data[2 * plane + Math.floor(plane / 2)]).toBeCloseTo(255, 3);
  });

  it("samples the source frame at full resolution rather than a downscale", () => {
    // A one-pixel checkerboard is the sharpest detail a frame can hold. Warped
    // at roughly 1:1 from the original pixels it survives, so the output keeps
    // most of the pattern's contrast. Had the warp sampled the 640x640
    // letterboxed copy the detector uses, this 1920-wide frame would have been
    // shrunk 3:1 first and the checkerboard would have averaged to flat grey —
    // which is precisely the resolution loss KTD4 avoids, and it is invisible
    // to any test that only checks a tensor came back.
    const width = 1920;
    const height = 1080;
    const rgb = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = (x + y) % 2 === 0 ? 255 : 0;
        const i = (y * width + x) * 3;
        rgb[i] = v;
        rgb[i + 1] = v;
        rgb[i + 2] = v;
      }
    }
    // Template-sized region, so the warp is close to a 1:1 resample.
    const tight: Landmark[] = SFACE_TEMPLATE.map(([x, y]) => ({ x: 900 + x, y: 500 + y }));
    const { tensor } = warpToTemplate({ width, height, rgb }, tight);

    const data = tensor.data as Float32Array;
    const plane = WARP_SIZE * WARP_SIZE;
    const red = data.subarray(2 * plane, 3 * plane);
    const mean = red.reduce((a, b) => a + b, 0) / red.length;
    const sd = Math.sqrt(red.reduce((a, b) => a + (b - mean) ** 2, 0) / red.length);
    // Flat grey scores near 0; the intact checkerboard scores near 127.
    expect(sd).toBeGreaterThan(60);
  });

  it("clamps at every edge rather than reading out of bounds", () => {
    const frame = rampFrame(120, 90);
    // Landmarks placed so the warp's sampling window runs well past all four
    // edges of the frame.
    const outside: Landmark[] = SFACE_TEMPLATE.map(([x, y]) => ({ x: x * 4 - 150, y: y * 4 - 120 }));
    const { tensor } = warpToTemplate(frame, outside);
    const data = tensor.data as Float32Array;
    expect(data.every((v) => Number.isFinite(v) && v >= 0 && v <= 255)).toBe(true);
  });

  it("returns the transform it used, so a caller can map the crop back", () => {
    const frame = rampFrame(640, 480);
    const moved = translate(TEMPLATE_POINTS, 200, 100);
    const { transform } = warpToTemplate(frame, moved);
    const [x, y] = applySimilarity(transform, moved[2]!.x, moved[2]!.y);
    expect(x).toBeCloseTo(SFACE_TEMPLATE[2]![0], 3);
    expect(y).toBeCloseTo(SFACE_TEMPLATE[2]![1], 3);
  });
});
