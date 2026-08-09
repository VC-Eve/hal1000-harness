import { describe, it, expect } from "vitest";
import { HAL_RED, chatColor, entryColor } from "../src/colors";
import { DEFAULT_ADAPTER_COLOR, DEFAULT_CHAT_COLOR, DEFAULT_VISION_COLOR } from "../src/palette";
import { personaCopy } from "../src/persona";
import type { Monitor, NarrationEntry, Settings } from "../../shared/src/types";

const settings = (overrides: Partial<Settings> = {}): Settings => ({
  backends: {
    shared: { endpoint: "http://localhost:11434", protocol: "auto", hasKey: false },
    chat: { enabled: false, endpoint: "", protocol: "auto", hasKey: false },
  },
  chatModel: "m",
  narrationModel: null,
  personaIntensity: "medium",
  watchedSessionId: null,
  adapters: { "claude-code": { enabled: true, color: "#5fd3a6" } },
  chatColors: { user: "#8ab4f8", assistant: "#e8c8c2" },
  vision: {
    enabled: false,
    device: null,
    captionerEndpoint: "http://127.0.0.1:8099",
    intervalSeconds: 60,
    cycleSeconds: 300,
    sensitivity: "medium",
    color: "#63d4e0",
    retainFrames: 20,
    prompt: null,
    captionPrompt: null,
  },
  ...overrides,
});

const entry = (over: Partial<NarrationEntry> = {}): NarrationEntry => ({
  id: "e1",
  at: "2026-08-05T10:00:00Z",
  kind: "narration",
  text: "it is doing something",
  ...over,
});

describe("entryColor", () => {
  it("renders an observation in its own adapter's colour", () => {
    expect(entryColor(entry({ adapterId: "claude-code" }), settings())).toBe("#5fd3a6");
  });

  it("renders a Vision remark in Vision's colour", () => {
    expect(entryColor(entry({ fromVision: true }), settings())).toBe("#63d4e0");
  });

  it("never paints a Vision remark as HAL's own voice", () => {
    // The regression: fromVision was set on the wire and never read here, so a
    // remark about the room fell through to HAL red — the colour reserved for
    // HAL reporting on himself — and read as a status message.
    expect(entryColor(entry({ fromVision: true }), settings())).not.toBe(HAL_RED);
    expect(entryColor(entry({ fromVision: true, adapterId: null, monitorId: null }), settings())).not.toBe(HAL_RED);
  });

  it("falls back to the shipped Vision colour before settings arrive", () => {
    expect(entryColor(entry({ fromVision: true }), null)).toBe(DEFAULT_VISION_COLOR);
  });

  it("keeps HAL's red for gap and status entries even while an adapter is attached", () => {
    const attached = settings({ adapters: { "claude-code": { enabled: true, color: "#5fd3a6" } } });
    expect(entryColor(entry({ kind: "gap", adapterId: null }), attached)).toBe(HAL_RED);
    expect(entryColor(entry({ kind: "status", adapterId: null }), attached)).toBe(HAL_RED);
    // An entry recorded before attribution existed carries no key at all.
    expect(entryColor(entry({ kind: "gap" }), attached)).toBe(HAL_RED);
  });

  it("falls back to HAL's red when the entry's adapter is no longer registered", () => {
    // The server drops unregistered ids from the settings map, so absence
    // there is how an orphaned attribution presents.
    const color = entryColor(entry({ adapterId: "codex" as never }), settings());
    expect(color).toBe(HAL_RED);
    expect(color).toBeDefined();
  });

  it("keeps an entry's own colour after the adapter map changes around it", () => {
    const recorded = entry({ adapterId: "claude-code" });
    const switched = settings({ adapters: { "claude-code": { enabled: false, color: "#e07ad0" } } });
    expect(entryColor(recorded, switched)).toBe("#e07ad0");
  });

  it("stands in the default adapter colour before settings arrive", () => {
    expect(entryColor(entry({ adapterId: "claude-code" }), null)).toBe(DEFAULT_ADAPTER_COLOR);
    // HAL's own kinds need no settings to resolve.
    expect(entryColor(entry({ kind: "status", adapterId: null }), null)).toBe(HAL_RED);
  });
});

describe("chatColor", () => {
  it("resolves each role's configured colour", () => {
    expect(chatColor("user", settings())).toBe("#8ab4f8");
    expect(chatColor("assistant", settings())).toBe("#e8c8c2");
  });

  it("falls back to the default chat colour before settings arrive", () => {
    expect(chatColor("user", null)).toBe(DEFAULT_CHAT_COLOR);
    expect(chatColor("assistant", null)).toBe(DEFAULT_CHAT_COLOR);
  });
});

describe("no-adapter persona copy", () => {
  it("exists at all three intensities and never repeats a row", () => {
    const rows = (["low", "medium", "high"] as const).map((i) => personaCopy("no-adapter", i));
    for (const row of rows) expect(row.length).toBeGreaterThan(0);
    expect(new Set(rows).size).toBe(3);
  });
});

describe("entryColor for monitor entries", () => {
  const monitor = (over: Partial<Monitor> = {}): Monitor => ({
    id: "m1",
    label: "syslog",
    source: { kind: "file", path: "/var/log/syslog" },
    verbosity: "quiet",
    cycleMs: 300_000,
    color: "#9ec5d8",
    enabled: true,
    ...over,
  });

  it("takes the monitor's colour when the entry carries a monitor id", () => {
    expect(entryColor({ adapterId: null, monitorId: "m1" }, settings(), [monitor()])).toBe("#9ec5d8");
  });

  it("attributes a monitor's status entry to that monitor, not to HAL", () => {
    // With several monitors running, which one lost its source is the useful
    // part of the message.
    const monitors = [monitor(), monitor({ id: "m2", color: "#c8b4f8" })];
    expect(entryColor({ adapterId: null, monitorId: "m2" }, settings(), monitors)).toBe("#c8b4f8");
  });

  it("falls back to HAL red when the monitor has been removed", () => {
    expect(entryColor({ adapterId: null, monitorId: "gone" }, settings(), [monitor()])).toBe(HAL_RED);
  });

  it("leaves adapter and HAL entries unchanged", () => {
    expect(entryColor({ adapterId: "claude-code", monitorId: null }, settings(), [monitor()])).toBe("#5fd3a6");
    expect(entryColor({ adapterId: null, monitorId: null }, settings(), [monitor()])).toBe(HAL_RED);
  });
});
