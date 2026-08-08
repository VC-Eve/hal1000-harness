// Check and caption events reaching the timeline (U2/U3, R1-R5, AE1/AE2).
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
import type { Match } from "../../src/vision/people.js";
import type { ChatStreamOptions, Provider } from "../../src/providers/provider.js";
import type { VisionCheckEvent, VisionEvent } from "../../../shared/src/types.js";

let dir: string;
let settings: SettingsStore;
let timeline: VisionTimeline;
const clock = { at: 1_700_000_000_000 };
let broadcasts: import("../../../shared/src/types.js").ServerMessage[] = [];

const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

const face = (deg: number, box = { x: 0, y: 0, w: 120, h: 120 }) => {
  const t = (deg * Math.PI) / 180;
  return { box, score: 0.95, landmarks: [] as [number, number][], embedding: [Math.cos(t), Math.sin(t)], alignment: 1 };
};

const detected = (...faces: ReturnType<typeof face>[]): DetectResult => ({ width: 640, height: 480, faces });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-timeline-events-"));
  settings = new SettingsStore(dir);
  await settings.load();
  await settings.update({ chatModel: "test-model" });
  timeline = new VisionTimeline(dir);
  clock.at = 1_700_000_000_000;
  broadcasts = [];
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
    onConnection: () => {},
    sendTo: () => {},
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
