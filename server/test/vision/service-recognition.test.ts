import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// cropFace shells out to ffmpeg, and the fake camera's 4-byte JPEG is not a
// real image — so the real one correctly returns null. Controlled here so both
// the success and the failure path can be exercised deliberately.
const mocks = vi.hoisted(() => ({ crop: { value: null as Buffer | null } }));
vi.mock("../../src/vision/thumbnail.js", () => ({ cropFace: async () => mocks.crop.value }));

import { VisionService, type VisionHub, type VisionSink } from "../../src/vision/service.js";
import { FrameStore } from "../../src/vision/frames.js";
import { ProviderQueue } from "../../src/providers/queue.js";
import { SettingsStore } from "../../src/storage/settings.js";
import { RecogniserError, type DetectResult, type Recogniser } from "../../src/vision/recogniser.js";
import type { Gallery, Match } from "../../src/vision/people.js";
import { VisionTimeline } from "../../src/vision/timeline.js";
import { fakeCandidates, fakeGallery } from "./fakes.js";
import type { CandidateQueue } from "../../src/vision/candidates.js";
import type { CameraFeed } from "../../src/vision/stream.js";
import type { Captioner } from "../../src/vision/captioner.js";
import type { ChatStreamOptions, Provider, ProviderFactory } from "../../src/providers/provider.js";
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

const gallery = (match: Match | null = null): Gallery => fakeGallery({ match: async () => match });

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

