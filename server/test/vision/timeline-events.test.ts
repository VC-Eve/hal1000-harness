// Check and caption events reaching the timeline (U2/U3, R1-R5, AE1/AE2).
import { pinnedSettings } from "../settings.js";
//
// Driven through the service, because the claim is about what the loops emit
// and when — not about the store, which has its own tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ crop: { value: null as Buffer | null } }));
vi.mock("../../src/vision/thumbnail.js", () => ({ cropFace: async () => mocks.crop.value }));

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { VisionService, type VisionHub, type VisionSink } from "../../src/vision/service.js";
import { VisionTimeline } from "../../src/vision/timeline.js";
import { FrameStore } from "../../src/vision/frames.js";
import { ProviderQueue } from "../../src/providers/queue.js";
import { SettingsStore } from "../../src/storage/settings.js";
import { flushJsonl } from "../../src/storage/jsonl.js";
import { fakeCandidates, fakeGallery } from "./fakes.js";
import { RecogniserError, type DetectResult, type Recogniser } from "../../src/vision/recogniser.js";
import type { CameraFeed } from "../../src/vision/stream.js";
import type { Gallery, Match } from "../../src/vision/people.js";
import type { ChatStreamOptions, Provider } from "../../src/providers/provider.js";
import type { VisionCheckEvent, VisionEvent } from "../../../shared/src/types.js";
import { VISION_TIMELINE_WINDOW } from "../../../shared/src/types.js";

let dir: string;
let settings: SettingsStore;
let timeline: VisionTimeline;
const clock = { at: 1_700_000_000_000 };
let broadcasts: import("../../../shared/src/types.js").ServerMessage[] = [];
// What a joining client is handed, and the greet that hands it over.
let sent: import("../../../shared/src/types.js").ServerMessage[] = [];
let greeters: ((client: never) => void)[] = [];

const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

const face = (deg: number, box = { x: 0, y: 0, w: 120, h: 120 }) => {
  const t = (deg * Math.PI) / 180;
  return { box, score: 0.95, landmarks: [] as [number, number][], embedding: [Math.cos(t), Math.sin(t)], alignment: 1 };
};

const detected = (...faces: ReturnType<typeof face>[]): DetectResult => ({ width: 640, height: 480, faces });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-timeline-events-"));
  settings = await pinnedSettings(dir);
  await settings.update({ chatModel: "test-model" });
  timeline = new VisionTimeline(dir);
  clock.at = 1_700_000_000_000;
  broadcasts = [];
  sent = [];
  greeters = [];
  mocks.crop.value = null;
});

