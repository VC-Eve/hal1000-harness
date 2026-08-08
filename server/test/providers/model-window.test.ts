import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaProvider } from "../../src/providers/ollama.js";
import { contextBudgetChars, usableWindowTokens } from "../../../shared/src/prompts.js";
import { FALLBACK_CONTEXT_TOKENS } from "../../../shared/src/types.js";

// U8 — the window belongs to the model, and the model is chosen per
// conversation. These lock in the two things that make a derived budget safe:
// unknown never reads as unlimited, and the cap always wins when it is smaller.

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

describe("reading a model's window", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("carries the window from the list payload without a second request", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ models: [{ name: "big:latest", details: { context_length: 262144 } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const models = await new OllamaProvider("http://x").listModels();
    expect(models).toEqual([{ name: "big:latest", contextTokens: 262144 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("omits the window rather than inventing one when the list payload has none", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ models: [{ name: "quiet:latest" }] }));
    const models = await new OllamaProvider("http://x").listModels();
    expect(models).toEqual([{ name: "quiet:latest" }]);
  });

  it("finds the window under an architecture-prefixed key", async () => {
    // The key is `deepseek2.context_length` on one local model and
    // `qwen35.context_length` on another. Scanning the suffix means a new
    // architecture does not read as unknown purely because nobody listed it.
    vi.stubGlobal("fetch", async () =>
      jsonResponse({ model_info: { "deepseek2.context_length": 202752, "deepseek2.block_count": 40 } }),
    );
    expect(await new OllamaProvider("http://x").modelWindow("glm")).toBe(202752);
  });

  it("prefers the plain details key when the detail endpoint carries one", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse({ details: { context_length: 4096 }, model_info: { "x.context_length": 999999 } }),
    );
    expect(await new OllamaProvider("http://x").modelWindow("m")).toBe(4096);
  });

  it("returns null rather than throwing when the provider is unreachable", async () => {
    // A chat send must not fail over a number it can do without.
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await new OllamaProvider("http://x").modelWindow("m")).toBeNull();
  });

  it("returns null on a non-ok response", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({}, false));
    expect(await new OllamaProvider("http://x").modelWindow("m")).toBeNull();
  });

  it("rejects a non-numeric or zero window rather than passing it through", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse({ model_info: { "a.context_length": "lots", "b.context_length": 0 } }),
    );
    expect(await new OllamaProvider("http://x").modelWindow("m")).toBeNull();
  });
});

describe("the usable window", () => {
  it("takes the model's window when it is under the cap", () => {
    expect(usableWindowTokens(2048, 8192)).toBe(2048);
  });

  it("takes the cap when the model advertises more", () => {
    // 262,144 tokens of KV cache is not what this card has.
    expect(usableWindowTokens(262144, 8192)).toBe(8192);
  });

  it("falls back conservatively when the model's window is unknown", () => {
    // The failure this prevents: unknown reading as unlimited and evicting the
    // system prompt on a 2k model.
    expect(usableWindowTokens(null, 8192)).toBe(FALLBACK_CONTEXT_TOKENS);
    expect(usableWindowTokens(undefined, 8192)).toBe(FALLBACK_CONTEXT_TOKENS);
  });

  it("falls back on NaN rather than propagating it into a comparison", () => {
    expect(usableWindowTokens(Number.NaN, 8192)).toBe(FALLBACK_CONTEXT_TOKENS);
    expect(usableWindowTokens(8192, Number.NaN)).toBe(FALLBACK_CONTEXT_TOKENS);
  });

  it("falls back on a zero or negative window", () => {
    expect(usableWindowTokens(0, 8192)).toBe(FALLBACK_CONTEXT_TOKENS);
    expect(usableWindowTokens(-1, 8192)).toBe(FALLBACK_CONTEXT_TOKENS);
  });
});

describe("a level's character budget", () => {
  it("is zero when the source is off", () => {
    expect(contextBudgetChars("off", 8192)).toBe(0);
  });

  it("grows with the level", () => {
    const small = contextBudgetChars("small", 8192);
    const medium = contextBudgetChars("medium", 8192);
    const large = contextBudgetChars("large", 8192);
    expect(small).toBeLessThan(medium);
    expect(medium).toBeLessThan(large);
  });

  it("means different characters on different windows", () => {
    // The whole reason a level is a share: the same label against a 2k model
    // and a 32k one must not promise the same size.
    expect(contextBudgetChars("large", 2048)).toBeLessThan(contextBudgetChars("large", 32768));
  });

  it("leaves half the window free with both sources at maximum", () => {
    // Two sources at `large` is the worst case, and it must still leave room
    // for the system prompt and the history.
    const window = 8192;
    const both = contextBudgetChars("large", window) * 2;
    expect(both).toBeLessThanOrEqual(window * 4 * 0.5);
  });

  it("yields zero rather than a negative or NaN budget on a broken window", () => {
    expect(contextBudgetChars("large", Number.NaN)).toBe(0);
    expect(contextBudgetChars("large", 0)).toBe(0);
  });
});