function provider(reply: string): ProviderFactory {
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

  function build(opts: { recogniser?: Recogniser; gallery?: Gallery; reply?: string; candidates?: CandidateQueue } = {}) {
    const recogniser = opts.recogniser ?? fakeRecogniser();
    const svc = new VisionService(
      hub,
      settings,
      new FrameStore(dir),
      sink,
      queue,
      provider(opts.reply ?? "Someone is at the desk."),
      opts.gallery ?? gallery(),
      opts.candidates ?? fakeCandidates(),
      new VisionTimeline(dir),
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

  const appearanceMessages = (): { currentConfidence?: number | null; weight?: number; match: { confidence: number } | null }[][] =>
    sent
      .filter((m) => m.type === "vision-appearances")
      .map((m) => (m as unknown as { appearances: { currentConfidence?: number | null; weight?: number; match: { confidence: number } | null }[] }).appearances);

  // The appearances broadcast is chained onto the timeline write, so a
  // zero-timeout drain returns before it fires. Polls rather than sleeping a
  // fixed span: a sleep long enough on an idle machine is a coin toss on a
  // loaded one, which this suite has already proved twice.
  const awaitAppearances = async (count: number): Promise<void> => {
    for (let i = 0; i < 400; i += 1) {
      if (appearanceMessages().length >= count) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`only ${appearanceMessages().length} appearance broadcasts after waiting for ${count}`);
  };

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

  describe("R1 — identity on the observation, banded", () => {
    it("states the name above the statement threshold", async () => {
      // Was "never a bare name". A bare name is now correct above the statement
      // threshold, and the hedged case below is what still guards the old rule.
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

      expect(obs?.identity).toBe("Dave 92%");
    });

    it("hedges between the two thresholds, and never states the bare name there", async () => {
      // The half of the old guarantee that survives, and the direction that
      // matters: falling through to the more confident form is the dangerous
      // way to be wrong.
      await enableRecognition({ intervalSeconds: 3_600 });
      const { svc } = build({
        recogniser: fakeRecogniser(detected(face(0))),
        // 0.55 sits between the shipped 0.5 and 0.6. Named here because a
        // fixture one hundredth from a boundary is one default change away from
        // silently testing the other band.
        gallery: gallery({ personId: "p1", name: "Dave", confidence: 0.55 }),
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

      expect(obs?.identity).toBe("someone who looks like Dave 55%");
      expect(obs?.identity).not.toBe("Dave 55%");
    });

    it("carries the confidence on the observation for the pane", async () => {
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

    it("annotates a bare stated name the model produced", async () => {
      // The output-side check, end to end. At 0.92 the band allows the bare
      // name, so what the check adds is the reading behind it.
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
      expect(entries[0]!.text).toBe("Dave 92% is at the desk.");
    });

    it("hedges a bare name the model produced below the statement threshold", async () => {
      // The half of AE7 that still bites: the model was handed the hedged form
      // and flattened it anyway. 0.55 sits between the shipped 0.5 and 0.6.
      await enableRecognition({ intervalSeconds: 1, cycleSeconds: 2 });
      const { svc } = build({
        recogniser: fakeRecogniser(detected(face(0))),
        gallery: gallery({ personId: "p1", name: "Dave", confidence: 0.55 }),
        reply: "Dave is at the desk.",
      });

      await tick(svc);
      await settle();
      clock += 10_000;
      await tick(svc);
      await settle();

      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0]!.text).toBe("someone who looks like Dave 55% is at the desk.");
      expect(entries[0]!.text.startsWith("Dave")).toBe(false);
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
      const store: Gallery = fakeGallery({
        remove: async () => {
          removed = true;
          return true;
        },
        tally: async () => ({ people: 1, faces: 1 }),
        match: async () => ({ personId: "p1", name: "Dave", confidence: 0.9 }),
      });
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

  describe("keeping uncertain matches for review", () => {
    // A hedged match is exactly the pose or lighting the gallery covers badly,
    // so confirming it is what makes the next match better. It is opt-in
    // because a careless confirmation puts the wrong face in someone's gallery
    // and makes false positives MORE likely — a loop that runs backwards.

    async function detectOnce(svc: VisionService) {
      await tick(svc);
      await settle();
    }

    it("keeps nothing for an uncertain match while the setting is off", async () => {
      await enableRecognition({ intervalSeconds: 3_600 });
      const queue = fakeCandidates();
      const { svc } = build({
        recogniser: fakeRecogniser(detected(face(0))),
        // 0.55 sits between the shipped 0.5 and 0.6.
        gallery: gallery({ personId: "p1", name: "Dave", confidence: 0.55 }),
        candidates: queue,
      });

      await detectOnce(svc);
      expect(queue.items).toHaveLength(0);
    });

    it("keeps an uncertain match once the setting is on, tagged with who it might be", async () => {
      await enableRecognition({ intervalSeconds: 3_600, queueUncertainMatches: true });
      const queue = fakeCandidates();
      const { svc } = build({
        recogniser: fakeRecogniser(detected(face(0))),
        gallery: gallery({ personId: "p1", name: "Dave", confidence: 0.55 }),
        candidates: queue,
      });
      mocks.crop.value = Buffer.from("crop");

      await detectOnce(svc);

      expect(queue.items).toHaveLength(1);
      const broadcast = sent.filter((m) => m.type === "vision-candidates").pop() as
        | { candidates: { suspected?: { name: string; confidence: number } }[] }
        | undefined;
      expect(broadcast?.candidates[0]?.suspected).toMatchObject({ name: "Dave" });
    });

    it("never keeps a confident match, whatever the setting", async () => {
      // HAL is already sure. A face it is sure about adds nothing but disk.
      await enableRecognition({ intervalSeconds: 3_600, queueUncertainMatches: true });
      const queue = fakeCandidates();
      const { svc } = build({
        recogniser: fakeRecogniser(detected(face(0))),
        gallery: gallery({ personId: "p1", name: "Dave", confidence: 0.92 }),
        candidates: queue,
      });
      mocks.crop.value = Buffer.from("crop");

      await detectOnce(svc);
      expect(queue.items).toHaveLength(0);
    });

    it("still keeps an unrecognised face with the setting off", async () => {
      // The original purpose of the queue is untouched by the new setting.
      await enableRecognition({ intervalSeconds: 3_600 });
      const queue = fakeCandidates();
      const { svc } = build({ recogniser: fakeRecogniser(detected(face(0))), candidates: queue });
      mocks.crop.value = Buffer.from("crop");

      await detectOnce(svc);
      expect(queue.items).toHaveLength(1);
    });

    it("adds the face to the suspected person when confirmed", async () => {
      const added: { personId: string }[] = [];
      const queue = fakeCandidates();
      await queue.offer([1, 0], Buffer.from("crop"), 10, { personId: "p1", name: "Dave", confidence: 0.55 });
      const { svc } = build({
        candidates: queue,
        gallery: fakeGallery({
          addFace: async (personId) => {
            added.push({ personId });
            return true;
          },
        }),
      });

      await send(svc, { type: "confirm-candidate", id: queue.items[0]!.id, personId: "p1" });

      expect(added).toEqual([{ personId: "p1" }]);
      expect(queue.items).toHaveLength(0);
      expect(sent.some((m) => m.type === "vision-roster-result" && m.action === "confirm" && m.ok)).toBe(true);
    });

    it("puts the face back when confirming fails", async () => {
      // Taken from the queue before the add, so a failure here would otherwise
      // destroy it: gone from triage, never added to anyone, and silent.
      const queue = fakeCandidates();
      await queue.offer([1, 0], Buffer.from("crop"), 10, { personId: "p1", name: "Dave", confidence: 0.55 });
      const { svc } = build({
        candidates: queue,
        gallery: fakeGallery({
          addFace: async () => {
            throw new Error("disk full");
          },
        }),
      });

      await send(svc, { type: "confirm-candidate", id: queue.items[0]!.id, personId: "p1" });

      expect(queue.items).toHaveLength(1);
      expect(sent.some((m) => m.type === "vision-roster-result" && m.action === "confirm" && !m.ok)).toBe(true);
    });

    it("puts the face back when the person has gone", async () => {
      const queue = fakeCandidates();
      await queue.offer([1, 0], Buffer.from("crop"), 10, { personId: "p1", name: "Dave", confidence: 0.55 });
      const { svc } = build({ candidates: queue, gallery: fakeGallery({ addFace: async () => false }) });

      await send(svc, { type: "confirm-candidate", id: queue.items[0]!.id, personId: "p1" });

      expect(queue.items).toHaveLength(1);
    });

    it("answers when the face is already gone", async () => {
      const { svc } = build({ candidates: fakeCandidates() });
      await send(svc, { type: "confirm-candidate", id: "no-such-face", personId: "p1" });
      expect(sent.some((m) => m.type === "vision-roster-result" && m.action === "confirm" && !m.ok)).toBe(true);
    });
  });

  describe("remarking in the observation feed is its own switch", () => {
    // Separate from watching. Off, Vision keeps its eyes open and the pane is
    // unchanged; only the commentary stops, so a feed being read for coding
    // activity is not interleaved with remarks about the room.
    const cycleNow = async (svc: VisionService) => {
      clock += 6_000;
      await tick(svc);
      await settle();
      clock += 12_000;
      await tick(svc);
      await new Promise((r) => setTimeout(r, 40));
    };

    it("records a feed entry while it is on", async () => {
      await settings.update({ vision: { enabled: true, intervalSeconds: 5, cycleSeconds: 10, narrateToFeed: true } });
      const { svc } = build({ reply: "Someone is at the desk." });
      await cycleNow(svc);
      expect(entries.filter((e) => e.fromVision)).not.toHaveLength(0);
    });

    it("records nothing in the feed while it is off", async () => {
      await settings.update({ vision: { enabled: true, intervalSeconds: 5, cycleSeconds: 10, narrateToFeed: false } });
      const { svc } = build({ reply: "Someone is at the desk." });
      await cycleNow(svc);
      expect(entries.filter((e) => e.fromVision)).toHaveLength(0);
    });

    it("keeps capturing and captioning for the pane while it is off", async () => {
      // The whole point of the separation: the Vision pane is unchanged.
      await settings.update({ vision: { enabled: true, intervalSeconds: 5, cycleSeconds: 10, narrateToFeed: false } });
      const { svc } = build();
      await cycleNow(svc);
      expect(sent.some((m) => m.type === "vision-observation")).toBe(true);
    });

    it("keeps writing captions to the timeline while it is off", async () => {
      await settings.update({ vision: { enabled: true, intervalSeconds: 5, cycleSeconds: 10, narrateToFeed: false } });
      const { svc } = build();
      await cycleNow(svc);
      const events = await new VisionTimeline(dir).recent(50);
      expect(events.some((e) => e.kind === "caption")).toBe(true);
    });

    it("keeps recognising while it is off", async () => {
      await settings.update({
        vision: { enabled: true, recognitionEnabled: true, intervalSeconds: 5, cycleSeconds: 10, narrateToFeed: false },
      });
      const { svc, recogniser } = build({ recogniser: fakeRecogniser(detected(face(0))) });
      await cycleNow(svc);
      expect((recogniser as FakeRecogniser).calls).toBeGreaterThan(0);
    });

    it("does not let the buffer accumulate while it is off", async () => {
      // Draining still happens. Left to grow, switching it back on would
      // summarise an hour of the room in one remark.
      await settings.update({ vision: { enabled: true, intervalSeconds: 5, cycleSeconds: 10, narrateToFeed: false } });
      const { svc } = build();
      await cycleNow(svc);
      await cycleNow(svc);
      const buffered = (svc as unknown as { buffer: unknown[] }).buffer;
      expect(buffered.length).toBeLessThan(4);
    });

    it("resumes remarking when switched back on", async () => {
      await settings.update({ vision: { enabled: true, intervalSeconds: 5, cycleSeconds: 10, narrateToFeed: false } });
      const { svc } = build({ reply: "Someone is at the desk." });
      await cycleNow(svc);
      expect(entries.filter((e) => e.fromVision)).toHaveLength(0);

      await settings.update({ vision: { narrateToFeed: true } });
      await cycleNow(svc);
      expect(entries.filter((e) => e.fromVision)).not.toHaveLength(0);
    });
  });

  describe("a recogniser off this machine is gated on the acknowledgement", () => {
    // What leaves here is heavier than what leaves through chat: a whole frame
    // of whatever the camera is pointed at, including people who consented to
    // nothing. The gate sits at the one place all three senders pass through —
    // the detection loop, enrolling from the camera, and enrolling from a file.

    it("does not send a frame to a remote recogniser without the acknowledgement", async () => {
      await enableRecognition({ recogniserEndpoint: "http://192.168.1.50:8100" });
      const { svc, recogniser } = build();
      clock += 4_000;
      await tick(svc);
      await settle();
      expect((recogniser as FakeRecogniser).calls).toBe(0);
    });

    it("says why, rather than reporting the recogniser as simply broken", async () => {
      await enableRecognition({ recogniserEndpoint: "http://192.168.1.50:8100" });
      const { svc } = build();
      clock += 4_000;
      await tick(svc);
      await settle();
      const status = sent.filter((m) => m.type === "vision-status").at(-1) as { detail?: string } | undefined;
      expect(status?.detail ?? "").toContain("not on this machine");
    });

    it("sends once the acknowledgement is given", async () => {
      await settings.update({ offMachineAcknowledged: true });
      await enableRecognition({ recogniserEndpoint: "http://192.168.1.50:8100" });
      const { svc, recogniser } = build();
      clock += 4_000;
      await tick(svc);
      await settle();
      expect((recogniser as FakeRecogniser).calls).toBe(1);
    });

    it("never gates a loopback recogniser", async () => {
      await enableRecognition({ recogniserEndpoint: "http://127.0.0.1:8100" });
      const { svc, recogniser } = build();
      clock += 4_000;
      await tick(svc);
      await settle();
      expect((recogniser as FakeRecogniser).calls).toBe(1);
    });

    it("treats an unparseable endpoint as remote", async () => {
      await enableRecognition({ recogniserEndpoint: "not a url" });
      const { svc, recogniser } = build();
      clock += 4_000;
      await tick(svc);
      await settle();
      expect((recogniser as FakeRecogniser).calls).toBe(0);
    });

    it("refuses enrolment from the camera for the same reason", async () => {
      // The second sender. A gate on the detection loop alone would let a
      // deliberate enrolment carry the frame out instead.
      await enableRecognition({ recogniserEndpoint: "http://192.168.1.50:8100" });
      const { svc, recogniser } = build();
      await send(svc, { type: "enrol-person", name: "Alice" });
      await settle();
      expect((recogniser as FakeRecogniser).calls).toBe(0);
      const result = sent.filter((m) => m.type === "vision-enrol-result").at(-1) as { ok?: boolean } | undefined;
      expect(result?.ok).toBe(false);
    });

    it("keeps Vision running with recognition refused", async () => {
      // Refusing to recognise is not refusing to watch. Vision degrades the
      // same way it does for an absent recogniser.
      await enableRecognition({ recogniserEndpoint: "http://192.168.1.50:8100", intervalSeconds: 5 });
      const { svc } = build();
      clock += 6_000;
      await tick(svc);
      await settle();
      await new Promise((r) => setTimeout(r, 20));
      expect(sent.some((m) => m.type === "vision-observation")).toBe(true);
    });
  });

  describe("a visit that opens marginal is not hedged forever", () => {
    // The reported symptom, end to end: "someone who looks like Creator 68%"
    // against a statement threshold of 0.6. The setting's own description says
    // "at or above this I say the name outright", so banding on the opening
    // frame alone broke the promise the control makes.
    it("says the name outright once a reading clears the statement threshold", async () => {
      await enableRecognition({ intervalSeconds: 5 });
      let confidence = 0.55;
      const { svc } = build({
        recogniser: fakeRecogniser(detected(face(0))),
        gallery: fakeGallery({ match: async () => ({ personId: "p1", name: "Creator", confidence }) }),
        reply: "Creator is at the desk.",
      });

      clock += 4_000;
      await tick(svc);
      await awaitAppearances(1);
      expect(appearanceMessages().at(-1)![0]!.match!.confidence).toBeCloseTo(0.55);

      confidence = 0.68;
      clock += 4_000;
      await tick(svc);
      await awaitAppearances(2);

      // Above the shipped 0.6, so the pane bands it stated rather than hedged.
      expect(appearanceMessages().at(-1)![0]!.match!.confidence).toBeCloseTo(0.68);
    });

    it("carries the same value into the line handed to the summariser", async () => {
      // The pane and the caption line must not disagree about what HAL
      // believes — one function decides, and both read it.
      await enableRecognition({ intervalSeconds: 5 });
      let confidence = 0.55;
      const { svc } = build({
        recogniser: fakeRecogniser(detected(face(0))),
        gallery: fakeGallery({ match: async () => ({ personId: "p1", name: "Creator", confidence }) }),
      });
      clock += 4_000;
      await tick(svc);
      await awaitAppearances(1);
      confidence = 0.72;
      clock += 4_000;
      await tick(svc);
      await awaitAppearances(2);

      clock += 6_000;
      await tick(svc);
      await new Promise((r) => setTimeout(r, 50));

      const obs = sent.filter((m) => m.type === "vision-observation").at(-1) as
        | { observation: { identity: string | null } }
        | undefined;
      if (obs?.observation.identity) {
        expect(obs.observation.identity).not.toContain("someone who looks like");
        expect(obs.observation.identity).toContain("Creator");
      }
    });
  });

  describe("the appearances broadcast carries this check's reading", () => {
    // Reported from the running instance: the pane's percentage never moved
    // while the timeline beside it changed every few seconds. The broadcast
    // sent only `match`, which is decided when the appearance opens and never
    // revisited — so the strip could not have updated whatever the camera did.

    it("moves with the gallery's reading while the standing decision holds", async () => {
      await enableRecognition();
      let confidence = 0.8;
      const { svc } = build({
        recogniser: fakeRecogniser(detected(face(0))),
        gallery: fakeGallery({ match: async () => ({ personId: "p1", name: "Alice", confidence }) }),
      });

      clock += 4_000;
      await tick(svc);
      await awaitAppearances(1);
      confidence = 0.55;
      clock += 4_000;
      await tick(svc);
      await awaitAppearances(2);

      const latest = appearanceMessages().at(-1)!;
      expect(latest[0]!.currentConfidence).toBe(0.55);
      // ...and the decision the visit opened on is unmoved, because that is
      // what banding reads.
      expect(latest[0]!.match!.confidence).toBe(0.8);
    });

    it("carries the recognition weight", async () => {
      await enableRecognition();
      const { svc } = build({
        recogniser: fakeRecogniser(detected(face(0))),
        gallery: gallery({ personId: "p1", name: "Alice", confidence: 0.8 }),
      });
      clock += 4_000;
      await tick(svc);
      await awaitAppearances(1);
      expect(appearanceMessages().at(-1)![0]!.weight).toBeGreaterThan(0);
    });

    it("reports a null reading when the frame matched nobody", async () => {
      await enableRecognition();
      let match: Match | null = { personId: "p1", name: "Alice", confidence: 0.8 };
      const { svc } = build({
        recogniser: fakeRecogniser(detected(face(0))),
        gallery: fakeGallery({ match: async () => match }),
      });
      clock += 4_000;
      await tick(svc);
      await awaitAppearances(1);
      match = null;
      clock += 4_000;
      await tick(svc);
      await awaitAppearances(2);

      const latest = appearanceMessages().at(-1)!;
      expect(latest[0]!.currentConfidence).toBeNull();
      // The appearance still stands — one frame failing to match is not a
      // departure, and the standing decision is what HAL acts on.
      expect(latest[0]!.match!.confidence).toBe(0.8);
    });
  });

  // U1 — the live appearance set, reachable from outside the loop.
  //
  // The distinction these lock in is `watching`: an empty `present` means
  // nothing on its own, and a caller that read the array alone would report an
  // empty room HAL never looked at.
  describe("U1 — presence snapshot", () => {
    it("reports not-watching while Vision is off", async () => {
      await settings.update({ vision: { enabled: false, recognitionEnabled: true } });
      const { svc } = build();
      expect(svc.presence()).toEqual({ watching: false, present: [] });
    });

    it("reports not-watching while recognition is off, even with Vision on", async () => {
      await settings.update({ vision: { enabled: true, recognitionEnabled: false } });
      const { svc } = build();
      expect(svc.presence()).toEqual({ watching: false, present: [] });
    });

    it("reports watching with nobody present when the room is empty", async () => {
      await enableRecognition();
      const { svc } = build({ recogniser: fakeRecogniser(detected()) });
      clock += 4_000;
      await tick(svc);
      await settle();
      expect(svc.presence()).toEqual({ watching: true, present: [] });
    });

    it("returns one entry per open appearance, each with its own standing decision", async () => {
      await enableRecognition();
      const known: Match = { personId: "p1", name: "Alice", confidence: 0.8 };
      const { svc } = build({
        recogniser: fakeRecogniser(detected(face(0), face(90, { x: 300, y: 0, w: 100, h: 100 }))),
        // Only the first face matches; the second is a stranger.
        gallery: fakeGallery({
          match: async (embedding: number[]) => (embedding[0]! > 0.5 ? known : null),
        }),
      });
      clock += 4_000;
      await tick(svc);
      await settle();

      const snap = svc.presence();
      expect(snap.watching).toBe(true);
      expect(snap.present).toHaveLength(2);
      expect(snap.present.filter((p) => p.match?.name === "Alice")).toHaveLength(1);
      // A stranger is present-and-unidentified, not dropped from the set.
      expect(snap.present.filter((p) => p.match === null)).toHaveLength(1);
    });

    it("carries the standing decision and this frame's reading separately", async () => {
      await enableRecognition();
      let confidence = 0.8;
      const { svc } = build({
        recogniser: fakeRecogniser(detected(face(0))),
        gallery: fakeGallery({ match: async () => ({ personId: "p1", name: "Alice", confidence }) }),
      });
      clock += 4_000;
      await tick(svc);
      await settle();
      expect(svc.presence().present[0]!.match?.confidence).toBe(0.8);

      // The same appearance continues; the gallery now reads lower. The
      // standing decision must not move — that stability is the whole point of
      // appearance continuity — but the current reading must.
      confidence = 0.55;
      clock += 4_000;
      await tick(svc);
      await settle();

      const after = svc.presence().present[0]!;
      expect(after.match?.confidence).toBe(0.8);
      expect(after.currentConfidence).toBe(0.55);
    });

    it("hands out copies that a caller cannot use to disturb the tracker", async () => {
      await enableRecognition();
      const { svc } = build({
        recogniser: fakeRecogniser(detected(face(0))),
        gallery: gallery({ personId: "p1", name: "Alice", confidence: 0.8 }),
      });
      clock += 4_000;
      await tick(svc);
      await settle();

      const snap = svc.presence();
      snap.present[0]!.match!.name = "Mallory";
      snap.present.length = 0;

      const again = svc.presence();
      expect(again.present).toHaveLength(1);
      expect(again.present[0]!.match?.name).toBe("Alice");
    });

    it("dates each entry from when the appearance opened, not from the last check", async () => {
      await enableRecognition();
      const { svc } = build({
        recogniser: fakeRecogniser(detected(face(0))),
        gallery: gallery({ personId: "p1", name: "Alice", confidence: 0.8 }),
      });
      clock += 4_000;
      await tick(svc);
      await settle();
      const opened = svc.presence().present[0]!.since;

      // Two more checks inside APPEARANCE_GAP_MS — one continuous visit.
      clock += 4_000;
      await tick(svc);
      await settle();
      clock += 4_000;
      await tick(svc);
      await settle();
      expect(svc.presence().present[0]!.since).toBe(opened);
    });

    it("re-dates after a gap long enough to end the visit", async () => {
      // `since` is what a caller reads to say how long someone has been there,
      // so it has to mean this visit and not this person. A gap past
      // APPEARANCE_GAP_MS is absence, and the same face returning is a new
      // visit rather than a continuation of the old one.
      await enableRecognition();
      const { svc } = build({
        recogniser: fakeRecogniser(detected(face(0))),
        gallery: gallery({ personId: "p1", name: "Alice", confidence: 0.8 }),
      });
      clock += 4_000;
      await tick(svc);
      await settle();
      const opened = svc.presence().present[0]!.since;

      clock += 60_000;
      await tick(svc);
      await settle();
      expect(svc.presence().present[0]!.since).not.toBe(opened);
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
      fakeCandidates(),
      new VisionTimeline(dir2),
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

    // 0.70 clears the statement threshold, so this reads as a bare name now.
    // The test is about the person appearing once, not about the form.
    expect(obs?.identity).toBe("SW 70%");
    expect(obs?.identityMatch).toHaveLength(1);

    await fs.rm(dir2, { recursive: true, force: true });
  });
});

describe("our own work is not blamed on the recogniser", () => {
  let clock = 1_000_000;

  it("keeps detecting while candidate thumbnails are being made", async () => {
    // Thumbnailing spawns ffmpeg, which dwarfs the ~7.5ms detection. Doing it
    // inside the single-flight window made every subsequent detection skip and
    // the skip counter then reported "the recogniser cannot keep up" about a
    // recogniser answering instantly. Measured before the fix: one call across
    // six due intervals.
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), "hal-slowq-"));
    const settings2 = new SettingsStore(dir2);
    await settings2.load();
    await settings2.update({
      chatModel: "m",
      vision: { enabled: true, recognitionEnabled: true, detectionIntervalSeconds: 3, intervalSeconds: 3_600 },
    });

    const out: ServerMessage[] = [];
    let calls = 0;
    const slowQueue: CandidateQueue = {
      list: async () => [],
      overflow: () => ({ dropped: 0, since: null }),
      acknowledgeOverflow: async () => {},
      count: async () => 0,
      offer: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return null;
      },
      take: async () => null,
      dismiss: async () => false,
      clear: async () => {},
    };

    const svc = new VisionService(
      { broadcast: (m) => out.push(m), onMessage: () => {}, onConnection: () => {}, sendTo: () => {} },
      settings2,
      new FrameStore(dir2),
      { record: () => {} },
      new ProviderQueue(),
      provider("..."),
      gallery(null),
      slowQueue,
      new VisionTimeline(dir2),
      () => fakeCaptioner("c"),
      () => ({
        async detect() {
          calls += 1;
          return detected(face(0));
        },
        async probe() {
          return { reachable: true, detector: "ok", embedder: "ok" };
        },
      }),
      fakeCamera(),
      () => clock,
    );

    for (let i = 0; i < 5; i++) {
      clock += 4_000;
      await (svc as unknown as { tick(): Promise<void> }).tick();
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 400));

    // Every due interval reached the recogniser.
    expect(calls).toBe(5);
    const states = out.filter((m) => m.type === "vision-status").map((m) => (m as { state: string }).state);
    expect(states).not.toContain("recogniser-slow");

    await fs.rm(dir2, { recursive: true, force: true });
  }, 30_000);
});

describe("enrolment failure does not destroy the face", () => {
  let clock = 1_000_000;

  async function build(galleryThrows: boolean) {
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), "hal-enrolfail-"));
    const settings2 = new SettingsStore(dir2);
    await settings2.load();
    await settings2.update({ vision: { enabled: true, recognitionEnabled: true } });

    const out: ServerMessage[] = [];
    const queued: { id: string; embedding: number[] }[] = [{ id: "c1", embedding: [1, 0] }];
    const queue: CandidateQueue = {
      list: async () => queued.map((c) => ({ id: c.id, at: "t", thumbnail: "data:image/jpeg;base64,AA" })),
      overflow: () => ({ dropped: 0, since: null }),
      acknowledgeOverflow: async () => {},
      count: async () => 0,
      offer: async (embedding) => {
        const id = `re-${queued.length}`;
        queued.push({ id, embedding });
        return { id, at: "t", thumbnail: "data:image/jpeg;base64,AA" };
      },
      take: async (id) => {
        const i = queued.findIndex((c) => c.id === id);
        if (i < 0) return null;
        const [t] = queued.splice(i, 1);
        return { embedding: t!.embedding, thumbnail: Buffer.from("crop") };
      },
      dismiss: async () => false,
      clear: async () => {},
    };
    const store: Gallery = fakeGallery({
      enrolByName: async () => {
        if (galleryThrows) throw new Error("disk full");
        return { person: { id: "p1", name: "Liam", createdAt: "t", faces: [] }, added: false };
      },
    });

    const svc = new VisionService(
      { broadcast: (m) => out.push(m), onMessage: () => {}, onConnection: () => {}, sendTo: () => {} },
      settings2, new FrameStore(dir2), { record: () => {} }, new ProviderQueue(),
      provider("..."), store, queue,
      new VisionTimeline(dir2),
      () => fakeCaptioner("c"), () => fakeRecogniser(), fakeCamera(), () => clock,
    );
    return { svc, out, queued, dir2 };
  }

  it("puts the face back in the queue and says why when saving fails", async () => {
    // `take` removes the candidate before the person is created. A throw in
    // between used to lose the face entirely — out of triage, in nobody's
    // record — and report nothing to the client.
    const { svc, out, queued, dir2 } = await build(true);
    await (svc as unknown as { handle(m: ClientMessage): Promise<void> }).handle({
      type: "enrol-person", name: "Liam", candidateId: "c1",
    });

    const result = out.find((m) => m.type === "vision-enrol-result") as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/disk full/);
    // The face is back, not gone.
    expect(queued).toHaveLength(1);
    expect(queued[0]!.embedding).toEqual([1, 0]);

    await fs.rm(dir2, { recursive: true, force: true });
  });

  it("consumes the candidate on success", async () => {
    const { svc, out, queued, dir2 } = await build(false);
    await (svc as unknown as { handle(m: ClientMessage): Promise<void> }).handle({
      type: "enrol-person", name: "Liam", candidateId: "c1",
    });

    expect((out.find((m) => m.type === "vision-enrol-result") as { ok: boolean }).ok).toBe(true);
    expect(queued).toHaveLength(0);

    await fs.rm(dir2, { recursive: true, force: true });
  });
});

