import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CandidateStore } from "../../src/vision/candidates.js";

function vec(angleDeg: number): number[] {
  const t = (angleDeg * Math.PI) / 180;
  return [Math.cos(t), Math.sin(t)];
}

const CROP = Buffer.from("a jpeg, for the purposes of this test");

// Far enough apart to be three different people: cos(80) = 0.17 and
// cos(160) = -0.94, both well under the same-face bar. Using closer angles
// here made the eviction tests pass without ever evicting anything, because
// the dedupe swallowed the second face — green for the wrong reason.
const THREE_DISTINCT = [0, 80, 160];

// N faces guaranteed mutually distinct, whatever the same-face bar is: one-hot
// vectors are orthogonal, so every pair scores exactly 0. Angles on a 2D circle
// cannot do this past a handful — six at 60 degrees apart put adjacent pairs at
// cosine 0.5, which the dedupe correctly swallows, and the test then measures
// the dedupe instead of the thing it names.
function distinctFaces(n: number): number[][] {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
}

describe("CandidateStore", () => {
  let dir: string;
  let store: CandidateStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-candidates-"));
    store = new CandidateStore(dir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const crops = () => fs.readdir(path.join(dir, "vision-candidates")).catch(() => [] as string[]);

  describe("keeping a face", () => {
    it("queues an unrecognised face and lists it with a thumbnail", async () => {
      const offered = await store.offer(vec(0), CROP, 20);
      expect(offered).not.toBeNull();

      const listed = await store.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.thumbnail).toMatch(/^data:image\/jpeg;base64,/);
      expect(listed[0]!.at).toBeTruthy();
    });

    it("survives a restart, because triage happens later by definition", async () => {
      await store.offer(vec(0), CROP, 20);
      expect(await new CandidateStore(dir).list()).toHaveLength(1);
    });

    it("keeps nothing when the cap is zero", async () => {
      // Triage off, without touching recognition.
      expect(await store.offer(vec(0), CROP, 0)).toBeNull();
      expect(await store.list()).toHaveLength(0);
      expect(await crops()).toHaveLength(0);
    });

    it("lists newest first", async () => {
      await store.offer(vec(0), CROP, 20);
      await store.offer(vec(90), CROP, 20);
      const listed = await store.list();
      // The second face queued is the one most likely to still be nameable.
      expect(listed).toHaveLength(2);
      expect(listed[0]!.id).not.toBe(listed[1]!.id);
    });
  });

  describe("one visit is one item", () => {
    it("does not queue the same face twice", async () => {
      // The property that matters even when appearance continuity fragments a
      // visit: the brief warns the queue would otherwise fill with a hundred
      // crops of one person.
      await store.offer(vec(0), CROP, 20);
      expect(await store.offer(vec(10), CROP, 20)).toBeNull();
      expect(await store.list()).toHaveLength(1);
    });

    it("still queues a genuinely different face", async () => {
      await store.offer(vec(0), CROP, 20);
      expect(await store.offer(vec(80), CROP, 20)).not.toBeNull();
      expect(await store.list()).toHaveLength(2);
    });

    it("leaves no crop behind for a face it declined to queue", async () => {
      await store.offer(vec(0), CROP, 20);
      await store.offer(vec(10), CROP, 20);
      expect(await crops()).toHaveLength(1);
    });
  });

  describe("the bound", () => {
    it("drops the oldest when full", async () => {
      for (const angle of THREE_DISTINCT) await store.offer(vec(angle), CROP, 2);
      expect(await store.list()).toHaveLength(2);
    });

    it("counts what it dropped, so an empty queue is not mistaken for a quiet week", async () => {
      // A bound that discards silently tells the user nobody came when in fact
      // it simply ran out of room — the same failure the brief guards against
      // for expiry, applied to eviction.
      for (const angle of THREE_DISTINCT) await store.offer(vec(angle), CROP, 2);
      expect(store.overflow().dropped).toBe(1);
      expect(store.overflow().since).toBeTruthy();
    });

    it("deletes the crop of anything it drops", async () => {
      for (const angle of THREE_DISTINCT) await store.offer(vec(angle), CROP, 2);
      expect(await crops()).toHaveLength(2);
    });

    it("carries the tally across a restart", async () => {
      for (const angle of THREE_DISTINCT) await store.offer(vec(angle), CROP, 2);
      const reopened = new CandidateStore(dir);
      await reopened.list();
      expect(reopened.overflow().dropped).toBe(1);
    });
  });

  describe("naming one", () => {
    it("returns the embedding and the crop, and removes it from the queue", async () => {
      const offered = await store.offer(vec(0), CROP, 20);
      const taken = await store.take(offered!.id);

      expect(taken?.embedding).toEqual(vec(0));
      // The crop moves to the person rather than being deleted and remade.
      expect(taken?.thumbnail.length).toBeGreaterThan(0);
      expect(await store.list()).toHaveLength(0);
      expect(await crops()).toHaveLength(0);
    });

    it("returns null for an id that is no longer waiting", async () => {
      expect(await store.take("gone")).toBeNull();
    });

    it("cannot be taken twice", async () => {
      const offered = await store.offer(vec(0), CROP, 20);
      await store.take(offered!.id);
      expect(await store.take(offered!.id)).toBeNull();
    });

    it("lets the same person be queued again after being taken", async () => {
      // Taking removes the dedupe anchor, which is correct: if they are now
      // enrolled they will be recognised, and if enrolment failed they should
      // be offered again.
      const offered = await store.offer(vec(0), CROP, 20);
      await store.take(offered!.id);
      expect(await store.offer(vec(0), CROP, 20)).not.toBeNull();
    });
  });

  describe("dismissing one", () => {
    it("deletes the item and its crop and records nothing", async () => {
      const offered = await store.offer(vec(0), CROP, 20);
      expect(await store.dismiss(offered!.id)).toBe(true);
      expect(await store.list()).toHaveLength(0);
      expect(await crops()).toHaveLength(0);
    });

    it("survives a restart", async () => {
      const offered = await store.offer(vec(0), CROP, 20);
      await store.dismiss(offered!.id);
      expect(await new CandidateStore(dir).list()).toHaveLength(0);
    });

    it("means the same person is queued again tomorrow", async () => {
      // The accepted cost of not keeping a gallery of unrecognised people: a
      // recurring visitor who is never named is flagged every time.
      const offered = await store.offer(vec(0), CROP, 20);
      await store.dismiss(offered!.id);
      expect(await store.offer(vec(0), CROP, 20)).not.toBeNull();
    });

    it("is a no-op for an id that does not exist", async () => {
      expect(await store.dismiss("nobody")).toBe(false);
    });
  });

  describe("clearing everything", () => {
    it("removes the items, the crops and the tally", async () => {
      for (const angle of THREE_DISTINCT) await store.offer(vec(angle), CROP, 2);
      await store.clear();
      expect(await store.list()).toHaveLength(0);
      expect(await crops()).toHaveLength(0);
      expect(store.overflow().dropped).toBe(0);
    });
  });

  describe("a damaged file", () => {
    it("starts empty and says so rather than taking Vision down", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      await fs.writeFile(path.join(dir, "vision-candidates.json"), JSON.stringify({ candidates: "nope" }));
      const damaged = new CandidateStore(dir);
      expect(await damaged.list()).toEqual([]);
      expect(spy).toHaveBeenCalled();
    });

    it("omits an item whose crop has gone missing rather than listing a blank", async () => {
      await store.offer(vec(0), CROP, 20);
      await fs.rm(path.join(dir, "vision-candidates"), { recursive: true, force: true });
      expect(await store.list()).toEqual([]);
    });
  });
});

