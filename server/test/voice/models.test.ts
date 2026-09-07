import { createHash } from "node:crypto";
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KOKORO_VOICES,
  ensureModels,
  forgetVerified,
  matchesSpec,
  modelPath,
  modelReady,
  voiceModelsDir,
  voiceReadiness,
  type ModelSpec,
} from "../../src/voice/models.js";
import { tmpDir } from "../tmp.js";

// The fetch, the verification and the rename.
//
// `recogniser/src/models.ts` — the module this one is modelled on — has a full
// suite; this one had none, so the digest check, the length check, the atomic
// rename and the temp-file cleanup were all unexercised. Everything here runs
// against a local `http` server: no network, and a body this test controls byte
// for byte.

let dir: string;
let origin: http.Server;
let port: number;
let body: Buffer;
let status = 200;
let truncateTo: number | null = null;

const CONTENT = Buffer.from("a voice pack, for the purposes of argument");

/** A spec pointing at the local server rather than at GitHub. */
const spec = (over: Partial<ModelSpec> = {}): ModelSpec => ({
  file: "test-model.bin",
  sha256: createHash("sha256").update(CONTENT).digest("hex"),
  bytes: CONTENT.length,
  url: `http://127.0.0.1:${port}/model`,
  label: "the test model",
  ...over,
});

