import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { VisionService, type VisionHub, type VisionSink } from "../../src/vision/service.js";
import { FrameStore } from "../../src/vision/frames.js";
import { ProviderQueue } from "../../src/providers/queue.js";
import { SettingsStore } from "../../src/storage/settings.js";
import { VISION_SILENCE_TOKEN } from "../../../shared/src/prompts.js";
import { CaptionerError, type Captioner } from "../../src/vision/captioner.js";
import { CaptureError } from "../../src/vision/capture.js";
import type { Gallery } from "../../src/vision/people.js";
import { fakeCandidates } from "./fakes.js";
import { ProviderError, type ChatStreamOptions, type Provider } from "../../src/providers/provider.js";
import type { ClientMessage, NarrationEntry, ServerMessage } from "../../../shared/src/types.js";

let dir: string;
let settings: SettingsStore;
let queue: ProviderQueue;
let entries: NarrationEntry[];
let sent: ServerMessage[];
let handlers: ((msg: ClientMessage) => void)[];
let calls: { system: string | undefined; user: string }[];
let clock: number;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal1000-vision-"));
  settings = new SettingsStore(dir);
  await settings.load();
  // A long interval and a short cycle, so advancing the clock past the cycle
  // does not also trigger a second capture. Tests about the interval set their
  // own.
  await settings.update({ chatModel: "fake-model", vision: { enabled: true, intervalSeconds: 600, cycleSeconds: 10 } });
  queue = new ProviderQueue();
  entries = [];
  sent = [];
  handlers = [];
  calls = [];
  clock = 1_000_000;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

const hub: VisionHub = {
  broadcast: (msg) => sent.push(msg),
  onMessage: (h) => handlers.push(h as (msg: ClientMessage) => void),
  onConnection: () => {},
  sendTo: (_client, msg) => sent.push(msg),
};

const sink: VisionSink = { record: (entry) => entries.push(entry) };

