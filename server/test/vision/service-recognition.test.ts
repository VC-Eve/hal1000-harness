import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VisionService, type VisionHub, type VisionSink } from "../../src/vision/service.js";
import { FrameStore } from "../../src/vision/frames.js";
import { ProviderQueue } from "../../src/providers/queue.js";
import { SettingsStore } from "../../src/storage/settings.js";
import { RecogniserError, type DetectResult, type Recogniser } from "../../src/vision/recogniser.js";
import type { Gallery, Match } from "../../src/vision/people.js";
import type { CameraFeed } from "../../src/vision/stream.js";
import type { Captioner } from "../../src/vision/captioner.js";
import type { ChatStreamOptions, Provider } from "../../src/providers/provider.js";
import type { ClientMessage, NarrationEntry, ServerMessage } from "../../../shared/src/types.js";

// ---------------------------------------------------------------------------
// Fakes. The recogniser and the gallery are the two seams this slice adds, and
// both are interfaces precisely so these can be object literals.
// ---------------------------------------------------------------------------

function face(angleDeg: number, box = { x: 0, y: 0, w: 100, h: 100 }) {
  const t = (angleDeg * Math.PI) / 180;
  return { box, score: 0.95, landmarks: [] as [number, number][], embedding: [Math.cos(t), Math.sin(t)], alignment: 1 };
}

function detected(...faces: ReturnType<typeof face>[]): DetectResult {
  return { width: 640, height: 480, faces };
}

interface FakeRecogniser extends Recogniser {
  calls: number;
  next: DetectResult | Error;
  // Resolves the pending detect when set, so an in-flight request can be held
  // open deliberately rather than by racing a timer.
  hold?: () => void;
}

function fakeRecogniser(next: DetectResult | Error = detected()): FakeRecogniser {
  const rec: FakeRecogniser = {
    calls: 0,
    next,
    async detect() {
      rec.calls += 1;
      if (rec.hold) await new Promise<void>((resolve) => (rec.hold = resolve));
      if (rec.next instanceof Error) throw rec.next;
      return rec.next;
    },
    async probe() {
      return { reachable: true, detector: "ok", embedder: "ok" };
    },
  };
  return rec;
}

