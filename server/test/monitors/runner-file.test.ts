import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { FileMonitorRunner } from "../../src/monitors/runner.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal1000-runner-"));
  file = path.join(dir, "app.log");
});

const runner = () => new FileMonitorRunner({ kind: "file", path: file });

describe("FileMonitorRunner", () => {
  it("emits nothing for content that existed before it started (R3)", async () => {
    await fs.writeFile(file, "old line one\nold line two\n", "utf8");
    const r = runner();
    expect((await r.poll()).events).toEqual([]);
    // A second poll with no writes is still silent.
    expect((await r.poll()).events).toEqual([]);
  });

  it("emits appended lines once and not again", async () => {
    await fs.writeFile(file, "existing\n", "utf8");
    const r = runner();
    await r.poll();

    await fs.appendFile(file, "first new\nsecond new\n", "utf8");
    const first = await r.poll();
    expect(first.events.map((e) => e.text)).toEqual(["first new", "second new"]);

    expect((await r.poll()).events).toEqual([]);
  });

  it("holds a partial trailing line until its newline arrives", async () => {
    await fs.writeFile(file, "", "utf8");
    const r = runner();
    await r.poll();

    await fs.appendFile(file, "half a li", "utf8");
    expect((await r.poll()).events).toEqual([]);

    await fs.appendFile(file, "ne\n", "utf8");
    expect((await r.poll()).events.map((e) => e.text)).toEqual(["half a line"]);
  });

  it("strips carriage returns from CRLF files", async () => {
    await fs.writeFile(file, "", "utf8");
    const r = runner();
    await r.poll();

    await fs.appendFile(file, "windows line\r\nanother\r\n", "utf8");
    expect((await r.poll()).events.map((e) => e.text)).toEqual(["windows line", "another"]);
  });

  it("classifies severity from the line text", async () => {
    await fs.writeFile(file, "", "utf8");
    const r = runner();
    await r.poll();

    await fs.appendFile(file, "all good here\nconnection failed\n", "utf8");
    const events = (await r.poll()).events;
    expect(events.map((e) => e.severity)).toEqual(["routine", "severe"]);
  });

  it("resyncs at the present when the file is truncated, rather than re-emitting it", async () => {
    await fs.writeFile(file, "line one\nline two\nline three\n", "utf8");
    const r = runner();
    await r.poll();

    await fs.writeFile(file, "", "utf8");
    const after = await r.poll();
    expect(after.events).toEqual([]);
    expect(after.problem).toMatch(/truncated/i);

    await fs.appendFile(file, "fresh\n", "utf8");
    expect((await r.poll()).events.map((e) => e.text)).toEqual(["fresh"]);
  });

  it("reports a missing file in persona and recovers when it returns (R5, AE5)", async () => {
    await fs.writeFile(file, "before\n", "utf8");
    const r = runner();
    await r.poll();

    await fs.rm(file);
    const gone = await r.poll();
    expect(gone.events).toEqual([]);
    expect(gone.problem).toMatch(/cannot read/i);

    // Recreated: resumes at the present without replaying the new file's
    // existing content, and without needing a restart.
    await fs.writeFile(file, "pre-existing after recreate\n", "utf8");
    expect((await r.poll()).events).toEqual([]);
    await fs.appendFile(file, "after recovery\n", "utf8");
    expect((await r.poll()).events.map((e) => e.text)).toEqual(["after recovery"]);
  });

  it("reports a missing file on the very first poll without throwing", async () => {
    const r = runner();
    const result = await r.poll();
    expect(result.events).toEqual([]);
    expect(result.problem).toMatch(/cannot read/i);
  });

  it("skips blank lines rather than emitting empty events", async () => {
    await fs.writeFile(file, "", "utf8");
    const r = runner();
    await r.poll();

    await fs.appendFile(file, "real\n\n   \nalso real\n", "utf8");
    expect((await r.poll()).events.map((e) => e.text)).toEqual(["real", "also real"]);
  });
});
