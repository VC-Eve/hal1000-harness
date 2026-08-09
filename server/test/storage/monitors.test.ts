import { describe, it, expect, beforeEach } from "vitest";
import { tmpDir } from "../tmp.js";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { MonitorStore } from "../../src/storage/monitors.js";
import { DEFAULT_CYCLE_MS, MIN_POLL_MS } from "../../src/monitors/monitor.js";
import { contrastRatio, parseHex, MIN_CONTRAST, PANE_BACKGROUND } from "../../src/storage/colors.js";
import type { MonitorSource } from "../../../shared/src/types.js";

let dir: string;

beforeEach(async () => {
  dir = await tmpDir("monitors");
});

const fileSource: MonitorSource = { kind: "file", path: "/var/log/syslog" };
const commandSource: MonitorSource = { kind: "command", command: "journalctl -n 20", intervalMs: 30_000 };

async function writeRaw(value: unknown): Promise<void> {
  await fs.writeFile(path.join(dir, "monitors.json"), JSON.stringify(value), "utf8");
}

describe("MonitorStore", () => {
  it("round-trips add, list, update, and remove across a restart (R4)", async () => {
    const store = new MonitorStore(dir);
    const added = await store.add({ label: "syslog", source: fileSource });
    expect(added.id).toBeTruthy();
    expect(added.verbosity).toBe("quiet");
    expect(added.cycleMs).toBe(DEFAULT_CYCLE_MS);

    // Fresh instance stands in for a restart.
    const reopened = new MonitorStore(dir);
    expect((await reopened.list()).map((m) => m.label)).toEqual(["syslog"]);

    await reopened.update(added.id, { verbosity: "full" });
    expect((await new MonitorStore(dir).list())[0]!.verbosity).toBe("full");

    expect(await reopened.remove(added.id)).toBe(true);
    expect(await new MonitorStore(dir).list()).toEqual([]);
  });

  it("lifts a below-floor colour on write and again on load", async () => {
    const store = new MonitorStore(dir);
    const submitted = "#101014";
    const added = await store.add({ label: "dim", source: fileSource, color: submitted });
    expect(added.color).not.toBe(submitted);
    const bg = parseHex(PANE_BACKGROUND)!;
    expect(contrastRatio(parseHex(added.color)!, bg)).toBeGreaterThanOrEqual(MIN_CONTRAST);

    // A hand-edited file never passed through add(), so load() has to correct it.
    await writeRaw([{ ...added, color: "#101014" }]);
    const loaded = (await new MonitorStore(dir).list())[0]!;
    expect(contrastRatio(parseHex(loaded.color)!, bg)).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  it("updating one monitor leaves the others untouched", async () => {
    const store = new MonitorStore(dir);
    const a = await store.add({ label: "a", source: fileSource });
    const b = await store.add({ label: "b", source: commandSource });

    await store.update(a.id, { label: "renamed" });
    const all = await store.list();
    expect(all.find((m) => m.id === a.id)!.label).toBe("renamed");
    expect(all.find((m) => m.id === b.id)!.label).toBe("b");
    expect(all.find((m) => m.id === b.id)!.source).toEqual(commandSource);
  });

  it("a patch that omits the source keeps the stored one", async () => {
    const store = new MonitorStore(dir);
    const m = await store.add({ label: "cmd", source: commandSource });
    const updated = await store.update(m.id, { verbosity: "full" });
    expect(updated!.source).toEqual(commandSource);
  });

  it("keeps a stored file with an unknown extra key", async () => {
    await writeRaw([
      { id: "m1", label: "keeps", source: fileSource, verbosity: "quiet", cycleMs: 1000, color: "#9ec5d8", enabled: true, futureKey: 7 },
    ]);
    expect((await new MonitorStore(dir).list()).map((m) => m.id)).toEqual(["m1"]);
  });

  it("drops a structurally unusable entry rather than failing the whole load", async () => {
    await writeRaw([
      { id: "good", label: "ok", source: fileSource, verbosity: "quiet", cycleMs: 1000, color: "#9ec5d8", enabled: true },
      { id: "no-source", label: "broken" },
      { label: "no-id", source: fileSource },
      { id: "empty-path", label: "broken", source: { kind: "file", path: "" } },
      "not an object",
      null,
    ]);
    expect((await new MonitorStore(dir).list()).map((m) => m.id)).toEqual(["good"]);
  });

  it("replaces a non-positive cycle with the default", async () => {
    await writeRaw([
      { id: "m1", label: "zero", source: fileSource, verbosity: "quiet", cycleMs: 0, color: "#9ec5d8", enabled: true },
    ]);
    expect((await new MonitorStore(dir).list())[0]!.cycleMs).toBe(DEFAULT_CYCLE_MS);
  });

  it("clamps a command interval that would spin the exec loop", async () => {
    // The UI's completeness check does not bind an agent speaking the protocol,
    // so a stored zero must be corrected here rather than trusted.
    await writeRaw([
      { id: "m1", label: "spin", source: { kind: "command", command: "echo hi", intervalMs: 0 }, verbosity: "quiet", cycleMs: 1000, color: "#9ec5d8", enabled: true },
      { id: "m2", label: "negative", source: { kind: "command", command: "echo hi", intervalMs: -5 }, verbosity: "quiet", cycleMs: 1000, color: "#9ec5d8", enabled: true },
      { id: "m3", label: "missing", source: { kind: "command", command: "echo hi" }, verbosity: "quiet", cycleMs: 1000, color: "#9ec5d8", enabled: true },
    ]);
    for (const m of await new MonitorStore(dir).list()) {
      expect(m.source.kind).toBe("command");
      if (m.source.kind !== "command") continue;
      expect(m.source.intervalMs).toBeGreaterThanOrEqual(MIN_POLL_MS);
    }
  });

  it("clamps an interval supplied through add and update", async () => {
    const store = new MonitorStore(dir);
    const added = await store.add({ label: "viaAdd", source: { kind: "command", command: "echo hi", intervalMs: 1 } });
    expect(added.source.kind === "command" && added.source.intervalMs).toBe(MIN_POLL_MS);

    const updated = await store.update(added.id, { source: { kind: "command", command: "echo hi", intervalMs: 0 } });
    expect(updated!.source.kind === "command" && updated!.source.intervalMs).toBe(MIN_POLL_MS);
  });

  it("drops a monitor whose source path or command is only whitespace", async () => {
    await writeRaw([
      { id: "blank-path", label: "x", source: { kind: "file", path: "   " }, verbosity: "quiet", cycleMs: 1000, color: "#9ec5d8", enabled: true },
      { id: "blank-cmd", label: "x", source: { kind: "command", command: "  ", intervalMs: 30000 }, verbosity: "quiet", cycleMs: 1000, color: "#9ec5d8", enabled: true },
    ]);
    expect(await new MonitorStore(dir).list()).toEqual([]);
  });

  it("removing a monitor that does not exist reports false rather than throwing", async () => {
    const store = new MonitorStore(dir);
    expect(await store.remove("nope")).toBe(false);
  });

  it("updating a monitor that does not exist returns null", async () => {
    const store = new MonitorStore(dir);
    expect(await store.update("nope", { verbosity: "full" })).toBeNull();
  });

  it("a stored file that is not an array yields no monitors", async () => {
    await writeRaw({ not: "an array" });
    expect(await new MonitorStore(dir).list()).toEqual([]);
  });

  it("serializes concurrent adds so none is lost", async () => {
    const store = new MonitorStore(dir);
    await Promise.all([
      store.add({ label: "one", source: fileSource }),
      store.add({ label: "two", source: fileSource }),
      store.add({ label: "three", source: fileSource }),
    ]);
    expect((await store.list()).map((m) => m.label).sort()).toEqual(["one", "three", "two"]);
  });
});

describe("severity rules in storage", () => {
  it("keeps a valid pattern rule", async () => {
    const store = new MonitorStore(dir);
    const m = await store.add({ label: "ollama", source: fileSource, severity: { kind: "pattern", pattern: "out of memory" } });
    expect(m.severity).toEqual({ kind: "pattern", pattern: "out of memory" });
    expect((await new MonitorStore(dir).list())[0]!.severity).toEqual({ kind: "pattern", pattern: "out of memory" });
  });

  it("keeps never and default rules", async () => {
    const store = new MonitorStore(dir);
    const never = await store.add({ label: "quiet", source: fileSource, severity: { kind: "never" } });
    expect(never.severity).toEqual({ kind: "never" });
    const dflt = await store.update(never.id, { severity: { kind: "default" } });
    expect(dflt!.severity).toEqual({ kind: "default" });
  });

  it("drops a pattern that will not compile, rather than storing a deaf monitor", async () => {
    const store = new MonitorStore(dir);
    const m = await store.add({ label: "broken", source: fileSource, severity: { kind: "pattern", pattern: "unclosed (" } });
    // Undefined means the shipped keyword list, which is noisy but not silent.
    expect(m.severity).toBeUndefined();
  });

  it("drops an empty or over-long pattern", async () => {
    const store = new MonitorStore(dir);
    expect((await store.add({ label: "empty", source: fileSource, severity: { kind: "pattern", pattern: "   " } })).severity).toBeUndefined();
    const huge = "a".repeat(500);
    expect((await store.add({ label: "huge", source: fileSource, severity: { kind: "pattern", pattern: huge } })).severity).toBeUndefined();
  });

  it("drops a structurally bogus rule from a hand-edited file", async () => {
    await writeRaw([
      { id: "m1", label: "x", source: fileSource, verbosity: "quiet", cycleMs: 1000, color: "#9ec5d8", enabled: true, severity: { kind: "nonsense" } },
      { id: "m2", label: "y", source: fileSource, verbosity: "quiet", cycleMs: 1000, color: "#9ec5d8", enabled: true, severity: "not an object" },
    ]);
    for (const m of await new MonitorStore(dir).list()) expect(m.severity).toBeUndefined();
  });

  it("trims a pattern before storing it", async () => {
    const store = new MonitorStore(dir);
    const m = await store.add({ label: "spaced", source: fileSource, severity: { kind: "pattern", pattern: "  panic  " } });
    expect(m.severity).toEqual({ kind: "pattern", pattern: "panic" });
  });
});
