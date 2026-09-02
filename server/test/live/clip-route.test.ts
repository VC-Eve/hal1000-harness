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
  await fs.writeFile(path.join(worldDir, "clips", "notes.txt"), "not a video", "utf8");
  await fs.writeFile(path.join(worldDir, "clips", "empty.mp4"), Buffer.alloc(0));
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
        { id: "s4", sceneId: "cam", positionId: "p4", clip: { path: "clips/notes.txt", durationMs: 3000 } },
        { id: "s5", sceneId: "cam", positionId: "p5", clip: { path: "clips/empty.mp4", durationMs: 3000 } },
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
function request(query: string, headers: Record<string, string> = {}, method = "GET"): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: `/api/live/clip?${query}`, method, headers: { host: `127.0.0.1:${port}`, ...headers } },
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

  it("answers a suffix range with the last bytes", async () => {
    const res = await request("world=lounge&clip=clips/idle.mp4", { range: "bytes=-100" });
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes ${BODY.length - 100}-${BODY.length - 1}/${BODY.length}`);
    expect(res.body.equals(BODY.subarray(BODY.length - 100))).toBe(true);
  });

  it("refuses any range against a zero-length clip rather than throwing after the headers", async () => {
    // The suffix branch used to answer {start: 0, end: -1}, and the stream then
    // threw ERR_OUT_OF_RANGE with the 206 already sent — a hung response.
    const suffix = await request("world=lounge&clip=clips/empty.mp4", { range: "bytes=-100" });
    expect(suffix.status).toBe(416);
    const prefix = await request("world=lounge&clip=clips/empty.mp4", { range: "bytes=0-10" });
    expect(prefix.status).toBe(416);
  });

  it("answers HEAD with the headers and no body", async () => {
    const res = await request("world=lounge&clip=clips/idle.mp4", {}, "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers["content-length"]).toBe(String(BODY.length));
    expect(res.body.length).toBe(0);
  });

  it("declares nosniff, since a World folder is copied-in content on our own origin", async () => {
    const res = await request("world=lounge&clip=clips/idle.mp4");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
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

  it("refuses a manifest-referenced file that is not a video", async () => {
    // The extension gate is what keeps the declared content type to video, so
    // it is what stops this route serving a document from our own origin.
    const res = await request("world=lounge&clip=clips/notes.txt");
    expect(res.status).toBe(403);
  });

  it("refuses a method that is not a read", async () => {
    const res = await request("world=lounge&clip=clips/idle.mp4", {}, "DELETE");
    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("GET, HEAD");
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
