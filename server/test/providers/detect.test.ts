import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { detectProtocol, forgetProtocol, forgetAllProtocols, resolveProtocol } from "../../src/providers/detect.js";

// Which protocol an endpoint speaks, worked out rather than declared.
//
// The load-bearing assertion in this file is the both-answer case. Ollama
// serves `/api/tags` AND its own `/v1/models`, so probe order is what decides
// which provider a stock Ollama gets — and the OpenAI schema has no field for
// `num_ctx`, which every request in this app sets. Detecting Ollama as
// OpenAI-compatible would quietly degrade Context Level with no error anywhere.
// The order is behaviour, so it is pinned here rather than left to whichever
// probe happens to be written first.

/**
 * A server that answers only the routes it is given.
 *
 * Returns 404 for everything else, which is what a real server does for a
 * route belonging to the other protocol.
 */
function serverAnswering(...routes: string[]) {
  return vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    return routes.some((r) => href.endsWith(r))
      ? Response.json({ models: [], data: [] })
      : new Response("not found", { status: 404 });
  });
}

/**
 * A hosted API: it answers its route, but only to a caller carrying the key.
 *
 * `401` rather than a refusal to connect, which is the whole difficulty — an
 * unauthenticated probe cannot tell that apart from nothing listening.
 */
function serverRequiringKey(route: string, key: string) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (!href.endsWith(route)) return new Response("not found", { status: 404 });
    const auth = new Headers(init?.headers).get("authorization");
    return auth === `Bearer ${key}`
      ? Response.json({ data: [] })
      : new Response("unauthorized", { status: 401 });
  });
}

const OLLAMA = "/api/tags";
const OPENAI = "/v1/models";