describe("queueUnrecognised — the pipeline that had no test at all", () => {
  let clock = 1_000_000;

  async function harness(opts: { cap?: number; cropFails?: boolean } = {}) {
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), "hal-queuepipe-"));
    const settings2 = new SettingsStore(dir2);
    await settings2.load();
    await settings2.update({
      vision: {
        enabled: true,
        recognitionEnabled: true,
        detectionIntervalSeconds: 3,
        intervalSeconds: 3_600,
        candidateFaces: opts.cap ?? 20,
      },
    });

    const out: ServerMessage[] = [];
    const offered: number[][] = [];
    const queue: CandidateQueue = {
      list: async () => [],
      overflow: () => ({ dropped: 0, since: null }),
      acknowledgeOverflow: async () => {},
      count: async () => 0,
      offer: async (embedding) => {
        offered.push(embedding);
        return { id: `c${offered.length}`, at: "t", thumbnail: "data:image/jpeg;base64,AA" };
      },
      take: async () => null,
      dismiss: async () => false,
      clear: async () => {},
    };

    mocks.crop.value = opts.cropFails ? null : Buffer.from("a cropped face");

    const svc = new VisionService(
      { broadcast: (m) => out.push(m), onMessage: () => {}, onConnection: () => {}, sendTo: () => {} },
      settings2, new FrameStore(dir2), { record: () => {} }, new ProviderQueue(),
      provider("..."), gallery(null), queue,
      new VisionTimeline(dir2),
      () => fakeCaptioner("c"),
      () => fakeRecogniser(detected(face(0))),
      fakeCamera(), () => clock,
    );
    const tick = () => (svc as unknown as { tick(): Promise<void> }).tick();
    return { tick, offered, out, dir2 };
  }

  it("offers an unrecognised face to the queue exactly once per visit", async () => {
    // Nothing asserted on fakeCandidates before this: the whole cap ->
    // dedupe -> crop -> offer -> broadcast path could regress and all 740
    // tests would stay green, because the call is wrapped in a swallowing
    // .catch.
    const { tick, offered, out, dir2 } = await harness();
    for (let i = 0; i < 3; i++) {
      clock += 4_000;
      await tick();
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(offered).toHaveLength(1);
    expect(out.some((m) => m.type === "vision-candidates")).toBe(true);
    await fs.rm(dir2, { recursive: true, force: true });
  }, 30_000);

  it("offers nothing when the cap is zero", async () => {
    const { tick, offered, dir2 } = await harness({ cap: 0 });
    clock += 4_000;
    await tick();
    await new Promise((r) => setTimeout(r, 250));
    expect(offered).toHaveLength(0);
    await fs.rm(dir2, { recursive: true, force: true });
  }, 30_000);

  it("queues nothing rather than storing the whole frame when the crop fails", async () => {
    // The old `?? jpeg` fallback silently stored a picture of the entire room
    // as one person's face, in the only store that holds biometric data.
    const { tick, offered, dir2 } = await harness({ cropFails: true });
    clock += 4_000;
    await tick();
    await new Promise((r) => setTimeout(r, 400));
    expect(offered).toHaveLength(0);
    await fs.rm(dir2, { recursive: true, force: true });
  }, 30_000);
});

