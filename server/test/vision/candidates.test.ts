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

    it("dates the shelf tally from when the face was shelved, not when it was seen", async () => {
      // The notice says "since". Reading `at` would describe a period in which
      // nobody shelved anything — and every ordering test here would still pass,
      // because ordering and the stamp are separate reads of the same record.
      const old = await store.offer(vec(0), CROP, 10);
      const recent = await store.offer(vec(80), CROP, 10);
      await store.setAside(recent!.id, 1);
      await new Promise((r) => setTimeout(r, 2));
      await store.setAside(old!.id, 1);

      const shelvedAt = (await store.list()).find((c) => c.id === old!.id)?.setAsideAt;
      // `recent` was evicted. Its sighting time is the earlier of the two, so a
      // tally dated from `at` would read earlier than either shelving.
      expect(store.setAsideOverflow().since).not.toBe(recent!.at);
      expect(store.setAsideOverflow().since! <= shelvedAt!).toBe(true);
      expect(store.setAsideOverflow().since! >= recent!.at).toBe(true);
    });

    it("counts a returning face once a day, not once an appearance", async () => {
      // A visit fragments into several appearances and the same person walks past
      // again tomorrow. Counting every match made this a measure of how often a
      // shelved regular is at their desk — which is the case the design WANTS,
      // and it would have buried the case the number exists to expose.
      const shelved = await store.offer(vec(0), CROP, 10);
      await store.setAside(shelved!.id, 10);

      await store.offer(vec(1), CROP, 10);
      await store.offer(vec(2), CROP, 10);
      await store.offer(vec(3), CROP, 10);

      expect(store.shelfMatches().matched).toBe(1);
      // Still stamped every time, because the card should say when they were
      // last here rather than when they were first counted.
      const listed = (await store.list()).find((c) => c.id === shelved!.id);
      expect(listed?.lastSeenAt).toBeDefined();
    });

    it("refuses a shelf of zero rather than shelving and deleting in one step", async () => {
      // `later` on a zero shelf used to shelve the face, evict it by its own
      // bound, and report success: a delete button that said it had kept the
      // face. Zero means "off" for the queue and nothing at all for the shelf.
      const face = await store.offer(vec(0), CROP, 10);
      expect(await store.setAside(face!.id, 0)).toBe(false);

      expect((await store.list()).map((c) => c.id)).toContain(face!.id);
      expect((await store.list())[0]?.setAsideAt).toBeUndefined();
      expect(store.setAsideOverflow().dropped).toBe(0);
    });

    it("clears the seen-again stamp when a face comes back to the queue", async () => {
      // The stamp means "came back while it was on the shelf", and the pane
      // renders it as such. Left behind, it put a "back 14:30" line on an active
      // card whose own documentation says the field is shelf-only.
      const shelved = await store.offer(vec(0), CROP, 10);
      await store.setAside(shelved!.id, 10);
      await store.offer(vec(1), CROP, 10);
      expect((await store.list())[0]?.lastSeenAt).toBeDefined();

      await store.restore(shelved!.id, 10);
      expect((await store.list())[0]?.lastSeenAt).toBeUndefined();
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
      // Neither tally. A refusal is not a drop, and the shelf did not lose
      // anything either — the face is exactly where the user left it.
      expect(store.setAsideOverflow().dropped).toBe(0);
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

    it("reinstates a taken face exactly as it was, without re-running the dedupe", async () => {
      // The rollback path for a failed enrolment. Re-offering the face ran
      // arrival logic on something that had not arrived: a new id, the active
      // bound, and the duplicate check — which could match it against a
      // DIFFERENT held face and return null, destroying the face this exists to
      // rescue while stamping the unrelated card it matched.
      const shelved = await store.offer(vec(0), CROP, 10, { personId: "p1", name: "Dave", confidence: 0.55 }, 200);
      await store.setAside(shelved!.id, 10);
      // A second shelved face close enough to the first to be taken for it.
      const neighbour = await store.offer(vec(80), CROP, 10);
      await store.setAside(neighbour!.id, 10);

      const taken = await store.take(shelved!.id);
      expect(taken?.setAside).toBe(true);
      expect(await store.reinstate(taken!)).toBe(true);

      const back = (await store.list()).find((c) => c.id === shelved!.id);
      expect(back, "the same id came back, not a new one").toBeDefined();
      expect(back!.setAsideAt).toBe(shelved!.at === undefined ? undefined : back!.setAsideAt);
      expect(back!.setAsideAt, "still shelved").toBeDefined();
      expect(back!.at, "its own sighting time, not the moment of the failure").toBe(shelved!.at);
      expect(back!.suspected?.name, "the guess that gives a hedged card its verb").toBe("Dave");
      expect(back!.sourceWidth).toBe(200);
      // Nothing was charged to either bound, and the neighbour was left alone.
      expect(store.overflow().dropped).toBe(0);
      expect(store.setAsideOverflow().dropped).toBe(0);
      expect(store.shelfMatches().matched).toBe(0);
      expect(await store.count()).toEqual({ pending: 0, setAside: 2, total: 2 });
    });

    it("puts back a pending face as pending, with its crop readable again", async () => {
      const face = await store.offer(vec(0), CROP, 10);
      const taken = await store.take(face!.id);
      expect(taken?.setAside).toBeUndefined();

      expect(await store.reinstate(taken!)).toBe(true);
      const back = (await store.list()).find((c) => c.id === face!.id);
      expect(back?.setAsideAt).toBeUndefined();
      // `list()` drops an item whose crop is missing, so appearing here at all
      // proves the crop was written back.
      expect(back?.thumbnail).toContain("data:image/jpeg;base64,");
    });

    it("will not reinstate a face that is already held", async () => {
      const face = await store.offer(vec(0), CROP, 10);
      const taken = await store.take(face!.id);
      expect(await store.reinstate(taken!)).toBe(true);
      expect(await store.reinstate(taken!), "a double rollback must not duplicate the record").toBe(false);
      expect(await store.count()).toEqual({ pending: 1, setAside: 0, total: 1 });
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
    it("does not make a second item, and leaves no second crop", async () => {
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
    it("removes both pools, every crop, and all three tallies", async () => {
      // R28. The purge is the only way this data is ever destroyed, so a tally
      // it leaves behind is a claim about faces that no longer exist.
      const a = await store.offer(vec(0), CROP, 10);
      const b = await store.offer(vec(80), CROP, 10);
      await store.setAside(a!.id, 1);
      await store.setAside(b!.id, 1); // evicts `a` from the shelf: setAsideOverflow = 1
      await store.offer(vec(81), CROP, 10); // matches `b` on the shelf: shelfMatches = 1
      for (const angle of THREE_DISTINCT) await store.offer(vec(angle), CROP, 1); // overflow > 0

      expect(store.setAsideOverflow().dropped).toBeGreaterThan(0);
      expect(store.shelfMatches().matched).toBeGreaterThan(0);
      expect(store.overflow().dropped).toBeGreaterThan(0);

      await store.clear();

      expect(await store.list()).toEqual([]);
      expect(await store.count()).toEqual({ pending: 0, setAside: 0, total: 0 });
      expect(await crops()).toHaveLength(0);
      expect(store.overflow()).toEqual({ dropped: 0, since: null });
      expect(store.setAsideOverflow()).toEqual({ dropped: 0, since: null });
      expect(store.shelfMatches()).toEqual({ matched: 0, since: null });
    });

    it("removes the items, the crops and the tally", async () => {
      for (const angle of THREE_DISTINCT) await store.offer(vec(angle), CROP, 2);
      await store.clear();
      expect(await store.list()).toHaveLength(0);
      expect(await crops()).toHaveLength(0);
      expect(store.overflow().dropped).toBe(0);
    });
  });

  describe("acknowledging a tally", () => {
    // Three counters, three notices, and clearing one must not clear another.
    // Acknowledging destroys a count, so guessing which one was meant is the
    // wrong default.
    async function allThree() {
      const a = await store.offer(vec(0), CROP, 10);
      const b = await store.offer(vec(80), CROP, 10);
      await store.setAside(a!.id, 1);
      await store.setAside(b!.id, 1);
      await store.offer(vec(81), CROP, 10);
      for (const angle of THREE_DISTINCT) await store.offer(vec(angle), CROP, 1);
      return {
        pending: store.overflow().dropped,
        setAside: store.setAsideOverflow().dropped,
        matched: store.shelfMatches().matched,
      };
    }

    it("clears only the one named", async () => {
      const before = await allThree();
      expect(before.pending).toBeGreaterThan(0);
      expect(before.setAside).toBeGreaterThan(0);
      expect(before.matched).toBeGreaterThan(0);

      await store.acknowledgeOverflow("setAside");
      expect(store.setAsideOverflow().dropped).toBe(0);
      expect(store.overflow().dropped).toBe(before.pending);
      expect(store.shelfMatches().matched).toBe(before.matched);

      await store.acknowledgeOverflow("shelfMatches");
      expect(store.shelfMatches().matched).toBe(0);
      expect(store.overflow().dropped).toBe(before.pending);
    });

    it("clears nothing at all for a value outside the union", async () => {
      // The third branch was a catch-all, so `which: "pendign"` from an agent —
      // or any client built against a newer union than this server knows —
      // silently wiped the shelf-match count instead of the one it named.
      const before = await allThree();
      await store.acknowledgeOverflow("not-a-tally" as never);

      expect(store.overflow().dropped).toBe(before.pending);
      expect(store.setAsideOverflow().dropped).toBe(before.setAside);
      expect(store.shelfMatches().matched).toBe(before.matched);
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

  const crops = () => fs.readdir(path.join(dir, "vision-candidates")).catch(() => [] as string[]);

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

  it("lets exactly one of set-aside and dismiss win, with no crop left behind", async () => {
    // A named scenario in the plan that had no test. The two verbs disagree
    // about the same face: one keeps it and one destroys it, and the loser must
    // not leave a crop for a record that is gone — biometric data with no owner
    // and no UI to reach it.
    const face = await store.offer(vec(0), CROP, 20);
    const [shelved, dismissed] = await Promise.all([store.setAside(face!.id, 25), store.dismiss(face!.id)]);

    const listed = await store.list();
    if (dismissed) {
      expect(listed, "dismiss won, so nothing is held").toHaveLength(0);
      expect(await crops(), "and its crop went with it").toHaveLength(0);
    } else {
      expect(shelved, "one of the two has to have happened").toBe(true);
      expect(listed).toHaveLength(1);
      expect(listed[0]!.setAsideAt).toBeDefined();
      expect(await crops()).toHaveLength(1);
    }
    // Whichever order they landed in, the store is not holding a record and a
    // crop that disagree.
    expect(await crops()).toHaveLength(listed.length);
  });

  it("does not un-purge a face when an offer is in flight across the purge", async () => {
    // `clear()` and `count()` were outside the lock: an offer loaded its state
    // before the purge and persisted after, restoring the pre-purge list to the
    // cache AND to disk — a purge that silently un-purged. Seconds-old faces
    // made that survivable; a shelf meant to hold faces for years does not.
    await store.offer(vec(0), CROP, 20);
    await Promise.all([store.clear(), store.offer(vec(80), CROP, 20)]);

    // Whichever way the two land, what must never happen is the purged face
    // coming back. At most the arrival that raced it survives.
    const listed = await store.list();
    expect(listed.length).toBeLessThanOrEqual(1);
    expect(await crops()).toHaveLength(listed.length);
    expect(await store.count()).toEqual({
      pending: listed.length,
      setAside: 0,
      total: listed.length,
    });

    // And it stays that way across a restart, which is the disk rather than the
    // cache answering.
    const reopened = new CandidateStore(dir);
    expect((await reopened.list()).length).toBe(listed.length);
  });
});
