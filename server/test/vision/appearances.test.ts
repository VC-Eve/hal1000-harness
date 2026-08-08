import { beforeEach, describe, expect, it } from "vitest";
import {
  APPEARANCE_GAP_MS,
  AppearanceTracker,
  CONTINUITY_THRESHOLD,
} from "../../src/vision/appearances.js";
import type { DetectedFace } from "../../src/vision/recogniser.js";
import type { Match } from "../../src/vision/people.js";

// Embeddings are unit vectors, so two faces are "the same person" when their
// vectors point the same way. Building them from an angle makes the similarity
// between any two exactly controllable, which is what these tests need — the
// question is never "does SFace work" but "does the tracker draw the lines
// where the acceptance examples say".
function faceAt(angleDeg: number, box = { x: 0, y: 0, w: 100, h: 100 }): DetectedFace {
  const t = (angleDeg * Math.PI) / 180;
  return {
    box,
    score: 0.95,
    landmarks: [],
    embedding: [Math.cos(t), Math.sin(t)],
    alignment: 1,
  };
}

// Similarity between two faceAt vectors is cos(difference), so:
//   0 deg apart  -> 1.00   (same face, next frame)
//   20 deg apart -> 0.94   (same person, barely moved)
//   50 deg apart -> 0.64   (same person across independent captures — the
//                           real loop measured 0.53 to 0.78 for this)
//   75 deg apart -> 0.26   (a different person)
//
// The different-person figure is anchored on two things: a non-face scores
// 0.21 against a face on this pipeline, and OpenCV publishes 0.363 as SFace's
// same-identity threshold — so anything a model would call a different person
// sits below that. An earlier draft of this file used 0.50 for "different",
// which is above OpenCV's own same-identity bar and therefore describes the
// same person, not a different one.
const SAME = 0;
const MOVED = 20;
const DIFFERENT = 75;

function noMatch(): Promise<Match | null> {
  return Promise.resolve(null);
}

