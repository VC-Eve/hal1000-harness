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

  // How wide the face was in the frame is the reviewer's only clue that a
  // capture was distant before they open it. The public `offer` accepted the
  // number and dropped it on the way to `offerUnlocked`, so the real store has
  // never once persisted it — invisible because the fake store forwards it and
  // the UI tests inject it straight into state.
  describe("the capture width survives the offer", () => {
    it("persists the width it was given", async () => {
      await store.offer(vec(0), CROP, 20, undefined, 128);

      const [listed] = await store.list();
      expect(listed?.sourceWidth).toBe(128);
    });

    it("still reads back after a restart", async () => {
      await store.offer(vec(0), CROP, 20, undefined, 96);

      const [listed] = await new CandidateStore(dir).list();
      expect(listed?.sourceWidth).toBe(96);
    });

    it("omits the width when none was measured", async () => {
      await store.offer(vec(0), CROP, 20);

      const [listed] = await store.list();
      expect(listed?.sourceWidth).toBeUndefined();
    });
  });

  // The shelf: a face held with no expiry, until the user acts. Two properties
  // carry the feature — a shelved face is not displaced by a stranger arriving,
  // and it stays in the duplicate check so its owner does not re-queue on every
  // visit for the rest of time.
  describe("setting a face aside", () => {
    it("keeps a shelved face when the active bound would have dropped it", async () => {
      const shelved = await store.offer(vec(0), CROP, 1);
      await store.setAside(shelved!.id, 10);

      // The active pool is capped at one, and this is the second face.
      const arrival = await store.offer(vec(80), CROP, 1);

      const ids = (await store.list()).map((c) => c.id);
      expect(ids).toContain(shelved!.id);
      expect(ids).toContain(arrival!.id);
      expect(store.overflow().dropped).toBe(0);
    });

    it("drops the longest-shelved face when the shelf is full", async () => {
      const a = await store.offer(vec(0), CROP, 10);
      const b = await store.offer(vec(80), CROP, 10);
      const c = await store.offer(vec(160), CROP, 10);
      await store.setAside(a!.id, 2);
      await store.setAside(b!.id, 2);
      await store.setAside(c!.id, 2);

      const ids = (await store.list()).map((x) => x.id);
      expect(ids).not.toContain(a!.id);
      expect(ids).toEqual(expect.arrayContaining([b!.id, c!.id]));
      expect(store.setAsideOverflow().dropped).toBe(1);
      // The shelf's own counter, not the one that means "a stranger you never
      // looked at". Those are different sentences and must not share a number.
      expect(store.overflow().dropped).toBe(0);
    });

    it("evicts by when it was shelved, not by when it was seen", async () => {
      // `old` was seen first, so it sits first in the array — but it is shelved
      // second, so it is the newer thing on the shelf and must outlive `recent`.
      const old = await store.offer(vec(0), CROP, 10);
      const recent = await store.offer(vec(80), CROP, 10);
      await store.setAside(recent!.id, 1);
      await new Promise((r) => setTimeout(r, 2));
      await store.setAside(old!.id, 1);

      const ids = (await store.list()).map((x) => x.id);
      expect(ids).toContain(old!.id);
      expect(ids).not.toContain(recent!.id);
    });

    it("refuses to restore into a full active pool", async () => {
      const shelved = await store.offer(vec(0), CROP, 10);
      await store.setAside(shelved!.id, 10);
      await store.offer(vec(80), CROP, 10);

      // Evicting to make room would charge a pending face to the tally the user
      // reads as "dropped before you looked at it" — a sentence about a
      // stranger, for a drop they caused by clicking restore.
      expect(await store.restore(shelved!.id, 1)).toBe(false);
      expect(store.overflow().dropped).toBe(0);
      expect((await store.list()).find((c) => c.id === shelved!.id)?.setAsideAt).toBeDefined();
    });

    it("restores into a pool with room", async () => {
      const shelved = await store.offer(vec(0), CROP, 10);
      await store.setAside(shelved!.id, 10);

      expect(await store.restore(shelved!.id, 10)).toBe(true);
      expect((await store.list())[0]?.setAsideAt).toBeUndefined();
    });

    it("reports which pool a taken face came from", async () => {
      const shelved = await store.offer(vec(0), CROP, 10);
      await store.setAside(shelved!.id, 10);

      // Without this the enrolment rollback puts a shelved face back as
      // pending, undoing the deferral and charging a stranger's tally.
      expect((await store.take(shelved!.id))?.setAside).toBe(true);
    });

    it("counts both pools apart, for the purge confirmation", async () => {
      const shelved = await store.offer(vec(0), CROP, 10);
      await store.offer(vec(80), CROP, 10);
      await store.setAside(shelved!.id, 10);

      expect(await store.count()).toEqual({ pending: 1, setAside: 1, total: 2 });
    });

    it("survives a restart still shelved", async () => {
      const shelved = await store.offer(vec(0), CROP, 10);
      await store.setAside(shelved!.id, 10);

      const [listed] = await new CandidateStore(dir).list();
      expect(listed?.setAsideAt).toBeDefined();
    });

    it("carries both new tallies across a restart", async () => {
      // The pending tally is already covered, which is exactly why this needed
      // its own case: `load()` rebuilt the cache field by field, and a field it
      // did not name read as absent — then the next write persisted the cache
      // over the file, so a restart did not merely fail to show these counts,
      // it erased them. A tally nobody acknowledged must not vanish because HAL
      // was restarted.
      const a = await store.offer(vec(0), CROP, 10);
      const b = await store.offer(vec(80), CROP, 10);
      await store.setAside(a!.id, 1);
      await store.setAside(b!.id, 1);
      await store.offer(vec(80), CROP, 10);

      const reopened = new CandidateStore(dir);
      await reopened.list();
      expect(reopened.setAsideOverflow().dropped).toBe(1);
      expect(reopened.shelfMatches().matched).toBe(1);

      // And a write after the restart keeps them, rather than persisting a
      // cache that lost them on the way in.
      await reopened.offer(vec(160), CROP, 10);
      const again = new CandidateStore(dir);
      await again.list();
      expect(again.setAsideOverflow().dropped).toBe(1);
      expect(again.shelfMatches().matched).toBe(1);
    });

    it("is a no-op on an unknown id, and on one already shelved", async () => {
      expect(await store.setAside("nope", 10)).toBe(false);
      expect(await store.restore("nope", 10)).toBe(false);
      const shelved = await store.offer(vec(0), CROP, 10);
      await store.setAside(shelved!.id, 10);
      expect(await store.setAside(shelved!.id, 10)).toBe(false);
    });
  });

  // What happens when someone on the shelf comes back. Dropping the arrival
  // silently would freeze the face at whatever capture made it undecidable —
  // usually the reason it was shelved — and leave no sign they had been in.
  describe("a shelved face seen again", () => {
    it("does not make a second item", async () => {
      const shelved = await store.offer(vec(0), CROP, 10);
      await store.setAside(shelved!.id, 10);

      expect(await store.offer(vec(5), CROP, 10)).toBeNull();
      expect(await store.list()).toHaveLength(1);
    });

    it("stamps it as seen again", async () => {
      const shelved = await store.offer(vec(0), CROP, 10);
      await store.setAside(shelved!.id, 10);

      await store.offer(vec(5), CROP, 10);

      expect((await store.list())[0]?.lastSeenAt).toBeDefined();
    });

    it("keeps the wider capture of the two", async () => {
      const shelved = await store.offer(vec(0), CROP, 10, undefined, 64);
      await store.setAside(shelved!.id, 10);

      await store.offer(vec(5), CROP, 10, undefined, 180);

      expect((await store.list())[0]?.sourceWidth).toBe(180);
    });

    it("keeps the stored capture when the new one is narrower", async () => {
      const shelved = await store.offer(vec(0), CROP, 10, undefined, 180);
      await store.setAside(shelved!.id, 10);

      await store.offer(vec(5), CROP, 10, undefined, 64);

      expect((await store.list())[0]?.sourceWidth).toBe(180);
    });

    it("counts the match, because the queue is a stranger's only way in", async () => {
      const shelved = await store.offer(vec(0), CROP, 10);
      await store.setAside(shelved!.id, 10);

      await store.offer(vec(5), CROP, 10);

      expect(store.shelfMatches().matched).toBe(1);
      expect(store.shelfMatches().since).not.toBeNull();
    });

    it("does not count a duplicate of a pending face", async () => {
      await store.offer(vec(0), CROP, 10);
      await store.offer(vec(5), CROP, 10);

      expect(store.shelfMatches().matched).toBe(0);
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
      // What dismissing costs, and the reason the shelf exists: a dismissed
      // face keeps nothing, so a recurring visitor who is never named is
      // flagged every time. Setting the face aside is the answer to that; this
      // is the behaviour for the user who said no rather than not yet.
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
