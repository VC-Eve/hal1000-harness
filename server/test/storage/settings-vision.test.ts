import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { SettingsStore, DEFAULT_VISION } from "../../src/storage/settings.js";

let dir: string;
let settings: SettingsStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal1000-vset-"));
  settings = new SettingsStore(dir);
  await settings.load();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("vision settings", () => {
  it("ships off, so nothing opens a camera before someone asks", async () => {
    expect(settings.get().vision.enabled).toBe(false);
  });

  it("merges per field rather than replacing the block", async () => {
    await settings.update({ vision: { intervalSeconds: 120, prompt: "watch quietly" } });
    await settings.update({ vision: { enabled: true } });

    const vision = settings.get().vision;
    // Turning it on must not discard a tuned interval or an edited prompt.
    expect(vision.enabled).toBe(true);
    expect(vision.intervalSeconds).toBe(120);
    expect(vision.prompt).toBe("watch quietly");
  });

  it("clamps an interval that would capture in a loop", async () => {
    await settings.update({ vision: { intervalSeconds: 0 } });
    expect(settings.get().vision.intervalSeconds).toBe(5);

    await settings.update({ vision: { intervalSeconds: 99_999 } });
    expect(settings.get().vision.intervalSeconds).toBe(3_600);
  });

  it("keeps the stored value when a number arrives as garbage", async () => {
    await settings.update({ vision: { retainFrames: "twenty" as unknown as number } });
    expect(settings.get().vision.retainFrames).toBe(DEFAULT_VISION.retainFrames);
  });

  it("ignores a sensitivity outside the dial", async () => {
    await settings.update({ vision: { sensitivity: "constant" as never } });
    expect(settings.get().vision.sensitivity).toBe("medium");

    await settings.update({ vision: { sensitivity: "always" } });
    expect(settings.get().vision.sensitivity).toBe("always");
  });

  it("treats a null device as a choice, not an omission", async () => {
    await settings.update({ vision: { device: "Logi C310" } });
    expect(settings.get().vision.device).toBe("Logi C310");

    // Null means "whatever this machine lists first" and must survive a write.
    await settings.update({ vision: { device: null } });
    expect(settings.get().vision.device).toBeNull();
  });

  it("resets a prompt to the shipped default with null", async () => {
    await settings.update({ vision: { captionPrompt: "mine" } });
    await settings.update({ vision: { captionPrompt: null } });
    expect(settings.get().vision.captionPrompt).toBeNull();
  });

  it("seeds vision onto a settings file written before it existed", async () => {
    await fs.writeFile(
      path.join(dir, "settings.json"),
      JSON.stringify({ providerEndpoint: "http://localhost:11434", chatModel: "m" }),
    );
    const reloaded = new SettingsStore(dir);
    await reloaded.load();
    expect(reloaded.get().vision).toEqual(DEFAULT_VISION);
  });
});
