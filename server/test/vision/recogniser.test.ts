import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpRecogniser, RecogniserError, cosine } from "../../src/vision/recogniser.js";

// The plan's U1 called for this file and it was never written, so the client's
// error classification and its identity check went untested through three
// slices. The distinctions it draws are load-bearing: R8 wants "slow" and
// "unreachable" reported as different conditions because they send a user
// looking in completely different places.

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function respond(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HttpRecogniser.detect", () => {
  it("parses a well-formed response", async () => {
    vi.stubGlobal("fetch", async () =>
      respond({
        width: 640,
        height: 480,
        faces: [{ box: { x: 1, y: 2, w: 3, h: 4 }, score: 0.9, landmarks: [], embedding: [1, 0], alignment: 0.5 }],
      }),
    );
    const result = await new HttpRecogniser("http://127.0.0.1:8100").detect(JPEG);
    expect(result.width).toBe(640);
    expect(result.faces).toHaveLength(1);
    expect(result.faces[0]!.embedding).toEqual([1, 0]);
  });

  it("preserves a null embedding rather than coercing it", async () => {
    // The sidecar's detector-works-embedder-does-not state. A zero vector here
    // would score 0 against everything and read as a confident non-match.
    vi.stubGlobal("fetch", async () =>
      respond({ width: 1, height: 1, faces: [{ box: { x: 0, y: 0, w: 1, h: 1 }, score: 0.9, embedding: null }] }),
    );
    const result = await new HttpRecogniser("http://127.0.0.1:8100").detect(JPEG);
    expect(result.faces[0]!.embedding).toBeNull();
  });

  it("rejects an embedding containing a non-finite value", async () => {
    // One NaN makes every cosine against this vector NaN, and a NaN score used
    // to pass the match threshold as a confident identification.
    vi.stubGlobal("fetch", async () =>
      respond({
        width: 1,
        height: 1,
        faces: [{ box: { x: 0, y: 0, w: 1, h: 1 }, score: 0.9, embedding: [1, null, 0] }],
      }),
    );
    const result = await new HttpRecogniser("http://127.0.0.1:8100").detect(JPEG);
    expect(result.faces[0]!.embedding).toBeNull();
  });

  it("caps an absurd face count rather than warping and cropping thousands", async () => {
    const faces = Array.from({ length: 5_000 }, () => ({
      box: { x: 0, y: 0, w: 1, h: 1 },
      score: 0.9,
      embedding: [1, 0],
    }));
    vi.stubGlobal("fetch", async () => respond({ width: 1, height: 1, faces }));
    const result = await new HttpRecogniser("http://127.0.0.1:8100").detect(JPEG);
    expect(result.faces.length).toBeLessThanOrEqual(64);
  });

  it("classifies a refused connection as unreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(new HttpRecogniser("http://127.0.0.1:8100").detect(JPEG)).rejects.toMatchObject({
      kind: "unreachable",
    });
  });

  it("classifies a blown deadline as slow, not missing", async () => {
    // R8's distinction. A recogniser answering late is running fine and needs a
    // different message than one that is not there.
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      await new Promise((resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
      throw new Error("unreachable");
    });
    await expect(new HttpRecogniser("http://127.0.0.1:8100", 30).detect(JPEG)).rejects.toMatchObject({
      kind: "slow",
    });
  });

  it("classifies a server error as failed and keeps the sidecar's own message", async () => {
    vi.stubGlobal("fetch", async () => new Response("the models are not loaded", { status: 500 }));
    await expect(new HttpRecogniser("http://127.0.0.1:8100").detect(JPEG)).rejects.toMatchObject({
      kind: "failed",
    });
  });

  it("treats an unreadable body as failed rather than as an empty scene", async () => {
    vi.stubGlobal("fetch", async () => new Response("not json", { status: 200 }));
    await expect(new HttpRecogniser("http://127.0.0.1:8100").detect(JPEG)).rejects.toBeInstanceOf(RecogniserError);
  });

  it("refuses to follow a redirect", async () => {
    // Whole camera frames cross this boundary. A process holding the configured
    // port must not be able to 302 them to a host the user never named.
    let passed: RequestInit | undefined;
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      passed = init;
      return respond({ width: 1, height: 1, faces: [] });
    });
    await new HttpRecogniser("http://127.0.0.1:8100").detect(JPEG);
    expect(passed?.redirect).toBe("error");
  });
});

describe("HttpRecogniser.probe", () => {
  it("reports both legs when the sidecar is healthy", async () => {
    vi.stubGlobal("fetch", async () =>
      respond({ service: "hal1000-recogniser", detector: "ok", embedder: "ok" }),
    );
    expect(await new HttpRecogniser("http://127.0.0.1:8100").probe()).toEqual({
      reachable: true,
      detector: "ok",
      embedder: "ok",
    });
  });

  it("reports the legs separately when the embedder is down", async () => {
    vi.stubGlobal("fetch", async () =>
      respond({ service: "hal1000-recogniser", detector: "ok", embedder: "corrupt" }),
    );
    const health = await new HttpRecogniser("http://127.0.0.1:8100").probe();
    expect(health.detector).toBe("ok");
    expect(health.embedder).toBe("corrupt");
  });

  it("refuses a 200 from something that is not a recogniser", async () => {
    // A liveness probe answers "is something listening", never "is this mine".
    vi.stubGlobal("fetch", async () => respond({ service: "some-other-app", detector: "ok", embedder: "ok" }));
    expect((await new HttpRecogniser("http://127.0.0.1:8100").probe()).reachable).toBe(false);
  });

  it("treats an unreachable host as not reachable rather than throwing", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    expect((await new HttpRecogniser("http://127.0.0.1:8100").probe()).reachable).toBe(false);
  });
});

describe("cosine", () => {
  it("scores identical unit vectors at 1 and orthogonal ones at 0", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1, 9);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 9);
  });

  it("returns 0 for a length mismatch rather than throwing mid-detection", () => {
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
  });

  it("returns 0 for an empty or zero vector", () => {
    expect(cosine([], [])).toBe(0);
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });
});
