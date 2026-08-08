import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PeopleStore } from "../../src/vision/people.js";

// Unit vectors built from an angle, so the similarity between any two is
// exactly controllable: cos(difference).
function vec(angleDeg: number): number[] {
  const t = (angleDeg * Math.PI) / 180;
  return [Math.cos(t), Math.sin(t)];
}

const THUMB = Buffer.from("not really a jpeg, and nothing here decodes it");

describe("PeopleStore", () => {
  let dir: string;
  let store: PeopleStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-people-"));
    store = new PeopleStore(dir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe("enrolling", () => {
    it("persists a person and matches them afterwards", async () => {
      const person = await store.create("Dave", vec(0), THUMB);
      const match = await store.match(vec(0), 0.5);
      expect(match).toEqual({ personId: person.id, name: "Dave", confidence: expect.closeTo(1, 5) });
    });

    it("survives a reload from disk", async () => {
      const person = await store.create("Dave", vec(0), THUMB);
      const reopened = new PeopleStore(dir);
      const match = await reopened.match(vec(0), 0.5);
      expect(match?.personId).toBe(person.id);
    });

    it("trims the name", async () => {
      const person = await store.create("  Dave  ", vec(0), THUMB);
      expect(person.name).toBe("Dave");
    });

    it("keeps two people with the same name distinct", async () => {
      // Names are not keys. Two Daves are two records, or deleting one would
      // take the other with it.
      const a = await store.create("Dave", vec(0), THUMB);
      const b = await store.create("Dave", vec(90), THUMB);
      expect(a.id).not.toBe(b.id);
      expect(await store.list()).toHaveLength(2);
    });

    it("accumulates faces on an existing person", async () => {
      const person = await store.create("Dave", vec(0), THUMB);
      expect(await store.addFace(person.id, vec(30), THUMB)).toBe(true);
      const summaries = await store.list();
      expect(summaries[0]!.faceCount).toBe(2);
    });

    it("refuses to add a face to a person who does not exist", async () => {
      expect(await store.addFace("nobody", vec(0), THUMB)).toBe(false);
    });
  });

  describe("matching", () => {
    it("scores a person by their nearest face, not their average", async () => {
      // The reason this matters: one poorly-framed enrolment would drag a mean
      // down and quietly stop that person matching at all. On a maximum it
      // merely fails to be the nearest.
      const person = await store.create("Dave", vec(0), THUMB);
      await store.addFace(person.id, vec(85), THUMB);

      const match = await store.match(vec(0), 0.5);
      expect(match?.personId).toBe(person.id);
      // A mean of cos(0)=1 and cos(85)=0.087 would be ~0.54; the maximum is 1.
      expect(match!.confidence).toBeCloseTo(1, 5);
    });

    it("returns nobody below the threshold rather than the nearest person", async () => {
      // R9. A weak match is unrecognised, never a guess at who is closest —
      // returning a nearest-with-low-score would invite exactly the caller
      // behaviour the requirement forbids.
      await store.create("Dave", vec(0), THUMB);
      expect(await store.match(vec(80), 0.5)).toBeNull();
    });

    it("honours the threshold it is given", async () => {
      await store.create("Dave", vec(0), THUMB);
      // cos(60) = 0.5 exactly: at the threshold counts as a match, above it too.
      expect(await store.match(vec(60), 0.5)).not.toBeNull();
      expect(await store.match(vec(60), 0.75)).toBeNull();
    });

    it("picks the closer of two people", async () => {
      const near = await store.create("Near", vec(10), THUMB);
      await store.create("Far", vec(70), THUMB);
      const match = await store.match(vec(0), 0.5);
      expect(match?.personId).toBe(near.id);
    });

    it("is stable regardless of enrolment order", async () => {
      const first = new PeopleStore(await fs.mkdtemp(path.join(os.tmpdir(), "hal-people-a-")));
      const second = new PeopleStore(await fs.mkdtemp(path.join(os.tmpdir(), "hal-people-b-")));
      const near = await first.create("Near", vec(10), THUMB);
      await first.create("Far", vec(70), THUMB);
      await second.create("Far", vec(70), THUMB);
      const nearAgain = await second.create("Near", vec(10), THUMB);

      expect((await first.match(vec(0), 0.5))?.name).toBe("Near");
      expect((await second.match(vec(0), 0.5))?.name).toBe("Near");
      expect(near.name).toBe(nearAgain.name);
    });

    it("returns nobody from an empty gallery without throwing", async () => {
      await expect(store.match(vec(0), 0.5)).resolves.toBeNull();
    });

    it("scores zero rather than throwing when a stored vector has a different width", async () => {
      // A model change underneath us. Zero is a safe answer; an exception
      // mid-detection is not.
      await store.create("Dave", [1, 0, 0, 0], THUMB);
      await expect(store.match(vec(0), 0.5)).resolves.toBeNull();
    });
  });

  describe("deletion (R27)", () => {
    it("stops the person matching immediately", async () => {
      const person = await store.create("Dave", vec(0), THUMB);
      expect(await store.remove(person.id)).toBe(true);
      expect(await store.match(vec(0), 0.5)).toBeNull();
    });

    it("removes every face held for them", async () => {
      const person = await store.create("Dave", vec(0), THUMB);
      await store.addFace(person.id, vec(20), THUMB);
      const facesDir = path.join(dir, "vision-faces");
      expect(await fs.readdir(facesDir)).toHaveLength(2);

      await store.remove(person.id);
      expect(await fs.readdir(facesDir)).toHaveLength(0);
    });

    it("survives a restart", async () => {
      const person = await store.create("Dave", vec(0), THUMB);
      await store.remove(person.id);
      expect(await new PeopleStore(dir).match(vec(0), 0.5)).toBeNull();
    });

    it("leaves other people alone", async () => {
      const dave = await store.create("Dave", vec(0), THUMB);
      await store.create("Marvin", vec(90), THUMB);
      await store.remove(dave.id);
      expect((await store.match(vec(90), 0.5))?.name).toBe("Marvin");
      expect(await store.list()).toHaveLength(1);
    });

    it("is a no-op for an id that does not exist", async () => {
      expect(await store.remove("nobody")).toBe(false);
    });

    it("still removes the person when a thumbnail file is already gone", async () => {
      // The person going first is the point: the guarantee is "stop
      // recognising them", and a failed unlink must not leave them matchable.
      const person = await store.create("Dave", vec(0), THUMB);
      await fs.rm(path.join(dir, "vision-faces"), { recursive: true, force: true });
      expect(await store.remove(person.id)).toBe(true);
      expect(await store.match(vec(0), 0.5)).toBeNull();
    });
  });

  describe("the roster", () => {
    it("reports a face count and a thumbnail data URL", async () => {
      await store.create("Dave", vec(0), THUMB);
      const [summary] = await store.list();
      expect(summary!.name).toBe("Dave");
      expect(summary!.faceCount).toBe(1);
      expect(summary!.thumbnail).toMatch(/^data:image\/jpeg;base64,/);
    });

    it("omits the thumbnail rather than failing when the file is missing", async () => {
      await store.create("Dave", vec(0), THUMB);
      await fs.rm(path.join(dir, "vision-faces"), { recursive: true, force: true });
      const [summary] = await store.list();
      expect(summary!.thumbnail).toBeUndefined();
      expect(summary!.name).toBe("Dave");
    });

    it("never exposes an embedding to clients", async () => {
      // The roster is for recognising a name, not for carrying the biometric
      // payload out to every connected client.
      await store.create("Dave", vec(0), THUMB);
      expect(JSON.stringify(await store.list())).not.toContain("embedding");
    });
  });

  describe("a damaged gallery", () => {
    it("loads empty and says so, rather than taking Vision down", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      await fs.writeFile(path.join(dir, "vision-people.json"), JSON.stringify({ people: "not an array" }));

      const damaged = new PeopleStore(dir);
      expect(await damaged.list()).toEqual([]);
      // Loud: the silent version of this un-enrols everyone and looks
      // identical to never having enrolled anyone.
      expect(spy).toHaveBeenCalled();
    });

    it("treats unparseable JSON as an empty gallery", async () => {
      await fs.writeFile(path.join(dir, "vision-people.json"), "{ this is not json");
      await expect(new PeopleStore(dir).list()).resolves.toEqual([]);
    });

    it("recovers by accepting new enrolments over the damaged file", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      await fs.writeFile(path.join(dir, "vision-people.json"), "{ this is not json");
      const damaged = new PeopleStore(dir);
      const person = await damaged.create("Dave", vec(0), THUMB);
      expect((await damaged.match(vec(0), 0.5))?.personId).toBe(person.id);
    });
  });
});

