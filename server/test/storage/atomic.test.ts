import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { writeJsonAtomic, readJson } from "../../src/storage/atomic.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal1000-atomic-"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const eperm = () => Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });

describe("writeJsonAtomic", () => {
  it("retries transient EPERM/EBUSY rename failures and succeeds", async () => {
    const file = path.join(dir, "data.json");
    const realRename = fs.rename.bind(fs);
    let failures = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (failures < 2) {
        failures += 1;
        throw eperm();
      }
      return realRename(from, to);
    });
    await writeJsonAtomic(file, { ok: true });
    expect(failures).toBe(2);
    expect(await readJson(file)).toEqual({ ok: true });
    const leftovers = (await fs.readdir(dir)).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("throws the original error and cleans the temp file when retries are exhausted", async () => {
    const file = path.join(dir, "data.json");
    vi.spyOn(fs, "rename").mockImplementation(async () => {
      throw eperm();
    });
    await expect(writeJsonAtomic(file, { ok: true })).rejects.toThrow(/EPERM/);
    const leftovers = (await fs.readdir(dir)).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
    expect(await readJson(file)).toBeNull();
  });

  it("does not retry non-transient errors", async () => {
    const file = path.join(dir, "data.json");
    let calls = 0;
    vi.spyOn(fs, "rename").mockImplementation(async () => {
      calls += 1;
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    });
    await expect(writeJsonAtomic(file, { ok: true })).rejects.toThrow(/ENOSPC/);
    expect(calls).toBe(1);
  });

  it("concurrent writes to the same file do not collide on temp paths", async () => {
    const file = path.join(dir, "data.json");
    await Promise.all(Array.from({ length: 8 }, (_, i) => writeJsonAtomic(file, { n: i })));
    const result = await readJson<{ n: number }>(file);
    expect(result).not.toBeNull();
    const leftovers = (await fs.readdir(dir)).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
