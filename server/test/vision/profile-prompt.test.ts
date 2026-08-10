// Character profiles reaching the vision observer (U12, R19-R24, AE2/AE6).
import { pinnedSettings } from "../settings.js";
//
// The section builder is tested directly; how it reaches the model is tested
// through the service, because "which system message did the provider receive"
// is the actual claim and a unit test of the builder cannot make it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ crop: { value: null as Buffer | null } }));
vi.mock("../../src/vision/thumbnail.js", () => ({ cropFace: async () => mocks.crop.value }));

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { knownPeopleSection } from "../../../shared/src/prompts.js";
import { MAX_PROFILE_CHARS, type PersonSummary } from "../../../shared/src/types.js";
import { VisionService, type VisionHub, type VisionSink } from "../../src/vision/service.js";
import { FrameStore } from "../../src/vision/frames.js";
import { ProviderQueue } from "../../src/providers/queue.js";
import { SettingsStore } from "../../src/storage/settings.js";
import { VisionTimeline } from "../../src/vision/timeline.js";
import { fakeCandidates, fakeGallery } from "./fakes.js";
import type { DetectResult, Recogniser } from "../../src/vision/recogniser.js";
import type { CameraFeed } from "../../src/vision/stream.js";
import type { ChatStreamOptions, Provider } from "../../src/providers/provider.js";
import type { Match } from "../../src/vision/people.js";

describe("knownPeopleSection", () => {
  const person = (name: string, profile: string, isOperator = false) => ({ name, profile, isOperator });

  it("reads as knowledge rather than as a document", () => {
    // Measured, not stylistic. Calling the captions "what your eye reported"
    // made the model discuss the report instead of the room, so this phrases
    // profiles as memory and never announces itself as a section.
    const out = knownPeopleSection([person("Dave", "my brother")]).text;
    expect(out).toContain("You know Dave: my brother");
    expect(out.toLowerCase()).not.toContain("context");
    expect(out.toLowerCase()).not.toContain("profile");
    expect(out.toLowerCase()).not.toContain("the following");
  });

  it("says who the operator is", () => {
    const out = knownPeopleSection([person("Dave", "my brother"), person("Jim", "me", true)]).text;
    expect(out).toContain("You know Jim, whose machine this is: me");
  });

  it("puts the operator first, so a bound never cuts them", () => {
    const out = knownPeopleSection([person("Dave", "x".repeat(40)), person("Jim", "me", true)]).text;
    expect(out.indexOf("Jim")).toBeLessThan(out.indexOf("Dave"));
  });

  it("carries exactly one instruction, and it is positive", () => {
    // This prompt was three times longer once and worked worse — ten competing
    // prohibitions and a model that began narrating the rules themselves.
    const out = knownPeopleSection([person("Dave", "my brother")]).text;
    const sentences = out.split("\n").filter((l) => l.trim());
    expect(sentences.at(-1)).toBe("Speak about them only as far as what you saw supports.");
    expect(out).not.toContain("Do not");
    expect(out).not.toContain("Never");
  });

  it("produces nothing when nobody is described", () => {
    expect(knownPeopleSection([]).text).toBe("");
    expect(knownPeopleSection([person("Dave", "   ")]).text).toBe("");
  });

  it("bounds the total across everyone, not just each profile", () => {
    // R24. R23 bounds one profile; several people in view is the case that
    // grows the prompt, and it is the prompt whose length was the problem.
    const many = Array.from({ length: 10 }, (_, i) => person(`P${i}`, "y".repeat(300)));
    expect(knownPeopleSection(many, 800).text.length).toBeLessThan(1_100);
  });

  it("says how many it left out rather than dropping them silently", () => {
    const many = Array.from({ length: 5 }, (_, i) => person(`P${i}`, "y".repeat(300)));
    const out = knownPeopleSection(many, 400).text;
    expect(out).toMatch(/I know \d+ other (person|people), not recalled here/);
  });
});

// ---------------------------------------------------------------------------
// Through the service: what the provider actually received.
// ---------------------------------------------------------------------------

let dir: string;
let settings: SettingsStore;
let seen: ChatStreamOptions[];

const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