describe("a fault standing when recognition is switched off", () => {
  let clock = 1_000_000;

  it("clears rather than reporting no-recogniser forever", async () => {
    // clearRecogniserFault was reachable only from a SUCCESSFUL detection,
    // which can never happen again once recognition is off — so publishIdle
    // kept substituting the standing fault indefinitely.
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), "hal-stuckfault-"));
    const settings2 = new SettingsStore(dir2);
    await settings2.load();
    await settings2.update({
      vision: { enabled: true, recognitionEnabled: true, detectionIntervalSeconds: 3, intervalSeconds: 3_600 },
    });

    const out: ServerMessage[] = [];
    const svc = new VisionService(
      { broadcast: (m) => out.push(m), onMessage: () => {}, onConnection: () => {}, sendTo: () => {} },
      settings2, new FrameStore(dir2), { record: () => {} }, new ProviderQueue(),
      provider("..."), gallery(null), fakeCandidates(),
      new VisionTimeline(dir2),
      () => fakeCaptioner("c"),
      () => fakeRecogniser(new RecogniserError("gone", "unreachable")),
      fakeCamera(), () => clock,
    );
    const tick = () => (svc as unknown as { tick(): Promise<void> }).tick();

    clock += 4_000;
    await tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(out.filter((m) => m.type === "vision-status").map((m) => (m as { state: string }).state)).toContain(
      "no-recogniser",
    );

    await settings2.update({ vision: { recognitionEnabled: false } });
    clock += 4_000;
    await tick();
    await new Promise((r) => setTimeout(r, 20));

    const last = out.filter((m) => m.type === "vision-status").at(-1);
    expect((last as { state: string }).state).toBe("idle");
    await fs.rm(dir2, { recursive: true, force: true });
  }, 30_000);

});
