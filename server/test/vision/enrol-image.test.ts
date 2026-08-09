// Adding a face from a picture on disk (U10, R13-R15, AE9).
import { pinnedSettings } from "../settings.js";
//
// The success path's last mile — a real photo containing a real face — is not
// testable here: it needs the recogniser sidecar with its models and an actual
// photograph. What IS testable is everything around it, and that is where the
// failures live: three distinct causes of "no face", a path that must not touch
// the camera, and a payload that arrives as text.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ crop: { value: null as Buffer | null } }));
vi.mock("../../src/vision/thumbnail.js", () => ({ cropFace: async () => mocks.crop.value }));

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { VisionService, type VisionHub, type VisionSink } from "../../src/vision/service.js";
import { FrameStore } from "../../src/vision/frames.js";
import { ProviderQueue } from "../../src/providers/queue.js";
import { SettingsStore } from "../../src/storage/settings.js";
import { RecogniserError, type DetectResult, type Recogniser } from "../../src/vision/recogniser.js";
import { VisionTimeline } from "../../src/vision/timeline.js";
import { fakeCandidates, fakeGallery } from "./fakes.js";
import type { CameraFeed } from "../../src/vision/stream.js";
import type { ClientMessage, ServerMessage } from "../../../shared/src/types.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const base64 = () => JPEG.toString("base64");

const detectedFace = (n: number, embedding: number[] | null = [1, 0]): DetectResult => ({
  width: 640,
  height: 480,
  faces: Array.from({ length: n }, () => ({
    box: { x: 0, y: 0, w: 100, h: 100 },
    score: 0.95,
    landmarks: [] as [number, number][],
    embedding,
    alignment: 1,
  })),
});

let dir: string;
let settings: SettingsStore;
let sent: ServerMessage[];