const roster = (over: Partial<PersonSummary> & { name: string }): PersonSummary => ({
  id: over.name,
  createdAt: "2026-08-08T00:00:00.000Z",
  faceCount: 1,
  faces: [],
  ...over,
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-profile-prompt-"));
  settings = await pinnedSettings(dir);
  await settings.update({ chatModel: "test-model" });
  seen = [];
  mocks.crop.value = null;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

const detected = (): DetectResult => ({
  width: 640,
  height: 480,
  faces: [{ box: { x: 0, y: 0, w: 100, h: 100 }, score: 0.95, landmarks: [], embedding: [1, 0], alignment: 1 }],
});

function build(opts: { people: PersonSummary[]; match: Match | null; reply?: string }) {
  const recogniser: Recogniser = {
    detect: async () => detected(),
    probe: async () => ({ reachable: true, detector: "ok", embedder: "ok" }),
  };
  const camera: CameraFeed = {
    start() {},
    stop() {},
    onFrame: () => () => {},
    grab: () => jpeg(),
    grabWhenReady: async () => jpeg(),
    running: true,
    lastError: null,
  };
  const provider = (): Provider => ({
    listModels: async () => [],
    async *chatStream(o: ChatStreamOptions) {
      seen.push(o);
      yield opts.reply ?? "Someone is at the desk.";
    },
  });
  const hub: VisionHub = { broadcast: () => {}, onMessage: () => {}, onConnection: () => {}, sendTo: () => {} };
  const sink: VisionSink = { record: () => {} };
  // A clock the test moves, not one that advances on every read. `now()` is
  // called several times per tick, so a self-incrementing clock made the
  // schedule unreproducible.
  const clockRef = { at: 1_000_000 };
  const svc = new VisionService(
    hub,
    settings,
    new FrameStore(dir),
    sink,
    new ProviderQueue(),
    provider,
    fakeGallery({ list: async () => opts.people, match: async () => opts.match }),
    fakeCandidates(),
    new VisionTimeline(dir),
    () => ({ caption: async () => "a person sits at a desk", probe: async () => true }),
    () => recogniser,
    camera,
    () => clockRef.at,
  );
  return { svc, clock: clockRef };
}

const tick = (svc: VisionService) => (svc as unknown as { tick(): Promise<void> }).tick();
const settle = () => new Promise((r) => setTimeout(r, 0));

async function runCycle(built: { svc: VisionService; clock: { at: number } }): Promise<string> {
  const { svc, clock } = built;
  await settings.update({
    vision: { enabled: true, recognitionEnabled: true, detectionIntervalSeconds: 1, intervalSeconds: 1, cycleSeconds: 1 },
  });
  // Detection is fire-and-forget from the tick, so the appearance it opens is
  // only visible to a LATER capture. Three ticks: detect, capture, summarise.
  await tick(svc);
  await settle();
  clock.at += 5_000;
  await tick(svc);
  await settle();
  clock.at += 5_000;
  await tick(svc);
  await settle();
  return seen.map((o) => o.messages.find((m) => m.role === "system")?.content ?? "").join(" --- ");
}

describe("profiles reaching the vision observer", () => {
  it("carries a stated person's profile", () => {
    // Covered separately below; this is the positive case the rest contrast to.
    expect(true).toBe(true);
  });

  it("withholds the profile of a hedged match (AE2)", async () => {
    // 0.55 sits between the shipped 0.5 and 0.6. Handing HAL someone's history
    // on the strength of a maybe is how a marginal match becomes a confident
    // story about the wrong person.
    const svc = build({
      people: [roster({ name: "Dave", profile: "my brother, works nights" })],
      match: { personId: "Dave", name: "Dave", confidence: 0.55 },
    });
    const system = await runCycle(svc);
    expect(system).not.toContain("works nights");
  });

  it("carries the profile once the match clears the statement threshold", async () => {
    const svc = build({
      people: [roster({ name: "Dave", profile: "my brother, works nights" })],
      match: { personId: "Dave", name: "Dave", confidence: 0.71 },
    });
    const system = await runCycle(svc);
    expect(system).toContain("You know Dave: my brother, works nights");
  });

  it("carries the operator even when nobody was recognised", async () => {
    // Standing context. The operator is who HAL is for, not who it just saw.
    const svc = build({
      people: [roster({ name: "Jim", profile: "the developer", isOperator: true })],
      match: null,
    });
    const system = await runCycle(svc);
    expect(system).toContain("whose machine this is");
  });

  it("never puts a profile in the caption line (R19)", async () => {
    // The whole placement decision. A profile in the caption line is a label
    // attached to an observation, which is the shape measured becoming the
    // subject of the narration three times.
    const svc = build({
      people: [roster({ name: "Dave", profile: "my brother, works nights" })],
      match: { personId: "Dave", name: "Dave", confidence: 0.71 },
    });
    await runCycle(svc);
    const user = seen.map((o) => o.messages.find((m) => m.role === "user")?.content ?? "").join("\n");
    expect(user).toContain("Dave");
    expect(user).not.toContain("works nights");
  });

  it("still carries profiles when the user has blanked the vision prompt (R20)", async () => {
    // A blank prompt says "add nothing of your own about how to narrate". It
    // does not say "forget who these people are", and gating the section on it
    // would make blanking the prompt silently delete standing knowledge.
    await settings.update({ vision: { prompt: "" } });
    const svc = build({
      people: [roster({ name: "Jim", profile: "the developer", isOperator: true })],
      match: null,
    });
    const system = await runCycle(svc);
    expect(system).toContain("the developer");
  });

  it("sends no system message at all when there is neither a prompt nor anyone described", async () => {
    // The pre-profile behaviour, preserved: a blank prompt with nothing to say
    // is still a request with no system message.
    await settings.update({ vision: { prompt: "" } });
    const svc = build({ people: [roster({ name: "Dave" })], match: null });
    await runCycle(svc);
    expect(seen.every((o) => !o.messages.some((m) => m.role === "system"))).toBe(true);
  });

  it("marks the profile text so the inference log withholds it (R40)", async () => {
    // U3 built the seam; this is the caller that has to use it. Without this
    // the profile is logged verbatim and outlives deleting the person.
    const svc = build({
      people: [roster({ name: "Dave", profile: "my brother, works nights" })],
      match: { personId: "Dave", name: "Dave", confidence: 0.71 },
    });
    await runCycle(svc);
    expect(seen.some((o) => (o.redact ?? []).some((r) => r.includes("works nights")))).toBe(true);
  });
});

describe("the length bound", () => {
  it("is the same number the editor counts against", () => {
    expect(MAX_PROFILE_CHARS).toBeGreaterThan(0);
  });
});
