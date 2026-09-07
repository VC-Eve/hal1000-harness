import { promises as fs } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_PRESETS, SHIPPED_PRESET, VoiceStore } from "../../src/storage/voices.js";
import { tmpDir } from "../tmp.js";

const AVAILABLE = ["am_michael", "bm_george", "bm_lewis", "af_bella"];

let dir: string;
let store: VoiceStore;

beforeEach(async () => {
  dir = await tmpDir("voices");
  store = new VoiceStore(dir);
});

const preset = (over: Record<string, unknown> = {}) => ({
  id: "narrator",
  label: "Narrator",
  mix: [{ voice: "am_michael", weight: 1 }],
  speed: 1,
  ...over,
});

const fileContents = async () =>
  JSON.parse(await fs.readFile(path.join(dir, "voices.json"), "utf8")) as unknown[];

describe("the shipped preset", () => {
  it("is offered before anything has been saved", async () => {
    // R6: the picker is usable the first time it is opened.
    expect(await store.list()).toEqual([SHIPPED_PRESET]);
  });

  it("is not written to disk by being read", async () => {
    // Resolved at read time, so a release that changes it reaches an install
    // that never edited it.
    await store.list();
    await expect(fs.stat(path.join(dir, "voices.json"))).rejects.toThrow();
  });

  it("is replaced rather than duplicated when one is saved over it", async () => {
    await store.save(preset({ id: SHIPPED_PRESET.id, label: "Mine" }), AVAILABLE);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.label).toBe("Mine");
  });

  it("comes back when the override is deleted", async () => {
    await store.save(preset({ id: SHIPPED_PRESET.id, label: "Mine" }), AVAILABLE);
    await store.remove(SHIPPED_PRESET.id);
    expect(await store.list()).toEqual([SHIPPED_PRESET]);
  });
});

describe("saving", () => {
  it("round-trips through a reopen", async () => {
    await store.save(preset(), AVAILABLE);
    const reopened = new VoiceStore(dir);
    expect(await reopened.get("narrator")).toEqual(preset());
  });

  it("keeps a field the file carries that this build does not know", async () => {
    // The read-is-a-write hazard: rebuilding by naming every field would delete
    // the unknown key on the next save, silently and permanently. Reopen *and
    // write again* is what makes it visible.
    await store.save(preset(), AVAILABLE);
    const raw = await fileContents();
    await fs.writeFile(
      path.join(dir, "voices.json"),
      JSON.stringify([{ ...(raw[0] as object), futureField: "keep me" }], null, 2),
    );

    const reopened = new VoiceStore(dir);
    await reopened.save(preset({ id: "second", label: "Second" }), AVAILABLE);

    const after = (await fileContents()) as Record<string, unknown>[];
    expect(after.find((p) => p.id === "narrator")?.futureField).toBe("keep me");
  });

  it("refuses a mix naming a voice the pack does not carry, and says which", async () => {
    const result = await store.save(
      preset({ mix: [{ voice: "am_michael", weight: 1 }, { voice: "am_nobody", weight: 1 }] }),
      AVAILABLE,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("am_nobody");
  });

  it("refuses every save while the voice pack cannot be read", async () => {
    // An unvalidatable preset in the store is one that fails at the moment it is
    // spoken, which is the worst time to find out.
    const result = await store.save(preset(), null);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/not readable/);
    expect(await store.list()).toEqual([SHIPPED_PRESET]);
  });

  it("says what is wrong rather than only that something is", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [preset({ label: "" }), /needs a name/],
      [preset({ mix: [] }), /at least one stock voice/],
      [preset({ mix: [{ voice: "am_michael", weight: 0 }] }), /weight above zero/],
      [preset({ speed: 9 }), /between 0.5 and 2/],
    ];
    for (const [input, expected] of cases) {
      const result = await store.save(input, AVAILABLE);
      expect(result.ok, JSON.stringify(input)).toBe(false);
      expect(result.ok === false && result.error).toMatch(expected);
    }
  });

  it("updates in place rather than adding a second with the same id", async () => {
    await store.save(preset({ speed: 1 }), AVAILABLE);
    await store.save(preset({ speed: 1.2 }), AVAILABLE);
    const list = await store.list();
    expect(list.filter((p) => p.id === "narrator")).toHaveLength(1);
    expect((await store.get("narrator"))!.speed).toBe(1.2);
  });

  it("bounds how many can be stored", async () => {
    for (let i = 0; i < MAX_PRESETS; i += 1) {
      await store.save(preset({ id: `v${i}`, label: `V${i}` }), AVAILABLE);
    }
    const result = await store.save(preset({ id: "one-too-many", label: "Extra" }), AVAILABLE);
    expect(result.ok).toBe(false);
  });

  it("serialises concurrent saves rather than losing one", async () => {
    // Two read-modify-writes over one file: without the queue the second read
    // sees the state before the first write and the first preset disappears.
    await Promise.all([
      store.save(preset({ id: "a", label: "A" }), AVAILABLE),
      store.save(preset({ id: "b", label: "B" }), AVAILABLE),
      store.save(preset({ id: "c", label: "C" }), AVAILABLE),
    ]);
    const ids = (await store.list()).map((p) => p.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");
  });
});

describe("loading a file that was edited by hand", () => {
  it("drops what cannot be read rather than failing the store", async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "voices.json"),
      JSON.stringify([preset(), { id: "broken" }, "not a preset", null, preset({ id: "ok2", label: "Ok" })]),
    );
    const list = await store.list();
    expect(list.map((p) => p.id)).toEqual([SHIPPED_PRESET.id, "narrator", "ok2"]);
  });

  it("survives a file that is not an array at all", async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "voices.json"), '{"not":"an array"}');
    expect(await store.list()).toEqual([SHIPPED_PRESET]);
  });

  it("keeps only the first of two presets sharing an id", async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "voices.json"),
      JSON.stringify([preset({ label: "First" }), preset({ label: "Second" })]),
    );
    const list = await store.list();
    expect(list.filter((p) => p.id === "narrator")).toHaveLength(1);
    expect(list.find((p) => p.id === "narrator")!.label).toBe("First");
  });
});

describe("removing", () => {
  it("reports a preset that was never there", async () => {
    const result = await store.remove("ghost");
    expect(result.ok).toBe(false);
  });

  it("leaves the others alone", async () => {
    await store.save(preset({ id: "a", label: "A" }), AVAILABLE);
    await store.save(preset({ id: "b", label: "B" }), AVAILABLE);
    await store.remove("a");
    expect((await store.list()).map((p) => p.id)).toEqual([SHIPPED_PRESET.id, "b"]);
  });
});
