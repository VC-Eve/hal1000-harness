import { beforeAll, describe, expect, it } from "vitest";
import { Detector } from "../src/detect.js";
import { Embedder, EMBEDDING_DIMS, cosine, normalise } from "../src/embed.js";
import { sampleBilinear, type Frame } from "../src/frame.js";
import { SFACE, YUNET } from "../src/models.js";
import { bgrPlanes, setBgr, tensorFrom } from "../src/tensor.js";
import { warpToTemplate } from "../src/warp.js";
import {
  DETECTOR_READY,
  EMBEDDER_READY,
  FIXTURE_READY,
  NO_EMBEDDER,
  NO_FIXTURE,
  describeWhen,
  modelPath,
} from "./models-required.js";
import { loadFace, reframe } from "./helpers.js";

describe("normalise", () => {
  it("returns a unit vector", () => {
    const v = normalise([3, 4]);
    expect(Math.hypot(...v)).toBeCloseTo(1, 9);
  });

  it("leaves a zero vector alone rather than dividing by zero", () => {
    expect(normalise([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("preserves direction", () => {
    expect(cosine(normalise([1, 2, 3]), [1, 2, 3])).toBeCloseTo(1, 9);
  });
});

describe("cosine", () => {
  it("is 1 for identical vectors and -1 for opposed ones", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1, 9);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 9);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 9);
  });

  it("returns 0 rather than NaN when a vector has no magnitude", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

// The spike's bounding-box crop, kept here as the baseline the warp has to
// beat. It is not used in `src/` — its only job is to make the improvement
// measurable rather than asserted.
function bboxCrop(
  frame: Frame,
  box: { x: number; y: number; w: number; h: number },
  size = 112,
) {
  const pad = 0.15;
  const x0 = box.x - box.w * pad;
  const y0 = box.y - box.h * pad;
  const x1 = box.x + box.w * (1 + pad);
  const y1 = box.y + box.h * (1 + pad);
  const planes = bgrPlanes(size, size);
  const plane = size * size;
  for (let oy = 0; oy < size; oy++) {
    const sy = y0 + ((y1 - y0) * oy) / (size - 1);
    for (let ox = 0; ox < size; ox++) {
      const sx = x0 + ((x1 - x0) * ox) / (size - 1);
      const [r, g, b] = sampleBilinear(frame, sx, sy);
      setBgr(planes, plane, oy * size + ox, r, g, b);
    }
  }
  return tensorFrom(planes, size, size);
}

function minPairwise(vectors: number[][]): number {
  let min = 1;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      min = Math.min(min, cosine(vectors[i]!, vectors[j]!));
    }
  }
  return min;
}

describeWhen(
  EMBEDDER_READY && DETECTOR_READY && FIXTURE_READY,
  `${NO_EMBEDDER} / ${NO_FIXTURE}`,
  "Embedder against a real face",
  () => {
    let detector: Detector;
    let embedder: Embedder;
    let face: Frame;

    beforeAll(async () => {
      detector = await Detector.load(modelPath(YUNET));
      embedder = await Embedder.load(modelPath(SFACE));
      face = loadFace();
    });

    async function embedWarped(frame: Frame): Promise<number[]> {
      const [detected] = await detector.detect(frame, 0.6, 0.3);
      if (!detected) throw new Error("no face in a frame the test requires one in");
      return embedder.embed(warpToTemplate(frame, detected.landmarks).tensor);
    }

    async function embedBoxed(frame: Frame): Promise<number[]> {
      const [detected] = await detector.detect(frame, 0.6, 0.3);
      if (!detected) throw new Error("no face in a frame the test requires one in");
      return embedder.embed(bboxCrop(frame, detected));
    }

    it("returns a unit-length vector of the expected width", async () => {
      const embedding = await embedWarped(face);
      expect(embedding).toHaveLength(EMBEDDING_DIMS);
      expect(Math.sqrt(embedding.reduce((a, b) => a + b * b, 0))).toBeCloseTo(1, 5);
    });

    it("is deterministic for the same input", async () => {
      const tensor = warpToTemplate(face, (await detector.detect(face, 0.6, 0.3))[0]!.landmarks).tensor;
      expect(await embedder.embed(tensor)).toEqual(await embedder.embed(tensor));
    });

    // ---------------------------------------------------------------------
    // The reason this unit exists.
    //
    // The origin brief's Measured Constraints recorded the same person
    // embedding at 0.92 on one run and 0.61 on another, seconds apart, using a
    // bounding-box crop — against 0.34 for a crop that is not a face. No
    // threshold fits in that gap, and the brief names landmark alignment as the
    // likely cause and therefore a prerequisite.
    //
    // These variants reproduce the framing changes a head turn produces. The
    // warp has to hold the same person together across them by a wider margin
    // than the bounding-box crop does, or the alignment bought nothing.
    // ---------------------------------------------------------------------
    it("holds the same person together across reframings better than a bounding-box crop", async () => {
      const variants: Frame[] = [
        face,
        reframe(face, 12, 1, 0, 0),
        reframe(face, -12, 1, 0, 0),
        reframe(face, 0, 0.85, 0, 0),
        reframe(face, 3, 1.05, 25, -15),
      ];

      const warped: number[][] = [];
      const boxed: number[][] = [];
      for (const variant of variants) {
        warped.push(await embedWarped(variant));
        boxed.push(await embedBoxed(variant));
      }

      const warpFloor = minPairwise(warped);
      const boxFloor = minPairwise(boxed);

      // The improvement, not merely a passing absolute number.
      expect(warpFloor).toBeGreaterThan(boxFloor);
      // And by a margin that actually leaves room for a threshold. The
      // bounding-box baseline lands near the 0.61 the brief recorded; the warp
      // has to clear it decisively rather than incidentally.
      expect(warpFloor - boxFloor).toBeGreaterThan(0.15);
      expect(warpFloor).toBeGreaterThan(0.8);
    }, 60_000);

    it("scores a non-face far below any same-person pair", async () => {
      // Consistency alone proves nothing: an embedder returning the same
      // vector for every input would ace the test above. This is the spike's
      // own degeneracy check, kept for the same reason.
      const embedding = await embedWarped(face);
      const background = await embedder.embed(bboxCrop(face, { x: 4, y: 4, w: 150, h: 150 }));
      const [detected] = await detector.detect(face, 0.6, 0.3);
      const offTarget = await embedder.embed(
        bboxCrop(face, { x: detected!.x + detected!.w * 1.6, y: detected!.y, w: detected!.w, h: detected!.h }),
      );

      expect(cosine(embedding, background)).toBeLessThan(0.5);
      expect(cosine(embedding, offTarget)).toBeLessThan(0.5);
      // The gap that makes a threshold possible: same person well above,
      // not-a-face well below, with clear air between.
      expect(cosine(embedding, background)).toBeLessThan(minPairwise([embedding, await embedWarped(reframe(face, 12, 1, 0, 0))]) - 0.3);
    }, 60_000);

    it("aligns the fixture's landmarks onto the template within a few pixels", async () => {
      // The correspondence check. A swapped eye or mouth pair — the mistake a
      // wrong template ordering makes — cannot be reconciled by any rotation
      // and leaves a residual an order of magnitude larger.
      const [detected] = await detector.detect(face, 0.6, 0.3);
      const { transform } = warpToTemplate(face, detected!.landmarks);
      expect(transform.residual).toBeLessThan(6);
    });
  },
);
