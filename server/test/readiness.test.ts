import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { probeReadiness } from "../src/readiness.js";
import { SettingsStore } from "../src/storage/settings.js";
import { ProviderError, type Provider } from "../src/providers/provider.js";

let dir: string;
let projectsDir: string;
let settings: SettingsStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal1000-ready-"));
  projectsDir = path.join(dir, "projects");
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

describe("probeReadiness", () => {
  it("reports all green when everything is present", async () => {
    await fs.mkdir(path.join(projectsDir, "C--proj"), { recursive: true });
    await fs.writeFile(path.join(projectsDir, "C--proj", "abc.jsonl"), "{}\n");
    const r = await probeReadiness(provider(["llama3"]), settings, projectsDir);
    expect(r).toEqual({ ollama: "ok", models: "ok", claudeLogs: "ok" });
  });

  it("distinguishes Ollama-down from zero-models", async () => {
    const down = await probeReadiness(provider("down"), settings, projectsDir);
    expect(down.ollama).toBe("unreachable");
    expect(down.models).toBe("unknown");

    const empty = await probeReadiness(provider([]), settings, projectsDir);
    expect(empty.ollama).toBe("ok");
    expect(empty.models).toBe("none");
  });

  it("reports missing Claude logs for absent dir and for jsonl-less projects", async () => {
    const absent = await probeReadiness(provider(["m"]), settings, projectsDir);
    expect(absent.claudeLogs).toBe("missing");

    await fs.mkdir(path.join(projectsDir, "C--proj", "memory"), { recursive: true });
    const jsonlLess = await probeReadiness(provider(["m"]), settings, projectsDir);
    expect(jsonlLess.claudeLogs).toBe("missing");
  });

  it("clears a failure state on re-probe after the condition is fixed", async () => {
    const before = await probeReadiness(provider([]), settings, projectsDir);
    expect(before.models).toBe("none");
    const after = await probeReadiness(provider(["pulled-now"]), settings, projectsDir);
    expect(after.models).toBe("ok");
  });
});
