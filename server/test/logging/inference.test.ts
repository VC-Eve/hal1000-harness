import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { InferenceLog, type InferenceRecord } from "../../src/logging/inference.js";
import { flushJsonl } from "../../src/storage/jsonl.js";
import { withCaptionLogging, withInferenceLogging } from "../../src/logging/instrument.js";
import { ProviderError, type ChatStreamOptions, type ModelInfo, type Provider } from "../../src/providers/provider.js";
import { CaptionerError, type Captioner } from "../../src/vision/captioner.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "hal1000-inference-"));
});

// Reads every record the log wrote, across all of its per-source files.
async function records(dir = path.join(root, "inference")): Promise<InferenceRecord[]> {
  // Records are written fire-and-forget, so the assertion waits for the disk.
  await flushJsonl();
  const out: InferenceRecord[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".jsonl")) {
        const text = await fs.readFile(full, "utf8");
        for (const line of text.split("\n").filter((l) => l.trim())) out.push(JSON.parse(line) as InferenceRecord);
      }
    }
  };
  await walk(dir);
  return out;
}

class FakeProvider implements Provider {
  constructor(private readonly run: (opts: ChatStreamOptions) => AsyncIterable<string>) {}
  async listModels(): Promise<ModelInfo[]> {
    return [];
  }
  chatStream(opts: ChatStreamOptions): AsyncIterable<string> {
    return this.run(opts);
  }
}

function tokens(...parts: string[]): (opts: ChatStreamOptions) => AsyncIterable<string> {
  return () =>
    (async function* () {
      for (const p of parts) yield p;
    })();
}

async function drain(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const token of stream) out += token;
  return out;
}