beforeEach(() => {
  forgetAllProtocols();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("detectProtocol", () => {
  it("detects ollama from /api/tags", async () => {
    vi.stubGlobal("fetch", serverAnswering(OLLAMA));
    await expect(detectProtocol("http://localhost:11434")).resolves.toBe("ollama");
  });

  it("detects openai from /v1/models", async () => {
    vi.stubGlobal("fetch", serverAnswering(OPENAI));
    await expect(detectProtocol("http://localhost:8080")).resolves.toBe("openai");
  });

  it("detects ollama when a server answers BOTH, because num_ctx depends on it", async () => {
    // Stock Ollama. Going through its own `/v1` compatibility layer would lose
    // the per-request context window that Context Level sizes against, with no
    // error and no visible change until a system prompt got evicted.
    vi.stubGlobal("fetch", serverAnswering(OLLAMA, OPENAI));
    await expect(detectProtocol("http://localhost:11434")).resolves.toBe("ollama");
  });

  it("returns null when the endpoint answers neither", async () => {
    vi.stubGlobal("fetch", serverAnswering());
    await expect(detectProtocol("http://localhost:9999")).resolves.toBeNull();
  });

  it("returns null when nothing is listening at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(detectProtocol("http://localhost:9999")).resolves.toBeNull();
  });

  it("asks once per endpoint and serves the answer thereafter", async () => {
    const fetchMock = serverAnswering(OPENAI);
    vi.stubGlobal("fetch", fetchMock);

    await detectProtocol("http://localhost:8080");
    const afterFirst = fetchMock.mock.calls.length;
    await detectProtocol("http://localhost:8080");

    expect(fetchMock.mock.calls.length).toBe(afterFirst);
  });

  it("does not cache a failure, so a server that starts later is found", async () => {
    // Booting HAL before Ollama must not strand it. Readiness already re-probes
    // on its own schedule; caching "unreachable" would make that recovery
    // impossible without a settings change nobody has a reason to make.
    const down = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    vi.stubGlobal("fetch", down);
    await expect(detectProtocol("http://localhost:11434")).resolves.toBeNull();

    vi.stubGlobal("fetch", serverAnswering(OLLAMA));
    await expect(detectProtocol("http://localhost:11434")).resolves.toBe("ollama");
  });

  it("keeps separate endpoints separate", async () => {
    vi.stubGlobal("fetch", serverAnswering(OLLAMA));
    await expect(detectProtocol("http://localhost:11434")).resolves.toBe("ollama");

    vi.stubGlobal("fetch", serverAnswering(OPENAI));
    await expect(detectProtocol("http://localhost:8080")).resolves.toBe("openai");
  });

  it("treats endpoints differing only by trailing slash as one entry", async () => {
    const fetchMock = serverAnswering(OPENAI);
    vi.stubGlobal("fetch", fetchMock);

    await detectProtocol("http://localhost:8080");
    const afterFirst = fetchMock.mock.calls.length;
    await expect(detectProtocol("http://localhost:8080/")).resolves.toBe("openai");

    expect(fetchMock.mock.calls.length).toBe(afterFirst);
  });

  it("probes concurrent callers once rather than racing", async () => {
    const fetchMock = serverAnswering(OPENAI);
    vi.stubGlobal("fetch", fetchMock);

    const [a, b, c] = await Promise.all([
      detectProtocol("http://localhost:8080"),
      detectProtocol("http://localhost:8080"),
      detectProtocol("http://localhost:8080"),
    ]);

    expect([a, b, c]).toEqual(["openai", "openai", "openai"]);
    // One detection, not three: `/api/tags` then `/v1/models`.
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("presents the key, so a hosted API behind one can be detected at all", async () => {
    // The case the OpenAI-compatible protocol was added to reach. An anonymous
    // GET gets 401, `res.ok` is false, and detection reports the endpoint
    // unreachable — for a backend that is working and whose key HAL holds.
    vi.stubGlobal("fetch", serverRequiringKey(OPENAI, "sk-secret"));
    await expect(detectProtocol("https://api.example.com", "sk-secret")).resolves.toBe("openai");
  });

  it("finds nothing at a keyed endpoint when the key is withheld", async () => {
    vi.stubGlobal("fetch", serverRequiringKey(OPENAI, "sk-secret"));
    await expect(detectProtocol("https://api.example.com")).resolves.toBeNull();
  });

  it("keys the answer by endpoint, not by credential", async () => {
    // Which protocol a server speaks is a property of the server. Two slots on
    // one host, one of them keyed, must not probe twice to learn one fact.
    const fetchMock = serverRequiringKey(OPENAI, "sk-secret");
    vi.stubGlobal("fetch", fetchMock);

    await detectProtocol("https://api.example.com", "sk-secret");
    const afterFirst = fetchMock.mock.calls.length;
    await expect(detectProtocol("https://api.example.com")).resolves.toBe("openai");

    expect(fetchMock.mock.calls.length).toBe(afterFirst);
  });

  it("re-probes after forgetProtocol", async () => {
    const fetchMock = serverAnswering(OLLAMA);
    vi.stubGlobal("fetch", fetchMock);
    await detectProtocol("http://localhost:11434");
    const afterFirst = fetchMock.mock.calls.length;

    forgetProtocol("http://localhost:11434");
    await detectProtocol("http://localhost:11434");

    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it("forgets by server rather than by spelling", async () => {
    const fetchMock = serverAnswering(OLLAMA);
    vi.stubGlobal("fetch", fetchMock);
    await detectProtocol("http://localhost:11434");
    const afterFirst = fetchMock.mock.calls.length;

    forgetProtocol("http://localhost:11434/");
    await detectProtocol("http://localhost:11434");

    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});

describe("resolveProtocol", () => {
  it("returns an override without issuing any request at all", async () => {
    const fetchMock = serverAnswering(OLLAMA, OPENAI);
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveProtocol("http://localhost:11434", "openai")).resolves.toBe("openai");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets an override win over what the probe would have said", async () => {
    vi.stubGlobal("fetch", serverAnswering(OLLAMA));
    await expect(resolveProtocol("http://localhost:11434", "openai")).resolves.toBe("openai");
  });

  it("never writes an override into the cache", async () => {
    // Clearing an override must fall back to probing, not to a value the
    // override left behind — a stale answer nobody chose is worse than the
    // round-trip.
    vi.stubGlobal("fetch", serverAnswering(OLLAMA));
    await resolveProtocol("http://localhost:11434", "openai");
    await expect(resolveProtocol("http://localhost:11434", "auto")).resolves.toBe("ollama");
  });

  it("probes when the preference is auto or absent", async () => {
    vi.stubGlobal("fetch", serverAnswering(OPENAI));
    await expect(resolveProtocol("http://localhost:8080", "auto")).resolves.toBe("openai");
    forgetAllProtocols();
    await expect(resolveProtocol("http://localhost:8080")).resolves.toBe("openai");
  });

  it("carries the key into the probe it issues", async () => {
    vi.stubGlobal("fetch", serverRequiringKey(OPENAI, "sk-secret"));
    await expect(resolveProtocol("https://api.example.com", "auto", "sk-secret")).resolves.toBe("openai");
  });
});
