import { describe, it, expect, beforeEach } from "vitest";
import { tmpDir } from "../tmp.js";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import type { NarrationEntry } from "../../../shared/src/types.js";
import { ObservationLog } from "../../src/storage/observations.js";

let root: string;

beforeEach(async () => {
  root = await tmpDir("observations");
});

function entry(text: string, at: string, extra: Partial<NarrationEntry> = {}): NarrationEntry {
  return { id: text, at, kind: "narration", text, adapterId: "claude-code", ...extra };
}

describe("ObservationLog", () => {
  it("returns nothing before anything has been recorded", async () => {
    expect(await new ObservationLog(root).recent(10)).toEqual([]);
  });

  it("replays what it stored, oldest first", async () => {
    const log = new ObservationLog(root);
    await log.append(entry("first", "2026-08-07T10:00:00.000Z"));
    await log.append(entry("second", "2026-08-07T10:01:00.000Z"));

    expect((await log.recent(10)).map((e) => e.text)).toEqual(["first", "second"]);
  });

  // The whole point of persisting the feed: a new process sees what the last
  // one saw. A fresh instance shares nothing with the writer but the directory.
  it("survives a restart", async () => {
    await new ObservationLog(root).append(entry("before the restart", "2026-08-07T10:00:00.000Z"));
    const reopened = await new ObservationLog(root).recent(10);
    expect(reopened.map((e) => e.text)).toEqual(["before the restart"]);
  });

  it("keeps every field the feed renders from", async () => {
    const log = new ObservationLog(root);
    await log.append(
      entry("about a session", "2026-08-07T10:00:00.000Z", {
        sessionId: "a3f9c21e-1111",
        sessionLabel: "Claude Code [a3f9c21e]",
      }),
    );
    await log.append(entry("from a monitor", "2026-08-07T10:01:00.000Z", { adapterId: null, monitorId: "mon-1" }));
    await log.append(entry("from vision", "2026-08-07T10:02:00.000Z", { adapterId: null, fromVision: true }));

    const [session, monitor, vision] = await log.recent(10);
    expect(session).toMatchObject({ sessionId: "a3f9c21e-1111", sessionLabel: "Claude Code [a3f9c21e]" });
    expect(monitor).toMatchObject({ monitorId: "mon-1" });
    expect(vision).toMatchObject({ fromVision: true });
  });

  it("spans day files, newest last", async () => {
    const log = new ObservationLog(root);
    await log.append(entry("monday", "2026-08-05T09:00:00.000Z"));
    await log.append(entry("tuesday", "2026-08-06T09:00:00.000Z"));
    await log.append(entry("wednesday", "2026-08-07T09:00:00.000Z"));

    expect((await fs.readdir(path.join(root, "observations"))).sort()).toEqual([
      "2026-08-05.jsonl",
      "2026-08-06.jsonl",
      "2026-08-07.jsonl",
    ]);
    expect((await log.recent(10)).map((e) => e.text)).toEqual(["monday", "tuesday", "wednesday"]);
  });

  it("returns the newest entries when the limit is smaller than the history", async () => {
    const log = new ObservationLog(root);
    await log.append(entry("monday", "2026-08-05T09:00:00.000Z"));
    await log.append(entry("tuesday", "2026-08-06T09:00:00.000Z"));
    await log.append(entry("wednesday", "2026-08-07T09:00:00.000Z"));

    expect((await log.recent(2)).map((e) => e.text)).toEqual(["tuesday", "wednesday"]);
  });

  // A log that cannot be replayed at all because one line is bad is worse than
  // one missing that line — a crash mid-write is the ordinary way this happens.
  it("skips a truncated line rather than losing the file", async () => {
    const log = new ObservationLog(root);
    await log.append(entry("intact", "2026-08-07T09:00:00.000Z"));
    await fs.appendFile(path.join(root, "observations", "2026-08-07.jsonl"), '{"id":"half","at":', "utf8");

    expect((await log.recent(10)).map((e) => e.text)).toEqual(["intact"]);
  });
});
