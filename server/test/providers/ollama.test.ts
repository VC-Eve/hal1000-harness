import { describe, it, expect, afterEach, vi } from "vitest";
import { OllamaProvider } from "../../src/providers/ollama.js";
import { ProviderError } from "../../src/providers/provider.js";

function ndjsonResponse(lines: object[], opts: { failAfter?: number } = {}): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.failAfter !== undefined && i >= opts.failAfter) {
        controller.error(new Error("socket hang up"));
        return;
      }
      if (i >= lines.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(JSON.stringify(lines[i]) + "\n"));
      i += 1;
    },
  });
  return new Response(stream, { status: 200 });
}

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const token of iter) out.push(token);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OllamaProvider.listModels", () => {
  it("lists model names from /api/tags", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ models: [{ name: "llama3" }, { name: "hal-ft" }] })));
    const models = await new OllamaProvider().listModels();
    expect(models.map((m) => m.name)).toEqual(["llama3", "hal-ft"]);
  });

  it("returns an empty list (not an error) when no models are pulled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ models: [] })));
    await expect(new OllamaProvider().listModels()).resolves.toEqual([]);
  });

  it("throws provider_unavailable when Ollama is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const err = await new OllamaProvider().listModels().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("provider_unavailable");
  });
});

describe("OllamaProvider.chatStream", () => {
  it("streams tokens in order and stops at done", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      ndjsonResponse([
        { message: { content: "I am " } },
        { message: { content: "HAL." } },
        { done: true },
        { message: { content: "never seen" } },
      ]),
    ));
    const tokens = await collect(new OllamaProvider().chatStream({ model: "llama3", messages: [] }));
    expect(tokens).toEqual(["I am ", "HAL."]);
  });

  it("throws model_not_found on 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"model \\"nope\\" not found"}', { status: 404 })));
    const err = await collect(new OllamaProvider().chatStream({ model: "nope", messages: [] })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("model_not_found");
  });

  it("yields received tokens then throws on mid-stream disconnect", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      ndjsonResponse([{ message: { content: "partial " } }, { message: { content: "reply" } }], { failAfter: 2 }),
    ));
    const received: string[] = [];
    const err = await (async () => {
      try {
        for await (const token of new OllamaProvider().chatStream({ model: "llama3", messages: [] })) {
          received.push(token);
        }
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(received).toEqual(["partial ", "reply"]);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("provider_unavailable");
  });

  it("throws aborted when the signal fires", async () => {
    const ctrl = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    }));
    const pending = collect(new OllamaProvider().chatStream({ model: "llama3", messages: [], signal: ctrl.signal }));
    ctrl.abort();
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("aborted");
  });
});

// Live integration — runs only when a local Ollama responds quickly.
const ollamaUp = await fetch("http://localhost:11434/api/version", { signal: AbortSignal.timeout(1500) })
  .then(() => true)
  .catch(() => false);

describe.skipIf(!ollamaUp)("OllamaProvider (live)", () => {
  it("lists models from the running instance", async () => {
    const models = await new OllamaProvider().listModels();
    expect(Array.isArray(models)).toBe(true);
  });
});
