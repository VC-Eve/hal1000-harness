import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type RecogniserConfig } from "../src/config.js";
import { Pipeline } from "../src/pipeline.js";
import { SERVICE_ID, createServer, listen, type Running } from "../src/server.js";
import {
  DETECTOR_READY,
  EMBEDDER_READY,
  FIXTURE_READY,
  MODELS_DIR,
  NO_DETECTOR,
  NO_EMBEDDER,
  NO_FIXTURE,
  describeWhen,
} from "./models-required.js";
import { blankFrame, encodeJpeg, faceJpeg, loadFace, sideBySide } from "./helpers.js";

function configFor(overrides: Partial<RecogniserConfig> = {}): RecogniserConfig {
  return {
    ...loadConfig({}),
    // Port 0 lets the OS choose, so the suite never collides with a real
    // recogniser — or, worse, silently talks to one and reports its answers as
    // its own.
    port: 0,
    modelsDir: MODELS_DIR,
    fetchModels: false,
    ...overrides,
  };
}

interface Reply {
  status: number;
  body: any;
  raw: string;
}

async function post(port: number, pathname: string, body: Buffer, type = "image/jpeg"): Promise<Reply> {
  return request(port, "POST", pathname, body, { "content-type": type });
}

function request(
  port: number,
  method: string,
  pathname: string,
  body?: Buffer,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: pathname, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(raw);
          } catch {
            /* left null; the test asserts on `raw` when it matters */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, raw });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function start(config: RecogniserConfig): Promise<{ running: Running; pipeline: Pipeline }> {
  const pipeline = new Pipeline(config);
  await pipeline.start();
  const running = await listen(createServer(config, pipeline), config);
  return { running, pipeline };
}

describe("the HTTP surface", () => {
  let running: Running;

  beforeAll(async () => {
    ({ running } = await start(configFor()));
  });

  afterAll(async () => {
    await running.close();
  });

  it("identifies itself on /health rather than answering a bare 200", async () => {
    // A liveness probe answers "is something listening", never "is this mine".
    // `docs/solutions/diagnosing-a-process-that-isnt-your-code.md` records a
    // probe satisfied by a previous run's process still holding the port,
    // which then wrote artifacts that looked exactly like proof.
    const reply = await request(running.port, "GET", "/health");
    expect(reply.status).toBe(200);
    expect(reply.body.service).toBe(SERVICE_ID);
    expect(reply.body.version).toBe(1);
  });

  it("reports the detector and the embedder as separate legs", async () => {
    const reply = await request(running.port, "GET", "/health");
    // Distinct keys, so one model's failure is legible on its own rather than
    // collapsing into a single unavailable flag.
    expect(reply.body).toHaveProperty("detector");
    expect(reply.body).toHaveProperty("embedder");
    expect(typeof reply.body.detector).toBe("string");
    expect(typeof reply.body.embedder).toBe("string");
  });

  it("answers an unknown path with a JSON 404, not an HTML default", async () => {
    const reply = await request(running.port, "GET", "/nope");
    expect(reply.status).toBe(404);
    expect(reply.body.error).toContain("/nope");
  });

  it("rejects a GET to /detect with 405", async () => {
    const reply = await request(running.port, "GET", "/detect");
    expect(reply.status).toBe(405);
  });

  it("rejects a non-JPEG content type with 415, naming what it accepts", async () => {
    const reply = await post(running.port, "/detect", Buffer.from("{}"), "application/json");
    expect(reply.status).toBe(415);
    expect(reply.body.error).toContain("image/jpeg");
  });

  it("accepts a content type carrying parameters", async () => {
    const reply = await post(running.port, "/detect", encodeJpeg(blankFrame(64, 64)), "image/jpeg; charset=binary");
    expect(reply.status).toBe(200);
  });

  it("rejects a body over the size cap before decoding it", async () => {
    const { running: small } = await start(configFor({ maxFrameBytes: 1024 }));
    try {
      const reply = await post(small.port, "/detect", Buffer.alloc(8192, 0x41));
      // A status, not a hang-up: a dropped socket is indistinguishable from a
      // recogniser that is not running, and would send a user hunting for a
      // process that is fine.
      expect(reply.status).toBe(413);
      expect(reply.body.condition).toBe("frame-too-large");
    } finally {
      await small.close();
    }
  });

  it("answers a malformed JPEG with 400 and keeps serving", async () => {
    const bad = await post(running.port, "/detect", Buffer.from("definitely not a jpeg"));
    expect(bad.status).toBe(400);
    expect(bad.body.condition).toBe("undecodable-frame");
    // The process is still healthy afterwards.
    expect((await request(running.port, "GET", "/health")).status).toBe(200);
  });

  it("binds loopback by default", () => {
    // AGENTS.md makes loopback-only a hard rule for the core, and this is a
    // second endpoint carrying whole camera frames.
    expect(loadConfig({}).host).toBe("127.0.0.1");
    expect(loadConfig({ HAL_RECOGNISER_HOST: "0.0.0.0" }).host).toBe("127.0.0.1");
  });

  it("takes a separate acknowledgement before binding anywhere else", () => {
    // Typing a host is not enough on its own — the exposure flag is its own
    // deliberate act.
    expect(loadConfig({ HAL_RECOGNISER_ALLOW_REMOTE: "1" }).host).toBe("0.0.0.0");
    expect(loadConfig({ HAL_RECOGNISER_ALLOW_REMOTE: "1", HAL_RECOGNISER_HOST: "10.0.0.5" }).host).toBe("10.0.0.5");
  });
});

