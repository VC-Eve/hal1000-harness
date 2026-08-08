import { beforeAll, describe, expect, it } from "vitest";
import { Detector, decodeYunet, iou, nonMaxSuppress, type DetectedFace } from "../src/detect.js";
import { YUNET } from "../src/models.js";
import {
  DETECTOR_READY,
  FIXTURE_READY,
  NO_DETECTOR,
  NO_FIXTURE,
  describeWhen,
  modelPath,
} from "./models-required.js";
import { blankFrame, loadFace, sideBySide } from "./helpers.js";

function box(x: number, y: number, w: number, h: number, score = 0.9): DetectedFace {
  return { x, y, w, h, score, landmarks: [] };
}

// Pure geometry — no model, always runs.
describe("iou", () => {
  it("is 1 for identical boxes and 0 for disjoint ones", () => {
    expect(iou(box(0, 0, 10, 10), box(0, 0, 10, 10))).toBeCloseTo(1, 6);
    expect(iou(box(0, 0, 10, 10), box(100, 100, 10, 10))).toBe(0);
  });

  it("is 0 for boxes that merely touch at an edge", () => {
    expect(iou(box(0, 0, 10, 10), box(10, 0, 10, 10))).toBe(0);
  });

  it("computes partial overlap symmetrically", () => {
    const a = box(0, 0, 10, 10);
    const b = box(5, 0, 10, 10);
    // Intersection 50, union 150.
    expect(iou(a, b)).toBeCloseTo(1 / 3, 6);
    expect(iou(b, a)).toBeCloseTo(iou(a, b), 9);
  });

  it("does not divide by zero on a degenerate box", () => {
    expect(iou(box(0, 0, 0, 0), box(0, 0, 0, 0))).toBe(0);
  });
});

describe("nonMaxSuppress", () => {
  it("collapses overlapping candidates to the strongest", () => {
    const kept = nonMaxSuppress([box(0, 0, 10, 10, 0.7), box(1, 1, 10, 10, 0.95)], 0.3);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.score).toBe(0.95);
  });

  it("keeps adjacent non-overlapping candidates", () => {
    expect(nonMaxSuppress([box(0, 0, 10, 10), box(40, 0, 10, 10)], 0.3)).toHaveLength(2);
  });

  it("keeps two boxes overlapping below the threshold", () => {
    // IoU here is 1/3; a threshold above that must not merge them.
    expect(nonMaxSuppress([box(0, 0, 10, 10, 0.9), box(5, 0, 10, 10, 0.8)], 0.5)).toHaveLength(2);
  });

  it("does not mutate the input order", () => {
    const input = [box(0, 0, 10, 10, 0.1), box(40, 0, 10, 10, 0.9)];
    nonMaxSuppress(input, 0.3);
    expect(input[0]!.score).toBe(0.1);
  });

  it("returns an empty list for no candidates", () => {
    expect(nonMaxSuppress([], 0.3)).toEqual([]);
  });
});

