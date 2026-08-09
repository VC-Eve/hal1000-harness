import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { probeEachBackend } from "../../src/providers/probe.js";
import { forgetAllProtocols } from "../../src/providers/detect.js";
import { SettingsStore } from "../../src/storage/settings.js";
import { BACKEND_SLOTS } from "../../../shared/src/types.js";
import type { ResolvedBackend } from "../../src/providers/provider.js";

// Ask each distinct backend once, and give every slot its own answer.
//
// The assertions that matter here are the call counts. Both defects this module
// was written for were invisible in the results — one slot's verdict copied
// onto the other looks exactly like two probes agreeing, right up until the two
// slots stop being the same destination. So every case pins how many times the
// probe actually ran, not only what came back.

let dir: string;
let settings: SettingsStore;

const HOSTED = "https://api.example.com";
const LOCAL = "http://localhost:11434";

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-probe-"));
  settings = new SettingsStore(dir);
  await settings.load();
  forgetAllProtocols();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** Records which backends it was handed, so call count is assertable. */
function recorder<T>(value: T) {
  const seen: ResolvedBackend[] = [];
  const probe = async (backend: ResolvedBackend): Promise<T> => {
    seen.push(backend);
    return value;
  };
  return { probe, seen };
}

describe("probeEachBackend", () => {
  it("asks once when both slots name the same destination", async () => {
    await settings.update({
      backends: { chat: { endpoint: LOCAL, protocol: "ollama" }, observation: { endpoint: LOCAL, protocol: "ollama" } },
    });
    const { probe, seen } = recorder(["qwen3"]);

    const out = await probeEachBackend(BACKEND_SLOTS, settings, probe);

    expect(seen.length).toBe(1);
    expect(out.get("chat")).toMatchObject({ value: ["qwen3"] });
    expect(out.get("observation")).toMatchObject({ value: ["qwen3"] });
  });

  it("asks twice when one slot carries a key and the other does not", async () => {
    // The reviewed defect. Same host, same protocol, one credential — the old
    // endpoint comparison called these one destination and probed once, with
    // whichever key happened to belong to the slot it probed.
    await settings.update({
      backends: {
        chat: { endpoint: HOSTED, protocol: "openai" },
        observation: { endpoint: HOSTED, protocol: "openai", apiKey: "sk-obs" },
      },
    });
    const { probe, seen } = recorder(["gpt-fake"]);

    await probeEachBackend(BACKEND_SLOTS, settings, probe);

    expect(seen.length).toBe(2);
    expect(seen.some((b) => b.apiKey === "sk-obs")).toBe(true);
    expect(seen.some((b) => b.apiKey === undefined)).toBe(true);
  });

  it("asks twice when one slot's protocol resolved differently", async () => {
    await settings.update({
      backends: {
        chat: { endpoint: LOCAL, protocol: "openai" },
        observation: { endpoint: LOCAL, protocol: "ollama" },
      },
    });
    const { probe, seen } = recorder([]);

    await probeEachBackend(BACKEND_SLOTS, settings, probe);

    expect(seen.length).toBe(2);
  });

  it("asks twice when the slots name different servers", async () => {
    await settings.update({
      backends: {
        chat: { endpoint: HOSTED, protocol: "openai" },
        observation: { endpoint: LOCAL, protocol: "ollama" },
      },
    });
    const { probe, seen } = recorder([]);

    await probeEachBackend(BACKEND_SLOTS, settings, probe);

    expect(seen.length).toBe(2);
  });

  it("contains one slot's unresolvable backend rather than spreading it", async () => {
    // Nothing listening at chat's endpoint and no protocol pinned, so its
    // protocol cannot be determined. Observation is pinned and fine.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await settings.update({
      backends: {
        chat: { endpoint: "http://127.0.0.1:9", protocol: "auto" },
        observation: { endpoint: LOCAL, protocol: "ollama" },
      },
    });
    const { probe, seen } = recorder(["qwen3"]);

    const out = await probeEachBackend(BACKEND_SLOTS, settings, probe);

    expect(out.get("chat")).toEqual({ backend: null });
    expect(out.get("observation")).toMatchObject({ value: ["qwen3"] });
    expect(seen.length).toBe(1);
  });

  it("contains a throwing probe to the group that provoked it", async () => {
    // The mirror image of the defect above: one slot's failure must not be
    // reported as the other's, on a backend that is answering.
    await settings.update({
      backends: {
        chat: { endpoint: HOSTED, protocol: "openai" },
        observation: { endpoint: LOCAL, protocol: "ollama" },
      },
    });
    const probe = async (backend: ResolvedBackend): Promise<string[]> => {
      if (backend.endpoint === HOSTED) throw new Error("401");
      return ["qwen3"];
    };

    const out = await probeEachBackend(BACKEND_SLOTS, settings, probe);

    expect(out.get("chat")).toMatchObject({ error: expect.any(Error) });
    expect(out.get("observation")).toMatchObject({ value: ["qwen3"] });
  });
});