describe("AppearanceTracker", () => {
  let tracker: AppearanceTracker;

  beforeEach(() => {
    tracker = new AppearanceTracker();
  });

  it("sets its continuity bar under the observed same-person floor", () => {
    // Measured on the real loop: independent captures of one person, seconds
    // apart, score 0.53 to 0.78 against each other. A bar above that floor
    // fragmented a single visit into seventeen appearances — so this constant
    // has to stay under it, and a future edit raising it back past 0.8 should
    // fail here rather than in the feed.
    expect(CONTINUITY_THRESHOLD).toBeLessThan(0.8);
    // And not so low that two different people would merge; a non-face scores
    // 0.21 against a face.
    expect(CONTINUITY_THRESHOLD).toBeGreaterThan(0.4);
  });

  it("holds a visit together across the observed same-person range", () => {
    // The regression this slice actually shipped and had to fix. 40 degrees
    // apart is cosine 0.766; 60 degrees is 0.5 — both inside the measured
    // range for one person across independent captures, and both must continue
    // the same appearance when the face has not moved.
    const box = { x: 100, y: 100, w: 120, h: 120 };
    const drift = { x: 104, y: 103, w: 122, h: 121 };

    const open = tracker.observe([faceAt(0, box)], 0, noMatch);
    return open.then(async (first) => {
      // cos(40) = 0.766 — the top of the measured range.
      const second = await tracker.observe([faceAt(40, drift)], 2_000, noMatch);
      expect(second).toHaveLength(1);
      expect(second[0]!.id).toBe(first[0]!.id);

      // cos(58) = 0.530 — the bottom of it, held together by the boxes
      // overlapping, which is what a stationary person's do.
      const third = await tracker.observe([faceAt(58, box)], 4_000, noMatch);
      expect(third).toHaveLength(1);
      expect(third[0]!.id).toBe(first[0]!.id);
    });
  });

  it("still refuses a different person who steps into the same place", () => {
    // The other side of that trade. Loosening continuity must not let AE10
    // through: overlapping boxes are not enough on their own.
    const box = { x: 100, y: 100, w: 120, h: 120 };
    return tracker.observe([faceAt(0, box)], 0, noMatch).then(async (first) => {
      const second = await tracker.observe([faceAt(DIFFERENT, box)], 2_000, noMatch);
      const fresh = second.filter((a) => a.id !== first[0]!.id);
      expect(fresh).toHaveLength(1);
    });
  });

  describe("collapsing one visit", () => {
    it("treats consecutive detections of one face as a single appearance", async () => {
      // Covers AE8's appearance half: one visit is one identity decision, not
      // one per detection. Without this the summariser sees identity
      // alternating and reads it as arrivals and departures.
      const first = await tracker.observe([faceAt(SAME)], 0, noMatch);
      const second = await tracker.observe([faceAt(MOVED)], 3_000, noMatch);
      const third = await tracker.observe([faceAt(SAME)], 6_000, noMatch);

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(third).toHaveLength(1);
      expect(second[0]!.id).toBe(first[0]!.id);
      expect(third[0]!.id).toBe(first[0]!.id);
    });

    it("decides identity once, on entry, and does not revisit it", async () => {
      // The gallery IS consulted every frame — that lookup is what lets a face
      // matching person P continue the appearance already resolved to P, which
      // is the strongest continuity signal available. What must not change is
      // the DECISION: once an appearance is matched, a later frame cannot
      // un-match it, or a single weak detection flips it to unrecognised and
      // back, and the summariser reads that as leaving and returning.
      const confidences = [0.9, 0.55, 0.88];
      let call = 0;
      const gallery = async (): Promise<Match | null> => {
        const confidence = confidences[Math.min(call++, confidences.length - 1)]!;
        return { personId: "p1", name: "Dave", confidence };
      };

      const first = await tracker.observe([faceAt(SAME)], 0, gallery);
      const second = await tracker.observe([faceAt(MOVED)], 3_000, gallery);
      const third = await tracker.observe([faceAt(SAME)], 6_000, gallery);

      // One appearance throughout, and the confidence it was opened with is
      // the confidence it keeps.
      expect(second[0]!.id).toBe(first[0]!.id);
      expect(third[0]!.id).toBe(first[0]!.id);
      expect(third[0]!.match?.confidence).toBeCloseTo(0.9, 5);
    });

    it("keeps one person on one appearance even when the embedding drifts apart", async () => {
      // The fix for what the live run showed: a real person's frame-to-frame
      // similarity dips below the continuity bar as they move and change
      // expression, and each dip used to open a duplicate. Two different people
      // cannot both be the same enrolled person, so matching the gallery to the
      // same id continues the appearance regardless of drift.
      const gallery = async (): Promise<Match | null> => ({ personId: "p1", name: "Dave", confidence: 0.8 });

      const first = await tracker.observe([faceAt(0, { x: 0, y: 0, w: 100, h: 100 })], 0, gallery);
      // 85 degrees apart is cosine 0.087 — far below any continuity bar — and
      // the boxes do not overlap either. Identity is the only thing holding
      // this together, and it should be enough.
      const second = await tracker.observe([faceAt(85, { x: 400, y: 300, w: 90, h: 90 })], 3_000, gallery);

      expect(second).toHaveLength(1);
      expect(second[0]!.id).toBe(first[0]!.id);
    });

    it("does not un-match an open appearance when a later detection would score lower", async () => {
      let first = true;
      const gallery = async (): Promise<Match | null> => {
        if (first) {
          first = false;
          return { personId: "p1", name: "Dave", confidence: 0.9 };
        }
        return null;
      };

      const opened = await tracker.observe([faceAt(SAME)], 0, gallery);
      expect(opened[0]!.match?.name).toBe("Dave");

      const later = await tracker.observe([faceAt(MOVED)], 3_000, gallery);
      expect(later[0]!.match?.name).toBe("Dave");
    });

    it("survives a single missed detection inside the gap", async () => {
      // A face that turns away for one interval must not refragment the visit.
      const opened = await tracker.observe([faceAt(SAME)], 0, noMatch);
      await tracker.observe([], 3_000, noMatch);
      const resumed = await tracker.observe([faceAt(MOVED)], 6_000, noMatch);

      expect(resumed).toHaveLength(1);
      expect(resumed[0]!.id).toBe(opened[0]!.id);
    });
  });

  describe("two people in frame", () => {
    it("produces two appearances with independent identity states", async () => {
      // Covers AE9. An enrolled person beside an unenrolled one must stay two
      // appearances — collapsing them is how a stranger inherits a name.
      const gallery = async (embedding: number[]): Promise<Match | null> =>
        embedding[0]! > 0.9 ? { personId: "p1", name: "Dave", confidence: 0.95 } : null;

      const open = await tracker.observe(
        [faceAt(SAME, { x: 0, y: 0, w: 100, h: 100 }), faceAt(DIFFERENT, { x: 300, y: 0, w: 100, h: 100 })],
        0,
        gallery,
      );

      expect(open).toHaveLength(2);
      const named = open.filter((a) => a.match !== null);
      const unnamed = open.filter((a) => a.match === null);
      expect(named).toHaveLength(1);
      expect(unnamed).toHaveLength(1);
      expect(named[0]!.match?.name).toBe("Dave");
    });

    it("keeps two look-alike faces in one frame as two appearances", async () => {
      // The rule similarity alone would violate: one appearance may claim at
      // most one face per observation. Identical twins, or simply two faces the
      // embedder cannot separate, must still be two appearances — a frame
      // physically contains two people.
      const open = await tracker.observe(
        [faceAt(SAME, { x: 0, y: 0, w: 100, h: 100 }), faceAt(SAME, { x: 400, y: 0, w: 100, h: 100 })],
        0,
        noMatch,
      );
      expect(open).toHaveLength(2);
      expect(new Set(open.map((a) => a.id)).size).toBe(2);
    });

    it("keeps each person on their own appearance across frames", async () => {
      const boxA = { x: 0, y: 0, w: 100, h: 100 };
      const boxB = { x: 400, y: 0, w: 100, h: 100 };
      const first = await tracker.observe([faceAt(SAME, boxA), faceAt(DIFFERENT, boxB)], 0, noMatch);
      const second = await tracker.observe([faceAt(DIFFERENT, boxB), faceAt(MOVED, boxA)], 3_000, noMatch);

      expect(second).toHaveLength(2);
      // Same two appearance ids, regardless of the order the recogniser
      // returned the faces in.
      expect(new Set(second.map((a) => a.id))).toEqual(new Set(first.map((a) => a.id)));
    });
  });

  describe("the gap window", () => {
    it("does not let a different person inherit an identity inside the gap", async () => {
      // Covers AE10, and it is the reason continuity keys on the embedding
      // rather than on position. The second person occupies the same pixels —
      // box overlap alone would hand them the first person's name.
      const box = { x: 0, y: 0, w: 100, h: 100 };
      let asked = 0;
      const gallery = async (): Promise<Match | null> => {
        asked += 1;
        return asked === 1 ? { personId: "p1", name: "Dave", confidence: 0.95 } : null;
      };

      const first = await tracker.observe([faceAt(SAME, box)], 0, gallery);
      expect(first[0]!.match?.name).toBe("Dave");

      // Well inside the gap, same position, different face.
      const second = await tracker.observe([faceAt(DIFFERENT, box)], 2_000, gallery);
      const fresh = second.find((a) => a.id !== first[0]!.id);

      expect(fresh).toBeDefined();
      expect(fresh!.match).toBeNull();
      expect(asked).toBe(2);
    });

    it("closes an appearance once the gap elapses with no matching detection", async () => {
      const opened = await tracker.observe([faceAt(SAME)], 0, noMatch);
      const after = await tracker.observe([], APPEARANCE_GAP_MS + 1, noMatch);
      expect(after).toHaveLength(0);

      const returned = await tracker.observe([faceAt(SAME)], APPEARANCE_GAP_MS + 2, noMatch);
      expect(returned).toHaveLength(1);
      expect(returned[0]!.id).not.toBe(opened[0]!.id);
    });

    it("re-decides identity for a person who leaves and comes back", async () => {
      let calls = 0;
      const gallery = async (): Promise<Match | null> => {
        calls += 1;
        return { personId: "p1", name: "Dave", confidence: 0.9 };
      };

      await tracker.observe([faceAt(SAME)], 0, gallery);
      await tracker.observe([], APPEARANCE_GAP_MS + 1, gallery);
      await tracker.observe([faceAt(SAME)], APPEARANCE_GAP_MS + 2, gallery);

      expect(calls).toBe(2);
    });
  });

  describe("retention (R5)", () => {
    it("holds no face data for a closed appearance", async () => {
      // R5 is a retention guarantee, not just a behaviour, so it is asserted on
      // the tracker's own state rather than inferred from what it returns.
      await tracker.observe([faceAt(SAME)], 0, noMatch);
      expect(tracker.open()).toHaveLength(1);

      await tracker.observe([], APPEARANCE_GAP_MS + 1, noMatch);
      expect(tracker.open()).toHaveLength(0);
      expect(JSON.stringify(tracker.open())).not.toContain("embedding");
    });

    it("drops everything on reset, for when Vision is switched off", async () => {
      await tracker.observe([faceAt(SAME)], 0, noMatch);
      tracker.reset();
      expect(tracker.open()).toHaveLength(0);
    });
  });

  describe("degraded detection", () => {
    it("tracks a face with no embedding by position and never names it", async () => {
      // The recogniser can detect without being able to embed. Continuity by
      // box overlap keeps the appearance from refragmenting, but a face with no
      // vector must never be assigned an identity — that would be a guess.
      const box = { x: 10, y: 10, w: 100, h: 100 };
      const nearby = { x: 14, y: 12, w: 100, h: 100 };
      const gallery = async (): Promise<Match | null> => ({
        personId: "p1",
        name: "Dave",
        confidence: 0.99,
      });

      const bare = (b: typeof box): DetectedFace => ({
        box: b,
        score: 0.9,
        landmarks: [],
        embedding: null,
        alignment: 1,
      });

      const first = await tracker.observe([bare(box)], 0, gallery);
      expect(first[0]!.match).toBeNull();
      expect(first[0]!.embedded).toBe(false);

      const second = await tracker.observe([bare(nearby)], 3_000, gallery);
      expect(second).toHaveLength(1);
      expect(second[0]!.id).toBe(first[0]!.id);
      expect(second[0]!.match).toBeNull();
    });

    it("does not continue an embedded appearance with an unembedded face", async () => {
      // Mixing the two would let a face nobody can identify silently inherit a
      // name decided from a real embedding.
      const box = { x: 0, y: 0, w: 100, h: 100 };
      const first = await tracker.observe([faceAt(SAME, box)], 0, noMatch);
      const second = await tracker.observe(
        [{ box, score: 0.9, landmarks: [], embedding: null, alignment: 1 }],
        2_000,
        noMatch,
      );

      // The embedded appearance is still open — it is inside the gap. What must
      // not happen is the unembedded face EXTENDING it: the original's
      // last-seen stays put, and the bare face gets an appearance of its own.
      const original = second.find((a) => a.id === first[0]!.id);
      expect(original).toBeDefined();
      expect(original!.lastSeen).toBe(0);

      const opened = second.filter((a) => a.id !== first[0]!.id);
      expect(opened).toHaveLength(1);
      expect(opened[0]!.embedded).toBe(false);
      expect(opened[0]!.match).toBeNull();
    });
  });

  describe("edges", () => {
    it("returns an empty set for no detections without throwing", async () => {
      await expect(tracker.observe([], 0, noMatch)).resolves.toEqual([]);
    });

    it("survives a gallery lookup that rejects, leaving the appearance unmatched", async () => {
      // A gallery read failing mid-detection must not take the loop down or
      // invent an identity.
      const failing = async (): Promise<Match | null> => {
        throw new Error("disk went away");
      };
      const open = await tracker.observe([faceAt(SAME)], 0, failing);
      expect(open).toHaveLength(1);
      expect(open[0]!.match).toBeNull();
    });

    it("reports first-seen and last-seen so a caller can age an appearance", async () => {
      await tracker.observe([faceAt(SAME)], 1_000, noMatch);
      const later = await tracker.observe([faceAt(MOVED)], 4_000, noMatch);
      expect(later[0]!.firstSeen).toBe(1_000);
      expect(later[0]!.lastSeen).toBe(4_000);
    });
  });
});