describe("decodeYunet", () => {
  // Twelve tensors across strides 8/16/32, built by hand so the stride
  // arithmetic is pinned down without a model file.
  function tensors(size: number, hits: Record<number, { cell: number; cls: number; obj: number }>) {
    const out: Record<string, { data: Float32Array }> = {};
    for (const stride of [8, 16, 32]) {
      const cells = Math.floor(size / stride) ** 2;
      const cls = new Float32Array(cells);
      const obj = new Float32Array(cells);
      const bbox = new Float32Array(cells * 4);
      const kps = new Float32Array(cells * 10);
      const hit = hits[stride];
      if (hit) {
        cls[hit.cell] = hit.cls;
        obj[hit.cell] = hit.obj;
        // Centre offset 0.5 of a cell, extent exp(0) = 1 stride.
        bbox[hit.cell * 4] = 0.5;
        bbox[hit.cell * 4 + 1] = 0.5;
        bbox[hit.cell * 4 + 2] = 0;
        bbox[hit.cell * 4 + 3] = 0;
        for (let k = 0; k < 5; k++) {
          kps[hit.cell * 10 + k * 2] = 0.25 * (k + 1);
          kps[hit.cell * 10 + k * 2 + 1] = 0.5;
        }
      }
      out[`cls_${stride}`] = { data: cls };
      out[`obj_${stride}`] = { data: obj };
      out[`bbox_${stride}`] = { data: bbox };
      out[`kps_${stride}`] = { data: kps };
    }
    return out as never;
  }

  it("scores a candidate as the geometric mean of classification and objectness", () => {
    // sqrt(0.64 * 0.81) = 0.72
    const faces = decodeYunet(tensors(64, { 8: { cell: 0, cls: 0.64, obj: 0.81 } }), 64, 64, 0.5);
    expect(faces).toHaveLength(1);
    expect(faces[0]!.score).toBeCloseTo(0.72, 6);
  });

  it("drops candidates below the threshold", () => {
    expect(decodeYunet(tensors(64, { 8: { cell: 0, cls: 0.1, obj: 0.1 } }), 64, 64, 0.5)).toHaveLength(0);
  });

  it("places the box from the cell offset in stride units, with extent in log space", () => {
    // Cell 0 at stride 8: centre (0 + 0.5) * 8 = 4, extent exp(0) * 8 = 8.
    const faces = decodeYunet(tensors(64, { 8: { cell: 0, cls: 1, obj: 1 } }), 64, 64, 0.5);
    expect(faces[0]!.w).toBeCloseTo(8, 6);
    expect(faces[0]!.h).toBeCloseTo(8, 6);
    expect(faces[0]!.x).toBeCloseTo(0, 6);
    expect(faces[0]!.y).toBeCloseTo(0, 6);
  });

  it("indexes the grid row-major, so a cell maps to the right column and row", () => {
    // 64/8 = 8 columns. Cell 11 is row 1, column 3.
    const faces = decodeYunet(tensors(64, { 8: { cell: 11, cls: 1, obj: 1 } }), 64, 64, 0.5);
    // Centre x = (3 + 0.5) * 8 = 28, centre y = (1 + 0.5) * 8 = 12.
    expect(faces[0]!.x + faces[0]!.w / 2).toBeCloseTo(28, 6);
    expect(faces[0]!.y + faces[0]!.h / 2).toBeCloseTo(12, 6);
  });

  it("returns five landmarks per candidate, offset from the same cell", () => {
    const faces = decodeYunet(tensors(64, { 8: { cell: 0, cls: 1, obj: 1 } }), 64, 64, 0.5);
    expect(faces[0]!.landmarks).toHaveLength(5);
    expect(faces[0]!.landmarks[0]!.x).toBeCloseTo(0.25 * 8, 6);
    expect(faces[0]!.landmarks[4]!.x).toBeCloseTo(1.25 * 8, 6);
  });

  it("reads every stride, not just the first", () => {
    const faces = decodeYunet(
      tensors(64, { 8: { cell: 0, cls: 1, obj: 1 }, 32: { cell: 0, cls: 1, obj: 1 } }),
      64,
      64,
      0.5,
    );
    expect(faces).toHaveLength(2);
    // The stride-32 candidate is four times the size of the stride-8 one.
    expect(faces.map((f) => Math.round(f.w)).sort((a, b) => a - b)).toEqual([8, 32]);
  });

  it("skips a stride whose tensors are absent rather than throwing", () => {
    expect(() => decodeYunet({} as never, 64, 64, 0.5)).not.toThrow();
    expect(decodeYunet({} as never, 64, 64, 0.5)).toEqual([]);
  });
});

