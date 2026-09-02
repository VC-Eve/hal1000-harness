import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { tmpDir } from "../tmp.js";
import { createHttpServer } from "../../src/http.js";
import { WorldStore } from "../../src/storage/worlds.js";

let dir: string;
let server: http.Server;
let port: number;
let store: WorldStore | null;

const BODY = Buffer.from(Array.from({ length: 500 }, (_, i) => i % 256));

async function seedWorld(): Promise<void> {
  const worldDir = path.join(dir, "worlds", "lounge");
  await fs.mkdir(path.join(worldDir, "clips"), { recursive: true });
  await fs.writeFile(path.join(worldDir, "clips", "idle.mp4"), BODY);
  await fs.writeFile(path.join(worldDir, "clips", "stray.mp4"), BODY);
  await fs.writeFile(path.join(dir, "elsewhere.mp4"), BODY);
  await fs.writeFile(
    path.join(worldDir, "world.json"),
    JSON.stringify({
      id: "lounge",
      name: "Lounge",
      positions: [],
      scenes: [],
      states: [
        { id: "s1", sceneId: "cam", positionId: "p1", clip: { path: "clips/idle.mp4", durationMs: 3000 } },
        { id: "s2", sceneId: "cam", positionId: "p2", clip: { path: "../elsewhere.mp4", durationMs: 3000 } },
        { id: "s3", sceneId: "cam", positionId: "p3", clip: { path: path.join(dir, "elsewhere.mp4"), durationMs: 3000 } },
      ],
      edges: [],
      parameters: [],
      struck: [],
    }),
    "utf8",
  );
}

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * Driven through `node:http` rather than `fetch`.
 *
 * `fetch` treats `Host` as a forbidden header, silently drops it, and would
 * make the host-guard test pass while proving nothing.
 */
function request(query: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: `/api/live/clip?${query}`, method: "GET", headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeEach(async () => {
  dir = await tmpDir("clip-route");
  await seedWorld();
  store = new WorldStore(dir);
  server = createHttpServer({ uiDist: null, worlds: () => store });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("serving a clip", () => {
  it("returns the whole file with a video content type", async () => {
    const res = await request("world=lounge&clip=clips/idle.mp4");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.body.length).toBe(BODY.length);
  });

  it("answers a byte range with 206 and exactly those bytes", async () => {
    const res = await request("world=lounge&clip=clips/idle.mp4", { range: "bytes=0-99" });
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 0-99/${BODY.length}`);
    expect(res.body.length).toBe(100);
    expect(res.body.equals(BODY.subarray(0, 100))).toBe(true);
  });

  it("answers an open-ended range with the remainder", async () => {
    const res = await request("world=lounge&clip=clips/idle.mp4", { range: "bytes=100-" });
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 100-${BODY.length - 1}/${BODY.length}`);
    expect(res.body.length).toBe(BODY.length - 100);
  });

  it("answers an unsatisfiable range with 416", async () => {
    const res = await request("world=lounge&clip=clips/idle.mp4", { range: `bytes=${BODY.length + 10}-` });
    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe(`bytes */${BODY.length}`);
  });
});

describe("what it will not serve", () => {
  it("refuses a path that climbs out of the World", async () => {
    const res = await request("world=lounge&clip=../elsewhere.mp4");
    expect([403, 404]).toContain(res.status);
    expect(res.body.length).toBeLessThan(BODY.length);
  });

  it("refuses an absolute path", async () => {
    const res = await request(`world=lounge&clip=${encodeURIComponent(path.join(dir, "elsewhere.mp4"))}`);
    expect([403, 404]).toContain(res.status);
  });

  it("refuses a file in clips/ that the manifest does not reference", async () => {
    // Confinement is the floor, not the whole rule: dropping a file into
    // clips/ must not make it network-reachable.
    const res = await request("world=lounge&clip=clips/stray.mp4");
    expect(res.status).toBe(404);
  });

  it("refuses an unregistered World", async () => {
    const res = await request("world=nowhere&clip=clips/idle.mp4");
    expect(res.status).toBe(404);
  });

  it("answers 503 while Worlds are not wired up", async () => {
    store = null;
    const res = await request("world=lounge&clip=clips/idle.mp4");
    expect(res.status).toBe(503);
  });
});

describe("the guards", () => {
  it("refuses a foreign Host header", async () => {
    const res = await request("world=lounge&clip=clips/idle.mp4", { host: "evil.example.com" });
    expect(res.status).toBe(403);
  });

  it("refuses a foreign Origin", async () => {
    const res = await request("world=lounge&clip=clips/idle.mp4", { origin: "http://evil.example.com" });
    expect(res.status).toBe(403);
  });

  it("allows an absent Origin, which is how a <video> element asks", async () => {
    const res = await request("world=lounge&clip=clips/idle.mp4");
    expect(res.status).toBe(200);
  });
});
