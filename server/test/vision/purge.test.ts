// The biometric purge (U2, R34/R39).
//
// Runs against real stores on a temp directory rather than fakes: the thing
// under test is that files actually leave the disk, and a fake store proves
// nothing about that.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PeopleStore } from "../../src/vision/people.js";
import { CandidateStore } from "../../src/vision/candidates.js";

let dir: string;
let people: PeopleStore;
let candidates: CandidateStore;

const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

// A unit vector at a given angle, so similarity between fixtures is exact and
// the dedupe bar in CandidateStore is something a fixture can clear on purpose
// rather than by luck.
const face = (deg: number): number[] => {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r)];
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-purge-"));
  people = new PeopleStore(dir);
  candidates = new CandidateStore(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

const exists = async (p: string): Promise<boolean> =>
  await fs
    .access(p)
    .then(() => true)
    .catch(() => false);

describe("biometric purge", () => {
  it("counts what it would destroy before destroying it", async () => {
    await people.enrolByName("Dave", face(0), jpeg());
    await people.enrolByName("Dave", face(5), jpeg());
    await people.enrolByName("Marvin", face(90), jpeg());
    // 80 degrees apart, so cosine is 0.17 — comfortably under CandidateStore's
    // SAME_FACE bar of 0.45. At 60 degrees these would score 0.5 and the second
    // would be absorbed as the same visitor, leaving this test asserting a
    // count of two against a queue holding one.
    await candidates.offer(face(140), jpeg(), 8);
    await candidates.offer(face(220), jpeg(), 8);

    expect(await people.tally()).toEqual({ people: 2, faces: 3 });
    expect(await candidates.count()).toEqual({ pending: 2, setAside: 0, total: 2 });
  });

  it("empties the gallery and deletes every face image", async () => {
    const dave = await people.enrolByName("Dave", face(0), jpeg());
    await people.enrolByName("Dave", face(5), jpeg());
    const faceIds = dave.person.faces.map((f) => f.id);

    await people.clear();

    expect(await people.list()).toEqual([]);
    expect(await people.tally()).toEqual({ people: 0, faces: 0 });
    for (const id of faceIds) {
      expect(await exists(path.join(dir, "vision-faces", `${id}.jpg`)), `face ${id} should be gone`).toBe(false);
    }
  });

  it("empties the queue, its crops, and the overflow tally", async () => {
    // The tally is part of the purge's job: it is a record that faces were
    // seen, which is exactly the kind of trace a purge is asked to remove.
    const first = await candidates.offer(face(0), jpeg(), 1);
    await candidates.offer(face(90), jpeg(), 1);
    expect(candidates.overflow().dropped).toBe(1);

    await candidates.clear();

    expect(await candidates.list()).toEqual([]);
    expect((await candidates.count()).total).toBe(0);
    expect(candidates.overflow()).toEqual({ dropped: 0, since: null });
    expect(await exists(path.join(dir, "vision-candidates", `${first!.id}.jpg`))).toBe(false);
  });

  it("stops recognising a purged person", async () => {
    // The outcome the user actually asked for. An empty roster that still
    // matches would be the worst possible version of this.
    await people.enrolByName("Dave", face(0), jpeg());
    expect(await people.match(face(0), 0.5)).not.toBeNull();

    await people.clear();

    expect(await people.match(face(0), 0.5)).toBeNull();
  });

  it("survives a purge with nothing to purge", async () => {
    await people.clear();
    await candidates.clear();
    expect(await people.tally()).toEqual({ people: 0, faces: 0 });
    expect((await candidates.count()).total).toBe(0);
  });

  it("leaves the gallery empty even when the image directory resists", async () => {
    // The ordering guarantee. `clear` empties the record first and the files
    // second, so a directory that cannot be removed leaves stray images rather
    // than people who are still matchable.
    await people.enrolByName("Dave", face(0), jpeg());
    const facesDir = path.join(dir, "vision-faces");
    const original = fs.rm;
    // @ts-expect-error — replacing a bound method for one call.
    fs.rm = async (target: string, opts?: unknown) => {
      if (String(target) === facesDir) throw new Error("EBUSY: directory in use");
      return original(target as never, opts as never);
    };
    try {
      await people.clear();
    } finally {
      (fs as { rm: typeof original }).rm = original;
    }

    expect(await people.list()).toEqual([]);
    expect(await people.match(face(0), 0.5)).toBeNull();
  });

  it("survives a reload, so the purge is on disk and not only in memory", async () => {
    await people.enrolByName("Dave", face(0), jpeg());
    await candidates.offer(face(90), jpeg(), 8);

    await people.clear();
    await candidates.clear();

    const reloadedPeople = new PeopleStore(dir);
    const reloadedCandidates = new CandidateStore(dir);
    expect(await reloadedPeople.list()).toEqual([]);
    expect((await reloadedCandidates.count()).total).toBe(0);
  });
});

describe("acknowledging the dropped-faces tally", () => {
  it("clears the count once it has been read", async () => {
    // The tally exists so an empty queue is never mistaken for a quiet one. Once
    // read it has done that job, and a notice nobody can clear stops being read.
    const first = await candidates.offer(face(0), jpeg(), 1);
    await candidates.offer(face(90), jpeg(), 1);
    expect(candidates.overflow().dropped).toBe(1);
    expect(first).not.toBeNull();

    await candidates.acknowledgeOverflow("pending");

    expect(candidates.overflow()).toEqual({ dropped: 0, since: null });
  });

  it("keeps the queue itself untouched", async () => {
    // Acknowledging is about the tally, not the faces still waiting.
    await candidates.offer(face(0), jpeg(), 1);
    await candidates.offer(face(90), jpeg(), 1);

    await candidates.acknowledgeOverflow("pending");

    expect((await candidates.count()).total).toBe(1);
  });

  it("starts a fresh count when more are dropped afterwards", async () => {
    await candidates.offer(face(0), jpeg(), 1);
    await candidates.offer(face(90), jpeg(), 1);
    await candidates.acknowledgeOverflow("pending");

    await candidates.offer(face(180), jpeg(), 1);

    expect(candidates.overflow().dropped).toBe(1);
  });

  it("survives a reload, so the acknowledgement is on disk", async () => {
    await candidates.offer(face(0), jpeg(), 1);
    await candidates.offer(face(90), jpeg(), 1);
    await candidates.acknowledgeOverflow("pending");

    const reloaded = new CandidateStore(dir);
    await reloaded.count();
    expect(reloaded.overflow().dropped).toBe(0);
  });

  it("does nothing when there is nothing to acknowledge", async () => {
    await candidates.acknowledgeOverflow("pending");
    expect(candidates.overflow()).toEqual({ dropped: 0, since: null });
  });
});

