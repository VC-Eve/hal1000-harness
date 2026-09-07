import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { createHttpServer } from "../../src/http.js";

// The speech audio route.
//
// The plan listed these scenarios under U5 and none of them were written — the
// service-level test covered `audioFor()` and felt like coverage of the route in
// front of it. It is not: the route has its own host check, method check,
// service-absent branch, parameter validation and range handling, and the buffer
// body source added to `sendMedia` for it is exercised nowhere else.

let server: http.Server;
let port: number;

/** Stands in for `SpeechService`, holding one line's worth of audio. */
function fakeSpeech(generation: number, bytes: Buffer) {
  return {
    audioFor(gen: number, index: number): Buffer | null {
      // The real guard: a URL must not outlive the line it belongs to.
      if (gen !== generation || index !== 0) return null;
      return bytes;
    },
  };
}

let speech: { audioFor(generation: number, index: number): Buffer | null } | null = null;
const WAV = Buffer.from("RIFF----WAVEfmt ................data----0123456789", "latin1");

beforeAll(async () => {
  server = createHttpServer({ uiDist: null, speech: () => speech });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});

/** A raw request, so `Host` can be set — `fetch` silently drops it. */
function raw(options: {
  path: string;
  host?: string;
  method?: string;
  range?: string;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: options.path,
        method: options.method ?? "GET",
        headers: {
          ...(options.host ? { host: options.host } : {}),
          ...(options.range ? { range: options.range } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("the speech audio route", () => {
  it("reports 503 while no speech service is wired up", async () => {
    speech = null;
    // 503 rather than 404: the route exists, the service is simply not loaded.
    const res = await raw({ path: "/api/live/speech?generation=1&sentence=0" });
    expect(res.status).toBe(503);
  });

  it("refuses a request whose Host is not this server on loopback", async () => {
    // What DNS rebinding produces: the connection lands on 127.0.0.1 but the
    // browser sends the attacker's hostname. Binding to loopback does not stop
    // it; checking Host does. Sent through node:http because `fetch` drops Host
    // as a forbidden header name — a fetch-based test would prove nothing.
    speech = fakeSpeech(1, WAV);
    const res = await raw({
      path: "/api/live/speech?generation=1&sentence=0",
      host: "evil.example.com",
    });
    expect(res.status).toBe(403);
  });

  it("refuses a method that is not a read", async () => {
    speech = fakeSpeech(1, WAV);
    const res = await raw({ path: "/api/live/speech?generation=1&sentence=0", method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("GET, HEAD");
  });

  it("refuses parameters that are not integers", async () => {
    speech = fakeSpeech(1, WAV);
    for (const path of [
      "/api/live/speech",
      "/api/live/speech?generation=1",
      "/api/live/speech?generation=one&sentence=0",
      "/api/live/speech?generation=1&sentence=-1",
      "/api/live/speech?generation=1.5&sentence=0",
    ]) {
      const res = await raw({ path });
      expect(res.status, path).toBe(400);
    }
  });

  it("serves nothing for a superseded line", async () => {
    // The whole point of keying the URL by generation: the character has moved
    // on, so the bytes for the line it is no longer saying are gone.
    speech = fakeSpeech(7, WAV);
    const stale = await raw({ path: "/api/live/speech?generation=6&sentence=0" });
    expect(stale.status).toBe(404);
    const current = await raw({ path: "/api/live/speech?generation=7&sentence=0" });
    expect(current.status).toBe(200);
  });

  it("serves the audio with the headers the other media routes send", async () => {
    speech = fakeSpeech(3, WAV);
    const res = await raw({ path: "/api/live/speech?generation=3&sentence=0" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/wav");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.body.equals(WAV)).toBe(true);
  });

  it("answers a HEAD without a body", async () => {
    speech = fakeSpeech(3, WAV);
    const res = await raw({ path: "/api/live/speech?generation=3&sentence=0", method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers["content-length"]).toBe(String(WAV.length));
    expect(res.body.length).toBe(0);
  });

  it("serves a range out of the buffer", async () => {
    // The branch added to `sendMedia` for this route. An `<audio>` element asks
    // for ranges, and nothing else in the suite exercises a buffer body.
    speech = fakeSpeech(3, WAV);
    const res = await raw({ path: "/api/live/speech?generation=3&sentence=0", range: "bytes=4-9" });
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 4-9/${WAV.length}`);
    expect(res.body.equals(WAV.subarray(4, 10))).toBe(true);
  });

  it("clamps a range that runs past the end rather than reading beyond it", async () => {
    speech = fakeSpeech(3, WAV);
    const res = await raw({
      path: "/api/live/speech?generation=3&sentence=0",
      range: `bytes=2-${WAV.length + 500}`,
    });
    expect(res.status).toBe(206);
    expect(res.body.equals(WAV.subarray(2))).toBe(true);
  });

  it("refuses a range that starts past the end", async () => {
    speech = fakeSpeech(3, WAV);
    const res = await raw({
      path: "/api/live/speech?generation=3&sentence=0",
      range: `bytes=${WAV.length + 10}-`,
    });
    expect(res.status).toBe(416);
  });
});