function gallery(match: Match | null = null): Gallery {
  return {
    list: async () => [],
    create: async () => {
      throw new Error("not used");
    },
    remove: async () => false,
    match: async () => match,
  };
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

function fakeCaptioner(text: string): Captioner {
  return { caption: async () => text, probe: async () => true };
}

function provider(reply: string): (endpoint: string) => Provider {
  return () => ({
    async listModels() {
      return [];
    },
    async *chatStream(_opts: ChatStreamOptions) {
      yield reply;
    },
  });
}

describe("recognition in VisionService", () => {
  let dir: string;
  let settings: SettingsStore;
  let sent: ServerMessage[];
  let entries: NarrationEntry[];
  let hub: VisionHub;
  let sink: VisionSink;
  let queue: ProviderQueue;
  let clock: number;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-recognition-"));
    settings = new SettingsStore(dir);
    await settings.load();
    // The summariser refuses to run without a model, and several tests here
    // assert on the entry it produces.
    await settings.update({ chatModel: "test-model" });
    sent = [];
    entries = [];
    clock = 1_000_000;
    hub = {
      broadcast: (m) => sent.push(m),
      onMessage: () => {},
      onConnection: () => {},
      sendTo: () => {},
    };
    sink = { record: (e) => entries.push(e) };
    queue = new ProviderQueue();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function build(opts: { recogniser?: Recogniser; gallery?: Gallery; reply?: string } = {}) {
    const recogniser = opts.recogniser ?? fakeRecogniser();
    const svc = new VisionService(
      hub,
      settings,
      new FrameStore(dir),
      sink,
      queue,
      provider(opts.reply ?? "Someone is at the desk."),
      opts.gallery ?? gallery(),
      () => fakeCaptioner("A person sits at a desk."),
      () => recogniser,
      fakeCamera(),
      () => clock,
    );
    return { svc, recogniser };
  }

  const tick = (svc: VisionService): Promise<void> =>
    (svc as unknown as { tick(): Promise<void> }).tick();

  const send = (svc: VisionService, msg: ClientMessage): Promise<void> =>
    (svc as unknown as { handle(m: ClientMessage): Promise<void> }).handle(msg);

  async function enableRecognition(extra: Record<string, unknown> = {}): Promise<void> {
    await settings.update({
      vision: { enabled: true, recognitionEnabled: true, detectionIntervalSeconds: 3, ...extra },
    });
  }

  // Detection is fire-and-forget from the tick, so a tick must be followed by a
  // microtask drain before its effects are observable.
  const settle = () => new Promise((r) => setTimeout(r, 0));

  describe("R1 — subordinate and off by default", () => {
    it("never reaches the recogniser while recognition is off", async () => {
      await settings.update({ vision: { enabled: true } });
      const { svc, recogniser } = build();
      await tick(svc);
      await settle();
      expect((recogniser as FakeRecogniser).calls).toBe(0);
    });

    it("never reaches the recogniser while Vision is off, even with recognition on", async () => {
      // Recognition never causes camera access on its own.
      await settings.update({ vision: { enabled: false, recognitionEnabled: true } });
      const { svc, recogniser } = build();
      await tick(svc);
      await settle();
      expect((recogniser as FakeRecogniser).calls).toBe(0);
    });

    it("leaves the observation identity null when recognition is off", async () => {
      await settings.update({ vision: { enabled: true, intervalSeconds: 5 } });
      const { svc } = build();
      await tick(svc);
      await settle();
      const obs = sent.find((m) => m.type === "vision-observation");
      expect(obs).toBeDefined();
      expect((obs as { observation: { identity: unknown } }).observation.identity).toBeNull();
    });
  });

  describe("R30 — its own interval", () => {
    it("detects on the detection interval, not the capture interval", async () => {
      await enableRecognition({ intervalSeconds: 3_600 });
      const { svc, recogniser } = build();

      await tick(svc);
      await settle();
      expect((recogniser as FakeRecogniser).calls).toBe(1);

      // Too soon.
      clock += 1_000;
      await tick(svc);
      await settle();
      expect((recogniser as FakeRecogniser).calls).toBe(1);

      clock += 3_000;
      await tick(svc);
      await settle();
      expect((recogniser as FakeRecogniser).calls).toBe(2);
    });

    it("applies a changed interval without a restart", async () => {
      await enableRecognition({ intervalSeconds: 3_600, detectionIntervalSeconds: 60 });
      const { svc, recogniser } = build();
      await tick(svc);
      await settle();

      clock += 10_000;
      await tick(svc);
      await settle();
      expect((recogniser as FakeRecogniser).calls).toBe(1);

      await settings.update({ vision: { detectionIntervalSeconds: 5 } });
      await tick(svc);
      await settle();
      expect((recogniser as FakeRecogniser).calls).toBe(2);
    });
  });

  describe("R8 — skipped, never queued", () => {
    it("skips a detection while one is still in flight", async () => {
      await enableRecognition({ intervalSeconds: 3_600 });
      const recogniser = fakeRecogniser();
      recogniser.hold = () => {};
      const { svc } = build({ recogniser });

      await tick(svc);
      await settle();
      expect(recogniser.calls).toBe(1);

      // Many intervals pass while the first is stuck. The backlog must not grow.
      for (let i = 0; i < 5; i++) {
        clock += 5_000;
        await tick(svc);
        await settle();
      }
      expect(recogniser.calls).toBe(1);
    });

    it("reports the too-slow condition, distinct from unreachable", async () => {
      await enableRecognition({ intervalSeconds: 3_600 });
      const recogniser = fakeRecogniser();
      recogniser.hold = () => {};
      const { svc } = build({ recogniser });

      await tick(svc);
      await settle();
      for (let i = 0; i < 4; i++) {
        clock += 5_000;
        await tick(svc);
        await settle();
      }

      const states = sent.filter((m) => m.type === "vision-status").map((m) => (m as { state: string }).state);
      expect(states).toContain("recogniser-slow");
      expect(states).not.toContain("no-recogniser");
    });
  });

  describe("R7 — an absent recogniser is quiet", () => {
    it("keeps capturing and summarising, and narrates nothing about the fault", async () => {
      // Covers AE5.
      await enableRecognition({ intervalSeconds: 5, cycleSeconds: 10 });
      const { svc } = build({
        recogniser: fakeRecogniser(new RecogniserError("nope", "unreachable")),
      });

      await tick(svc);
      await settle();
      clock += 20_000;
      await tick(svc);
      await settle();

      // Captions still happened.
      expect(sent.some((m) => m.type === "vision-observation")).toBe(true);
      // The cycle still summarised.
      expect(entries.length).toBeGreaterThan(0);
      // And nothing in the feed mentions the recogniser.
      expect(entries.every((e) => !/recognis|recogniz/i.test(e.text))).toBe(true);
      // The fault surfaced only as status.
      const states = sent.filter((m) => m.type === "vision-status").map((m) => (m as { state: string }).state);
      expect(states).toContain("no-recogniser");
    });

    it("recovers without a restart once the recogniser returns", async () => {
      await enableRecognition({ intervalSeconds: 3_600 });
      const recogniser = fakeRecogniser(new RecogniserError("nope", "unreachable"));
      const { svc } = build({ recogniser });

      await tick(svc);
      await settle();
      expect(
        sent.filter((m) => m.type === "vision-status").map((m) => (m as { state: string }).state),
      ).toContain("no-recogniser");

      recogniser.next = detected(face(0));
      clock += 5_000;
      await tick(svc);
      await settle();

      const last = sent.filter((m) => m.type === "vision-status").at(-1);
      expect((last as { state: string }).state).toBe("idle");
    });

    it("does not publish a fault repeatedly while it persists", async () => {
      await enableRecognition({ intervalSeconds: 3_600 });
      const { svc } = build({ recogniser: fakeRecogniser(new RecogniserError("nope", "unreachable")) });

      for (let i = 0; i < 4; i++) {
        clock += 5_000;
        await tick(svc);
        await settle();
      }
      const faults = sent
        .filter((m) => m.type === "vision-status")
        .filter((m) => (m as { state: string }).state === "no-recogniser");
      expect(faults).toHaveLength(1);
    });
  });

  describe("R23 — identity on the observation, hedged", () => {
    it("puts the hedged form on the observation and never a bare name", async () => {
      // Covers AE7's input half.
      await enableRecognition({ intervalSeconds: 3_600 });
      const { svc } = build({
        recogniser: fakeRecogniser(detected(face(0))),
        gallery: gallery({ personId: "p1", name: "Dave", confidence: 0.92 }),
      });

      await tick(svc);
      await settle();

      clock += 5_000;
      await settings.update({ vision: { intervalSeconds: 1 } });
      await tick(svc);
      await settle();

      const obs = sent
        .filter((m) => m.type === "vision-observation")
        .map((m) => (m as { observation: { identity: string | null } }).observation)
        .find((o) => o.identity !== null);

      expect(obs?.identity).toBe("someone who looks like Dave");
      expect(obs?.identity).not.toBe("Dave");
    });

    it("carries the confidence for the UI without giving it to the model", async () => {
      await enableRecognition({ intervalSeconds: 3_600 });
      const { svc } = build({
        recogniser: fakeRecogniser(detected(face(0))),
        gallery: gallery({ personId: "p1", name: "Dave", confidence: 0.92 }),
      });
      await tick(svc);
      await settle();
      clock += 5_000;
      await settings.update({ vision: { intervalSeconds: 1 } });
      await tick(svc);
      await settle();

      const obs = sent
        .filter((m) => m.type === "vision-observation")
        .map((m) => (m as { observation: { identityMatch?: { confidence: number }[] } }).observation)
        .find((o) => o.identityMatch);
      expect(obs?.identityMatch?.[0]?.confidence).toBeCloseTo(0.92, 5);
    });

    it("rewrites a bare name the model produced anyway", async () => {
      // Covers AE7's output half — the guarantee checked on what the model
      // returned, not only on what it was handed.
      await enableRecognition({ intervalSeconds: 1, cycleSeconds: 2 });
      const { svc } = build({
        recogniser: fakeRecogniser(detected(face(0))),
        gallery: gallery({ personId: "p1", name: "Dave", confidence: 0.92 }),
        reply: "Dave is at the desk.",
      });

      await tick(svc);
      await settle();
      clock += 10_000;
      await tick(svc);
      await settle();

      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0]!.text).toBe("someone who looks like Dave is at the desk.");
    });

    it("leaves an unrecognised appearance without an identity", async () => {
      // Covers AE6: below threshold is unrecognised, not a guess.
      await enableRecognition({ intervalSeconds: 3_600 });
      const { svc } = build({ recogniser: fakeRecogniser(detected(face(0))), gallery: gallery(null) });

      await tick(svc);
      await settle();
      clock += 5_000;
      await settings.update({ vision: { intervalSeconds: 1 } });
      await tick(svc);
      await settle();

      const obs = sent
        .filter((m) => m.type === "vision-observation")
        .map((m) => (m as { observation: { identity: string | null } }).observation);
      expect(obs.every((o) => o.identity === null)).toBe(true);
    });
  });

  describe("enrolment", () => {
    it("refuses a blank name", async () => {
      await enableRecognition();
      const { svc } = build();
      await send(svc, { type: "enrol-person", name: "   " });
      const result = sent.find((m) => m.type === "vision-enrol-result") as { ok: boolean; error?: string };
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/name/i);
    });

    it("refuses when no face is in view", async () => {
      await enableRecognition();
      const { svc } = build({ recogniser: fakeRecogniser(detected()) });
      await send(svc, { type: "enrol-person", name: "Dave" });
      const result = sent.find((m) => m.type === "vision-enrol-result") as { ok: boolean; error?: string };
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/no face/i);
    });

    it("refuses when two faces are in view, with a distinct reason", async () => {
      // Enrolling from a crowded frame would silently attach the wrong face to
      // a name, and this slice has no queue to correct it with.
      await enableRecognition();
      const { svc } = build({
        recogniser: fakeRecogniser(detected(face(0), face(90, { x: 300, y: 0, w: 100, h: 100 }))),
      });
      await send(svc, { type: "enrol-person", name: "Dave" });
      const result = sent.find((m) => m.type === "vision-enrol-result") as { ok: boolean; error?: string };
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/2 faces/i);
    });

    it("refuses when the recogniser detected but could not embed", async () => {
      // A person with no vector would look enrolled and never match.
      await enableRecognition();
      const bare = { ...face(0), embedding: null };
      const { svc } = build({ recogniser: fakeRecogniser({ width: 640, height: 480, faces: [bare] }) });
      await send(svc, { type: "enrol-person", name: "Dave" });
      const result = sent.find((m) => m.type === "vision-enrol-result") as { ok: boolean; error?: string };
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/cannot describe/i);
    });

    it("refuses when the recogniser is unreachable, rather than storing a faceless person", async () => {
      await enableRecognition();
      const { svc } = build({ recogniser: fakeRecogniser(new RecogniserError("gone", "unreachable")) });
      await send(svc, { type: "enrol-person", name: "Dave" });
      const result = sent.find((m) => m.type === "vision-enrol-result") as { ok: boolean };
      expect(result.ok).toBe(false);
    });

    it("refuses while recognition is off", async () => {
      await settings.update({ vision: { enabled: true, recognitionEnabled: false } });
      const { svc } = build();
      await send(svc, { type: "enrol-person", name: "Dave" });
      const result = sent.find((m) => m.type === "vision-enrol-result") as { ok: boolean };
      expect(result.ok).toBe(false);
    });
  });

  describe("deletion", () => {
    it("rebroadcasts the roster and forces the next appearance to decide again", async () => {
      await enableRecognition();
      let removed = false;
      const store: Gallery = {
        list: async () => [],
        create: async () => {
          throw new Error("not used");
        },
        remove: async () => {
          removed = true;
          return true;
        },
        match: async () => ({ personId: "p1", name: "Dave", confidence: 0.9 }),
      };
      const { svc } = build({ gallery: store });

      await send(svc, { type: "delete-person", id: "p1" });
      expect(removed).toBe(true);
      expect(sent.some((m) => m.type === "vision-people")).toBe(true);
      // An open appearance decided before the deletion must not keep trading on
      // that decision.
      expect(sent.some((m) => m.type === "vision-appearances")).toBe(true);
    });

    it("is a no-op for an id that does not exist", async () => {
      await enableRecognition();
      const { svc } = build();
      await send(svc, { type: "delete-person", id: "nobody" });
      expect(sent.some((m) => m.type === "vision-people")).toBe(false);
    });
  });

  describe("R5 — face data does not outlive the appearance", () => {
    it("drops appearances when Vision is switched off", async () => {
      await enableRecognition({ intervalSeconds: 3_600 });
      const { svc } = build({ recogniser: fakeRecogniser(detected(face(0))) });
      await tick(svc);
      await settle();

      await settings.update({ vision: { enabled: false } });
      await tick(svc);
      await settle();

      const last = sent.filter((m) => m.type === "vision-appearances").at(-1);
      expect((last as { appearances: unknown[] }).appearances).toEqual([]);
    });

    it("drops appearances when recognition alone is switched off", async () => {
      await enableRecognition({ intervalSeconds: 3_600 });
      const { svc } = build({ recogniser: fakeRecogniser(detected(face(0))) });
      await tick(svc);
      await settle();

      await settings.update({ vision: { recognitionEnabled: false } });
      await tick(svc);
      await settle();

      const last = sent.filter((m) => m.type === "vision-appearances").at(-1);
      expect((last as { appearances: unknown[] }).appearances).toEqual([]);
    });

    it("never broadcasts an embedding to clients", async () => {
      await enableRecognition({ intervalSeconds: 3_600 });
      const { svc } = build({ recogniser: fakeRecogniser(detected(face(0))) });
      await tick(svc);
      await settle();
      expect(JSON.stringify(sent)).not.toContain("embedding");
    });
  });
});

