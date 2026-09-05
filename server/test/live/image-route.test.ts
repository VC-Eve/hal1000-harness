import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { tmpDir } from "../tmp.js";
import { createHttpServer } from "../../src/http.js";
import { WorldStore } from "../../src/storage/worlds.js";

/**
 * What the image route will and will not answer with.
 *
 * `clip-route.test.ts`'s shape, and written out rather than parameterised over
 * it: the two routes share a confinement helper and an accepted authorisation
 * trade, but they differ in what they serve and in which set they check
 * against, and a shared test would have to be read twice to learn what either
 * one proves. The refusals below are the point — every one of them is an
 * absence, so a guard that silently stopped running would show up here rather
 * than in a positive case that happens to still pass.
 */

let dir: string;
let server: http.Server;
let port: number;
let store: WorldStore | null;

const BODY = Buffer.from(Array.from({ length: 120 }, (_, i) => i % 256));

async function seedWorld(): Promise<void> {
  const worldDir = path.join(dir, "worlds", "lounge");
  await fs.mkdir(path.join(worldDir, "images"), { recursive: true });
  await fs.writeFile(path.join(worldDir, "images", "logo.png"), BODY);
  // Present in the folder, named by no slot. Dropping a file into a World must
  // not make it network-reachable — confinement is the floor, not the rule.
  await fs.writeFile(path.join(worldDir, "images", "stray.png"), BODY);
  // Named by a slot, but not an image this build will draw.
  await fs.writeFile(path.join(worldDir, "images", "notes.txt"), "not an image", "utf8");
  await fs.writeFile(path.join(dir, "elsewhere.png"), BODY);
  await fs.writeFile(
    path.join(worldDir, "world.json"),
    JSON.stringify({
      id: "lounge",
      name: "Lounge",
      states: [],
      transitions: [],
      parameters: [],
      overlays: [
        { kind: "image", position: "top-right", image: "images/logo.png", size: 6 },
        { kind: "image", position: "top-left", image: "images/notes.txt", size: 6 },
        { kind: "image", position: "bottom-left", image: "images/gone.png", size: 6 },
        { kind: "image", position: "bottom-right", image: "../elsewhere.png", size: 6 },
        { kind: "image", position: "middle-left", image: path.join(dir, "elsewhere.png"), size: 6 },
        { kind: "image", position: "middle-right", image: "images/../../elsewhere.png", size: 6 },
        // A slot the strict guard refuses, naming a real file. The route serves
        // it anyway: the name was imported on purpose, and refusing it here too
        // would answer 404 for a second, unrelated cause. Nothing the picture
        // shows becomes reachable, because the layer skips it as well.
        { kind: "image", position: "middle-center", image: "images/logo.png", size: 300 },
        { position: "top-center", source: "title", font: "Segoe UI", size: 5, color: "#ffffff" },
      ],
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
 * make the host-guard test pass while proving nothing — the reason the clip
 * route's tests do the same.
 */
function request(query: string, headers: Record<string, string> = {}, method = "GET"): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/api/live/image?${query}`,
        method,
        headers: { host: `127.0.0.1:${port}`, ...headers },
      },
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
  dir = await tmpDir("image-route");
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

describe("serving an overlay image", () => {
  it("returns the file a slot names, with an image content type", async () => {
    const res = await request("world=lounge&image=images/logo.png");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.body.length).toBe(BODY.length);
  });

  it("serves a file named by a slot the strict guard refuses", async () => {
    // The reference walk is lenient on purpose: a slot with a hand-edited size
    // still names a file the operator imported, and a 404 here would report a
    // cause nobody asked about.
    const res = await request("world=lounge&image=images/logo.png");
    expect(res.status).toBe(200);
  });

  it("answers HEAD without a body", async () => {
    const res = await request("world=lounge&image=images/logo.png", {}, "HEAD");
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(0);
  });
});

describe("what it refuses", () => {
  it("refuses a file in the World that no slot names", async () => {
    const res = await request("world=lounge&image=images/stray.png");
    expect(res.status).toBe(404);
  });

  it("refuses a name a slot holds whose file is gone", async () => {
    const res = await request("world=lounge&image=images/gone.png");
    expect(res.status).toBe(404);
  });

  it("refuses a file whose extension this build will not draw", async () => {
    const res = await request("world=lounge&image=images/notes.txt");
    expect(res.status).toBe(403);
  });

  it("refuses every way out of the World folder", async () => {
    // Each written as an absence. A guard that stopped running would turn one
    // of these into a 200 with the bytes of a file outside the World.
    for (const name of [
      "../elsewhere.png",
      "images/../../elsewhere.png",
      path.join(dir, "elsewhere.png"),
      "C:elsewhere.png",
      "//server/share/elsewhere.png",
      "%2e%2e/elsewhere.png",
    ]) {
      const res = await request(`world=lounge&image=${encodeURIComponent(name)}`);
      expect([403, 404]).toContain(res.status);
      expect(res.body.equals(BODY)).toBe(false);
    }
  });

  it("refuses an unknown World, and a missing parameter", async () => {
    expect((await request("world=nowhere&image=images/logo.png")).status).toBe(404);
    expect((await request("world=lounge")).status).toBe(404);
    expect((await request("image=images/logo.png")).status).toBe(404);
  });

  it("refuses anything but a read", async () => {
    const res = await request("world=lounge&image=images/logo.png", {}, "POST");
    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("GET, HEAD");
  });

  it("refuses a Host that is not ours, which is what actually defends this route", async () => {
    // An <img> presents no per-boot token and sends no Origin, and a missing
    // Origin is allowed by design so agents keep protocol access. So the host
    // check is the guard, not a second opinion.
    const res = await request("world=lounge&image=images/logo.png", { host: "evil.example" });
    expect(res.status).toBe(403);
  });

  it("allows an absent Origin, which is how an <img> asks", async () => {
    const res = await request("world=lounge&image=images/logo.png");
    expect(res.status).toBe(200);
  });
});

describe("with no worlds wired up", () => {
  it("says the route exists but the store does not", async () => {
    store = null;
    const res = await request("world=lounge&image=images/logo.png");
    expect(res.status).toBe(503);
  });
});
