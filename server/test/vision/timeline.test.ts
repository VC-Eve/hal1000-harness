// The vision timeline store (U1, R6/R15/R16, AE7).
//
// Real files on a temp directory. What is under test is that events reach disk
// and come back in order, and an in-memory fake would prove neither.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { VisionTimeline } from "../../src/vision/timeline.js";
import { flushJsonl } from "../../src/storage/jsonl.js";
import type { VisionCheckFace, VisionEvent } from "../../../shared/src/types.js";

let dir: string;
let timeline: VisionTimeline;

const check = (at: string, faces: VisionCheckFace[] = []): VisionEvent => ({ kind: "check", at, faces });

const caption = (at: string, text: string): VisionEvent => ({ kind: "caption", at, caption: text });

const seen = (name: string, weight?: number) => [
  { personId: name, name, confidence: 0.7, band: "stated" as const, embedded: true, ...(weight ? { weight } : {}) },
];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-timeline-"));
  timeline = new VisionTimeline(dir);
});

afterEach(async () => {
  await flushJsonl();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("VisionTimeline", () => {
  it("survives being reconstructed, so a restart does not lose what was seen", async () => {
    // Covers AE7.
    await timeline.append(check("2026-08-08T10:00:00.000Z", seen("Creator")));
    await timeline.append(caption("2026-08-08T10:00:20.000Z", "a person at a desk"));
    await flushJsonl();

    const reloaded = new VisionTimeline(dir);
    const events = await reloaded.recent(10);

    expect(events).toHaveLength(2);
    expect(events[0]!.kind).toBe("check");
    expect(events[1]!.kind).toBe("caption");
  });

  it("returns the newest events, oldest first within the result", async () => {
    for (let i = 0; i < 5; i += 1) {
      await timeline.append(caption(`2026-08-08T10:0${i}:00.000Z`, `caption ${i}`));
    }
    await flushJsonl();

    const events = await timeline.recent(3);
    expect(events.map((e) => (e.kind === "caption" ? e.caption : ""))).toEqual([
      "caption 2",
      "caption 3",
      "caption 4",
    ]);
  });

  it("walks back across day files to fill the window", async () => {
    await timeline.append(caption("2026-08-07T23:59:00.000Z", "yesterday"));
    await timeline.append(caption("2026-08-08T00:01:00.000Z", "today"));
    await flushJsonl();

    const events = await timeline.recent(5);
    expect(events).toHaveLength(2);
    expect((events[0] as { caption: string }).caption).toBe("yesterday");
  });

  it("keeps both event kinds distinguishable after a round trip", async () => {
    await timeline.append(check("2026-08-08T10:00:00.000Z", seen("Creator", 0.8)));
    await flushJsonl();

    const events = await timeline.recent(1);
    const event = events[0];
    expect(event?.kind).toBe("check");
    if (event?.kind === "check") {
      expect(event.faces[0]).toMatchObject({ name: "Creator", weight: 0.8, embedded: true });
    }
  });

  it("records a check that found nobody rather than dropping it", async () => {
    // R3. An empty faces array is the whole point — "HAL looked and saw no one"
    // is information, and it is what makes decay observable rather than
    // inferred from a gap between entries.
    await timeline.append(check("2026-08-08T10:00:00.000Z", []));
    await flushJsonl();

    const events = await timeline.recent(1);
    const event = events[0];
    expect(event?.kind).toBe("check");
    if (event?.kind === "check") expect(event.faces).toEqual([]);
  });

  it("skips a damaged line rather than failing the whole read", async () => {
    await timeline.append(caption("2026-08-08T10:00:00.000Z", "good"));
    await flushJsonl();
    await fs.appendFile(path.join(dir, "vision-timeline", "2026-08-08.jsonl"), "{ this is not json\n", "utf8");
    await timeline.append(caption("2026-08-08T10:01:00.000Z", "also good"));
    await flushJsonl();

    const events = await timeline.recent(10);
    expect(events).toHaveLength(2);
  });

  it("reads as empty before anything has been written", async () => {
    expect(await timeline.recent(10)).toEqual([]);
  });

  it("returns nothing for a non-positive window", async () => {
    await timeline.append(caption("2026-08-08T10:00:00.000Z", "x"));
    await flushJsonl();
    expect(await timeline.recent(0)).toEqual([]);
  });

  it("reports a write failure without taking the caller down", async () => {
    // Detection must not stop because a disk is full.
    const original = fs.mkdir;
    (fs as { mkdir: typeof original }).mkdir = (async () => {
      throw new Error("ENOSPC");
    }) as typeof original;
    try {
      await expect(timeline.append(caption("2026-08-08T10:00:00.000Z", "x"))).resolves.toBeUndefined();
    } finally {
      (fs as { mkdir: typeof original }).mkdir = original;
    }
  });
});

describe("lastSeen — how weight survives a restart", () => {
  it("finds the most recent check carrying a person and their weight", async () => {
    await timeline.append(check("2026-08-08T10:00:00.000Z", seen("Creator", 0.4)));
    await timeline.append(check("2026-08-08T10:00:15.000Z", seen("Creator", 0.6)));
    await timeline.append(check("2026-08-08T10:00:30.000Z", []));
    await flushJsonl();

    const last = await new VisionTimeline(dir).lastSeen("Creator");
    expect(last).toMatchObject({ at: "2026-08-08T10:00:15.000Z", weight: 0.6 });
  });

  it("returns nothing for someone never seen", async () => {
    await timeline.append(check("2026-08-08T10:00:00.000Z", seen("Creator", 0.6)));
    await flushJsonl();
    expect(await timeline.lastSeen("nobody")).toBeNull();
  });

  it("ignores a sighting that carried no weight", async () => {
    // A face recorded before weight existed, or one detected but not embedded.
    // Returning it would hand the caller an undefined to decay.
    await timeline.append(check("2026-08-08T10:00:00.000Z", seen("Creator")));
    await flushJsonl();
    expect(await timeline.lastSeen("Creator")).toBeNull();
  });

  it("returns nothing when the timeline is empty", async () => {
    expect(await timeline.lastSeen("Creator")).toBeNull();
  });
});