describe("one person is named once", () => {
  let clock = 1_000_000;

  it("does not repeat a person when two appearances resolve to them", async () => {
    // The defect the live run surfaced: an observation carrying "someone who
    // looks like SW and someone who looks like SW and …". Nobody is in the
    // room twice, so two appearances resolving to one person is a split visit
    // or a double detection — either way the caption names them once.
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), "hal-dupe-"));
    const settings2 = new SettingsStore(dir2);
    await settings2.load();
    await settings2.update({
      chatModel: "test-model",
      vision: { enabled: true, recognitionEnabled: true, detectionIntervalSeconds: 3, intervalSeconds: 3_600 },
    });

    const out: ServerMessage[] = [];
    const svc = new VisionService(
      { broadcast: (m) => out.push(m), onMessage: () => {}, onConnection: () => {}, sendTo: () => {} },
      settings2,
      new FrameStore(dir2),
      { record: () => {} },
      new ProviderQueue(),
      provider("..."),
      gallery({ personId: "p1", name: "SW", confidence: 0.7 }),
      () => fakeCaptioner("A person sits at a desk."),
      // Two faces far apart in the frame, so they cannot merge into one
      // appearance — but both match the same enrolled person.
      () => fakeRecogniser(detected(face(0), face(70, { x: 400, y: 0, w: 100, h: 100 }))),
      fakeCamera(),
      () => clock,
    );

    await (svc as unknown as { tick(): Promise<void> }).tick();
    await new Promise((r) => setTimeout(r, 0));
    clock += 5_000;
    await settings2.update({ vision: { intervalSeconds: 1 } });
    await (svc as unknown as { tick(): Promise<void> }).tick();
    await new Promise((r) => setTimeout(r, 0));

    const obs = out
      .filter((m) => m.type === "vision-observation")
      .map((m) => (m as { observation: { identity: string | null; identityMatch?: unknown[] } }).observation)
      .find((o) => o.identity);

    expect(obs?.identity).toBe("someone who looks like SW");
    expect(obs?.identityMatch).toHaveLength(1);

    await fs.rm(dir2, { recursive: true, force: true });
  });
});
