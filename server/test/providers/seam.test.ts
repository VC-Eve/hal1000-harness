import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { makeProvider } from "../../src/providers/factory.js";
import { ollamaBackend, sameBackend, type ResolvedBackend } from "../../src/providers/provider.js";
import { withInferenceLogging } from "../../src/logging/instrument.js";
import { InferenceLog, type InferenceRecord } from "../../src/logging/inference.js";
import { flushJsonl } from "../../src/storage/jsonl.js";

// The provider seam takes a backend rather than an endpoint string.
//
// The behavioural guarantee this file carries is narrow and load-bearing: an
// api key travels on the backend and must not reach the inference log, which is
// kept verbatim and never pruned. `withInferenceLogging` is handed only the
// endpoint for exactly that reason, so the guarantee is structural — this
// asserts the structure holds rather than trusting the comment.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sameBackend", () => {
  it("treats a trailing slash as the same server", () => {
    expect(sameBackend("http://localhost:11434", "http://localhost:11434/")).toBe(true);
    expect(sameBackend("http://localhost:11434//", "http://localhost:11434")).toBe(true);
  });

  it("ignores surrounding whitespace a settings field will happily hold", () => {
    expect(sameBackend("  http://localhost:11434 ", "http://localhost:11434")).toBe(true);
  });

  it("keeps genuinely different servers apart", () => {
    expect(sameBackend("http://localhost:11434", "http://localhost:8080")).toBe(false);
    expect(sameBackend("http://localhost:11434", "https://api.example.com")).toBe(false);
  });
});

describe("makeProvider", () => {
  it("serves an ollama backend over the native API", async () => {
    const fetchMock = vi.fn(async () => Response.json({ models: [{ name: "llama3" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await makeProvider(ollamaBackend("http://localhost:11434")).listModels();

    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://localhost:11434/api/tags");
  });

  it("ollamaBackend names the protocol rather than leaving it to be guessed", () => {
    expect(ollamaBackend("http://localhost:11434")).toEqual({
      endpoint: "http://localhost:11434",
      protocol: "ollama",
    });
  });
});

describe("withInferenceLogging", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hal1000-seam-"));
  });

  async function records(): Promise<InferenceRecord[]> {
    const dir = path.join(root, "inference");
    const out: InferenceRecord[] = [];
    const walk = async (at: string): Promise<void> => {
      for (const entry of await fs.readdir(at, { withFileTypes: true })) {
        const next = path.join(at, entry.name);
        if (entry.isDirectory()) await walk(next);
        else if (entry.name.endsWith(".jsonl")) {
          const text = await fs.readFile(next, "utf8");
          for (const line of text.split("\n").filter((l) => l.trim())) out.push(JSON.parse(line) as InferenceRecord);
        }
      }
    };
    await walk(dir);
    return out;
  }

  const backendWithKey: ResolvedBackend = {
    endpoint: "http://api.example.com",
    protocol: "openai",
    apiKey: "sk-do-not-write-this-down",
  };

  function fakeFactory() {
    return () => ({
      async listModels() {
        return [];
      },
      async *chatStream() {
        yield "ok";
      },
    });
  }

  it("still records the endpoint the call went to", async () => {
    const log = new InferenceLog(root);
    const factory = withInferenceLogging(fakeFactory(), log);
    const stream = factory(ollamaBackend("http://localhost:11434")).chatStream({ model: "m", messages: [] });
    for await (const _ of stream) void _;
    await flushJsonl();

    const [record] = await records();
    expect(record!.endpoint).toBe("http://localhost:11434");
  });

  it("never writes an api key into the log", async () => {
    const log = new InferenceLog(root);
    const factory = withInferenceLogging(fakeFactory(), log);
    const stream = factory(backendWithKey).chatStream({
      model: "m",
      messages: [{ role: "user", content: "hello" }],
    });
    for await (const _ of stream) void _;
    await flushJsonl();

    // Asserted against the serialised record rather than a field, because a key
    // could only ever arrive here by being somewhere nobody thought to check.
    const written = JSON.stringify(await records());
    expect(written).not.toContain("sk-do-not-write-this-down");
    expect(written).toContain("http://api.example.com");
  });
});
