import { describe, it, expect, beforeEach } from "vitest";
import { pinnedSettings } from "../settings.js";
import { tmpDir } from "../tmp.js";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { MonitorNarrator } from "../../src/monitors/narrator.js";
import { ProviderQueue } from "../../src/providers/queue.js";
import { SettingsStore } from "../../src/storage/settings.js";
import { DEFAULT_MONITOR_PROMPT } from "../../../shared/src/prompts.js";
import { ProviderError, type ChatStreamOptions, type Provider, type ProviderFactory } from "../../src/providers/provider.js";
import type { Monitor, MonitorEvent, NarrationEntry } from "../../../shared/src/types.js";

let dir: string;
let settings: SettingsStore;
let queue: ProviderQueue;
let entries: NarrationEntry[];
let calls: { system: string | undefined; user: string }[];
let clock: number;

beforeEach(async () => {
  dir = await tmpDir("mnarr");
  settings = await pinnedSettings(dir);
  await settings.update({ chatModel: "fake-model" });
  queue = new ProviderQueue();
  entries = [];
  calls = [];
  clock = 1_000_000;
});

const sink = { record: (entry: NarrationEntry) => entries.push(entry) };

function provider(reply = "Nothing untoward."): ProviderFactory {
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

  // The line handed to the model is a Phrase now. These go through `ingest`
  // rather than the private renderer, so what is asserted is what was sent.
  describe("the line format is editable", () => {
    const evs = (over: Partial<MonitorEvent>[]) =>
      over.map((o) => ({ at: "2026-08-06T12:00:00.000Z", text: "x", severity: "routine" as const, ...o }));

    it("renders severe and routine, with and without a source, as it always did", async () => {
      const n = narrator();
      await n.ingest(monitor({ verbosity: "full" }), {
        events: evs([
          { text: "plain routine" },
          { text: "plain severe", severity: "severe" },
          { text: "sourced routine", source: "kernel" },
          { text: "sourced severe", severity: "severe", source: "kernel" },
        ]),
      });
      const user = calls[0]!.user;
      expect(user).toContain("plain routine");
      expect(user).toContain("[severe] plain severe");
      expect(user).toContain("kernel: sourced routine");
      expect(user).toContain("[severe] kernel: sourced severe");
      // An empty source is never rendered as a source called nothing.
      expect(user).not.toContain(" : ");
    });

    it("an edited marker and separator reach the line", async () => {
      await settings.update({
        phrases: { "monitor.severe_marker": "!! ", "monitor.line_source": "<{source}> " },
      });
      const n = narrator();
      await n.ingest(monitor({ verbosity: "full" }), {
        events: evs([{ text: "boom", severity: "severe", source: "kernel" }]),
      });
      expect(calls[0]!.user).toContain("!! <kernel> boom");
      expect(calls[0]!.user).not.toContain("[severe]");
    });

    it("an edited line reorders what the model reads", async () => {
      await settings.update({ phrases: { "monitor.event_line": "{text} {severity_marker}({source_label})" } });
      const n = narrator();
      await n.ingest(monitor({ verbosity: "full" }), {
        events: evs([{ text: "boom", severity: "severe", source: "kernel" }]),
      });
      expect(calls[0]!.user).toContain("boom [severe] (kernel: )");
    });

    it("the budget measures the rendered line, so a longer phrase drops more lines", async () => {
      // The arithmetic in `render()` sizes what is finally emitted. If it
      // measured the pre-phrase text instead, an edit that made every line
      // longer would overflow the budget silently.
      const many = evs(Array.from({ length: 400 }, (_, i) => ({ text: `line ${i} ${"y".repeat(30)}` })));

      const n1 = narrator();
      await n1.ingest(monitor({ verbosity: "full" }), { events: many });
      const shipped = calls[0]!.user;

      calls = [];
      await settings.update({ phrases: { "monitor.event_line": `${"P".repeat(200)}{text}` } });
      const n2 = narrator();
      await n2.ingest(monitor({ verbosity: "full" }), { events: many });
      const padded = calls[0]!.user;

      const kept = (s: string) => s.split("\n").filter((l) => /line \d+/.test(l)).length;
      expect(kept(padded)).toBeLessThan(kept(shipped));
      expect(padded).toContain("further lines omitted");
    });

    it("the omitted-lines notice is a phrase, and an edit reaches it", async () => {
      const many = evs(Array.from({ length: 400 }, (_, i) => ({ text: `line ${i} ${"y".repeat(30)}` })));
      const n1 = narrator();
      await n1.ingest(monitor({ verbosity: "full" }), { events: many });
      expect(calls[0]!.user).toMatch(/\(\d+ further lines omitted\)/);

      calls = [];
      await settings.update({ phrases: { "monitor.lines_omitted": "[{count} dropped]" } });
      const n2 = narrator();
      await n2.ingest(monitor({ verbosity: "full" }), { events: many });
      expect(calls[0]!.user).toMatch(/\[\d+ dropped\]/);
      expect(calls[0]!.user).not.toContain("further lines omitted");
    });
  });

  it("reports rather than throwing when no model is selected", async () => {
    await settings.update({ chatModel: null, narrationModel: null });
    const n = narrator();
    await n.ingest(monitor({ verbosity: "full" }), { events: [ev("x")] });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("status");
    expect(entries[0]!.text).toMatch(/model/i);
  });

  it("keeps the batch when chat preempts the narration, instead of losing it", async () => {
    // Chat preempting narration aborts the job — that is scheduling, not
    // failure. Dropping the batch would silently lose the severe line the
    // interrupt existed to report.
    let calls = 0;
    const aborting = (): ProviderFactory => () => ({
      async listModels() {
        return [];
      },
      async *chatStream(_opts: ChatStreamOptions): AsyncIterable<string> {
        calls += 1;
        if (calls === 1) throw new ProviderError("aborted", "Request was interrupted.");
        yield "Reported after the interruption.";
      },
    });
    const n = new MonitorNarrator(sink, settings, queue, aborting(), () => clock);
    const m = monitor();

    await n.ingest(m, { events: [ev("disk failed", "severe")] });
    // Aborted: nothing said yet, and no error entry either.
    expect(entries).toEqual([]);

    // The sweep retries it, and the severe line is still there.
    await n.sweepDue([m]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("narration");
    expect(calls).toBe(2);
  });

  it("re-arms a batch that arrived while a flush was in flight", async () => {
    // Without a deadline the stranded batch would wait for an event that may
    // never come — and on a quiet monitor that batch can be the severe one.
    const gate: { open?: () => void } = {};
    let started = 0;
    const slow = (): ProviderFactory => () => ({
      async listModels() {
        return [];
      },
      // Only the first call blocks; the retry must be able to complete on its
      // own or the test would hang on its own scaffolding rather than fail.
      async *chatStream(_opts: ChatStreamOptions): AsyncIterable<string> {
        started += 1;
        if (started === 1) {
          await new Promise<void>((r) => {
            gate.open = r;
          });
        }
        yield "done";
      },
    });
    const n = new MonitorNarrator(sink, settings, queue, slow(), () => clock);
    const m = monitor({ verbosity: "full" });

    const first = n.ingest(m, { events: [ev("one")] });
    // Wait for the provider call to actually be in flight rather than assuming
    // a fixed delay is enough.
    while (!gate.open) await new Promise((r) => setTimeout(r, 5));
    // Arrives mid-flight and is skipped by the guard.
    await n.ingest(m, { events: [ev("two", "severe")] });

    gate.open();
    await first;
    await n.sweepDue([m]);
    expect(entries).toHaveLength(2);
  });

  it("reports a source problem once, not once per poll", async () => {
    const n = narrator();
    const m = monitor();
    const problem = "I cannot read /var/log/syslog at the moment.";
    for (let i = 0; i < 5; i += 1) await n.ingest(m, { events: [], problem });
    expect(entries).toHaveLength(1);

    // Recovery is its own single entry.
    await n.ingest(m, { events: [] });
    expect(entries).toHaveLength(2);
    expect(entries[1]!.text).toMatch(/readable again/i);
  });

  it("caps a quiet monitor's buffer and never discards a severe line", async () => {
    const n = narrator();
    const m = monitor({ verbosity: "full" });
    const flood = Array.from({ length: 800 }, (_, i) => ev(`routine ${i}`));
    await n.ingest(m, { events: [ev("the one that matters", "severe"), ...flood] });

    // The severe line survives the cap and reaches the model.
    expect(calls[0]!.user).toContain("[severe] the one that matters");
    expect(calls[0]!.user).toMatch(/lines omitted/);
  });

  it("keeps severe lines when the batch exceeds the render budget", async () => {
    const n = narrator();
    const m = monitor({ verbosity: "full" });
    // Newest-first, as Get-WinEvent emits: taking the tail would drop this.
    const bulky = Array.from({ length: 200 }, (_, i) => ev(`padding line ${i} `.repeat(20)));
    await n.ingest(m, { events: [ev("critical failure here", "severe"), ...bulky] });
    expect(calls[0]!.user).toContain("[severe] critical failure here");
  });

  it("does not interrupt repeatedly within the interrupt gap", async () => {
    // A servicing log full of the word "error" would otherwise interrupt every
    // poll and saturate the single provider lane.
    const n = narrator();
    const m = monitor();
    await n.ingest(m, { events: [ev("error one", "severe")] });
    expect(entries).toHaveLength(1);

    clock += 1_000;
    await n.ingest(m, { events: [ev("error two", "severe")] });
    expect(entries).toHaveLength(1);

    // Past the gap, it speaks again.
    clock += 60_001;
    await n.ingest(m, { events: [ev("error three", "severe")] });
    expect(entries).toHaveLength(2);
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