describeWhen(DETECTOR_READY && FIXTURE_READY, `${NO_DETECTOR} / ${NO_FIXTURE}`, "Detector against a real frame", () => {
  let detector: Detector;

  beforeAll(async () => {
    detector = await Detector.load(modelPath(YUNET));
  });

  it("finds exactly one face in the fixture, well above the threshold", async () => {
    const faces = await detector.detect(loadFace(), 0.6, 0.3);
    expect(faces).toHaveLength(1);
    // The origin brief measured 0.93 on this camera; the capture script will
    // not write a fixture below 0.85.
    expect(faces[0]!.score).toBeGreaterThan(0.85);
  });

  it("returns a box inside the frame with positive extent", async () => {
    const frame = loadFace();
    const [face] = await detector.detect(frame, 0.6, 0.3);
    expect(face!.w).toBeGreaterThan(0);
    expect(face!.h).toBeGreaterThan(0);
    expect(face!.x).toBeGreaterThanOrEqual(-1);
    expect(face!.y).toBeGreaterThanOrEqual(-1);
    expect(face!.x + face!.w).toBeLessThanOrEqual(frame.width + 1);
    expect(face!.y + face!.h).toBeLessThanOrEqual(frame.height + 1);
  });

  it("returns five landmarks in a plausible facial arrangement", async () => {
    const [face] = await detector.detect(loadFace(), 0.6, 0.3);
    const [rightEye, leftEye, nose, rightMouth, leftMouth] = face!.landmarks as [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
    ];
    expect(face!.landmarks).toHaveLength(5);

    // The first landmark is the subject's RIGHT eye, which is the LEFT-most
    // point in the image. If this ordering were backwards the warp would
    // produce a mirrored crop that embeds happily and scores plausibly, so it
    // is asserted rather than assumed.
    expect(rightEye.x).toBeLessThan(leftEye.x);
    expect(rightMouth.x).toBeLessThan(leftMouth.x);
    // The nose sits between the eyes horizontally and below them vertically.
    expect(nose.x).toBeGreaterThan(rightEye.x);
    expect(nose.x).toBeLessThan(leftEye.x);
    expect(nose.y).toBeGreaterThan((rightEye.y + leftEye.y) / 2);
    // The mouth is below the nose.
    expect((rightMouth.y + leftMouth.y) / 2).toBeGreaterThan(nose.y);
  });

  it("places every landmark inside the detected box", async () => {
    const [face] = await detector.detect(loadFace(), 0.6, 0.3);
    for (const point of face!.landmarks) {
      expect(point.x).toBeGreaterThanOrEqual(face!.x);
      expect(point.x).toBeLessThanOrEqual(face!.x + face!.w);
      expect(point.y).toBeGreaterThanOrEqual(face!.y);
      expect(point.y).toBeLessThanOrEqual(face!.y + face!.h);
    }
  });

  it("finds two faces when two people are in frame, without collapsing them", async () => {
    // R4: appearances are per face, not per frame.
    const faces = await detector.detect(sideBySide(loadFace()), 0.6, 0.3);
    expect(faces).toHaveLength(2);
    const [a, b] = faces.sort((l, r) => l.x - r.x);
    expect(b!.x).toBeGreaterThan(a!.x + a!.w);
  });

  it("returns an empty list for a frame with no face, rather than erroring", async () => {
    await expect(detector.detect(blankFrame(640, 480), 0.6, 0.3)).resolves.toEqual([]);
  });

  it("returns coordinates in source space for a non-square frame", async () => {
    // The letterbox pads a 640x480 frame by 80 rows top and bottom. A box
    // reported in letterboxed space would sit 80px lower than the real face.
    const frame = loadFace();
    const [face] = await detector.detect(frame, 0.6, 0.3);
    const centreY = face!.y + face!.h / 2;
    // Sample the source frame at the box centre: a face is not the flat
    // background, so its pixels must vary across the box.
    const values: number[] = [];
    for (let x = Math.max(0, face!.x); x < Math.min(frame.width, face!.x + face!.w); x += 8) {
      values.push(frame.rgb[(Math.round(centreY) * frame.width + Math.round(x)) * 3]!);
    }
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
    expect(sd).toBeGreaterThan(5);
  });

  it("carries no state between calls", async () => {
    const frame = loadFace();
    const first = await detector.detect(frame, 0.6, 0.3);
    await detector.detect(blankFrame(640, 480), 0.6, 0.3);
    const second = await detector.detect(frame, 0.6, 0.3);
    expect(second).toEqual(first);
  });

  it("honours the score threshold it is given", async () => {
    expect(await detector.detect(loadFace(), 0.999, 0.3)).toEqual([]);
  });
});
