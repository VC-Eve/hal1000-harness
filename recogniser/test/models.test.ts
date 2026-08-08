import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelStore, SFACE, YUNET, matches, sha256 } from "../src/models.js";
import { MODELS_DIR } from "./models-required.js";

// A stand-in for the real 37MB download: any bytes plus a spec that describes
// them honestly. The point under test is the verification, not SFace itself.
function specFor(bytes: Buffer, overrides: Partial<typeof SFACE> = {}) {
  return {
    name: "test-model",
    file: "test-model.onnx",
    sha256: sha256(bytes),
    bytes: bytes.length,
    url: "https://example.invalid/test-model.onnx",
    committed: false,
    ...overrides,
  };
}

describe("the committed detector model", () => {
  it("matches the digest published by opencv_zoo's git-LFS pointer", async () => {
    // This guards the checkout. It fails loudly if the binary is ever replaced
    // without updating the constant, which is the only way a swapped detector
    // would otherwise announce itself — a different export can change the
    // tensor layout, the input size, or the landmark order, and none of those
    // fail loudly at runtime.
    const bytes = await fs.readFile(path.join(MODELS_DIR, YUNET.file));
    expect(bytes.length).toBe(YUNET.bytes);
    expect(sha256(bytes)).toBe(YUNET.sha256);
  });
});

describe("matches", () => {
  it("accepts bytes of the right length and digest", () => {
    const bytes = Buffer.from("the actual model");
    expect(matches(bytes, specFor(bytes))).toBe(true);
  });

  it("rejects a truncated transfer on length before considering the digest", () => {
    const bytes = Buffer.from("the actual model");
    expect(matches(bytes.subarray(0, 5), specFor(bytes))).toBe(false);
  });

  it("rejects bytes of the right length but the wrong content", () => {
    const bytes = Buffer.from("the actual model");
    expect(matches(Buffer.from("the actuaL model"), specFor(bytes))).toBe(false);
  });
});

describe("ModelStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-recogniser-models-"));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function contents(): Promise<string[]> {
    return (await fs.readdir(dir)).sort();
  }

  it("installs a download whose digest matches, at the expected path and length", async () => {
    const bytes = Buffer.from("a well-formed model payload");
    const spec = specFor(bytes);
    vi.stubGlobal("fetch", async () => new Response(bytes));

    const store = new ModelStore(dir, true);
    expect(await store.ensure(spec)).toBe("ok");
    const written = await fs.readFile(path.join(dir, spec.file));
    expect(written.length).toBe(spec.bytes);
    expect(sha256(written)).toBe(spec.sha256);
  });

  it("rejects a mismatched download and leaves nothing behind", async () => {
    const spec = specFor(Buffer.from("what we asked for"));
    vi.stubGlobal("fetch", async () => new Response(Buffer.from("what we got instead")));

    const store = new ModelStore(dir, true);
    expect(await store.ensure(spec)).toBe("corrupt");
    // No destination file and no temp file: a truncated 37MB artifact that
    // looks installed is worse than no file at all, and a leftover temp would
    // accumulate one copy per failed start.
    expect(await contents()).toEqual([]);
    expect(store.state(spec)).toBe("corrupt");
  });

  it("rejects a truncated stream even when its prefix is correct", async () => {
    const full = Buffer.from("the whole model, every byte of it");
    const spec = specFor(full);
    vi.stubGlobal("fetch", async () => new Response(full.subarray(0, 10)));

    const store = new ModelStore(dir, true);
    expect(await store.ensure(spec)).toBe("corrupt");
    expect(await contents()).toEqual([]);
  });

  it("reports a fetch that throws as unreachable, not corrupt", async () => {
    const spec = specFor(Buffer.from("unreachable payload"));
    vi.stubGlobal("fetch", async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });

    const store = new ModelStore(dir, true);
    // The network failed; the artifact is not known to be wrong. These are
    // different things to tell a user and different things to retry.
    expect(await store.ensure(spec)).toBe("unreachable");
  });

  it("reports a non-ok HTTP response as unreachable", async () => {
    const spec = specFor(Buffer.from("payload"));
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));

    const store = new ModelStore(dir, true);
    expect(await store.ensure(spec)).toBe("unreachable");
  });

  it("does not touch the network when the model is already present and correct", async () => {
    const bytes = Buffer.from("already here");
    const spec = specFor(bytes);
    await fs.writeFile(path.join(dir, spec.file), bytes);

    const fetchSpy = vi.fn(async () => new Response(bytes));
    vi.stubGlobal("fetch", fetchSpy);

    const store = new ModelStore(dir, true);
    expect(await store.ensure(spec)).toBe("ok");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports a corrupted file on disk rather than serving from it", async () => {
    const spec = specFor(Buffer.from("the real thing"));
    await fs.writeFile(path.join(dir, spec.file), Buffer.from("something else"));
    vi.stubGlobal("fetch", async () => {
      throw new Error("should not be called");
    });

    const store = new ModelStore(dir, true);
    expect(await store.ensure(spec)).toBe("corrupt");
  });

  it("never downloads a committed model, so a broken checkout stays visible", async () => {
    const bytes = Buffer.from("committed payload");
    const spec = specFor(bytes, { committed: true });
    const fetchSpy = vi.fn(async () => new Response(bytes));
    vi.stubGlobal("fetch", fetchSpy);

    const store = new ModelStore(dir, true);
    expect(await store.ensure(spec)).toBe("absent");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stays absent rather than fetching when fetching is switched off", async () => {
    const spec = specFor(Buffer.from("payload"));
    const fetchSpy = vi.fn(async () => new Response(Buffer.from("payload")));
    vi.stubGlobal("fetch", fetchSpy);

    const store = new ModelStore(dir, false);
    expect(await store.ensure(spec)).toBe("absent");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("tracks each model's state independently, so one failure does not mask the other", async () => {
    const good = Buffer.from("good model");
    const goodSpec = specFor(good, { name: "good", file: "good.onnx" });
    const badSpec = specFor(Buffer.from("expected"), { name: "bad", file: "bad.onnx" });

    vi.stubGlobal("fetch", async (url: string) =>
      url.includes("good") ? new Response(good) : new Response(Buffer.from("wrong")),
    );
    const store = new ModelStore(dir, true);
    await store.ensure({ ...goodSpec, url: "https://example.invalid/good.onnx" });
    await store.ensure({ ...badSpec, url: "https://example.invalid/bad.onnx" });

    expect(store.state(goodSpec)).toBe("ok");
    expect(store.state(badSpec)).toBe("corrupt");
  });
});

describe("the published model specs", () => {
  it("pin dated releases rather than a moving alias", () => {
    // A different export can change the tensor layout, the fixed input size,
    // or the landmark order — none of which fail loudly.
    expect(YUNET.file).toContain("2023mar");
    expect(SFACE.file).toContain("2021dec");
    expect(YUNET.url).toContain("2023mar");
    expect(SFACE.url).toContain("2021dec");
  });

  it("records a full-length sha256 and a byte count for each model", () => {
    for (const spec of [YUNET, SFACE]) {
      expect(spec.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(spec.bytes).toBeGreaterThan(0);
    }
  });
});