// Deliberately explodes if touched. This path must never open the camera: the
// device is exclusive and its stream lives and dies with Vision being on, so
// reaching for it here would make roster editing depend on Vision after all.
const forbiddenCamera = (): CameraFeed => ({
  start() {
    throw new Error("the image path must not touch the camera");
  },
  stop() {},
  onFrame: () => () => {},
  grab: () => {
    throw new Error("the image path must not touch the camera");
  },
  grabWhenReady: async () => {
    throw new Error("the image path must not touch the camera");
  },
  running: false,
  lastError: null,
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-enrol-image-"));
  settings = await pinnedSettings(dir);
  sent = [];
  mocks.crop.value = Buffer.from("crop");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

function build(opts: { detect?: DetectResult | Error; added?: boolean } = {}) {
  const recogniser: Recogniser = {
    async detect() {
      if (opts.detect instanceof Error) throw opts.detect;
      return opts.detect ?? detectedFace(1);
    },
    async probe() {
      return { reachable: true, detector: "ok", embedder: "ok" };
    },
  };
  const added: { embedding: number[]; thumbnail: Buffer }[] = [];
  const hub: VisionHub = {
    broadcast: (m) => sent.push(m),
    onMessage: () => {},
    onConnection: () => {},
    sendTo: () => {},
  };
  const sink: VisionSink = { record: () => {} };
  const svc = new VisionService(
    hub,
    settings,
    new FrameStore(dir),
    sink,
    new ProviderQueue(),
    (() => ({ listModels: async () => [], chatStream: async function* () {} })) as never,
    fakeGallery({
      addFace: async (_id, embedding, thumbnail) => {
        added.push({ embedding, thumbnail });
        return opts.added ?? true;
      },
    }),
    fakeCandidates(),
    new VisionTimeline(dir),
    undefined,
    () => recogniser,
    forbiddenCamera(),
  );
  return { svc, added };
}

const send = (svc: VisionService, msg: ClientMessage): Promise<void> =>
  (svc as unknown as { handle(m: ClientMessage): Promise<void> }).handle(msg);

const result = () =>
  sent.find((m) => m.type === "vision-roster-result" && m.action === "add-face") as
    | { ok: boolean; error?: string }
    | undefined;

describe("adding a face from a picture", () => {
  it("adds the face and rebroadcasts the roster", async () => {
    const { svc, added } = build();
    await send(svc, { type: "add-face-from-image", personId: "p1", jpegBase64: base64() });

    expect(result()).toMatchObject({ ok: true });
    expect(added).toHaveLength(1);
    expect(added[0]!.embedding).toEqual([1, 0]);
    expect(sent.some((m) => m.type === "vision-people")).toBe(true);
  });

  it("works with Vision switched off and never touches the camera", async () => {
    // R16. The camera fake throws if reached, so this asserts by construction
    // rather than by checking a flag.
    const { svc } = build();
    expect(settings.get().vision.enabled).toBe(false);
    await send(svc, { type: "add-face-from-image", personId: "p1", jpegBase64: base64() });
    expect(result()).toMatchObject({ ok: true });
  });

  it("refuses a picture with no face, and says what usually causes it", async () => {
    const { svc, added } = build({ detect: detectedFace(0) });
    await send(svc, { type: "add-face-from-image", personId: "p1", jpegBase64: base64() });

    const r = result();
    expect(r?.ok).toBe(false);
    expect(r?.error).toContain("could not find a face");
    // The camera path's wording is about looking at the lens, which is useless
    // advice about a file.
    expect(r?.error).not.toContain("Look at the camera");
    expect(added).toHaveLength(0);
  });

  it("refuses a picture with two faces (AE9)", async () => {
    const { svc, added } = build({ detect: detectedFace(2) });
    await send(svc, { type: "add-face-from-image", personId: "p1", jpegBase64: base64() });

    expect(result()?.error).toContain("2 faces");
    expect(added).toHaveLength(0);
  });

  it("distinguishes a face it cannot describe from one it cannot find", async () => {
    // Three causes, three messages. Collapsing them would tell the user to find
    // a better photo when the real problem is the embedder being unavailable.
    const { svc, added } = build({ detect: detectedFace(1, null) });
    await send(svc, { type: "add-face-from-image", personId: "p1", jpegBase64: base64() });

    expect(result()?.error).toContain("cannot describe it");
    expect(added).toHaveLength(0);
  });

  it("refuses something that is not an image at all", async () => {
    const { svc } = build();
    await send(svc, { type: "add-face-from-image", personId: "p1", jpegBase64: "%%%" });
    expect(result()?.error).toContain("did not arrive as an image");
  });

  it("refuses a picture over the size backstop", async () => {
    const { svc } = build();
    const huge = Buffer.alloc(9 * 1024 * 1024).toString("base64");
    await send(svc, { type: "add-face-from-image", personId: "p1", jpegBase64: huge });
    expect(result()?.error).toContain("too large");
  });

  it("says to try again when the recogniser is busy with the camera", async () => {
    // The single-flight lane is shared with live detection. A deliberate action
    // losing that race should not report the recogniser as broken.
    const { svc } = build({ detect: new RecogniserError("took too long", "slow") });
    await send(svc, { type: "add-face-from-image", personId: "p1", jpegBase64: base64() });

    const r = result();
    expect(r?.error).toContain("busy");
    expect(r?.error).toContain("Try that again");
  });

  it("reports an unreachable recogniser as itself", async () => {
    const { svc } = build({ detect: new RecogniserError("connection refused", "unreachable") });
    await send(svc, { type: "add-face-from-image", personId: "p1", jpegBase64: base64() });
    expect(result()?.ok).toBe(false);
  });

  it("refuses when the crop fails rather than storing the whole picture", async () => {
    // The rule the crop exists for: a whole photograph must never be stored as
    // one person's face.
    mocks.crop.value = null;
    const { svc, added } = build();
    await send(svc, { type: "add-face-from-image", personId: "p1", jpegBase64: base64() });

    expect(result()?.error).toContain("could not crop");
    expect(added).toHaveLength(0);
  });

  it("answers when the person has gone", async () => {
    const { svc } = build({ added: false });
    await send(svc, { type: "add-face-from-image", personId: "gone", jpegBase64: base64() });
    expect(result()?.error).toContain("no longer on the roster");
  });

  it("always answers, even when something unexpected throws", async () => {
    // Without the catch at the handler the client sits on a spinner and the
    // only trace is a line in the server log — the defect the camera enrolment
    // path already records.
    const { svc } = build({ detect: new Error("something unforeseen") });
    await send(svc, { type: "add-face-from-image", personId: "p1", jpegBase64: base64() });
    expect(result()?.ok).toBe(false);
  });
});