function provider(reply: string): (endpoint: string) => Provider {
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

function abortingProvider(): (endpoint: string) => Provider {
  return () => ({
    async listModels() {
      return [];
    },
    // eslint-disable-next-line require-yield
    async *chatStream(): AsyncIterable<string> {
      throw new ProviderError("aborted", "Request was interrupted.");
    },
  });
}

const fakeCaptioner = (caption: string | Error): Captioner => ({
  async caption() {
    if (caption instanceof Error) throw caption;
    return caption;
  },
  async probe() {
    return true;
  },
});

// Stands in for the ffmpeg-backed stream. Counting grabs is how the interval
// is asserted now that a capture is a buffer read rather than a process spawn.
function emptyGallery(): Gallery {
  return {
    list: async () => [],
    create: async () => {
      throw new Error("these tests do not enrol");
    },
    enrolByName: async () => {
      throw new Error("not used");
    },
    remove: async () => false,
    match: async () => null,
  };
}

function fakeCamera(fail?: Error) {
  return {
    starts: [] as (string | null)[],
    stops: 0,
    grabs: 0,
    running: true,
    lastError: null as string | null,
    start(device: string | null) {
      this.starts.push(device);
    },
    stop() {
      this.stops += 1;
    },
    onFrame() {
      return () => {};
    },
    grab() {
      return Buffer.from("jpeg-bytes");
    },
    async grabWhenReady() {
      this.grabs += 1;
      if (fail) throw fail;
      return Buffer.from("jpeg-bytes");
    },
  };
}

type FakeCamera = ReturnType<typeof fakeCamera>;

function service(
  opts: {
    reply?: string;
    caption?: string | Error;
    providerFactory?: (endpoint: string) => Provider;
    camera?: FakeCamera;
  } = {},
) {
  const camera = opts.camera ?? fakeCamera();
  const svc = new VisionService(
    hub,
    settings,
    new FrameStore(dir),
    sink,
    queue,
    opts.providerFactory ?? provider(opts.reply ?? "You are at the desk."),
    // An empty gallery. These tests predate recognition and assert that Vision
    // behaves the same without it, which is R1's guarantee — so nobody is
    // enrolled and nothing here should ever consult it.
    emptyGallery(),
    fakeCandidates(),
    () => fakeCaptioner(opts.caption ?? "A person sits at a desk."),
    // No recogniser: recognition is off in these tests, so reaching for one at
    // all would be the bug.
    () => {
      throw new Error("these tests must not construct a recogniser");
    },
    camera,
    () => clock,
  );
  return { svc, camera };
}

// The tick loop is driven directly rather than by waiting out a real interval:
// the schedule is derived from settings on every tick, so calling it is the
// same code path the timer takes.
function tick(svc: VisionService): Promise<void> {
  return (svc as unknown as { tick(): Promise<void> }).tick();
}

// The hub's registered listener returns void (it attaches its own .catch), so
// awaiting it would assert before the handler has done anything. Drive handle()
// directly for the same reason tick() is driven directly.
function handle(svc: VisionService, msg: ClientMessage): Promise<void> {
  return (svc as unknown as { handle(msg: ClientMessage): Promise<void> }).handle(msg);
}

describe("VisionService", () => {
  it("captions a frame, publishes the observation, and summarises the cycle", async () => {
    const { svc } = service({ reply: "You have not moved in some minutes." });

    await tick(svc);
    clock += 11_000;
    await tick(svc);

    const observations = sent.filter((m) => m.type === "vision-observation");
    expect(observations).toHaveLength(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe("You have not moved in some minutes.");
    // R11: attributed to Vision, and never to one of the other two roles.
    expect(entries[0]!.fromVision).toBe(true);
    expect(entries[0]!.adapterId).toBeNull();
    expect(entries[0]!.monitorId).toBeNull();
  });

  it("leaves no trace when the summariser judges the cycle unremarkable", async () => {
    const { svc } = service({ reply: VISION_SILENCE_TOKEN });

    await tick(svc);
    clock += 11_000;
    await tick(svc);

    // The captions still happened — silence is a decision about speaking, not
    // about looking.
    expect(sent.filter((m) => m.type === "vision-observation")).toHaveLength(1);
    expect(entries).toHaveLength(0);
  });

  it("carries the chosen sensitivity into the summariser's instruction", async () => {
    await settings.update({ vision: { sensitivity: "always" } });
    const { svc } = service();

    await tick(svc);
    clock += 11_000;
    await tick(svc);

    expect(calls[0]!.user).toContain("Always remark on this cycle");
    // `always` must not offer the silence escape hatch, or the dial's top
    // setting would still be able to say nothing.
    expect(calls[0]!.user).not.toContain(VISION_SILENCE_TOKEN);
  });

  it("offers the silence token at every sensitivity below always", async () => {
    await settings.update({ vision: { sensitivity: "low" } });
    const { svc } = service();

    await tick(svc);
    clock += 11_000;
    await tick(svc);

    expect(calls[0]!.user).toContain(VISION_SILENCE_TOKEN);
  });

  it("keeps the observations when chat preempts the summary", async () => {
    const { svc } = service({ providerFactory: abortingProvider() });

    await tick(svc);
    clock += 11_000;
    await tick(svc);

    // An abort is scheduling, not failure: nothing observed may be lost.
    expect(entries).toHaveLength(0);
    const state = svc as unknown as { buffer: unknown[] };
    expect(state.buffer).toHaveLength(1);
  });

  it("reports a busy camera as status and never as an observation", async () => {
    const camera = fakeCamera(new CaptureError("The camera is in use by another application.", "no-camera"));
    const { svc } = service({ camera });

    await tick(svc);

    const status = sent.filter((m) => m.type === "vision-status").at(-1);
    expect(status).toMatchObject({ state: "no-camera" });
    expect(sent.filter((m) => m.type === "vision-observation")).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });

  it("reports an unreachable captioner distinctly from a missing camera", async () => {
    const { svc } = service({ caption: new CaptionerError("nope", "unreachable") });

    await tick(svc);

    expect(sent.filter((m) => m.type === "vision-status").at(-1)).toMatchObject({ state: "no-captioner" });
  });

  it("opens no camera at all while disabled", async () => {
    await settings.update({ vision: { enabled: false } });
    const { svc, camera } = service();

    await tick(svc);

    // Neither a capture nor the live stream: holding the device open for a
    // preview would be camera access before the user asked for it (R15).
    expect(camera.grabs).toBe(0);
    expect(camera.starts).toHaveLength(0);
  });

  it("offers no live camera source while disabled", async () => {
    await settings.update({ vision: { enabled: false } });
    const { svc } = service();

    expect(svc.cameraSource()).toBeNull();
  });

  it("starts the camera when the preview asks for it, rather than waiting for a tick", async () => {
    const { svc, camera } = service();

    // The pane requests the stream the instant Vision is enabled. Waiting for
    // the next tick returned a 503 the <img> never retried.
    expect(svc.cameraSource()).toBe(camera);
    expect(camera.starts).toHaveLength(1);
  });

  it("refuses an on-demand look while Vision is off", async () => {
    await settings.update({ vision: { enabled: false } });
    const { svc, camera } = service();

    await handle(svc, { type: "vision-capture-now" });

    // R15: no device is touched until the user enables Vision, and the request
    // arrives over the protocol so any client can send it.
    expect(camera.grabs).toBe(0);
    expect(camera.starts).toHaveLength(0);
    expect(sent.filter((m) => m.type === "vision-observation")).toHaveLength(0);
  });

  it("looks on demand while Vision is on", async () => {
    const { svc, camera } = service();

    await handle(svc, { type: "vision-capture-now" });

    expect(camera.grabs).toBe(1);
    expect(sent.filter((m) => m.type === "vision-observation")).toHaveLength(1);
  });

  it("does not record an observation from a capture that outlived being switched off", async () => {
    let release: (() => void) | null = null;
    const camera = fakeCamera();
    // Hold the grab open so the capture is still awaiting when Vision stops.
    camera.grabWhenReady = async function () {
      this.grabs += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return Buffer.from("jpeg-bytes");
    };
    const { svc } = service({ camera });

    const inFlight = tick(svc);
    await settings.update({ vision: { enabled: false } });
    await tick(svc);
    release!();
    await inFlight;

    // A picture written after the purge is a picture the user believes is gone.
    expect(await new FrameStore(dir).list()).toHaveLength(0);
    expect(sent.filter((m) => m.type === "vision-observation")).toHaveLength(0);
    expect(sent.filter((m) => m.type === "vision-status").at(-1)).toMatchObject({ state: "off" });
  });

  it("holds the camera open while enabled, so the preview and captures share it", async () => {
    const { svc, camera } = service();

    await tick(svc);

    expect(camera.starts.length).toBeGreaterThan(0);
    expect(svc.cameraSource()).toBe(camera);
  });

  it("purges retained frames and releases the camera when Vision is switched off", async () => {
    const frames = new FrameStore(dir);
    const { svc, camera } = service();

    await tick(svc);
    expect(await frames.list()).toHaveLength(1);

    await settings.update({ vision: { enabled: false } });
    await tick(svc);

    expect(await frames.list()).toHaveLength(0);
    expect(camera.stops).toBeGreaterThan(0);
  });

  it("drives the loop from its own timer, not only from the test seam", async () => {
    // docs/solutions/tests-that-lock-in-the-bug.md: a seam added for
    // testability must not become the only thing tested. Every other test here
    // calls tick() directly, which would pass even if start() never scheduled
    // anything — the same gap feat-ambient-log-monitors.md still records for
    // Monitors.
    vi.useFakeTimers();
    try {
      const { svc, camera } = service();
      svc.start();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(camera.grabs).toBe(1);

      svc.stop();
      await vi.advanceTimersByTimeAsync(30_000);
      // Stopping must actually stop it, and release the camera.
      expect(camera.grabs).toBe(1);
      expect(camera.stops).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits out the interval between captures", async () => {
    await settings.update({ vision: { intervalSeconds: 5 } });
    const { svc, camera } = service();

    await tick(svc);
    await tick(svc);
    expect(camera.grabs).toBe(1);

    clock += 5_000;
    await tick(svc);
    expect(camera.grabs).toBe(2);
  });

  it("applies a shortened interval without a restart", async () => {
    const { svc, camera } = service();

    await tick(svc);
    clock += 30_000;
    await tick(svc);
    // Still inside the ten-minute interval it started with.
    expect(camera.grabs).toBe(1);

    // The schedule is derived from settings on every tick, so a change takes
    // effect on the next one rather than waiting out the old interval.
    await settings.update({ vision: { intervalSeconds: 10 } });
    await tick(svc);
    expect(camera.grabs).toBe(2);
  });
});

describe("FrameStore", () => {
  it("keeps only the newest frames within the window", async () => {
    const frames = new FrameStore(dir);
    for (let i = 0; i < 5; i += 1) {
      await frames.save(Buffer.from(`f${i}`), new Date(Date.UTC(2026, 0, 1, 0, 0, i)), 3);
    }
    const kept = await frames.list();
    expect(kept).toHaveLength(3);
    // Oldest go first, so the survivors are the last three written.
    expect(await fs.readFile(kept[2]!, "utf8")).toBe("f4");
  });

  it("writes nothing when the window is zero", async () => {
    const frames = new FrameStore(dir);
    await frames.save(Buffer.from("f"), new Date(), 0);
    expect(await frames.list()).toHaveLength(0);
  });
});
