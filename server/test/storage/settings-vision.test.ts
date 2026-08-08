import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { SettingsStore, DEFAULT_VISION } from "../../src/storage/settings.js";
import { MIN_BAND_SEPARATION } from "../../../shared/src/types.js";

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

describe("the two identity thresholds (U4, R2/R3)", () => {
  const bands = () => {
    const v = settings.get().vision;
    return { recognition: v.confidenceThreshold, statement: v.statementThreshold };
  };

  it("ships with a reachable hedged band", async () => {
    expect(bands()).toEqual({ recognition: 0.5, statement: 0.6 });
  });

  it("keeps both settable independently", async () => {
    await settings.update({ vision: { confidenceThreshold: 0.4 } });
    await settings.update({ vision: { statementThreshold: 0.8 } });
    expect(bands()).toEqual({ recognition: 0.4, statement: 0.8 });
  });

  it("refuses to let the statement threshold sink below the recognition one", async () => {
    // Inverted, the hedged band would be negative and every recognised face
    // would be stated flat — the opposite of what the pair exists to express.
    await settings.update({ vision: { statementThreshold: 0.2 } });
    const { recognition, statement } = bands();
    expect(statement).toBeGreaterThan(recognition);
    expect(statement - recognition).toBeGreaterThanOrEqual(MIN_BAND_SEPARATION - 1e-9);
  });

  it("refuses to let the two be set equal", async () => {
    // R3's actual point. Equal thresholds delete the hedge through the settings
    // panel, on a threshold whose governing quantity has never been measured.
    await settings.update({ vision: { confidenceThreshold: 0.7, statementThreshold: 0.7 } });
    const { recognition, statement } = bands();
    expect(statement - recognition).toBeGreaterThanOrEqual(MIN_BAND_SEPARATION - 1e-9);
  });

  it("pushes the statement threshold up when the recognition one is raised past it", async () => {
    await settings.update({ vision: { confidenceThreshold: 0.4, statementThreshold: 0.5 } });
    await settings.update({ vision: { confidenceThreshold: 0.8 } });
    const { recognition, statement } = bands();
    expect(recognition).toBe(0.8);
    expect(statement).toBeGreaterThanOrEqual(0.85 - 1e-9);
  });

  it("pulls the recognition threshold down when the statement one hits the ceiling", async () => {
    // The statement threshold cannot rise forever; at the top the other one
    // gives way instead, so the band survives rather than collapsing at 0.99.
    await settings.update({ vision: { confidenceThreshold: 0.99 } });
    const { recognition, statement } = bands();
    expect(statement).toBeLessThanOrEqual(0.99);
    expect(statement - recognition).toBeGreaterThanOrEqual(MIN_BAND_SEPARATION - 1e-9);
  });

  it("keeps a non-finite threshold from reaching the comparison at all", async () => {
    // Supplied deliberately. `NaN` fails every comparison, so a guard written
    // as a negation would treat it as a satisfied constraint and let a face be
    // stated at NaN% — the failure recorded in
    // docs/solutions/a-threshold-guard-written-as-a-negation-fails-open-on-nan.md.
    for (const bad of [NaN, Infinity, -Infinity]) {
      await settings.update({ vision: { statementThreshold: bad } });
      const { recognition, statement } = bands();
      expect(Number.isFinite(statement)).toBe(true);
      expect(statement - recognition).toBeGreaterThanOrEqual(MIN_BAND_SEPARATION - 1e-9);
    }
  });

  it("ignores a threshold that is not a number", async () => {
    await settings.update({ vision: { statementThreshold: "0.9" as unknown as number } });
    expect(Number.isFinite(bands().statement)).toBe(true);
  });

  it("repairs an inverted pair written into the file by hand", async () => {
    // The file is hand-editable and this pair decides whether a human gets
    // named, so it has to be valid at load rather than only after the next
    // patch through the panel. Written directly to disk, because going through
    // `update` would exercise the path that is already covered above.
    await fs.writeFile(
      path.join(dir, "settings.json"),
      JSON.stringify({ vision: { confidenceThreshold: 0.9, statementThreshold: 0.3 } }),
      "utf8",
    );

    const reloaded = new SettingsStore(dir);
    await reloaded.load();

    const v = reloaded.get().vision;
    expect(v.statementThreshold).toBeGreaterThan(v.confidenceThreshold);
    expect(v.statementThreshold - v.confidenceThreshold).toBeGreaterThanOrEqual(MIN_BAND_SEPARATION - 1e-9);
  });

  it("leaves no floating-point debris in a file a person may open", async () => {
    await settings.update({ vision: { confidenceThreshold: 0.5, statementThreshold: 0.5 } });
    const { statement } = bands();
    expect(String(statement).length).toBeLessThanOrEqual(6);
  });

  it("does not disturb the other vision settings", async () => {
    await settings.update({ vision: { intervalSeconds: 120, candidateFaces: 7 } });
    await settings.update({ vision: { statementThreshold: 0.75 } });
    const v = settings.get().vision;
    expect(v.intervalSeconds).toBe(120);
    expect(v.candidateFaces).toBe(7);
    expect(v.statementThreshold).toBe(0.75);
  });
});
