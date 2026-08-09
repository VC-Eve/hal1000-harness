import { describe, it, expect, afterEach, vi } from "vitest";
import { OpenAICompatibleProvider } from "../../src/providers/openai.js";
import { ProviderError } from "../../src/providers/provider.js";
import type { InferenceMetrics } from "../../src/logging/inference.js";

// The second protocol. What is asserted here is the protocol, not a vendor:
// llama.cpp, LM Studio, vLLM and the hosted APIs all answer this shape, so the
// canned responses below are the wire contract rather than any one server's.

/**
 * An SSE body, delivered in caller-chosen chunks.
 *
 * The chunk boundaries are the point of several tests: a real socket splits an
 * event wherever it likes, and a parser that assumed one network read was one
 * event would lose tokens only under timing nobody can reproduce on demand.
 */
function sseResponse(chunks: string[], opts: { status?: number; failAfter?: number } = {}): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.failAfter !== undefined && i >= opts.failAfter) {
        controller.error(new Error("socket hang up"));
        return;
      }
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]!));
      i += 1;
    },
  });
  return new Response(stream, { status: opts.status ?? 200 });
}

const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const token of iter) out.push(token);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAICompatibleProvider.chatStream", () => {
  it("yields the deltas in order and stops at [DONE]", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse([delta("I am "), delta("HAL"), delta("."), "data: [DONE]\n\n", delta("never")])),
    );
    const tokens = await collect(new OpenAICompatibleProvider("http://x").chatStream({ model: "m", messages: [] }));
    expect(tokens).toEqual(["I am ", "HAL", "."]);
  });

  it("reassembles an event split across network reads", async () => {
    const whole = delta("split");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse([whole.slice(0, 12), whole.slice(12), "data: [DONE]\n\n"])),
    );
    const tokens = await collect(new OpenAICompatibleProvider("http://x").chatStream({ model: "m", messages: [] }));
    expect(tokens).toEqual(["split"]);
  });

  it("ignores keep-alive comments and blank lines", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse([": ping\n\n", delta("ok"), "\n\n", ": ping\n\n", "data: [DONE]\n\n"])),
    );
    const tokens = await collect(new OpenAICompatibleProvider("http://x").chatStream({ model: "m", messages: [] }));
    expect(tokens).toEqual(["ok"]);
  });

  it("skips an unparseable fragment rather than failing a delivering stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse([delta("a"), "data: {not json\n\n", delta("b"), "data: [DONE]\n\n"])),
    );
    const tokens = await collect(new OpenAICompatibleProvider("http://x").chatStream({ model: "m", messages: [] }));
    expect(tokens).toEqual(["a", "b"]);
  });

  it("reports usage from the final event", async () => {
    const usage = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 41, completion_tokens: 2 } })}\n\n`;
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([delta("hi"), usage, "data: [DONE]\n\n"])));

    let seen: InferenceMetrics | null = null;
    await collect(
      new OpenAICompatibleProvider("http://x").chatStream({
        model: "m",
        messages: [],
        onMetrics: (m) => {
          seen = m;
        },
      }),
    );
    expect(seen).toEqual({ promptTokens: 41, outputTokens: 2 });
  });

  it("reports nothing rather than zeroes when the server never sends usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([delta("hi"), "data: [DONE]\n\n"])));
    const onMetrics = vi.fn();
    await collect(new OpenAICompatibleProvider("http://x").chatStream({ model: "m", messages: [], onMetrics }));
    expect(onMetrics).not.toHaveBeenCalled();
  });

  it("still reports usage when the stream ends without [DONE]", async () => {
    const usage = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 1 } })}\n\n`;
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([delta("hi"), usage])));
    let seen: InferenceMetrics | null = null;
    await collect(
      new OpenAICompatibleProvider("http://x").chatStream({
        model: "m",
        messages: [],
        onMetrics: (m) => {
          seen = m;
        },
      }),
    );
    expect(seen).toEqual({ promptTokens: 7, outputTokens: 1 });
  });

  it("raises model_not_found on a 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no such model", { status: 404 })));
    await expect(
      collect(new OpenAICompatibleProvider("http://x").chatStream({ model: "ghost", messages: [] })),
    ).rejects.toMatchObject({ code: "model_not_found" });
  });

  it("raises model_not_found when a 400 body names the model", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("The model `ghost` does not exist", { status: 400 })));
    await expect(
      collect(new OpenAICompatibleProvider("http://x").chatStream({ model: "ghost", messages: [] })),
    ).rejects.toMatchObject({ code: "model_not_found" });
  });

  it("raises provider_unavailable on a 500", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(
      collect(new OpenAICompatibleProvider("http://x").chatStream({ model: "m", messages: [] })),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("raises provider_unavailable when the connection cannot be made", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(
      collect(new OpenAICompatibleProvider("http://x").chatStream({ model: "m", messages: [] })),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("raises provider_unavailable when an error event arrives mid-stream", async () => {
    const err = `data: ${JSON.stringify({ error: { message: "context length exceeded" } })}\n\n`;
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([delta("a"), err])));
    await expect(
      collect(new OpenAICompatibleProvider("http://x").chatStream({ model: "m", messages: [] })),
    ).rejects.toThrow("context length exceeded");
  });

  it("raises aborted, not unavailable, when the caller cancels", async () => {
    const ctrl = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        ctrl.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }),
    );
    await expect(
      collect(new OpenAICompatibleProvider("http://x").chatStream({ model: "m", messages: [], signal: ctrl.signal })),
    ).rejects.toMatchObject({ code: "aborted" });
  });

  it("raises provider_unavailable when the body is dropped mid-stream", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([delta("a"), delta("b")], { failAfter: 1 })));
    await expect(
      collect(new OpenAICompatibleProvider("http://x").chatStream({ model: "m", messages: [] })),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("sends a bearer header only when a key is set", async () => {
    const withKey = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => sseResponse(["data: [DONE]\n\n"]));
    vi.stubGlobal("fetch", withKey);
    await collect(new OpenAICompatibleProvider("http://x", "sk-abc").chatStream({ model: "m", messages: [] }));
    expect((withKey.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ authorization: "Bearer sk-abc" });

    const withoutKey = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => sseResponse(["data: [DONE]\n\n"]));
    vi.stubGlobal("fetch", withoutKey);
    await collect(new OpenAICompatibleProvider("http://x").chatStream({ model: "m", messages: [] }));
    expect((withoutKey.mock.calls[0]![1] as RequestInit).headers).not.toHaveProperty("authorization");
  });

  it("never asks for a context window, because this protocol has no field for one", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => sseResponse(["data: [DONE]\n\n"]));
    vi.stubGlobal("fetch", fetchMock);
    await collect(
      new OpenAICompatibleProvider("http://x").chatStream({
        model: "m",
        messages: [],
        // Set by every caller in the app for Ollama's sake. It must be dropped
        // here rather than passed through as a field the server would ignore.
        options: { num_ctx: 8192 },
      }),
    );
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("options");
    expect(body).not.toHaveProperty("num_ctx");
  });

  it("posts to /v1/chat/completions, tolerating a trailing slash on the endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => sseResponse(["data: [DONE]\n\n"]));
    vi.stubGlobal("fetch", fetchMock);
    await collect(new OpenAICompatibleProvider("http://x:8080/").chatStream({ model: "m", messages: [] }));
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://x:8080/v1/chat/completions");
  });
});

