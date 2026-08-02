import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { probeReadiness } from "../src/readiness.js";
import { SettingsStore } from "../src/storage/settings.js";
import { ProviderError, type Provider } from "../src/providers/provider.js";

let settings: SettingsStore;

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal1000-ready-"));
  settings = new SettingsStore(dir);
  await settings.load();
});

const provider = (models: string[] | "down"): (() => Provider) => () => ({
  async listModels() {
    if (models === "down") throw new ProviderError("provider_unavailable", "unreachable");
    return models.map((name) => ({ name }));
  },
  async *chatStream() {
    yield "";
  },
});

const sessions = (count: number) => async () => Array.from({ length: count }, (_, i) => ({ id: String(i) }));
const sessionsError = async (): Promise<unknown[]> => {
  throw new Error("discovery failed");
};

describe("probeReadiness", () => {
  it("reports all green when everything is present", async () => {
    const r = await probeReadiness(provider(["llama3"]), settings, sessions(2));
    expect(r).toEqual({ ollama: "ok", models: "ok", claudeLogs: "ok" });
  });

  it("distinguishes Ollama-down from zero-models", async () => {
    const down = await probeReadiness(provider("down"), settings, sessions(1));
    expect(down.ollama).toBe("unreachable");
    expect(down.models).toBe("unknown");

    const empty = await probeReadiness(provider([]), settings, sessions(1));
    expect(empty.ollama).toBe("ok");
    expect(empty.models).toBe("none");
  });

  it("reports missing Claude logs when discovery finds no sessions or fails", async () => {
    const none = await probeReadiness(provider(["m"]), settings, sessions(0));
    expect(none.claudeLogs).toBe("missing");

    const failed = await probeReadiness(provider(["m"]), settings, sessionsError);
    expect(failed.claudeLogs).toBe("missing");
  });

  it("clears a failure state on re-probe after the condition is fixed", async () => {
    const before = await probeReadiness(provider([]), settings, sessions(0));
    expect(before.models).toBe("none");
    expect(before.claudeLogs).toBe("missing");
    const after = await probeReadiness(provider(["pulled-now"]), settings, sessions(1));
    expect(after.models).toBe("ok");
    expect(after.claudeLogs).toBe("ok");
  });
});
