import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { tmpDir } from "../tmp.js";
import { createHttpServer } from "../../src/http.js";
import { AudioStore } from "../../src/storage/audio.js";

let dir: string;
let server: http.Server;
let port: number;
let store: AudioStore | null;

const BODY = Buffer.from(Array.from({ length: 500 }, (_, i) => i % 256));

/**
 * A store with one playlist naming three of the five files on disk.
 *
 * `stray.flac` is deliberately in `tracks/` and in no index: a shared store
 * collects files, and being inside it must not be what makes a file reachable.
 */
async function seedStore(): Promise<void> {
  const tracks = path.join(dir, "audio", "tracks");
  await fs.mkdir(tracks, { recursive: true });
  await fs.writeFile(path.join(tracks, "opener.flac"), BODY);
  await fs.writeFile(path.join(tracks, "stray.flac"), BODY);
  await fs.writeFile(path.join(tracks, "notes.txt"), "not audio", "utf8");
  await fs.writeFile(path.join(tracks, "empty.mp3"), Buffer.alloc(0));
  await fs.writeFile(path.join(dir, "elsewhere.flac"), BODY);

  await fs.mkdir(path.join(dir, "audio", "playlists"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "audio", "playlists", "warmup.json"),
    JSON.stringify({
      id: "warmup",
      name: "Warmup",
      tracks: [
        { path: "tracks/opener.flac", name: "Opener", durationMs: 1000 },
        { path: "tracks/notes.txt", name: "Notes", durationMs: 0 },
        { path: "tracks/empty.mp3", name: "Empty", durationMs: 0 },
        { path: "../elsewhere.flac", name: "Outside", durationMs: 0 },
        { path: path.join(dir, "elsewhere.flac"), name: "Absolute", durationMs: 0 },
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
 * Driven through `node:http` rather than `fetch`, exactly as the clip route's
 * suite is: `fetch` treats `Host` as a forbidden header, silently drops it, and
 * would make the host-guard test pass while proving nothing.
 */
function request(query: string, headers: Record<string, string> = {}, method = "GET"): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: `/api/live/audio?${query}`, method, headers: { host: `127.0.0.1:${port}`, ...headers } },
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
  dir = await tmpDir("audio-route");
  await seedStore();
  store = new AudioStore(dir);
  server = createHttpServer({ uiDist: null, audio: () => store });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("serving a track", () => {
  it("returns the whole file with an audio content type", async () => {
    const res = await request("track=tracks/opener.flac");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/flac");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.body.length).toBe(BODY.length);
  });

  it("answers a byte range with 206 and exactly those bytes", async () => {
    // What an <audio> element does to seek inside a large FLAC without
    // fetching it whole.
    const res = await request("track=tracks/opener.flac", { range: "bytes=100-199" });
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 100-199/${BODY.length}`);
    expect(res.body.length).toBe(100);
    expect(res.body.equals(BODY.subarray(100, 200))).toBe(true);
  });

  it("answers a suffix range with the last bytes", async () => {
    // How a decoder finds a trailing tag.
    const res = await request("track=tracks/opener.flac", { range: "bytes=-100" });
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes ${BODY.length - 100}-${BODY.length - 1}/${BODY.length}`);
    expect(res.body.equals(BODY.subarray(BODY.length - 100))).toBe(true);
  });

  it("answers an unsatisfiable range with 416 and no body", async () => {
    const res = await request("track=tracks/opener.flac", { range: `bytes=${BODY.length + 10}-` });
    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe(`bytes */${BODY.length}`);
    expect(res.body.length).toBe(0);
  });

  it("refuses any range against a zero-length track rather than throwing after the headers", async () => {
    // `parseRange`'s `size <= 0` branch. Without it the suffix form answers
    // {start: 0, end: -1} and the stream throws ERR_OUT_OF_RANGE with the 206
    // already sent — a response that hangs rather than fails.
    const suffix = await request("track=tracks/empty.mp3", { range: "bytes=-100" });
    expect(suffix.status).toBe(416);
    const prefix = await request("track=tracks/empty.mp3", { range: "bytes=0-10" });
    expect(prefix.status).toBe(416);
    // And the whole-file read of an empty track is still an ordinary 200.
    const whole = await request("track=tracks/empty.mp3");
    expect(whole.status).toBe(200);
    expect(whole.body.length).toBe(0);
  });

  it("answers HEAD with the headers and no body", async () => {
    const res = await request("track=tracks/opener.flac", {}, "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers["content-length"]).toBe(String(BODY.length));
    expect(res.body.length).toBe(0);
  });

  it("declares nosniff and no-store on every kind of answer", async () => {
    // Every kind, not one: the store is copied-in content on the origin whose
    // document carries this boot's WS token.
    const whole = await request("track=tracks/opener.flac");
    const ranged = await request("track=tracks/opener.flac", { range: "bytes=0-9" });
    const head = await request("track=tracks/opener.flac", {}, "HEAD");
    for (const res of [whole, ranged, head]) {
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });
});

describe("what it will not serve", () => {
  it("refuses a file in the store that no playlist names", async () => {
    // Confinement is the floor, not the whole rule. The store is shared, so
    // files accumulate in it; being inside it is not authorisation.
    const res = await request("track=tracks/stray.flac");
    expect(res.status).toBe(404);
    expect(res.body.length).toBeLessThan(BODY.length);
  });

  it("refuses a path that climbs out of the store, even when a playlist names it", async () => {
    const res = await request("track=../elsewhere.flac");
    expect([403, 404]).toContain(res.status);
    expect(res.body.length).toBeLessThan(BODY.length);
  });

  it("refuses an absolute path a hand-edited index carries", async () => {
    const res = await request(`track=${encodeURIComponent(path.join(dir, "elsewhere.flac"))}`);
    expect([403, 404]).toContain(res.status);
    expect(res.body.length).toBeLessThan(BODY.length);
  });

  it("refuses an indexed file that is not audio", async () => {
    // `audioMime` is what keeps the declared content type to audio, so it is
    // what stops this route serving a document from our own origin.
    const res = await request("track=tracks/notes.txt");
    expect(res.status).toBe(403);
  });

  it("refuses a request with no track at all", async () => {
    const res = await request("");
    expect(res.status).toBe(404);
  });

  it("refuses a method that is not a read", async () => {
    const res = await request("track=tracks/opener.flac", {}, "POST");
    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("GET, HEAD");
  });

  it("answers 503 while the audio store is not wired up", async () => {
    store = null;
    const res = await request("track=tracks/opener.flac");
    expect(res.status).toBe(503);
  });
});

describe("the guards", () => {
  it("refuses a foreign Host header", async () => {
    // The DNS-rebinding case, and the only guard actually defending this route.
    const res = await request("track=tracks/opener.flac", { host: "evil.example.com" });
    expect(res.status).toBe(403);
    expect(res.body.length).toBeLessThan(BODY.length);
  });

  it("refuses a foreign Origin", async () => {
    const res = await request("track=tracks/opener.flac", { origin: "http://evil.example.com" });
    expect(res.status).toBe(403);
  });

  it("allows an absent Origin, which is how an <audio> element asks", async () => {
    // The documented trade, asserted so it is a decision rather than an
    // accident — see docs/residual-review-findings/feat-live-audio-soundtrack.md.
    const res = await request("track=tracks/opener.flac");
    expect(res.status).toBe(200);
  });

  it("checks the Host before it looks at the store", async () => {
    // The order matters: a refused Host must not be able to tell a track that
    // exists from one that does not.
    const real = await request("track=tracks/opener.flac", { host: "evil.example.com" });
    const absent = await request("track=tracks/nothing.flac", { host: "evil.example.com" });
    expect(real.status).toBe(403);
    expect(absent.status).toBe(403);
  });
});