describe("OpenAICompatibleProvider.listModels", () => {
  it("maps data[].id to model names", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "qwen3" }, { id: "gemma3" }] })));
    const models = await new OpenAICompatibleProvider("http://x").listModels();
    expect(models).toEqual([{ name: "qwen3" }, { name: "gemma3" }]);
  });

  it("reports no window, because /v1/models does not carry one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "qwen3" }] })));
    const [model] = await new OpenAICompatibleProvider("http://x").listModels();
    expect(model!.contextTokens).toBeUndefined();
  });

  it("tolerates an absent or malformed data array", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
    await expect(new OpenAICompatibleProvider("http://x").listModels()).resolves.toEqual([]);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: 7 }, {}, { id: "ok" }] })));
    await expect(new OpenAICompatibleProvider("http://x").listModels()).resolves.toEqual([{ name: "ok" }]);
  });

  it("returns an empty list, not an error, when the server has no models", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [] })));
    await expect(new OpenAICompatibleProvider("http://x").listModels()).resolves.toEqual([]);
  });

  it("raises provider_unavailable when unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(new OpenAICompatibleProvider("http://x").listModels()).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("OpenAICompatibleProvider.modelWindow", () => {
  it("reads n_ctx from /props", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ n_ctx: 16384 })));
    await expect(new OpenAICompatibleProvider("http://x").modelWindow()).resolves.toBe(16384);
  });

  it("reads n_ctx from the nested generation settings llama-server also uses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ default_generation_settings: { n_ctx: 4096 } })));
    await expect(new OpenAICompatibleProvider("http://x").modelWindow()).resolves.toBe(4096);
  });

  it("returns null when the server has no /props at all", async () => {
    // Every hosted API. Unknown is a defined answer the caller handles by
    // falling back conservatively — never by treating it as unlimited.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    await expect(new OpenAICompatibleProvider("http://x").modelWindow()).resolves.toBeNull();
  });

  it("returns null for a window that is absent, zero, or not a number", async () => {
    for (const body of [{}, { n_ctx: 0 }, { n_ctx: "8192" }, { n_ctx: Number.NaN }]) {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
      await expect(new OpenAICompatibleProvider("http://x").modelWindow()).resolves.toBeNull();
    }
  });

  it("returns null rather than throwing when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(new OpenAICompatibleProvider("http://x").modelWindow()).resolves.toBeNull();
  });
});
