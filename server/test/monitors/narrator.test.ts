import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { MonitorNarrator } from "../../src/monitors/narrator.js";
import { ProviderQueue } from "../../src/providers/queue.js";
import { SettingsStore } from "../../src/storage/settings.js";
import { DEFAULT_MONITOR_PROMPT } from "../../../shared/src/prompts.js";
import type { ChatStreamOptions, Provider } from "../../src/providers/provider.js";
import type { Monitor, MonitorEvent, NarrationEntry } from "../../../shared/src/types.js";

let dir: string;
let settings: SettingsStore;
let queue: ProviderQueue;
let entries: NarrationEntry[];
let calls: { system: string | undefined; user: string }[];
let clock: number;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal1000-mnarr-"));
  settings = new SettingsStore(dir);
  await settings.load();
  await settings.update({ chatModel: "fake-model" });
  queue = new ProviderQueue();
  entries = [];
  calls = [];
  clock = 1_000_000;
});

const sink = { record: (entry: NarrationEntry) => entries.push(entry) };

function provider(reply = "Nothing untoward."): (endpoint: string) => Provider {
  return () => ({
    async listModels() {
      return [];
    },
    async *chatStream(opts: ChatStreamOptions): AsyncIterable<string> {
      calls.push({
        system: opts.messages.find((m) => m.role === "system")?.content,
        user: opts.messages.find((m) => m.role === "user")?.content ?? "",
      });
      yield reply;
    },
  });
}

const narrator = (reply?: string) =>
  new MonitorNarrator(sink, settings, queue, provider(reply), () => clock);

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

const ev = (text: string, severity: MonitorEvent["severity"] = "routine"): MonitorEvent => ({
  at: "2026-08-06T12:00:00.000Z",
  text,
  severity,
});

describe("MonitorNarrator", () => {
  it("holds routine events until the cycle elapses, then emits one entry (AE1)", async () => {
    const n = narrator();
    const m = monitor();
    await n.ingest(m, { events: [ev("a"), ev("b")] });
    expect(entries).toEqual([]);

    // Before the deadline nothing is due.
    clock += 299_000;
    await n.sweepDue([m]);
    expect(entries).toEqual([]);

    clock += 2_000;
    await n.sweepDue([m]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("narration");
    expect(entries[0]!.monitorId).toBe("m1");
  });

  it("produces nothing for a cycle that saw no events", async () => {
    const n = narrator();
    const m = monitor();
    clock += 600_000;
    await n.sweepDue([m]);
    expect(entries).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("speaks immediately on a severe event, before the cycle (AE2)", async () => {
    const n = narrator();
    const m = monitor();
    await n.ingest(m, { events: [ev("all fine"), ev("disk failed", "severe")] });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("narration");
    expect(calls[0]!.user).toMatch(/looks wrong/i);
  });

  it("returns to its cadence after interrupting, unchanged (AE2, R10)", async () => {
    const n = narrator();
    const m = monitor();
    await n.ingest(m, { events: [ev("panic", "severe")] });
    expect(entries).toHaveLength(1);

    // Still quiet: routine events after the interrupt wait for a full cycle.
    await n.ingest(m, { events: [ev("routine again")] });
    expect(entries).toHaveLength(1);
    clock += 300_001;
    await n.sweepDue([m]);
    expect(entries).toHaveLength(2);
  });

  it("narrates every batch when verbosity is full", async () => {
    const n = narrator();
    const m = monitor({ verbosity: "full" });
    await n.ingest(m, { events: [ev("one")] });
    await n.ingest(m, { events: [ev("two")] });
    expect(entries).toHaveLength(2);
  });

  it("keeps monitors independent — one interrupting does not flush another", async () => {
    const n = narrator();
    const a = monitor({ id: "a", label: "a" });
    const b = monitor({ id: "b", label: "b" });
    await n.ingest(a, { events: [ev("quiet line")] });
    await n.ingest(b, { events: [ev("fatal", "severe")] });

    expect(entries).toHaveLength(1);
    expect(entries[0]!.monitorId).toBe("b");
  });

  it("reports a source problem directly, without calling the model", async () => {
    const n = narrator();
    await n.ingest(monitor(), { events: [], problem: "I cannot read /var/log/syslog at the moment." });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("status");
    expect(entries[0]!.monitorId).toBe("m1");
    // No model call: a condition report needs no interpretation, and queueing
    // it would delay the one message saying HAL has stopped seeing anything.
    expect(calls).toEqual([]);
  });

  it("uses the shipped monitor prompt when none is stored", async () => {
    const n = narrator();
    await n.ingest(monitor({ verbosity: "full" }), { events: [ev("x")] });
    expect(calls[0]!.system).toBe(DEFAULT_MONITOR_PROMPT);
  });

  it("uses an edited monitor prompt for the next entry and leaves prior entries alone (AE7)", async () => {
    const n = narrator();
    const m = monitor({ verbosity: "full" });
    await n.ingest(m, { events: [ev("first")] });
    const firstText = entries[0]!.text;

    await settings.update({ monitorPrompt: "Be terse." });
    await n.ingest(m, { events: [ev("second")] });

    expect(calls[0]!.system).toBe(DEFAULT_MONITOR_PROMPT);
    expect(calls[1]!.system).toBe("Be terse.");
    expect(entries[0]!.text).toBe(firstText);
  });

  it("marks severe lines in the batch it hands the model", async () => {
    const n = narrator();
    await n.ingest(monitor({ verbosity: "full" }), { events: [ev("ok"), ev("boom", "severe")] });
    expect(calls[0]!.user).toContain("[severe] boom");
    expect(calls[0]!.user).toContain("ok");
  });

  it("reports rather than throwing when no model is selected", async () => {
    await settings.update({ chatModel: null, narrationModel: null });
    const n = narrator();
    await n.ingest(monitor({ verbosity: "full" }), { events: [ev("x")] });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("status");
    expect(entries[0]!.text).toMatch(/model/i);
  });

  it("drops a forgotten monitor's buffered work", async () => {
    const n = narrator();
    const m = monitor();
    await n.ingest(m, { events: [ev("pending")] });
    n.forget(m.id);
    clock += 300_001;
    await n.sweepDue([m]);
    expect(entries).toEqual([]);
  });

  it("does not flush a monitor the sweep was not given", async () => {
    // A removed monitor must not surface after the user turned it off.
    const n = narrator();
    await n.ingest(monitor(), { events: [ev("pending")] });
    clock += 300_001;
    await n.sweepDue([]);
    expect(entries).toEqual([]);
  });
});