describeWhen(DETECTOR_READY && FIXTURE_READY, `${NO_DETECTOR} / ${NO_FIXTURE}`, "POST /detect", () => {
  let running: Running;

  beforeAll(async () => {
    ({ running } = await start(configFor()));
  });

  afterAll(async () => {
    await running.close();
  });

  it("returns one face with a box, five landmarks and the source dimensions", async () => {
    const reply = await post(running.port, "/detect", faceJpeg());
    expect(reply.status).toBe(200);
    expect(reply.body.width).toBe(640);
    expect(reply.body.height).toBe(480);
    expect(reply.body.faces).toHaveLength(1);

    const face = reply.body.faces[0];
    expect(face.box).toEqual({
      x: expect.any(Number),
      y: expect.any(Number),
      w: expect.any(Number),
      h: expect.any(Number),
    });
    expect(face.landmarks).toHaveLength(5);
    expect(face.score).toBeGreaterThan(0.85);
    expect(face.alignment).toBeLessThan(6);
  });

  it("returns two independent entries for two people in frame", async () => {
    // R4 at the wire boundary: two faces are two appearances, and HAL decides
    // continuity for each separately.
    const reply = await post(running.port, "/detect", encodeJpeg(sideBySide(loadFace())));
    expect(reply.body.faces).toHaveLength(2);
    const [a, b] = reply.body.faces.sort((l: any, r: any) => l.box.x - r.box.x);
    expect(b.box.x).toBeGreaterThan(a.box.x + a.box.w);
  });

  it("returns an empty face list with 200 for a frame with nobody in it", async () => {
    const reply = await post(running.port, "/detect", encodeJpeg(blankFrame(640, 480)));
    expect(reply.status).toBe(200);
    expect(reply.body.faces).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // R5's half of the bargain. HAL owns appearance continuity, which it can
  // only do if the recogniser is not quietly making that decision itself.
  // Checked at the contract rather than inferred from the implementation.
  // -----------------------------------------------------------------------
  it("returns byte-identical responses for the same frame", async () => {
    const first = await post(running.port, "/detect", faceJpeg());
    const second = await post(running.port, "/detect", faceJpeg());
    expect(second.raw).toBe(first.raw);
  });

  it("leaks nothing from an intervening frame", async () => {
    const a1 = await post(running.port, "/detect", faceJpeg());
    await post(running.port, "/detect", encodeJpeg(sideBySide(loadFace())));
    const a2 = await post(running.port, "/detect", faceJpeg());
    expect(a2.raw).toBe(a1.raw);
  });

  it("writes nothing to disk while detecting", async () => {
    // R29's half: a face that walks past leaves no trace in this process. A
    // stray debug dump or an embedding cache would pass every other test here.
    const packageRoot = path.join(MODELS_DIR, "..");
    const snapshot = async () => {
      const seen: string[] = [];
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 2) return;
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (entry.name === "node_modules") continue;
          const full = path.join(dir, entry.name);
          seen.push(full);
          if (entry.isDirectory()) await walk(full, depth + 1);
        }
      };
      await walk(packageRoot, 0);
      return seen.sort();
    };

    // Scoped to the package tree rather than the process cwd: vitest runs test
    // files in parallel workers, so another suite writing to the repo root
    // would make a cwd assertion flake and teach us to distrust it.
    const before = await snapshot();
    for (let i = 0; i < 3; i++) await post(running.port, "/detect", faceJpeg());
    expect(await snapshot()).toEqual(before);
  });

  it("serves concurrent requests correctly rather than interleaving them", async () => {
    const replies = await Promise.all([
      post(running.port, "/detect", faceJpeg()),
      post(running.port, "/detect", faceJpeg()),
      post(running.port, "/detect", faceJpeg()),
    ]);
    for (const reply of replies) {
      expect(reply.status).toBe(200);
      expect(reply.body.faces).toHaveLength(1);
    }
    expect(replies[1]!.raw).toBe(replies[0]!.raw);
  });

  it("refuses past the waiting bound with a 503 that names the condition, then recovers", async () => {
    const { running: tight } = await start(configFor({ maxWaiting: 2 }));
    try {
      const burst = await Promise.all(
        Array.from({ length: 12 }, () => post(tight.port, "/detect", faceJpeg())),
      );
      const refused = burst.filter((r) => r.status === 503);
      expect(refused.length).toBeGreaterThan(0);
      // Busy is its own condition, distinct from unreachable and from broken.
      expect(refused[0]!.body.condition).toBe("busy");
      // And the server is fine once the burst clears.
      expect((await post(tight.port, "/detect", faceJpeg())).status).toBe(200);
    } finally {
      await tight.close();
    }
  });

  it("keeps serving after a frame that fails mid-pipeline", async () => {
    await post(running.port, "/detect", Buffer.from("garbage"));
    const reply = await post(running.port, "/detect", faceJpeg());
    // The single-flight lane must survive a rejected request, or one bad frame
    // wedges every subsequent one behind it.
    expect(reply.status).toBe(200);
  });
});