describe("InferenceLog", () => {
  it("records the input and the output of a completed call", async () => {
    const log = new InferenceLog(root);
    const factory = withInferenceLogging(() => new FakeProvider(tokens("Hel", "lo")), log);

    const text = await drain(
      factory("http://localhost:11434").chatStream({
        model: "hal:7b",
        messages: [
          { role: "system", content: "You are HAL." },
          { role: "user", content: "Say hello." },
        ],
        source: { kind: "chat", id: "conv-1", label: "First thread" },
      }),
    );

    expect(text).toBe("Hello");
    const [record] = await records();
    expect(record).toMatchObject({
      source: { kind: "chat", id: "conv-1" },
      model: "hal:7b",
      endpoint: "http://localhost:11434",
      system: "You are HAL.",
      output: "Hello",
      outcome: "ok",
      outputChars: 5,
    });
    // The whole request, not just the system prompt: analysing a completion
    // without the messages that produced it is guesswork.
    expect(record!.input).toEqual([
      { role: "system", content: "You are HAL." },
      { role: "user", content: "Say hello." },
    ]);
  });

  it("files each source separately, so one log's history reads on its own", async () => {
    const log = new InferenceLog(root);
    const factory = withInferenceLogging(() => new FakeProvider(tokens("ok")), log);
    const provider = factory("http://localhost:11434");

    await drain(provider.chatStream({ model: "m", messages: [], source: { kind: "session", id: "sess-aaa" } }));
    await drain(provider.chatStream({ model: "m", messages: [], source: { kind: "session", id: "sess-bbb" } }));
    await drain(provider.chatStream({ model: "m", messages: [], source: { kind: "vision", id: null } }));

    await flushJsonl();
    const day = new Date().toISOString().slice(0, 10);
    const inference = path.join(root, "inference");
    await expect(fs.stat(path.join(inference, "session", "sess-aaa", `${day}.jsonl`))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(inference, "session", "sess-bbb", `${day}.jsonl`))).resolves.toBeTruthy();
    // A source with no id has no directory level of its own.
    await expect(fs.stat(path.join(inference, "vision", `${day}.jsonl`))).resolves.toBeTruthy();
  });

  it("records a failed call, keeping whatever streamed before it failed", async () => {
    const log = new InferenceLog(root);
    const factory = withInferenceLogging(
      () =>
        new FakeProvider(() =>
          (async function* () {
            yield "partial";
            throw new ProviderError("provider_unavailable", "down");
          })(),
        ),
      log,
    );

    await expect(
      drain(factory("http://x").chatStream({ model: "m", messages: [], source: { kind: "monitor", id: "mon-1" } })),
    ).rejects.toThrow("down");

    const [record] = await records();
    expect(record).toMatchObject({
      outcome: "error",
      output: "partial",
      error: { code: "provider_unavailable", message: "down" },
    });
  });

  // Chat preempts narration constantly, so an abort is the most common way a
  // narration call ends. A log that only kept clean completions would omit
  // exactly the calls worth looking at.
  it("records an aborted call as aborted rather than dropping it", async () => {
    const log = new InferenceLog(root);
    const factory = withInferenceLogging(
      () =>
        new FakeProvider(() =>
          (async function* () {
            yield "cut ";
            throw new ProviderError("aborted", "Request was interrupted.");
          })(),
        ),
      log,
    );

    await expect(
      drain(factory("http://x").chatStream({ model: "m", messages: [], source: { kind: "session", id: "s1" } })),
    ).rejects.toThrow();

    const [record] = await records();
    expect(record).toMatchObject({ outcome: "aborted", output: "cut " });
  });

  it("keeps the usage counts the provider reported", async () => {
    const log = new InferenceLog(root);
    const factory = withInferenceLogging(
      () =>
        new FakeProvider((opts) =>
          (async function* () {
            yield "hi";
            opts.onMetrics?.({ promptTokens: 41, outputTokens: 2, totalDurationMs: 88 });
          })(),
        ),
      log,
    );

    await drain(factory("http://x").chatStream({ model: "m", messages: [], source: { kind: "chat", id: "c1" } }));
    const [record] = await records();
    expect(record!.metrics).toEqual({ promptTokens: 41, outputTokens: 2, totalDurationMs: 88 });
  });

  it("logs a call with no source rather than dropping it", async () => {
    const log = new InferenceLog(root);
    const factory = withInferenceLogging(() => new FakeProvider(tokens("x")), log);
    await drain(factory("http://x").chatStream({ model: "m", messages: [] }));
    const [record] = await records();
    expect(record!.source.kind).toBe("chat");
    expect(record!.outcome).toBe("ok");
  });

  it("records a caption against its frame, without the image", async () => {
    const log = new InferenceLog(root);
    const captioner: Captioner = {
      async caption() {
        return "A desk, and a cup.";
      },
      async probe() {
        return true;
      },
    };
    const make = withCaptionLogging(() => captioner, log);
    await make("http://localhost:8080").caption(Buffer.from("jpegbytes"), "Describe the frame.", undefined, {
      frame: "C:/data/vision-frames/2026-08-07.jpg",
    });

    const [record] = await records();
    expect(record).toMatchObject({
      source: { kind: "vision-caption" },
      output: "A desk, and a cup.",
      outcome: "ok",
      frame: "C:/data/vision-frames/2026-08-07.jpg",
    });
    // The frame is referenced, never inlined: a base64 image per line would
    // make the log unreadable and duplicate what `vision-frames/` holds.
    expect(JSON.stringify(record)).not.toContain("jpegbytes");
  });

  it("records a captioner failure", async () => {
    const log = new InferenceLog(root);
    const captioner: Captioner = {
      async caption() {
        throw new CaptionerError("The captioner at http://x is not reachable.", "unreachable");
      },
      async probe() {
        return false;
      },
    };
    const make = withCaptionLogging(() => captioner, log);
    await expect(make("http://x").caption(Buffer.from(""), "Describe.")).rejects.toThrow();

    const [record] = await records();
    expect(record).toMatchObject({ outcome: "error", error: { code: "unreachable" } });
  });

  // The log observes the app; it must never be able to take it down.
  it("does not fail the call when the record cannot be written", async () => {
    const log = new InferenceLog(root);
    // A file where the log wants a directory: every write under it fails.
    await fs.writeFile(path.join(root, "inference"), "not a directory", "utf8");
    const factory = withInferenceLogging(() => new FakeProvider(tokens("fine")), log);
    await expect(
      drain(factory("http://x").chatStream({ model: "m", messages: [], source: { kind: "chat", id: "c1" } })),
    ).resolves.toBe("fine");
  });
});