beforeEach(async () => {
  dir = await tmpDir("voice-models");
  body = CONTENT;
  status = 200;
  truncateTo = null;
  forgetVerified();
  origin = http.createServer((req, res) => {
    if (status !== 200) {
      res.writeHead(status);
      res.end("no");
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream" });
    // A body that stops early, to stand in for a dropped connection.
    res.end(truncateTo === null ? body : body.subarray(0, truncateTo));
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  const addr = origin.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});

afterEach(async () => {
  origin.closeAllConnections?.();
  await new Promise<void>((r) => origin.close(() => r()));
});

const parts = async () => (await fs.readdir(dir)).filter((name) => name.endsWith(".part"));

describe("matchesSpec", () => {
  it("requires the length and the digest, not either", () => {
    const s = spec();
    expect(matchesSpec(CONTENT, s)).toBe(true);
    // Right length, wrong bytes — exactly what a digest is for.
    const swapped = Buffer.alloc(CONTENT.length, 0x41);
    expect(matchesSpec(swapped, s)).toBe(false);
    // Right digest is impossible at the wrong length, but the length is checked
    // first because it is free and truncation is the common failure.
    expect(matchesSpec(CONTENT.subarray(0, 5), s)).toBe(false);
  });
});

describe("modelReady", () => {
  it("is false for a file that is not there", () => {
    expect(modelReady(dir, spec())).toBe(false);
  });

  it("is false for a file of the wrong length", async () => {
    await fs.writeFile(modelPath(dir, spec()), CONTENT.subarray(0, 4));
    expect(modelReady(dir, spec())).toBe(false);
  });

  it("is false for a file of the right length and the wrong contents", async () => {
    await fs.writeFile(modelPath(dir, spec()), Buffer.alloc(CONTENT.length, 0x41));
    expect(modelReady(dir, spec())).toBe(false);
  });

  it("answers from the cache rather than hashing again", async () => {
    // The reason the cache exists: the real files are 353MB and this runs on the
    // path of every spoken line, where a re-hash costs ~260ms of blocked event
    // loop. Asserted by behaviour rather than by wall-clock cost — an earlier
    // version timed the second call and asserted it under 5ms, which is the
    // shape that flakes under parallel load. Here the bytes are replaced with
    // rubbish while the size and mtime are held fixed: a `modelReady` that
    // re-read the file would say false, and only one that answered from the
    // cache can still say true.
    const file = modelPath(dir, spec());
    await fs.writeFile(file, CONTENT);
    const when = new Date(Date.UTC(2026, 0, 1, 12, 0, 0)); // whole seconds, so it survives a round trip
    await fs.utimes(file, when, when);
    expect(modelReady(dir, spec())).toBe(true);

    await fs.writeFile(file, Buffer.alloc(CONTENT.length, 0x41)); // same size
    await fs.utimes(file, when, when); // same mtime
    expect(modelReady(dir, spec())).toBe(true);

    // And the cache is the only reason: forget it and the same file is refused.
    forgetVerified();
    expect(modelReady(dir, spec())).toBe(false);
  });

  it("re-verifies rather than trusting a file whose mtime moved", async () => {
    // The conservative half of the same cache: the key includes mtime, so
    // anything that touches the file costs one honest re-hash. Set explicitly
    // rather than slept for — a fixed sleep before a positive assertion is a
    // guess about how long a filesystem takes to tick.
    const file = modelPath(dir, spec());
    await fs.writeFile(file, CONTENT);
    const first = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));
    await fs.utimes(file, first, first);
    expect(modelReady(dir, spec())).toBe(true);

    await fs.writeFile(file, Buffer.alloc(CONTENT.length, 0x41)); // same size
    const later = new Date(Date.UTC(2026, 0, 1, 12, 0, 30));
    await fs.utimes(file, later, later);
    expect(modelReady(dir, spec())).toBe(false);
  });
});

describe("ensureModels", () => {
  // Driven against a local server through the injected spec list, so what runs
  // here is the real fetch, digest check, length check and atomic rename — not a
  // copy of them written in the test.
  const withFetch = async <T,>(run: () => Promise<T>): Promise<T> => {
    const previous = process.env.HAL_VOICE_FETCH_MODELS;
    delete process.env.HAL_VOICE_FETCH_MODELS;
    try {
      return await run();
    } finally {
      if (previous !== undefined) process.env.HAL_VOICE_FETCH_MODELS = previous;
    }
  };

  it("refuses to fetch at all when fetching is switched off", async () => {
    // Pinned off for the whole suite in vitest.config.ts, which is what keeps
    // every other test in this repo away from a 353MB download.
    expect(await ensureModels(dir, [spec()])).toBe("unavailable");
    expect(await parts()).toEqual([]);
    await expect(fs.stat(modelPath(dir, spec()))).rejects.toThrow();
  });

  it("fetches, verifies and renames into place", async () => {
    await withFetch(async () => {
      expect(await ensureModels(dir, [spec()])).toBe("ok");
    });
    expect(modelReady(dir, spec())).toBe(true);
    expect(await parts()).toEqual([]);
  });

  it("does not fetch again once the file is there", async () => {
    await fs.writeFile(modelPath(dir, spec()), CONTENT);
    // The server would answer, but nothing should ask it: a "hit" here means the
    // presence check ran before the fetch, which is what makes this cheap.
    status = 500;
    await withFetch(async () => {
      expect(await ensureModels(dir, [spec()])).toBe("ok");
    });
  });

  it("keeps no file and no temp when the body is truncated", async () => {
    truncateTo = 5;
    await withFetch(async () => {
      expect(await ensureModels(dir, [spec()])).toBe("unavailable");
    });
    await expect(fs.stat(modelPath(dir, spec()))).rejects.toThrow();
    expect(await parts()).toEqual([]);
  });

  it("keeps no file and no temp when the body is the wrong bytes", async () => {
    // Right length, wrong contents — the case the digest exists for, and the one
    // a length check alone would wave through.
    body = Buffer.alloc(CONTENT.length, 0x41);
    await withFetch(async () => {
      expect(await ensureModels(dir, [spec()])).toBe("unavailable");
    });
    await expect(fs.stat(modelPath(dir, spec()))).rejects.toThrow();
    expect(await parts()).toEqual([]);
  });

  it("keeps no file and no temp when the body is longer than its recorded size", async () => {
    // Bounded as it streams rather than only at the end, so a body that keeps
    // coming cannot fill the disk before anything checks a length.
    body = Buffer.concat([CONTENT, Buffer.alloc(4096, 0x42)]);
    await withFetch(async () => {
      expect(await ensureModels(dir, [spec()])).toBe("unavailable");
    });
    await expect(fs.stat(modelPath(dir, spec()))).rejects.toThrow();
    expect(await parts()).toEqual([]);
  });

  it("keeps no file when the server refuses", async () => {
    status = 500;
    await withFetch(async () => {
      expect(await ensureModels(dir, [spec()])).toBe("unavailable");
    });
    await expect(fs.stat(modelPath(dir, spec()))).rejects.toThrow();
    expect(await parts()).toEqual([]);
  });

  it("reports fetching for the directory being fetched, and not for another", async () => {
    // The flag used to be one process-wide boolean, so a fetch into one
    // directory answered "fetching" for a readiness check about a different one.
    const other = await tmpDir("voice-models-other");
    let readingDuringFetch: string[] = [];
    body = CONTENT;
    await withFetch(async () => {
      const inFlight = ensureModels(dir, [spec()]);
      readingDuringFetch = [voiceReadiness(dir), voiceReadiness(other)];
      await inFlight;
    });
    expect(readingDuringFetch[1]).toBe("unavailable");
    expect(voiceReadiness(dir)).toBe("unavailable"); // the real specs, still absent
  });
});

describe("voiceModelsDir", () => {
  it("puts the models beside the other stores by default", () => {
    const previous = process.env.HAL_VOICE_MODELS_DIR;
    delete process.env.HAL_VOICE_MODELS_DIR;
    try {
      expect(voiceModelsDir("/data")).toBe(path.join("/data", "voice-models"));
    } finally {
      if (previous !== undefined) process.env.HAL_VOICE_MODELS_DIR = previous;
    }
  });

  it("is overridable, so a machine holding a copy need not download one", () => {
    const previous = process.env.HAL_VOICE_MODELS_DIR;
    process.env.HAL_VOICE_MODELS_DIR = "/elsewhere";
    try {
      expect(voiceModelsDir("/data")).toBe("/elsewhere");
    } finally {
      if (previous === undefined) delete process.env.HAL_VOICE_MODELS_DIR;
      else process.env.HAL_VOICE_MODELS_DIR = previous;
    }
  });
});