describeWhen(EMBEDDER_READY && DETECTOR_READY && FIXTURE_READY, `${NO_EMBEDDER} / ${NO_FIXTURE}`, "embeddings over the wire", () => {
  let running: Running;

  beforeAll(async () => {
    ({ running } = await start(configFor()));
  });

  afterAll(async () => {
    await running.close();
  });

  it("carries a 128-value unit vector per face", async () => {
    const reply = await post(running.port, "/detect", faceJpeg());
    const embedding: number[] = reply.body.faces[0].embedding;
    expect(embedding).toHaveLength(128);
    expect(Math.sqrt(embedding.reduce((a, b) => a + b * b, 0))).toBeCloseTo(1, 4);
  });

  it("gives two people in one frame distinct embeddings", async () => {
    const reply = await post(running.port, "/detect", encodeJpeg(sideBySide(loadFace())));
    const [a, b] = reply.body.faces;
    expect(a.embedding).not.toEqual(b.embedding);
  });
});

function NO_EMBEDDER_MSG(): string {
  return "sface has not been fetched, or the detector/fixture is missing.";
}

describe("when the embedder is unavailable", () => {
  let running: Running;
  let empty: string;

  beforeAll(async () => {
    // A models directory holding the detector but no SFace: R35's failure path.
    empty = await fs.mkdtemp(path.join(os.tmpdir(), "hal-recogniser-nosface-"));
    if (DETECTOR_READY) {
      await fs.copyFile(
        path.join(MODELS_DIR, "face_detection_yunet_2023mar.onnx"),
        path.join(empty, "face_detection_yunet_2023mar.onnx"),
      );
    }
    ({ running } = await start(configFor({ modelsDir: empty })));
  });

  afterAll(async () => {
    await running.close();
    await fs.rm(empty, { recursive: true, force: true });
  });

  it("reports the embedder as not ok while the detector stays healthy", async () => {
    const reply = await request(running.port, "GET", "/health");
    expect(reply.body.embedder).not.toBe("ok");
    if (DETECTOR_READY) expect(reply.body.detector).toBe("ok");
  });

  it("still detects, returning faces with a null embedding", async () => {
    if (!DETECTOR_READY || !FIXTURE_READY) return;
    const reply = await post(running.port, "/detect", faceJpeg());
    expect(reply.status).toBe(200);
    expect(reply.body.faces).toHaveLength(1);
    // Detection is the half that still works. A dead endpoint would take
    // Vision's whole recognition path down for a missing 37MB file.
    expect(reply.body.faces[0].embedding).toBeNull();
    expect(reply.body.faces[0].box).toBeTruthy();
  });

  it("agrees with itself: health says not ok, and detect returns null embeddings", async () => {
    if (!DETECTOR_READY || !FIXTURE_READY) return;
    const health = await request(running.port, "GET", "/health");
    const detect = await post(running.port, "/detect", faceJpeg());
    expect(health.body.embedder === "ok").toBe(detect.body.faces[0].embedding !== null);
  });
});