describe("PeopleStore — enrolling by name", () => {
  let dir: string;
  let store: PeopleStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-people-name-"));
    store = new PeopleStore(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("creates a person the first time a name is used", async () => {
    const { person, added } = await store.enrolByName("Liam", vec(0), THUMB);
    expect(added).toBe(false);
    expect(person.faces).toHaveLength(1);
  });

  it("accumulates onto the same person the second time", async () => {
    // The failure this exists to stop: one person whose appearances fragmented
    // got named three times and became three records, each with one face —
    // strictly worse at recognising them than one record with three.
    const first = await store.enrolByName("Liam", vec(0), THUMB);
    const second = await store.enrolByName("Liam", vec(25), THUMB);

    expect(second.added).toBe(true);
    expect(second.person.id).toBe(first.person.id);
    expect(await store.list()).toHaveLength(1);
    expect((await store.list())[0]!.faceCount).toBe(2);
  });

  it("matches the name case-insensitively and ignores surrounding space", async () => {
    const first = await store.enrolByName("Liam", vec(0), THUMB);
    const second = await store.enrolByName("  liam ", vec(25), THUMB);
    expect(second.person.id).toBe(first.person.id);
  });

  it("improves recognition of that person rather than splitting it", async () => {
    // Two faces 50 degrees apart: a query near either one should match, which
    // is the practical payoff of accumulating.
    await store.enrolByName("Liam", vec(0), THUMB);
    await store.enrolByName("Liam", vec(50), THUMB);

    expect((await store.match(vec(5), 0.9))?.name).toBe("Liam");
    expect((await store.match(vec(45), 0.9))?.name).toBe("Liam");
  });

  it("keeps genuinely different names as different people", async () => {
    await store.enrolByName("Liam", vec(0), THUMB);
    await store.enrolByName("Steve", vec(90), THUMB);
    expect(await store.list()).toHaveLength(2);
  });
});

describe("PeopleStore — concurrent mutations", () => {
  let dir: string;
  let store: PeopleStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-people-race-"));
    store = new PeopleStore(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("loses no face when two enrolments of one name arrive together", async () => {
    // `VisionService.handle` is fire-and-forget, so two WS messages interleave
    // across their awaits. Before serialising, both loaded the same empty
    // roster and the second write erased the first — one record, one face, and
    // the other embedding gone with no error anywhere.
    await Promise.all([
      store.enrolByName("Liam", vec(0), THUMB),
      store.enrolByName("Liam", vec(90), THUMB),
    ]);

    const roster = await store.list();
    expect(roster).toHaveLength(1);
    expect(roster[0]!.faceCount).toBe(2);
    // Both faces are findable, which is the assertion that actually catches it —
    // a record count alone was green while an embedding was being lost.
    expect(await store.match(vec(0), 0.9)).not.toBeNull();
    expect(await store.match(vec(90), 0.9)).not.toBeNull();
  });

  it("loses no person when two different names arrive together", async () => {
    await Promise.all([
      store.enrolByName("Liam", vec(0), THUMB),
      store.enrolByName("Steve", vec(90), THUMB),
    ]);
    expect(await store.list()).toHaveLength(2);
  });

  it("does not resurrect a person deleted while an enrolment is in flight", async () => {
    const person = await store.enrolByName("Liam", vec(0), THUMB);
    await Promise.all([
      store.remove(person.person.id),
      store.enrolByName("Steve", vec(90), THUMB),
    ]);
    const roster = await store.list();
    expect(roster.map((p) => p.name)).toEqual(["Steve"]);
  });

  it("survives a burst without dropping any of it", async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => store.enrolByName(`P${i}`, vec(i * 40), THUMB)),
    );
    expect(await store.list()).toHaveLength(8);
  });
});

describe("PeopleStore — a NaN score must not read as a match", () => {
  let dir: string;
  let store: PeopleStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-nan-"));
    store = new PeopleStore(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("fails closed when a stored vector produces a non-finite score", async () => {
    // `NaN < threshold` is false, so the old negated guard let a NaN score
    // through as a CONFIDENT identification — the exact outcome R9 exists to
    // prevent, reachable from any non-finite value in a sidecar response.
    await store.create("Dave", [Number.NaN, 0], THUMB);
    expect(await store.match([1, 0], 0.5)).toBeNull();
  });

  it("fails closed for an Infinity in the query vector", async () => {
    await store.create("Dave", [1, 0], THUMB);
    expect(await store.match([Number.POSITIVE_INFINITY, 0], 0.5)).toBeNull();
  });
});
