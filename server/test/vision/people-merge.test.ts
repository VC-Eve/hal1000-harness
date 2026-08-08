// Rename, merge, and face pruning (U9, R9-R12, AE7/AE8).
//
// Real stores on a temp directory. The thing under test is what ends up on
// disk and what stops matching, and a fake gallery proves neither.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PeopleStore } from "../../src/vision/people.js";

let dir: string;
let people: PeopleStore;

const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

// Unit vectors at a known angle, so similarity between fixtures is exact.
const face = (deg: number): number[] => {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r)];
};

const exists = async (p: string): Promise<boolean> =>
  await fs
    .access(p)
    .then(() => true)
    .catch(() => false);

const thumb = (id: string) => path.join(dir, "vision-faces", `${id}.jpg`);
const byName = async (name: string) => (await people.list()).find((p) => p.name === name);

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-merge-"));
  people = new PeopleStore(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("rename", () => {
  it("changes the name and keeps the faces", async () => {
    const { person } = await people.enrolByName("Steven", face(0), jpeg());
    const result = await people.rename(person.id, "Stephen");

    expect(result).toMatchObject({ ok: true, merged: false, faceCount: 1 });
    expect((await byName("Stephen"))?.faceCount).toBe(1);
    expect(await byName("Steven")).toBeUndefined();
  });

  it("refuses a blank name", async () => {
    const { person } = await people.enrolByName("Steve", face(0), jpeg());
    expect(await people.rename(person.id, "   ")).toMatchObject({ ok: false });
    expect(await byName("Steve")).toBeDefined();
  });

  it("refuses a person who is no longer there", async () => {
    expect(await people.rename("nobody", "Steve")).toMatchObject({ ok: false });
  });

  it("fixes capitalisation without merging the record into itself", async () => {
    // The single most likely rename anyone performs, and the one that breaks if
    // the collision check is case-insensitive with no self carve-out: the
    // record finds ITSELF as the existing holder of the name.
    const { person } = await people.enrolByName("steve", face(0), jpeg());
    const result = await people.rename(person.id, "Steve");

    expect(result).toMatchObject({ ok: true, merged: false, personId: person.id, faceCount: 1 });
    expect((await people.list()).length).toBe(1);
    expect((await byName("Steve"))?.faceCount).toBe(1);
  });

  it("fixes spacing without merging the record into itself", async () => {
    const { person } = await people.enrolByName("Ann  Marie", face(0), jpeg());
    expect(await people.rename(person.id, "Ann Marie")).toMatchObject({ ok: true, merged: false });
    expect((await people.list()).length).toBe(1);
  });
});

describe("merge on rename (AE7)", () => {
  it("folds two records into one, keeping every face", async () => {
    const steve = await people.enrolByName("Steve", face(0), jpeg());
    await people.enrolByName("Steve", face(10), jpeg());
    await people.enrolByName("Steve", face(20), jpeg());
    const steven = await people.enrolByName("Steven", face(90), jpeg());
    await people.enrolByName("Steven", face(100), jpeg());

    const result = await people.rename(steven.person.id, "Steve");

    expect(result).toMatchObject({ ok: true, merged: true, faceCount: 5, mergedFrom: "Steven" });
    expect((await people.list()).length).toBe(1);
    expect((await byName("Steve"))?.faceCount).toBe(5);
    // The surviving id is the record that already held the name, matching what
    // enrolling under an existing name already does.
    expect(result).toMatchObject({ personId: steve.person.id });
  });

  it("matches the merged person against faces from both records", async () => {
    // The outcome the merge exists for: one record recognises them better than
    // two thin ones did.
    const steve = await people.enrolByName("Steve", face(0), jpeg());
    const steven = await people.enrolByName("Steven", face(90), jpeg());
    await people.rename(steven.person.id, "Steve");

    expect((await people.match(face(0), 0.9))?.personId).toBe(steve.person.id);
    expect((await people.match(face(90), 0.9))?.personId).toBe(steve.person.id);
  });

  it("is case-insensitive about the name it merges into", async () => {
    await people.enrolByName("Steve", face(0), jpeg());
    const other = await people.enrolByName("Steven", face(90), jpeg());
    expect(await people.rename(other.person.id, "STEVE")).toMatchObject({ ok: true, merged: true });
    expect((await people.list()).length).toBe(1);
  });

  it("does not keep a face the surviving record already holds", async () => {
    // Same embedding under two spellings. Left alone, faceCount stops being
    // true and the roster shows identical tiles the user then prunes one by one.
    await people.enrolByName("Steve", face(0), jpeg());
    const dupe = await people.enrolByName("Steven", face(0), jpeg());
    const droppedFaceId = dupe.person.faces[0]!.id;

    const result = await people.rename(dupe.person.id, "Steve");

    expect(result).toMatchObject({ ok: true, merged: true, faceCount: 1 });
    expect(await exists(thumb(droppedFaceId))).toBe(false);
  });

  it("keeps a near-duplicate, because a person accumulating faces is the point", async () => {
    // One degree apart is a different capture, not the same one recorded twice.
    await people.enrolByName("Steve", face(0), jpeg());
    const other = await people.enrolByName("Steven", face(1), jpeg());
    expect(await people.rename(other.person.id, "Steve")).toMatchObject({ faceCount: 2 });
  });

  it("survives a reload, so the merge is on disk", async () => {
    await people.enrolByName("Steve", face(0), jpeg());
    const other = await people.enrolByName("Steven", face(90), jpeg());
    await people.rename(other.person.id, "Steve");

    const reloaded = new PeopleStore(dir);
    const list = await reloaded.list();
    expect(list.length).toBe(1);
    expect(list[0]!.faceCount).toBe(2);
  });

  it("does not lose a write when a rename and an enrolment overlap", async () => {
    // Both are load-modify-write against one file. Without the store's lock the
    // second would persist the array it loaded and erase the first.
    await people.enrolByName("Steve", face(0), jpeg());
    const other = await people.enrolByName("Steven", face(90), jpeg());

    await Promise.all([people.rename(other.person.id, "Steve"), people.enrolByName("Steve", face(45), jpeg())]);

    const list = await people.list();
    expect(list.length).toBe(1);
    expect(list[0]!.faceCount).toBe(3);
  });
});

describe("removing a face (AE8)", () => {
  it("removes one face and its image, leaving the rest", async () => {
    const first = await people.enrolByName("Steve", face(0), jpeg());
    await people.enrolByName("Steve", face(45), jpeg());
    const faceId = first.person.faces[0]!.id;

    expect(await people.removeFace(first.person.id, faceId)).toMatchObject({ ok: true, faceCount: 1 });
    expect(await exists(thumb(faceId))).toBe(false);
    expect((await byName("Steve"))?.faceCount).toBe(1);
  });

  it("refuses the last face and says to delete the person instead", async () => {
    // A record with no faces can never match again — a person who exists and is
    // permanently unrecognisable, which is worse than not existing.
    const { person } = await people.enrolByName("Steve", face(0), jpeg());
    const result = await people.removeFace(person.id, person.faces[0]!.id);

    expect(result).toMatchObject({ ok: false, lastFace: true });
    expect(result.ok === false && result.reason).toContain("delete them instead");
    expect((await byName("Steve"))?.faceCount).toBe(1);
    expect(await exists(thumb(person.faces[0]!.id))).toBe(true);
  });

  it("still matches on the faces that remain", async () => {
    const p = await people.enrolByName("Steve", face(0), jpeg());
    await people.enrolByName("Steve", face(90), jpeg());
    await people.removeFace(p.person.id, p.person.faces[0]!.id);

    expect(await people.match(face(90), 0.9)).not.toBeNull();
    // And stops matching on the one that went.
    expect(await people.match(face(0), 0.9)).toBeNull();
  });

  it("refuses a face that is already gone", async () => {
    const { person } = await people.enrolByName("Steve", face(0), jpeg());
    await people.enrolByName("Steve", face(45), jpeg());
    expect(await people.removeFace(person.id, "no-such-face")).toMatchObject({ ok: false });
  });

  it("refuses a person who is no longer there", async () => {
    expect(await people.removeFace("nobody", "whatever")).toMatchObject({ ok: false });
  });

  it("removes the face from the record even when the image will not delete", async () => {
    // Record first, image second. A failed unlink leaves a stray file rather
    // than a person pointing at a face that is not there.
    const p = await people.enrolByName("Steve", face(0), jpeg());
    await people.enrolByName("Steve", face(45), jpeg());
    const faceId = p.person.faces[0]!.id;

    const original = fs.rm;
    (fs as { rm: typeof original }).rm = async (target: unknown, opts?: unknown) => {
      if (String(target) === thumb(faceId)) throw new Error("EBUSY");
      return original(target as never, opts as never);
    };
    try {
      expect(await people.removeFace(p.person.id, faceId)).toMatchObject({ ok: true, faceCount: 1 });
    } finally {
      (fs as { rm: typeof original }).rm = original;
    }

    expect((await byName("Steve"))?.faceCount).toBe(1);
    expect(await people.match(face(0), 0.9)).toBeNull();
  });
});