afterEach(async () => {
  await flushJsonl();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

function build(opts: { detect?: DetectResult | Error; match?: Match | null; caption?: string; camera?: CameraFeed } = {}) {
  const recogniser: Recogniser = {
    async detect() {
      if (opts.detect instanceof Error) throw opts.detect;
      return opts.detect ?? detected();
    },
    probe: async () => ({ reachable: true, detector: "ok", embedder: "ok" }),
  };
  const camera: CameraFeed =
    opts.camera ??
    ({
      start() {},
      stop() {},
      onFrame: () => () => {},
      grab: () => jpeg(),
      grabWhenReady: async () => jpeg(),
      running: true,
      lastError: null,
    } as CameraFeed);
  const provider = (): Provider => ({
    listModels: async () => [],
    async *chatStream(_o: ChatStreamOptions) {
      yield "...";
    },
  });
  const hub: VisionHub = {
    broadcast: (m) => broadcasts.push(m),
    onMessage: () => {},
    onConnection: (greet) => {
      greeters.push(greet as (client: never) => void);
    },
    sendTo: (_client, m) => sent.push(m),
  };
  const sink: VisionSink = { record: () => {} };
  return new VisionService(
    hub,
    settings,
    new FrameStore(dir),
    sink,
    new ProviderQueue(),
    provider,
    fakeGallery({ match: async () => opts.match ?? null }),
    fakeCandidates(),
    timeline,
    () => ({ caption: async () => opts.caption ?? "a person at a desk", probe: async () => true }),
    () => recogniser,
    camera,
    () => clock.at,
  );
}

const tick = (svc: VisionService) => (svc as unknown as { tick(): Promise<void> }).tick();
const settle = () => new Promise((r) => setTimeout(r, 0));

const enable = (extra: Record<string, unknown> = {}) =>
  settings.update({ vision: { enabled: true, recognitionEnabled: true, detectionIntervalSeconds: 1, ...extra } });

async function events(): Promise<VisionEvent[]> {
  await flushJsonl();
  return timeline.recent(50);
}

const checks = (all: VisionEvent[]) => all.filter((e): e is VisionCheckEvent => e.kind === "check");

/**
 * Wait until the timeline holds at least `count` check events.
 *
 * `recordCheck` awaits a timeline read before it appends — that is how weight
 * is recovered after a restart — so a single macrotask is not enough for a new
 * event to land. Asserting on `.at(-1)` without this reads the PREVIOUS event
 * and passes for the wrong reason, which is exactly what it did.
 */
async function awaitChecks(count: number): Promise<VisionCheckEvent[]> {
  for (let i = 0; i < 50; i += 1) {
    const found = checks(await events());
    if (found.length >= count) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${count} check events`);
}

/**
 * Tick once and wait for the event that tick produces.
 *
 * A plain tick can be skipped outright: detection is single-flight, so a tick
 * arriving while the previous one is still in flight does nothing at all.
 * Looping with a fixed settle therefore produces an unpredictable NUMBER of
 * checks, and a test that asserts on "the twentieth" waits forever for a
 * twentieth that was never going to happen.
 */
async function tickAwaiting(svc: VisionService, alreadySeen: number): Promise<VisionCheckEvent[]> {
  await tick(svc);
  return awaitChecks(alreadySeen + 1);
}

describe("check events", () => {
  it("records a pass that found nobody", async () => {
    // Covers AE1. Four passes with an empty room produce four events, each
    // saying so — the record is never idle while Vision is on, and that is what
    // makes an absence visible rather than being the gap between entries.
    await enable({ intervalSeconds: 3_600 });
    const svc = build({ detect: detected() });

    for (let i = 0; i < 4; i += 1) {
      await tick(svc);
      await settle();
      clock.at += 5_000;
    }

    const found = checks(await events());
    expect(found).toHaveLength(4);
    expect(found.every((e) => e.faces.length === 0)).toBe(true);
  });

  it("records who was matched, at what confidence, in which band", async () => {
    await enable({ intervalSeconds: 3_600 });
    const svc = build({
      detect: detected(face(0)),
      match: { personId: "p1", name: "Creator", confidence: 0.71 },
    });

    await tick(svc);
    await settle();

    expect(checks(await events())[0]!.faces[0]).toMatchObject({
      personId: "p1",
      name: "Creator",
      confidence: 0.71,
      band: "stated",
      embedded: true,
    });
  });

  it("records the hedged band for a marginal match", async () => {
    await enable({ intervalSeconds: 3_600 });
    const svc = build({ detect: detected(face(0)), match: { personId: "p1", name: "Creator", confidence: 0.55 } });

    await tick(svc);
    await settle();

    expect(checks(await events())[0]!.faces[0]).toMatchObject({ band: "hedged" });
  });

  it("records how wide the face was", async () => {
    await enable({ intervalSeconds: 3_600 });
    const svc = build({ detect: detected(face(0, { x: 0, y: 0, w: 240, h: 240 })) });

    await tick(svc);
    await settle();

    expect(checks(await events())[0]!.faces[0]).toMatchObject({ sourceWidth: 240 });
  });

  it("records two faces within one event", async () => {
    // One pass is one event, however many people it found.
    await enable({ intervalSeconds: 3_600 });
    const svc = build({
      detect: detected(face(0, { x: 0, y: 0, w: 100, h: 100 }), face(90, { x: 400, y: 0, w: 100, h: 100 })),
    });

    await tick(svc);
    await settle();

    const found = checks(await events());
    expect(found).toHaveLength(1);
    expect(found[0]!.faces).toHaveLength(2);
  });

  it("records a face it could detect but not describe as found, not as nobody", async () => {
    // Two different facts. Collapsing them would report an empty room when the
    // embedder is simply unavailable.
    await enable({ intervalSeconds: 3_600 });
    const noEmbedding: DetectResult = {
      width: 640,
      height: 480,
      faces: [{ box: { x: 0, y: 0, w: 120, h: 120 }, score: 0.9, landmarks: [], embedding: null, alignment: 1 }],
    };
    const svc = build({ detect: noEmbedding });

    await tick(svc);
    await settle();

    const [event] = checks(await events());
    expect(event!.faces).toHaveLength(1);
    expect(event!.faces[0]).toMatchObject({ embedded: false });
    expect(event!.faces[0]!.personId).toBeUndefined();
  });

  it("writes nothing while recognition is off", async () => {
    await settings.update({ vision: { enabled: true, recognitionEnabled: false } });
    const svc = build({ detect: detected(face(0)) });

    await tick(svc);
    await settle();

    expect(checks(await events())).toHaveLength(0);
  });

  it("writes nothing for a check that could not run", async () => {
    // An unreachable recogniser did not look. Recording an empty pass would say
    // HAL saw no one, which is a different and untrue claim.
    await enable({ intervalSeconds: 3_600 });
    const svc = build({ detect: new RecogniserError("gone", "unreachable") });

    await tick(svc);
    await settle();

    expect(checks(await events())).toHaveLength(0);
  });

  it("keeps detecting when the timeline cannot be written", async () => {
    await enable({ intervalSeconds: 3_600 });
    const broken = new VisionTimeline(dir);
    broken.append = async () => {
      throw new Error("ENOSPC");
    };
    timeline = broken;
    const svc = build({ detect: detected(face(0)) });

    await expect(tick(svc)).resolves.toBeUndefined();
  });
});

describe("caption events", () => {
  it("records the caption, stamped with the frame time", async () => {
    await enable({ intervalSeconds: 1 });
    const svc = build({ caption: "a person at a desk" });

    await tick(svc);
    await settle();

    const captions = (await events()).filter((e) => e.kind === "caption");
    expect(captions).toHaveLength(1);
    expect(captions[0]).toMatchObject({ caption: "a person at a desk" });
    // The frame time, not the answer time. Captioning takes tens of seconds, and
    // the observation is deliberately stamped when the frame was grabbed — the
    // caption event has to agree with it or the two records disagree about when
    // the same moment was.
    const observation = broadcasts.find((m) => m.type === "vision-observation") as
      | { observation: { at: string } }
      | undefined;
    expect(observation).toBeDefined();
    expect((captions[0] as { at: string }).at).toBe(observation!.observation.at);
  });

  it("interleaves with checks in one distinguishable stream", async () => {
    // Covers AE2. Detection is faster than capture, so several checks sit
    // between two captions and the kinds are unambiguous.
    await enable({ intervalSeconds: 1, detectionIntervalSeconds: 1 });
    const svc = build({ detect: detected(face(0)) });

    for (let i = 0; i < 3; i += 1) {
      await tick(svc);
      await settle();
      clock.at += 2_000;
    }

    const all = await events();
    expect(all.some((e) => e.kind === "check")).toBe(true);
    expect(all.some((e) => e.kind === "caption")).toBe(true);
    expect(new Set(all.map((e) => e.kind))).toEqual(new Set(["check", "caption"]));
  });

  it("writes nothing when there is no frame to caption", async () => {
    await enable({ intervalSeconds: 1 });
    const svc = build({
      camera: {
        start() {},
        stop() {},
        onFrame: () => () => {},
        grab: () => null,
        grabWhenReady: async () => {
          throw new Error("no camera");
        },
        running: false,
        lastError: null,
      } as CameraFeed,
    });

    await tick(svc);
    await settle();

    expect((await events()).filter((e) => e.kind === "caption")).toHaveLength(0);
  });
});

describe("weight on the record", () => {
  const CREATOR = { personId: "p1", name: "Creator", confidence: 0.7 };

  it("rises across consecutive checks", async () => {
    // Covers AE3, through the loop rather than the arithmetic.
    await enable({ intervalSeconds: 3_600 });
    const svc = build({ detect: detected(face(0)), match: CREATOR });

    const weights: number[] = [];
    let found: VisionCheckEvent[] = [];
    for (let i = 0; i < 5; i += 1) {
      found = await tickAwaiting(svc, i);
      clock.at += 2_000;
    }
    for (const event of found) {
      const w = event.faces[0]?.weight;
      if (typeof w === "number") weights.push(w);
    }

    expect(weights).toHaveLength(5);
    for (let i = 1; i < weights.length; i += 1) expect(weights[i]!).toBeGreaterThan(weights[i - 1]!);
  });

  it("records what weight would have decided, alongside what was decided", async () => {
    // Covers AE5. Early on, weight is still low while the frame reads stated —
    // that disagreement is exactly the evidence the record exists to collect.
    await enable({ intervalSeconds: 3_600 });
    const svc = build({ detect: detected(face(0)), match: CREATOR });

    await tick(svc);
    await settle();

    const first = checks(await events())[0]!.faces[0]!;
    expect(first.band).toBe("stated");
    expect(first.weightedBand).toBeDefined();
    expect(first.weightedBand).not.toBe(first.band);
  });

  it("records no weight for a face it did not match", async () => {
    await enable({ intervalSeconds: 3_600 });
    const svc = build({ detect: detected(face(0)), match: null });

    await tick(svc);
    await settle();

    const recorded = checks(await events())[0]!.faces[0]!;
    expect(recorded.weight).toBeUndefined();
    expect(recorded.weightedBand).toBeUndefined();
  });

  it("changes nothing HAL says", async () => {
    // Covers AE6, and this is the guard on the whole design. Four call sites
    // read the per-frame band today, and each is a plausible place to swap in
    // weight while wiring it up. A person at high weight whose current frame
    // reads hedged must still be hedged.
    await enable({ intervalSeconds: 3_600 });
    const svc = build({ detect: detected(face(0)), match: { ...CREATOR, confidence: 0.55 } });

    let found: VisionCheckEvent[] = [];
    for (let i = 0; i < 8; i += 1) {
      found = await tickAwaiting(svc, i);
      // MIN_DETECTION_INTERVAL_SECONDS is 2, and the setting is clamped to it —
      // a shorter advance is never due, so the loop would spin without ever
      // producing a second check.
      clock.at += 2_000;
    }

    const last = found.at(-1)!.faces[0]!;
    // Weight has accumulated...
    expect(last.weight!).toBeGreaterThan(0.5);
    // ...and the band HAL actually used is unmoved by it.
    expect(last.band).toBe("hedged");

    const observation = broadcasts.filter((m) => m.type === "vision-observation").at(-1) as
      | { observation: { identity: string | null } }
      | undefined;
    if (observation?.observation.identity) {
      expect(observation.observation.identity).toContain("someone who looks like");
    }
  });

  it("recovers weight from the timeline after a restart", async () => {
    // R9. The last event holds the value and its time; a restart is just
    // another gap, so a fresh service continues from there rather than zero.
    await enable({ intervalSeconds: 3_600 });
    const first = build({ detect: detected(face(0)), match: CREATOR });
    for (let i = 0; i < 6; i += 1) {
      await tick(first);
      await settle();
      clock.at += 2_000;
    }
    const first6 = await awaitChecks(6);
    const before = first6.at(-1)!.faces[0]!.weight!;
    expect(before).toBeGreaterThan(0.5);

    // A new service over the same timeline, a moment later.
    clock.at += 3_000;
    const second = build({ detect: detected(face(0)), match: CREATOR });
    await tick(second);

    const after = (await awaitChecks(7)).at(-1)!.faces[0]!.weight!;
    expect(after).toBeGreaterThan(before * 0.8);
  });

  it("reads a long gap as absence rather than as the last value", async () => {
    // Covers AE4 through the loop.
    await enable({ intervalSeconds: 3_600 });
    const first = build({ detect: detected(face(0)), match: CREATOR });
    for (let i = 0; i < 8; i += 1) {
      await tick(first);
      await settle();
      clock.at += 2_000;
    }

    await awaitChecks(8);

    // Overnight, then someone appears.
    clock.at += 14 * 60 * 60 * 1000;
    const second = build({ detect: detected(face(0)), match: CREATOR });
    await tick(second);

    const after = (await awaitChecks(9)).at(-1)!.faces[0]!.weight!;
    // A single sighting after a night away, not a continuation of yesterday.
    expect(after).toBeLessThan(0.3);
  });
});

describe("the pane's view of the record", () => {
  it("greets a joining client with what has already been seen", async () => {
    // R14/U6. A client joining an hour into a session would otherwise show an
    // empty record of a session that has been running for an hour, and the next
    // event alone would not explain the blank above it.
    await timeline.append({ kind: "caption", at: "2026-08-08T10:00:00.000Z", caption: "a person at a desk" });
    await flushJsonl();

    await enable({ intervalSeconds: 3_600 });
    build({ detect: detected() });
    greeters[0]!(undefined as never);

    for (let i = 0; i < 50 && !sent.some((m) => m.type === "vision-timeline"); i += 1) await settle();
    const greeting = sent.find((m) => m.type === "vision-timeline") as
      | { events: VisionEvent[]; window: number; append?: boolean }
      | undefined;
    expect(greeting).toBeDefined();
    expect(greeting!.append).toBeUndefined();
    expect(greeting!.window).toBe(VISION_TIMELINE_WINDOW);
    expect(greeting!.events).toHaveLength(1);
  });

  it("broadcasts each new event as an append rather than resending the window", async () => {
    // A check every few seconds resending two hundred events to add one is a
    // cost with no reader.
    await enable({ intervalSeconds: 3_600 });
    const svc = build({ detect: detected(face(0)) });

    await tickAwaiting(svc, 0);

    const appends = (
      broadcasts.filter((m) => m.type === "vision-timeline") as { events: VisionEvent[]; append?: boolean }[]
    ).filter((m) => m.events[0]?.kind === "check");
    expect(appends).toHaveLength(1);
    expect(appends[0]!.append).toBe(true);
    // One event, not the window. The first tick also captures, so the caption
    // broadcast rides alongside — filtered out above, not absent.
    expect(appends[0]!.events).toHaveLength(1);
  });

  it("broadcasts a caption the same way", async () => {
    await enable({ intervalSeconds: 1 });
    const svc = build({ caption: "a person at a desk" });

    await tick(svc);

    const captions = () =>
      (broadcasts.filter((m) => m.type === "vision-timeline") as { events: VisionEvent[] }[])
        .flatMap((m) => m.events)
        .filter((e) => e.kind === "caption");
    // Captioning is a long await; a single macrotask does not cover it.
    for (let i = 0; i < 50 && captions().length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(captions()).toHaveLength(1);
  });
});

describe("the confidence a check records", () => {
  it("is this frame's reading, not the one the appearance opened on", async () => {
    // Reported from the running instance: "Creator 61%" for fifteen consecutive
    // checks while the user moved around, then a jump to 62% that stuck. A
    // cosine similarity across independent captures does not behave like that —
    // 0.53 to 0.78 is the measured live range.
    //
    // The cause was that the record read the APPEARANCE's identity decision,
    // which is deliberately frozen on entry so HAL does not flicker between
    // matched and unmatched mid-visit. Freezing what HAL says is right; freezing
    // what the record says each check found is not, and it also meant weight
    // could only ever rise — a constant confidence can never be the "lower
    // accuracy" that is supposed to bring it down.
    await enable({ intervalSeconds: 3_600 });
    const readings = [0.71, 0.55, 0.64];
    let i = 0;
    const svc = build({ detect: detected(face(0)) });
    // A gallery that answers differently each call, the way a real one does
    // when the face moves.
    (svc as unknown as { people: Pick<Gallery, "match"> }).people = {
      match: async () => ({ personId: "p1", name: "Creator", confidence: readings[Math.min(i++, 2)]! }),
    } as Pick<Gallery, "match">;

    for (let n = 0; n < 3; n += 1) {
      await tickAwaiting(svc, n);
      clock.at += 2_000;
    }

    expect((await awaitChecks(3)).map((e) => e.faces[0]?.confidence)).toEqual(readings);
  });

  it("still lets HAL keep one identity for the whole visit", async () => {
    // The other half. The per-frame reading is what the RECORD carries; the
    // appearance's decision is what HAL acts on, and it stays put so a visit
    // does not read as a series of arrivals and departures.
    await enable({ intervalSeconds: 3_600 });
    let i = 0;
    const svc = build({ detect: detected(face(0)) });
    (svc as unknown as { people: Pick<Gallery, "match"> }).people = {
      match: async () => ({ personId: "p1", name: "Creator", confidence: [0.71, 0.55][Math.min(i++, 1)]! }),
    } as Pick<Gallery, "match">;

    for (let n = 0; n < 2; n += 1) {
      await tickAwaiting(svc, n);
      clock.at += 2_000;
    }

    const found = await awaitChecks(2);
    expect(found.map((e) => e.faces[0]?.name)).toEqual(["Creator", "Creator"]);
    // The band follows the reading, because the band is about this frame.
    expect(found.map((e) => e.faces[0]?.band)).toEqual(["stated", "hedged"]);
  });
});
