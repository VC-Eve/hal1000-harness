import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { CommandMonitorRunner } from "../../src/monitors/runner.js";

let dir: string;
let dataFile: string;
let emitScript: string;

// A command is invoked through the platform shell, so tests drive it with a
// node script rather than shell builtins — the same command string then works
// on cmd.exe and sh alike.
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal1000-cmd-"));
  dataFile = path.join(dir, "data.txt");
  emitScript = path.join(dir, "emit.js");
  await fs.writeFile(dataFile, "", "utf8");
  await fs.writeFile(
    emitScript,
    `const fs=require("fs");process.stdout.write(fs.readFileSync(${JSON.stringify(dataFile)},"utf8"));`,
    "utf8",
  );
});

const emitCommand = () => `node ${JSON.stringify(emitScript)}`;

const runner = (command: string, sinceTemplate?: string) =>
  new CommandMonitorRunner({ kind: "command", command, intervalMs: 1000, sinceTemplate });

describe("CommandMonitorRunner", () => {
  it("primes on the first poll rather than replaying a command's history (R3)", async () => {
    // A command's first output is history — Get-WinEvent -MaxEvents 40 returns
    // the last forty events. Emitting them would narrate yesterday as though it
    // had just happened.
    await fs.writeFile(dataFile, "old one\nold two\n", "utf8");
    const r = runner(emitCommand());
    expect((await r.poll()).events).toEqual([]);

    await fs.appendFile(dataFile, "genuinely new\n", "utf8");
    expect((await r.poll()).events.map((e) => e.text)).toEqual(["genuinely new"]);
  });

  it("emits identical output once, not on every poll", async () => {
    // The defect this unit exists to prevent: Get-WinEvent -MaxEvents N returns
    // the same records every run, so a byte offset is not a watermark.
    const r = runner(emitCommand());
    await r.poll();

    await fs.writeFile(dataFile, "alpha\nbeta\ngamma\n", "utf8");
    expect((await r.poll()).events.map((e) => e.text)).toEqual(["alpha", "beta", "gamma"]);
    expect((await r.poll()).events).toEqual([]);
    expect((await r.poll()).events).toEqual([]);
  });

  it("emits only the new line when a command appends one per poll", async () => {
    const r = runner(emitCommand());
    await r.poll();

    await fs.writeFile(dataFile, "one\n", "utf8");
    expect((await r.poll()).events.map((e) => e.text)).toEqual(["one"]);

    await fs.appendFile(dataFile, "two\n", "utf8");
    expect((await r.poll()).events.map((e) => e.text)).toEqual(["two"]);

    await fs.appendFile(dataFile, "three\n", "utf8");
    expect((await r.poll()).events.map((e) => e.text)).toEqual(["three"]);
  });

  it("emits only the new line when a command re-emits a sliding window", async () => {
    // The realistic shape: a fixed-size window whose oldest entry falls off.
    const r = runner(emitCommand());
    await r.poll();

    await fs.writeFile(dataFile, "l1\nl2\nl3\n", "utf8");
    await r.poll();

    await fs.writeFile(dataFile, "l2\nl3\nl4\n", "utf8");
    expect((await r.poll()).events.map((e) => e.text)).toEqual(["l4"]);
  });

  it("substitutes the since template with the previous poll time, and omits it on the first run", async () => {
    const seen = path.join(dir, "seen.txt");
    const script = path.join(dir, "record.js");
    await fs.writeFile(
      script,
      `const fs=require("fs");fs.appendFileSync(${JSON.stringify(seen)}, process.argv.slice(2).join(" ")+"\\n");console.log("ok "+Date.now());`,
      "utf8",
    );
    const r = runner(`node ${JSON.stringify(script)} {{since}}`, "{{since}}");

    await r.poll();
    await r.poll();

    // Split without trimming the file: the first run's empty substitution is
    // exactly what is being asserted, and a leading trim would erase it.
    const lines = (await fs.readFile(seen, "utf8")).split("\n");
    // First run has nothing to substitute; the second carries an ISO timestamp.
    expect(lines[0]!.trim()).toBe("");
    expect(lines[1]!.trim()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reports a non-zero exit and keeps running", async () => {
    const failing = path.join(dir, "fail.js");
    await fs.writeFile(failing, `console.log("partial output");process.exit(3);`, "utf8");
    const r = runner(`node ${JSON.stringify(failing)}`);

    const result = await r.poll();
    expect(result.problem).toBeTruthy();
    // A later successful poll still works — a failure is not terminal (R5).
    const r2 = runner(emitCommand());
    await r2.poll();
    await fs.writeFile(dataFile, "after\n", "utf8");
    expect((await r2.poll()).events.map((e) => e.text)).toEqual(["after"]);
  });

  it("reports a command that exceeds its timeout", async () => {
    const slow = path.join(dir, "slow.js");
    await fs.writeFile(slow, `setTimeout(()=>console.log("late"), 5000);`, "utf8");
    const r = new CommandMonitorRunner({ kind: "command", command: `node ${JSON.stringify(slow)}`, intervalMs: 1000 }, { timeoutMs: 300 });

    const result = await r.poll();
    expect(result.events).toEqual([]);
    expect(result.problem).toMatch(/did not finish|timed out/i);
  }, 15_000);

  it("caps captured output rather than buffering without bound", async () => {
    // Every line differs per run, so nothing is deduped away and the only thing
    // bounding the batch is the cap itself.
    const noisy = path.join(dir, "noisy.js");
    await fs.writeFile(noisy, `const t=Date.now();for(let i=0;i<20000;i++)console.log("line "+t+" "+i);`, "utf8");
    const r = new CommandMonitorRunner({ kind: "command", command: `node ${JSON.stringify(noisy)}`, intervalMs: 1000 }, { outputCap: 2000 });

    await r.poll();
    const result = await r.poll();
    // Truncated, not rejected: some output is better than none, and the cap is
    // what stops a runaway command growing the process.
    const total = result.events.reduce((n, e) => n + e.text.length, 0);
    expect(total).toBeLessThanOrEqual(2000);
  }, 15_000);

  it("treats no output as nothing to report rather than a failure", async () => {
    const r = runner(emitCommand());
    const result = await r.poll();
    expect(result.events).toEqual([]);
    expect(result.problem).toBeUndefined();
  });

  it("reads a level and source from tab-separated structured output", async () => {
    // The convention shipped suggestions format their output to: level, source,
    // then the message. It is what lets Get-WinEvent's LevelDisplayName reach
    // severity instead of being guessed from the text.
    const r = runner(emitCommand());
    await r.poll();
    await fs.writeFile(dataFile, "Information\tService Control Manager\tA service failed to start previously\n", "utf8");
    const events = (await r.poll()).events;

    expect(events).toHaveLength(1);
    expect(events[0]!.source).toBe("Service Control Manager");
    // The stated level wins over the alarming words in the message.
    expect(events[0]!.severity).toBe("routine");
    expect(events[0]!.text).toBe("A service failed to start previously");
  });

  it("marks a structured line severe when the source states an error level", async () => {
    const r = runner(emitCommand());
    await r.poll();
    await fs.writeFile(dataFile, "Error\tDisk\tThe device is not ready\n", "utf8");
    const events = (await r.poll()).events;
    expect(events[0]!.severity).toBe("severe");
  });

  it("does not treat a tab-containing plain line as structured", async () => {
    // The guard that matters: a log that happens to use tabs as separators must
    // not have its first field swallowed as a level and its severity suppressed.
    const r = runner(emitCommand());
    await r.poll();
    await fs.writeFile(dataFile, "2026-08-06\tworker-7\tFATAL: allocation refused\n", "utf8");
    const events = (await r.poll()).events;

    expect(events).toHaveLength(1);
    expect(events[0]!.source).toBeUndefined();
    expect(events[0]!.text).toBe("2026-08-06\tworker-7\tFATAL: allocation refused");
    expect(events[0]!.severity).toBe("severe");
  });

  it("falls back to text severity for output that is not structured", async () => {
    const r = runner(emitCommand());
    await r.poll();
    await fs.writeFile(dataFile, "plain line about a failed thing\n", "utf8");
    const events = (await r.poll()).events;
    expect(events[0]!.source).toBeUndefined();
    expect(events[0]!.severity).toBe("severe");
  });
});