describe("CandidateStore — concurrent mutations", () => {
  let dir: string;
  let store: CandidateStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-cand-race-"));
    store = new CandidateStore(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("keeps every distinct face when offers arrive together", async () => {
    // The detection loop offers while the user triages; nothing upstream
    // serialises them, and load-modify-write without a lock drops writes.
    await Promise.all(THREE_DISTINCT.map((a) => store.offer(vec(a), CROP, 20)));
    expect(await store.list()).toHaveLength(3);
  });

  it("does not resurrect a dismissed face via an offer in flight", async () => {
    const first = await store.offer(vec(0), CROP, 20);
    await Promise.all([store.dismiss(first!.id), store.offer(vec(80), CROP, 20)]);

    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).not.toBe(first!.id);
  });

  it("counts every eviction in a concurrent burst", async () => {
    // The tally is the assertion that cannot be right by coincidence.
    await Promise.all(distinctFaces(6).map((e) => store.offer(e, CROP, 2)));
    const kept = (await store.list()).length;
    expect(kept).toBe(2);
    expect(kept + store.overflow().dropped).toBe(6);
  });

  it("takes a candidate exactly once under contention", async () => {
    // Two clients naming the same face must not both get the embedding, or the
    // person is enrolled twice from one crop.
    const offered = await store.offer(vec(0), CROP, 20);
    const results = await Promise.all([store.take(offered!.id), store.take(offered!.id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
