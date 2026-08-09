import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ crop: { value: null as Buffer | null } }));
vi.mock("../../src/vision/thumbnail.js", () => ({ cropFace: async () => mocks.crop.value }));

import { VisionService, type VisionHub, type VisionSink } from "../../src/vision/service.js";
import { FrameStore } from "../../src/vision/frames.js";
import { ProviderQueue } from "../../src/providers/queue.js";
import { SettingsStore } from "../../src/storage/settings.js";
import type { DetectResult, Recogniser } from "../../src/vision/recogniser.js";
import type { Gallery, Match } from "../../src/vision/people.js";
import { VisionTimeline } from "../../src/vision/timeline.js";
import { fakeCandidates, fakeGallery } from "./fakes.js";
import type { CameraFeed } from "../../src/vision/stream.js";
import type { Captioner } from "../../src/vision/captioner.js";
import type { ChatStreamOptions, ProviderFactory } from "../../src/providers/provider.js";
import type { NarrationEntry, PersonSummary, ServerMessage } from "../../../shared/src/types.js";

// Vision's cycle summariser and the Off-Machine Acknowledgement.
//
// This file exists because the summariser had no acknowledgement check at all.
// It assembles Character Profiles for anyone in the stated band plus the
// Operator, formats banded enrolled names, and streamed the lot to whatever
// endpoint settings named. That was invisible for as long as every endpoint was
// loopback Ollama, and became a leak the moment a remote backend was
// selectable — the shape
// docs/solutions/a-gate-that-checks-one-direction-is-half-a-gate.md records: a
// check that covered two senders and gave the third away.
//
// The assertions are on what reached the provider, not on a flag. A flag can be
// set correctly while the prompt still carries the name.

const REMOTE = "https://api.example.com";
const LOCAL = "http://localhost:11434";

let dir: string;
let settings: SettingsStore;
let queue: ProviderQueue;
let entries: NarrationEntry[];
let sent: ServerMessage[];
let calls: { system: string | undefined; user: string }[];
let clock: number;

const hub: VisionHub = {
  broadcast: (m) => sent.push(m),
  onMessage: () => {},
  onConnection: () => {},
  sendTo: () => {},
};

const sink: VisionSink = { record: (e) => entries.push(e) };

function recordingProvider(reply = "Someone is at the desk."): ProviderFactory {
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

function face(angleDeg = 0) {
  const t = (angleDeg * Math.PI) / 180;
  return {
    box: { x: 0, y: 0, w: 100, h: 100 },
    score: 0.95,
    landmarks: [] as [number, number][],
    embedding: [Math.cos(t), Math.sin(t)],
    alignment: 1,
  };
}

const detected = (...faces: ReturnType<typeof face>[]): DetectResult => ({ width: 640, height: 480, faces });

function fakeRecogniser(next: DetectResult): Recogniser {
  return {
    async detect() {
      return next;
    },
    async probe() {
      return { reachable: true, detector: "ok", embedder: "ok" };
    },
  };
}

const ALICE: Match = { personId: "p1", name: "Alice", confidence: 0.92 };

// Alice is enrolled, confidently matched, and has a profile. Every ingredient
// the summariser would carry off-machine.
function galleryWithProfile(): Gallery {
  return fakeGallery({
    match: async () => ALICE,
    list: async (): Promise<PersonSummary[]> => [
      {
        id: "p1",
        name: "Alice",
        createdAt: "2026-08-08T00:00:00.000Z",
        faceCount: 1,
        faces: [],
        profile: "Alice is the lead engineer on the router project.",
      },
    ],
  });
}

function fakeCamera(): CameraFeed {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  return {
    start() {},
    stop() {},
    onFrame: () => () => {},
    grab: () => jpeg,
    grabWhenReady: async () => jpeg,
    running: true,
    lastError: null,
  };
}

const fakeCaptioner = (text = "A person sits at a desk."): Captioner => ({
  caption: async () => text,
  probe: async () => true,
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-vision-ack-"));
  settings = new SettingsStore(dir);
  await settings.load();
  await settings.update({
    chatModel: "test-model",
    // Pinned: this file is about the gate, and a probe against an endpoint
    // nobody is listening at would decide the outcome before the gate ran.
    backends: { observation: { endpoint: LOCAL, protocol: "ollama" } },
    vision: {
      enabled: true,
      recognitionEnabled: true,
      detectionIntervalSeconds: 1,
      intervalSeconds: 1,
      cycleSeconds: 1,
    },
  });
  queue = new ProviderQueue();
  entries = [];
  sent = [];
  calls = [];
  clock = 1_000_000;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

function build() {
  return new VisionService(
    hub,
    settings,
    new FrameStore(dir),
    sink,
    queue,
    recordingProvider(),
    galleryWithProfile(),
    fakeCandidates(),
    new VisionTimeline(dir),
    () => fakeCaptioner(),
    () => fakeRecogniser(detected(face())),
    fakeCamera(),
    () => clock,
  );
}

const tick = (svc: VisionService): Promise<void> => (svc as unknown as { tick(): Promise<void> }).tick();
const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * Detect, capture, summarise.
 *
 * Three ticks rather than two: detection is fire-and-forget from the tick, so
 * the appearance it opens is only visible to a *later* capture. Two ticks
 * summarise a cycle in which nobody had been recognised yet, which would make
 * every "the name did not reach the provider" assertion below pass for the
 * wrong reason.
 */
async function runCycle(svc: VisionService): Promise<void> {
  await tick(svc);
  await settle();
  clock += 5_000;
  await tick(svc);
  await settle();
  clock += 5_000;
  await tick(svc);
  await settle();
}

async function remote(): Promise<void> {
  await settings.update({ backends: { observation: { endpoint: REMOTE, protocol: "ollama" } } });
}

async function acknowledge(): Promise<void> {
  await settings.update({ offMachineAcknowledged: true });
}

describe("the vision summariser and the off-machine acknowledgement", () => {
  it("carries the profile and the name to a local backend", async () => {
    const svc = build();
    await runCycle(svc);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.system ?? "").toContain("lead engineer on the router project");
    expect(`${calls[0]!.system ?? ""}${calls[0]!.user}`).toContain("Alice");
  });

  it("withholds the profile and the name from an unacknowledged remote backend", async () => {
    // The defect this file was written for. Asserted on what was sent.
    await remote();
    const svc = build();
    await runCycle(svc);

    expect(calls.length).toBeGreaterThan(0);
    const wire = `${calls[0]!.system ?? ""}${calls[0]!.user}`;
    expect(wire).not.toContain("lead engineer on the router project");
    expect(wire).not.toContain("Alice");
  });

  it("carries them again once acknowledged", async () => {
    await remote();
    await acknowledge();
    const svc = build();
    await runCycle(svc);

    expect(calls.length).toBeGreaterThan(0);
    expect(`${calls[0]!.system ?? ""}${calls[0]!.user}`).toContain("Alice");
  });

  it("still produces a remark rather than falling silent", async () => {
    // Withholding says less; it does not skip the cycle. A cycle that produces
    // nothing is what the remarking switch means, and it means something else.
    await remote();
    const svc = build();
    await runCycle(svc);

    expect(calls.length).toBeGreaterThan(0);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("is unchanged for the ordinary local setup", async () => {
    const svc = build();
    await runCycle(svc);
    const withoutGate = `${calls[0]!.system ?? ""}${calls[0]!.user}`;

    calls = [];
    await acknowledge();
    const svc2 = build();
    await runCycle(svc2);

    expect(`${calls[0]!.system ?? ""}${calls[0]!.user}`).toBe(withoutGate);
  });

  it("treats an endpoint that will not parse as remote", async () => {
    await settings.update({ backends: { observation: { endpoint: "not a url", protocol: "ollama" } } });
    const svc = build();
    await runCycle(svc);

    expect(calls.length).toBeGreaterThan(0);
    expect(`${calls[0]!.system ?? ""}${calls[0]!.user}`).not.toContain("Alice");
  });

  it("does not gate on a remote chat backend while its own is local", async () => {
    // Per role, not per installation. Vision sends to the shared backend, so a
    // chat override pointed off-machine is none of its business.
    await settings.update({ backends: { chat: { endpoint: REMOTE, protocol: "openai" } } });
    const svc = build();
    await runCycle(svc);

    expect(calls.length).toBeGreaterThan(0);
    expect(`${calls[0]!.system ?? ""}${calls[0]!.user}`).toContain("Alice");
  });
});
