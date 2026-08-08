import crypto from "node:crypto";
import type {
  ClientMessage,
  IdentityMatch,
  NarrationEntry,
  ServerMessage,
  VisionObservation,
  VisionSettings,
  VisionState,
} from "../../../shared/src/types.js";
import type { WebSocket } from "ws";
import {
  DEFAULT_VISION_CAPTION_PROMPT,
  DEFAULT_VISION_PROMPT,
  VISION_SILENCE_TOKEN,
  enforceIdentityBands,
  formatIdentity,
  identityBand,
  isBlankPrompt,
  knownPeopleSection,
  resolvePrompt,
  visionSensitivityInstruction,
  type IdentityBand,
  type RosterBand,
} from "../../../shared/src/prompts.js";
import { AppearanceTracker, type Appearance } from "./appearances.js";
import { HttpRecogniser, RecogniserError, type DetectedFace, type Recogniser } from "./recogniser.js";
import type { Gallery } from "./people.js";
import type { CandidateQueue } from "./candidates.js";
import { cropFace } from "./thumbnail.js";
import { ProviderError, type ProviderFactory } from "../providers/provider.js";
import type { ProviderQueue } from "../providers/queue.js";
import type { SettingsStore } from "../storage/settings.js";
import { NARRATION_NUM_CTX } from "../narration/coalescer.js";
import { CaptureError, listDevices } from "./capture.js";
import { CaptionerError, HttpCaptioner, type Captioner } from "./captioner.js";
import { CameraStream, type CameraFeed } from "./stream.js";
import type { FrameStore } from "./frames.js";

// Structural hub interface so tests can fake it; WsHub satisfies this.
export interface VisionHub {
  broadcast(msg: ServerMessage): void;
  onMessage(handler: (msg: ClientMessage, client: WebSocket) => void): void;
  onConnection(greet: (client: WebSocket) => void): void;
  sendTo(client: WebSocket, msg: ServerMessage): void;
}

// Where Vision's entries land. NarrationService satisfies this — Vision shares
// the feed with the other two roles rather than owning a third one.
export interface VisionSink {
  record(entry: NarrationEntry): void;
}

// How often the loop reconciles itself with settings and checks deadlines.
// Deriving both schedules from the current settings on every tick is what makes
// an interval or sensitivity change take effect immediately, with no respawn.
const TICK_MS = 2_000;

// Ceiling on observations held for one cycle. A cycle is minutes and a capture
// is a caption, so this is only ever reached by a pathological interval — but
// an unbounded buffer would feed an unbounded prompt.
const BUFFER_CAP = 60;

// How many consecutive detections may be skipped for a still-in-flight
// predecessor before the recogniser is reported as unable to keep up.
//
// R8 wants too-slow surfaced as its own condition, distinct from unreachable,
// because the two send a user looking in completely different places. One skip
// is a hiccup; a run of them means the configured cadence is not achievable.
const SLOW_AFTER_SKIPS = 3;

// The largest picture accepted for enrolment, after the client's transcode.
//
// Below the recogniser's own 16MB body cap with room to spare, because base64
// inflates by a third on the way across and the far side's refusal is a socket
// condition rather than something with user-facing wording. The client states
// this limit before sending; this is the backstop for a client that does not.
const MAX_ENROL_IMAGE_BYTES = 8 * 1024 * 1024;

function isAborted(err: unknown): boolean {
  return err instanceof ProviderError && err.code === "aborted";
}

/**
 * The third observation role.
 *
 * Captures on an interval, describes each frame with the captioner, and once a
 * cycle asks the HAL model to remark on what accumulated — or to stay silent.
 * A camera always produces something, so unlike a Monitor there is no
 * structural silence to inherit: what counts as "nothing worth saying" is a
 * user-set sensitivity handed to the summariser.
 */
export class VisionService {
  private tickTimer: NodeJS.Timeout | null = null;
  private buffer: VisionObservation[] = [];
  private cycleStartedAt: number | null = null;
  private lastCaptureAt = 0;
  private capturing = false;
  private narrating = false;
  private state: VisionState = "off";
  private detail: string | undefined;
  private lastFrame: { at: string; dataUrl: string } | null = null;
  // Bumped whenever Vision is torn down, so a capture that is mid-await can
  // detect that it no longer speaks for the current state.
  private generation = 0;
  private captionerFor: { endpoint: string; captioner: Captioner } | null = null;

  // Recognition. All of it inert while `recognitionEnabled` is off, and inert
  // while Vision itself is off regardless — recognition never causes camera
  // access on its own (R1).
  private recogniserFor: { endpoint: string; recogniser: Recogniser } | null = null;
  private readonly tracker = new AppearanceTracker();
  private lastDetectAt = 0;
  private detecting = false;
  private consecutiveSkips = 0;
  // Set while the recogniser is faulted, so the fault is published once rather
  // than on every tick, and cleared on recovery without needing a restart.
  private recogniserFault: "no-recogniser" | "recogniser-slow" | null = null;
  private recogniserFaultDetail: string | undefined;
  // Appearances already offered to the triage queue, so one visit is offered
  // once rather than every few seconds for as long as someone stands there.
  private queued = new Set<string>();

  constructor(
    private readonly hub: VisionHub,
    private readonly settings: SettingsStore,
    private readonly frames: FrameStore,
    private readonly sink: VisionSink,
    private readonly queue: ProviderQueue,
    private readonly providerFactory: ProviderFactory,
    private readonly people: Gallery,
    private readonly candidates: CandidateQueue,
    private readonly makeCaptioner: (endpoint: string) => Captioner = (endpoint) => new HttpCaptioner(endpoint),
    private readonly makeRecogniser: (endpoint: string) => Recogniser = (endpoint) => new HttpRecogniser(endpoint),
    // One camera holder for the whole feature: the live preview and the
    // interval capture read the same stream, because the device cannot be
    // opened twice.
    private readonly camera: CameraFeed = new CameraStream(),
    private readonly now: () => number = () => Date.now(),
  ) {
    hub.onMessage((msg) => {
      this.handle(msg).catch((err: unknown) => {
        console.error(`vision handler error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    hub.onConnection((client) => {
      hub.sendTo(client, { type: "vision-status", state: this.state, ...(this.detail ? { detail: this.detail } : {}) });
      if (this.lastFrame) hub.sendTo(client, { type: "vision-frame", ...this.lastFrame });
      // The roster is greeted like adapters and monitors, so a reconnecting
      // client is not blank until the next change.
      this.broadcastPeople().catch((err: unknown) => {
        console.error(`vision people greet error: ${err instanceof Error ? err.message : String(err)}`);
      });
      // Who is in view right now. People and candidates were both greeted; this
      // was not, so a client joining mid-visit — an agent especially — saw
      // nobody until the next open or close event, which may be minutes away or
      // may never come if the visitor leaves first.
      this.broadcastAppearances();
      this.broadcastCandidates().catch((err: unknown) => {
        console.error(`vision candidates greet error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  }

  start(): void {
    this.tickTimer ??= setInterval(() => {
      void this.tick().catch((err: unknown) => {
        console.error(`vision tick error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, TICK_MS);
    this.tickTimer.unref?.();
    this.publish(this.config().enabled ? "idle" : "off");
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.camera.stop();
  }

  /**
   * The live camera, or null when nothing should be watchable.
   *
   * Null while Vision is off is the consent rule holding at the HTTP edge as
   * well as in the loop (R15): a preview is camera access, so there is nothing
   * to preview until the user switches Vision on.
   */
  cameraSource(): CameraFeed | null {
    const cfg = this.config();
    if (!cfg.enabled) return null;
    // Start on demand rather than waiting for the next tick. The pane requests
    // the stream the instant Vision is enabled, and a tick can be two seconds
    // away — an <img> that receives the 503 in that window never retries, so
    // the preview stayed blank until the user toggled Vision off and on again.
    // Consent is already established by `enabled`, so R15 still holds.
    this.camera.start(cfg.device);
    return this.camera;
  }

  private config(): VisionSettings {
    return this.settings.get().vision;
  }

  // One tick decides everything from the settings as they are right now, so a
  // changed interval, cycle, or sensitivity applies without a restart.
  private async tick(): Promise<void> {
    const cfg = this.config();
    if (!cfg.enabled) {
      if (this.state !== "off") await this.reset();
      return;
    }
    if (this.state === "off") this.publishIdle();

    // Idempotent, and re-targets if the device setting changed. Holding the
    // camera for as long as Vision is on is what lets the preview and the
    // capture share one exclusive device.
    this.camera.start(cfg.device);

    // Detection runs on its own interval (R30), off the same reconcile tick so
    // a changed interval applies with no respawn — and so the tick is the
    // practical floor on how often it can run, which the brief already names.
    // Deliberately before the capture branch: a capture is a long await, and
    // detection is milliseconds.
    if (cfg.recognitionEnabled) {
      if (this.now() - this.lastDetectAt >= cfg.detectionIntervalSeconds * 1_000) {
        if (this.detecting) {
          // Skipped, never queued (R8). A queue here turns a slow recogniser
          // into a growing backlog of frames describing moments already past.
          this.consecutiveSkips += 1;
          if (this.consecutiveSkips >= SLOW_AFTER_SKIPS) this.reportRecogniserFault("recogniser-slow", cfg);
        } else {
          void this.detectOnce(cfg);
        }
      }
    } else {
      // Recognition switched off mid-session. Unconditional, and it clears the
      // fault too: `clearRecogniserFault` is otherwise reachable only from a
      // SUCCESSFUL detection, which can never happen again once recognition is
      // off — so a fault standing at the moment it was switched off left
      // `publishIdle` substituting "no-recogniser" forever, for a feature
      // nobody is running.
      this.consecutiveSkips = 0;
      this.clearRecogniserFault();
      if (this.tracker.open().length > 0) {
        // Drop the in-flight face data rather than holding it (R5).
        this.tracker.reset();
        this.queued.clear();
        this.broadcastAppearances();
      }
    }

    if (!this.capturing && this.now() - this.lastCaptureAt >= cfg.intervalSeconds * 1_000) {
      await this.captureOnce(cfg);
    }

    const due = this.cycleStartedAt !== null && this.now() - this.cycleStartedAt >= cfg.cycleSeconds * 1_000;
    if (due && this.buffer.length > 0 && !this.narrating) {
      await this.summarise(cfg);
    }
  }

  // Turning Vision off stops the loop, drops buffered observations so nothing
  // surfaces afterwards, and purges the retained frames (R14).
  private async reset(): Promise<void> {
    // Invalidates any capture already in flight before anything is torn down.
    this.generation += 1;
    this.buffer = [];
    this.cycleStartedAt = null;
    this.lastCaptureAt = 0;
    this.lastFrame = null;
    // Face data held for in-flight appearances goes with everything else (R5).
    // The gallery does not: biometric data outlives the Vision toggle, which is
    // the narrowing the brief makes to the webcam brief's R14.
    this.tracker.reset();
    this.lastDetectAt = 0;
    this.consecutiveSkips = 0;
    this.recogniserFault = null;
    this.broadcastAppearances();
    // Releases the device as well as the frames — switching Vision off must
    // give the camera back to whatever else wants it.
    this.camera.stop();
    await this.frames.clear();
    this.publish("off");
  }

  private captioner(endpoint: string): Captioner {
    if (this.captionerFor?.endpoint !== endpoint) {
      this.captionerFor = { endpoint, captioner: this.makeCaptioner(endpoint) };
    }
    return this.captionerFor.captioner;
  }

  private recogniser(endpoint: string): Recogniser {
    if (this.recogniserFor?.endpoint !== endpoint) {
      this.recogniserFor = { endpoint, recogniser: this.makeRecogniser(endpoint) };
      // A different recogniser is a different opinion about who is in frame.
      // Carrying appearances across the change would attribute one process's
      // identity decision to another's.
      this.tracker.reset();
    }
    return this.recogniserFor.recogniser;
  }

  /**
   * One detection pass.
   *
   * The frame comes from the camera buffer rather than `grabWhenReady()`:
   * detection must never block on the device the capture loop also wants, and
   * a detection that waited eight seconds would be describing a moment that
   * has passed. No frame yet simply means nothing to detect.
   *
   * Recognition runs only on frames where detection found a face (R3) — the
   * recogniser embeds only what it detected, so the gate is structural rather
   * than a check here.
   */
  private async detectOnce(cfg: VisionSettings): Promise<void> {
    this.detecting = true;
    // Stamped before the attempt, so an unreachable recogniser retries on its
    // interval rather than on every tick.
    this.lastDetectAt = this.now();
    const generation = this.generation;
    // Deferred until the single-flight window closes. Thumbnailing a face
    // spawns ffmpeg, which is far slower than the ~7.5ms detection itself —
    // doing it under the lock made every subsequent detection skip, and the
    // skip counter then reported "the recogniser cannot keep up" about a
    // recogniser that was answering in milliseconds. Measured: one call across
    // six due intervals, blamed on the wrong process.
    let pending: { jpeg: Buffer; faces: DetectedFace[] } | null = null;

    try {
      const jpeg = this.camera.grab();
      if (!jpeg) return;

      const result = await this.recogniser(cfg.recogniserEndpoint).detect(jpeg);
      // Vision may have been switched off across that await. Feeding the
      // tracker now would repopulate state its own teardown just cleared.
      if (this.generation !== generation) return;

      await this.tracker.observe(result.faces, this.now(), (embedding) =>
        this.people.match(embedding, cfg.confidenceThreshold),
      );
      if (this.generation !== generation) return;

      this.consecutiveSkips = 0;
      this.clearRecogniserFault();
      this.broadcastAppearances();
      pending = { jpeg, faces: result.faces };
    } catch (err) {
      if (this.generation !== generation) return;
      // A fault here is HAL's own condition, not an observation about the
      // developer: published as status, never narrated (R7). Capture,
      // captioning and the cycle summary carry on untouched — an absent
      // recogniser degrades Vision rather than disabling it.
      if (err instanceof RecogniserError) {
        this.reportRecogniserFault(err.kind === "slow" ? "recogniser-slow" : "no-recogniser", cfg, err.message);
      } else {
        console.error(`vision detect error: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      this.detecting = false;
    }

    // Outside the lock. The next detection may start while this runs, which is
    // fine: `queued` is marked before the first await, so an appearance is
    // offered once regardless of overlap.
    if (pending && this.generation === generation) {
      await this.queueUnrecognised(pending.jpeg, pending.faces, cfg).catch((err: unknown) => {
        console.error(`vision candidate queue error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  // A recogniser fault is a standing condition, not a moment. Detection runs
  // alongside the capture loop, so an error usually arrives while the state
  // reads "capturing" or "captioning" — describing work that really is still
  // happening and must not be overwritten. Publishing only in that instant
  // meant the fault could be recorded and never seen, which is exactly what R7
  // asks for and AE5 checks.
  //
  // So the fault is held, and it is what "idle" means for as long as it lasts.
  private reportRecogniserFault(state: "no-recogniser" | "recogniser-slow", cfg: VisionSettings, detail?: string): void {
    if (this.recogniserFault === state) return;
    this.recogniserFault = state;
    this.recogniserFaultDetail =
      detail ??
      (state === "recogniser-slow"
        ? `The recogniser cannot keep up with a ${cfg.detectionIntervalSeconds}s detection interval.`
        : "The recogniser is not reachable.");
    // Surface immediately when nothing else is in progress; otherwise the next
    // return to idle carries it.
    if (this.isRestingState()) this.publishIdle();
  }

  private clearRecogniserFault(): void {
    if (!this.recogniserFault) return;
    this.recogniserFault = null;
    this.recogniserFaultDetail = undefined;
    if (this.isRestingState()) this.publishIdle();
  }

  private isRestingState(): boolean {
    return this.state === "idle" || this.state === "no-recogniser" || this.state === "recogniser-slow";
  }

  // "Idle" with a standing recogniser fault is not idle. Every path that would
  // have announced idleness goes through here so the fault cannot be lost to a
  // capture finishing after it.
  private publishIdle(): void {
    if (this.recogniserFault) {
      this.publish(this.recogniserFault, this.recogniserFaultDetail);
      return;
    }
    this.publish("idle");
  }

  private broadcastAppearances(): void {
    this.hub.broadcast({
      type: "vision-appearances",
      appearances: this.tracker.open().map((a) => ({
        id: a.id,
        match: a.match ? { personId: a.match.personId, name: a.match.name, confidence: a.match.confidence } : null,
        embedded: a.embedded,
      })),
    });
  }

  private async broadcastPeople(): Promise<void> {
    this.hub.broadcast({ type: "vision-people", people: await this.people.list() });
  }

  private async broadcastCandidates(): Promise<void> {
    this.hub.broadcast({
      type: "vision-candidates",
      candidates: await this.candidates.list(),
      overflow: this.candidates.overflow(),
    });
  }

  /**
   * Keep the faces HAL did not recognise, so they can be named later.
   *
   * Only for a face that is BOTH unrecognised and freshly seen: an appearance
   * already open was queued when it opened, and re-queueing it every few
   * seconds is the flood the brief warns about. The store deduplicates too, so
   * a visit that fragments into several appearances still produces one item.
   */
  private async queueUnrecognised(jpeg: Buffer, faces: DetectedFace[], cfg: VisionSettings): Promise<void> {
    if (cfg.candidateFaces <= 0) return;

    let added = false;
    for (const appearance of this.tracker.open()) {
      if (this.queued.has(appearance.id)) continue;

      // Which appearances are worth keeping a face for.
      //
      // Unrecognised, always: that is what the queue was built for. Recognised
      // but only in the hedged band, when the user has asked for it: an
      // uncertain match is exactly the pose or lighting the gallery covers
      // badly, so confirming it is what makes the next match better.
      //
      // A stated match is never queued. HAL is already confident, and a face it
      // is confident about adds nothing but disk.
      const match = appearance.match;
      const suspected = match
        ? identityBand(match.confidence, cfg.confidenceThreshold, cfg.statementThreshold) === "hedged" &&
          cfg.queueUncertainMatches
          ? { personId: match.personId, name: match.name, confidence: match.confidence }
          : null
        : null;
      if (match && !suspected) continue;

      // Matched by reference, not by float equality on coordinates. The tracker
      // assigns `appearance.box = face.box`, so the identity is real — comparing
      // x and y re-derived it by coincidence and would have paired the wrong
      // embedding for two faces that happened to share a rounded position.
      const face = faces.find((f) => f.box === appearance.box);
      // An appearance open but absent from THIS pass (a missed detection inside
      // the gap) is not a failure — it simply has no face here. Skipping without
      // marking leaves it eligible next pass.
      if (!face?.embedding) continue;

      // Marked only once the work is about to happen, and unmarked if it fails.
      // Marking up front meant a single crop or disk hiccup burned the id
      // permanently: that visitor was never offered for naming again, for the
      // rest of their visit, with nothing reported.
      this.queued.add(appearance.id);
      try {
        const thumbnail = await cropFace(jpeg, face.box);
        if (!thumbnail) {
          // No crop, no candidate. The old `?? jpeg` fallback stored the WHOLE
          // FRAME — the entire room, everyone in it — as this person's face,
          // silently, in the one store the brief says holds biometric data only
          // for people the user deliberately named. Better to queue nothing and
          // let the next detection try again.
          this.queued.delete(appearance.id);
          console.error("vision: could not crop a face; not queueing it (is ffmpeg available?)");
          continue;
        }
        if (await this.candidates.offer(face.embedding, thumbnail, cfg.candidateFaces, suspected ?? undefined)) {
          added = true;
        }
      } catch (err) {
        this.queued.delete(appearance.id);
        console.error(`vision: could not queue a face: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Bounded alongside the appearances it tracks, so a long session does not
    // accumulate ids for visits that ended hours ago.
    if (this.queued.size > 200) this.queued = new Set([...this.queued].slice(-100));
    if (added) await this.broadcastCandidates();
  }

  // The identities currently in frame, as the observation should carry them.
  //
  // `identity` holds the SHIPPED HEDGED FORM and never a bare name (R23) — the
  // hedge is applied here, once, on the way in, rather than asked for in a
  // prompt rule that this project has measured losing three times.
  private identityFor(appearances: Appearance[]): Pick<VisionObservation, "identity" | "identityMatch"> {
    // One entry per PERSON, not per appearance. Nobody is in the room twice, so
    // two appearances resolving to the same person is either a transient
    // double-detection or continuity having split a visit — and in both cases
    // naming them once is the truth. Without this the caption line read
    // "someone who looks like SW and someone who looks like SW and…", which is
    // the flicker arriving by another route.
    const best = new Map<string, IdentityMatch>();
    for (const appearance of appearances) {
      const match = appearance.match;
      if (!match) continue;
      const existing = best.get(match.personId);
      if (!existing || match.confidence > existing.confidence) {
        best.set(match.personId, { personId: match.personId, name: match.name, confidence: match.confidence });
      }
    }
    const matches = [...best.values()];

    if (matches.length === 0) return { identity: null };
    const cfg = this.config();
    return {
      identity: matches
        .map((m) => formatIdentity(m.name, m.confidence, identityBand(m.confidence, cfg.confidenceThreshold, cfg.statementThreshold)))
        .join(" and "),
      identityMatch: matches,
    };
  }

  /**
   * The band each person is in for a whole cycle, taking the lowest observed.
   *
   * A cycle spans many observations and a person's score drifts across them, so
   * the same face can land either side of the statement threshold within one
   * summary. Rendering each observation on its own would hand the model both
   * forms for one person and let a single good frame license the flat assertion
   * — R5 takes the least confident reading instead, which is the only direction
   * that cannot manufacture certainty the cycle did not have.
   *
   * Reduced with an explicit finite filter rather than `Math.min`, which
   * propagates `NaN`: one non-finite score would otherwise decide the band for
   * every appearance of that person in the cycle.
   */
  /**
   * Add a face to an existing person from a picture (R13, R14).
   *
   * Deliberately independent of the camera. `CameraStream` lives and dies with
   * Vision being on, and an exclusive device has one owner — so this path talks
   * to the recogniser directly and works with Vision switched off, which is
   * what R16 asks of roster editing generally.
   *
   * The client has already transcoded to JPEG and applied EXIF rotation. Doing
   * it there rather than here means the same bytes reach both detection and the
   * crop: the box the recogniser returns is in the coordinates of the buffer it
   * detected on, so re-encoding between the two would shift the crop off the
   * face.
   */
  private async addFaceFromImage(personId: string, jpegBase64: string): Promise<void> {
    const cfg = this.config();
    const fail = (error: string): void => {
      this.hub.broadcast({ type: "vision-roster-result", action: "add-face", ok: false, personId, error });
    };

    const jpeg = Buffer.from(jpegBase64, "base64");
    // Base64 decoding is lenient — garbage produces a short buffer rather than
    // an error — so the check is on what came out, not on what went in.
    if (jpeg.length < 4) return fail("That file did not arrive as an image I can read.");
    if (jpeg.length > MAX_ENROL_IMAGE_BYTES) {
      return fail(`That image is too large. Pictures up to ${Math.floor(MAX_ENROL_IMAGE_BYTES / 1_000_000)}MB work.`);
    }

    let faces;
    try {
      faces = (await this.recogniser(cfg.recogniserEndpoint).detect(jpeg)).faces;
    } catch (err) {
      // "busy" is the recogniser's single-flight lane, which the live detection
      // loop also uses. A deliberate action losing a race to a background one
      // should say to try again, not report the recogniser as broken.
      if (err instanceof RecogniserError && err.kind === "slow") {
        return fail("The recogniser is busy with the camera. Try that again in a moment.");
      }
      return fail(err instanceof RecogniserError ? err.message : "The recogniser could not be reached.");
    }

    // Three distinct causes, three distinct messages. The camera path's wording
    // is all about looking at the lens, which is unhelpful advice about a file.
    if (faces.length === 0) {
      return fail(
        "I could not find a face in that picture. A photo where the face is large and upright works best — a small face in a wide shot is often missed.",
      );
    }
    if (faces.length > 1) {
      return fail(`That picture has ${faces.length} faces in it. Use one with only the person you are adding.`);
    }

    const face = faces[0]!;
    if (!face.embedding) {
      return fail("I can see a face in that picture but cannot describe it yet. Check the recogniser's readiness.");
    }

    const thumbnail = await cropFace(jpeg, face.box);
    if (!thumbnail) return fail("I could not crop that face out of the picture.");

    // The source picture is never written. Only the crop is kept — the same
    // rule that stops a whole camera frame being stored as one person's face.
    if (!(await this.people.addFace(personId, face.embedding, thumbnail))) {
      return fail("That person is no longer on the roster.");
    }

    // So the new face counts on the next detection rather than the next
    // appearance, matching what both camera enrolment paths do.
    this.tracker.reset();
    this.broadcastAppearances();
    await this.broadcastPeople();
    this.hub.broadcast({ type: "vision-roster-result", action: "add-face", ok: true, personId });
  }

  /**
   * Every enrolled person, banded by whatever this cycle saw of them.
   *
   * The roster read is what makes R7's whole-roster rule possible, and it is
   * done once per cycle rather than per entry. A gallery that cannot be read
   * degrades to the cycle's own matches rather than skipping enforcement — a
   * failed disk read must not be the reason a bare name ships.
   */
  private async rosterBands(batch: VisionObservation[]): Promise<RosterBand[]> {
    const seen = this.cycleBands(batch);
    const roster = await this.people.list().catch((err: unknown) => {
      console.error(`vision: roster unreadable for the output check: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    });

    const bands: RosterBand[] = roster.map((person) => {
      const live = seen.get(person.id);
      return live
        ? { name: live.name, confidence: live.confidence, band: live.band }
        : // No reading this cycle: hedged, and no number to report.
          { name: person.name, confidence: null, band: "hedged" as const };
    });

    // Anyone matched this cycle but absent from the roster read — a deletion
    // mid-cycle, or a gallery that failed to load — still gets their band.
    const known = new Set(roster.map((p) => p.name));
    for (const live of seen.values()) {
      if (!known.has(live.name)) bands.push({ name: live.name, confidence: live.confidence, band: live.band });
    }
    return bands;
  }

  private cycleBands(batch: VisionObservation[]): Map<string, { name: string; confidence: number; band: IdentityBand }> {
    const cfg = this.config();
    const lowest = new Map<string, { name: string; confidence: number; band: IdentityBand }>();
    for (const observation of batch) {
      for (const match of observation.identityMatch ?? []) {
        if (!Number.isFinite(match.confidence)) continue;
        const seen = lowest.get(match.personId);
        if (seen && seen.confidence <= match.confidence) continue;
        lowest.set(match.personId, {
          name: match.name,
          confidence: match.confidence,
          band: identityBand(match.confidence, cfg.confidenceThreshold, cfg.statementThreshold),
        });
      }
    }
    return lowest;
  }

  private async captureOnce(cfg: VisionSettings): Promise<void> {
    this.capturing = true;
    // Stamped before the attempt, so a camera that is busy for an hour retries
    // on its interval rather than on every tick.
    this.lastCaptureAt = this.now();
    // A capture spans two long awaits — a frame grab and a caption — during
    // which the user can switch Vision off. reset() bumps this, so the resumed
    // capture can tell that the world it started in is gone and stop before it
    // writes a picture into a directory that was just purged.
    const generation = this.generation;
    const superseded = () => this.generation !== generation;
    try {
      this.publish("capturing");
      // A buffer read, not a process spawn: the stream already holds the
      // camera, so a capture is whatever frame is current.
      this.camera.start(cfg.device);
      const jpeg = await this.camera.grabWhenReady();
      if (superseded()) return;
      const at = new Date();
      // Sampled HERE, beside the frame, not after the caption.
      //
      // Captioning takes tens of seconds. Reading the tracker afterwards meant
      // the observation carried whoever was in view when the captioner ANSWERED
      // — so a frame of an empty room could be labelled with someone who walked
      // in thirty seconds later. That is the fabricated-event defect
      // `docs/residual-review-findings/feat-vision.md` records against the
      // captioner, reproduced against a person's name.
      const identity = this.identityFor(cfg.recognitionEnabled ? this.tracker.open() : []);

      this.lastFrame = { at: at.toISOString(), dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}` };
      this.hub.broadcast({ type: "vision-frame", ...this.lastFrame });
      const frame = await this.frames.save(jpeg, at, cfg.retainFrames).catch((err: unknown) => {
        // Reported rather than swallowed: a full or unwritable disk silently
        // disables retention, and the only symptom would be an empty folder.
        console.error(`vision frame save failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });

      this.publish("captioning");
      const prompt = resolvePrompt(cfg.captionPrompt, DEFAULT_VISION_CAPTION_PROMPT);
      // The retained frame travels with the request so the inference log can
      // name the picture a caption describes without holding the image itself.
      const caption = await this.captioner(cfg.captionerEndpoint).caption(jpeg, prompt, undefined, { frame });
      if (superseded()) return;

      // The seam the webcam brief reserved (its R21), now with a producer.
      // Identity comes from the appearances open at this moment — the
      // detection loop turns over far faster than the capture interval, so
      // this reads the current decision rather than making one.
      const observation: VisionObservation = {
        at: at.toISOString(),
        caption,
        ...identity,
      };
      this.buffer.push(observation);
      if (this.buffer.length > BUFFER_CAP) this.buffer = this.buffer.slice(-BUFFER_CAP);
      this.cycleStartedAt ??= this.now();

      this.hub.broadcast({ type: "vision-observation", observation });
      this.publishIdle();
    } catch (err) {
      // A fault here is HAL's own condition, not an observation about the
      // developer: it is published as status and never narrated (R17).
      if (err instanceof CaptureError) {
        this.publish(err.kind === "no-camera" ? "no-camera" : "error", err.message);
      } else if (err instanceof CaptionerError) {
        this.publish(err.kind === "unreachable" ? "no-captioner" : "error", err.message);
      } else {
        this.publish("error", err instanceof Error ? err.message : String(err));
      }
    } finally {
      this.capturing = false;
      // A capture that outlived its generation must not repaint the state its
      // own shutdown set, or Vision reports itself as watching after it stopped.
      if (superseded() && this.state !== "off") this.publish("off");
    }
  }

  private async summarise(cfg: VisionSettings): Promise<void> {
    const batch = this.buffer;
    this.buffer = [];
    this.cycleStartedAt = null;
    this.narrating = true;
    this.publish("narrating");
    try {
      const text = await this.narrate(cfg, batch);
      // The second half of the guarantee: a model can flatten a hedge it was
      // given, so what it produced is checked as well as what it received.
      //
      // Against the WHOLE roster, not the names matched this cycle (R7). Names
      // used to come from the batch on the reasoning that only someone
      // recognised could have been named — which stops being true once a
      // profile puts a name in the model's standing context. Anyone with no
      // live reading is hedged and carries no percentage, because there is no
      // confidence to report about a person HAL did not see.
      const trimmed = enforceIdentityBands(text, await this.rosterBands(batch)).trim();
      // Silence is a real outcome, and it leaves no trace: no placeholder, no
      // all-clear (R8).
      if (trimmed && !trimmed.startsWith(VISION_SILENCE_TOKEN)) {
        this.sink.record({
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          kind: "narration",
          text: trimmed,
          adapterId: null,
          monitorId: null,
          fromVision: true,
        });
      }
      this.publishIdle();
    } catch (err) {
      if (isAborted(err)) {
        // Chat preempted this cycle. An abort is scheduling, not failure, so
        // the observations go back and are summarised on the next tick.
        this.buffer = [...batch, ...this.buffer].slice(-BUFFER_CAP);
        this.cycleStartedAt = 0;
        this.publishIdle();
      } else {
        this.publish("error", err instanceof Error ? err.message : String(err));
      }
    } finally {
      this.narrating = false;
    }
  }

  private async narrate(cfg: VisionSettings, batch: VisionObservation[]): Promise<string> {
    const s = this.settings.get();
    const model = s.narrationModel ?? s.chatModel;
    if (!model) throw new Error("no narration model is selected");

    const prompt = resolvePrompt(cfg.prompt, DEFAULT_VISION_PROMPT);
    // Bare lines in order — no timestamps, no ordinals. Both were tried and both
    // became the subject: stamped times were quoted back as though the clock
    // were the event, and numbers turned the summary into "Frame 1 showed…,
    // Frame 2 repeated…". Anything given a label invites being referred to by
    // it, and a prompt rule against that loses to the label itself.
    // See docs/solutions/an-instruction-that-fights-its-own-input-loses.md.
    //
    // The identity prefix is rebuilt here rather than reusing the string
    // stamped on each observation, because the band is a property of the whole
    // cycle (R5) and each observation only knows its own moment.
    const bands = this.cycleBands(batch);

    // Profiles are unlocked by the stated band only (R21). A hedged match gives
    // its name and its number and no biography — handing HAL someone's history
    // on the strength of a maybe is how a marginal match becomes a confident
    // story about the wrong person.
    const stated = [...bands.values()].filter((b) => b.band === "stated");
    const roster = await this.people.list().catch(() => []);
    const described = roster
      .filter((person) => person.profile && (person.isOperator || stated.some((s) => s.name === person.name)))
      .map((person) => ({ name: person.name, profile: person.profile ?? "", isOperator: person.isOperator }));
    const known = knownPeopleSection(described);
    const lines = batch
      .map((o) => {
        const named = (o.identityMatch ?? [])
          .map((m) => bands.get(m.personId))
          .filter((b): b is NonNullable<typeof b> => Boolean(b))
          .map((b) => formatIdentity(b.name, b.confidence, b.band));
        // Deduped: one person can hold two appearances in a single observation
        // when continuity has split a visit, and "Dave 71% and Dave 71%" is the
        // flicker arriving by another route.
        const unique = [...new Set(named)];
        return `${unique.length ? `[${unique.join(" and ")}] ` : ""}${o.caption}`;
      })
      .join("\n");
    const framing = `${visionSensitivityInstruction(cfg.sensitivity)}\n\nFrames from the last period:`;

    // Enqueued as narration: chat still preempts, and the single-lane contract
    // is unchanged. Only this half touches Ollama — the captioner never does.
    return this.queue.enqueue("narration", async (signal) => {
      const provider = this.providerFactory(s.providerEndpoint);
      let out = "";
      const stream = provider.chatStream({
        model,
        messages: [
          // The profile section is independent of the prompt being blank.
          //
          // A blank prompt means "say nothing of your own about how to narrate"
          // — it does not mean "forget who these people are". Gating the
          // section on `isBlankPrompt` would make blanking the prompt silently
          // delete standing knowledge, which is not what blanking it says.
          ...(isBlankPrompt(prompt) && !known
            ? []
            : [{ role: "system" as const, content: [prompt, known].filter((part) => part.trim()).join("\n\n") }]),
          { role: "user" as const, content: `${framing}\n${lines}` },
        ],
        signal,
        options: { num_ctx: NARRATION_NUM_CTX },
        source: { kind: "vision", id: null, label: "vision" },
        // The profile text is named so the inference log withholds it (R40).
        // The log keeps every prompt verbatim and is never pruned, so without
        // this a profile would outlive deleting the person it describes — and
        // R33's promise would be false the moment it was written.
        ...(described.length ? { redact: described.map((p) => p.profile) } : {}),
      });
      for await (const token of stream) out += token;
      return out;
    });
  }

  private publish(state: VisionState, detail?: string): void {
    if (this.state === state && this.detail === detail) return;
    this.state = state;
    this.detail = detail;
    this.hub.broadcast({ type: "vision-status", state, ...(detail ? { detail } : {}) });
  }

  private async handle(msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "vision-capture-now": {
        const cfg = this.config();
        // Requires Vision to be on. This once ignored `enabled`, on the
        // argument that asking to look is consent in itself — but the request
        // arrives over the protocol, so any client can send it, and R15 says no
        // device is touched until the user enables Vision. A camera opening
        // while the toggle reads off is exactly what that rule forbids.
        if (!cfg.enabled) {
          this.publish("off", "I am not watching. Start me before asking me to look.");
          return;
        }
        if (this.capturing) return;
        await this.captureOnce(cfg);
        if (this.buffer.length > 0 && !this.narrating) await this.summarise(cfg);
        return;
      }
      case "list-vision-devices": {
        try {
          this.hub.broadcast({ type: "vision-devices", devices: await listDevices() });
        } catch (err) {
          this.hub.broadcast({
            type: "vision-devices",
            devices: [],
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case "clear-vision-frames":
        await this.frames.clear();
        this.lastFrame = null;
        return;
      case "list-people":
        await this.broadcastPeople();
        return;
      case "enrol-person":
        // Every path out of `enrol` must answer, including the unexpected one.
        // Without this the client sits on a spinner while the only trace is a
        // line in the server log.
        await this.enrol(msg.name, msg.candidateId).catch((err: unknown) => {
          this.hub.broadcast({
            type: "vision-enrol-result",
            ok: false,
            error: `Enrolment failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        });
        return;
      case "list-candidates":
        await this.broadcastCandidates();
        return;
      case "dismiss-candidate":
        // Deletes the item and its crop, and records nothing about the face.
        // The same person appearing tomorrow is queued again — that is the
        // cost the brief accepts for not keeping a gallery of people who never
        // agreed to be kept.
        if (await this.candidates.dismiss(msg.id)) await this.broadcastCandidates();
        return;
      case "delete-person": {
        // R27. Every face held for them goes with them, and the roster is
        // rebroadcast so no client keeps showing someone who is gone.
        if (await this.people.remove(msg.id)) {
          // An open appearance may still carry the deleted identity. Dropping
          // the tracker forces the next detection to decide again, so a purged
          // person's very next appearance is unrecognised rather than trading
          // on a decision made before they were deleted.
          this.tracker.reset();
          this.broadcastAppearances();
          await this.broadcastPeople();
        }
        return;
      }
      case "rename-person": {
        const result = await this.people.rename(msg.id, msg.name);
        this.hub.broadcast({
          type: "vision-roster-result",
          action: "rename",
          ok: result.ok,
          ...(result.ok
            ? {
                personId: result.personId,
                // A merge is not literally what was asked for, so it says so
                // rather than leaving the user to notice a record vanish.
                ...(result.merged
                  ? { note: `Merged ${result.mergedFrom} into ${msg.name.trim()} — ${result.faceCount} faces now.` }
                  : {}),
              }
            : { error: result.reason }),
        });
        if (result.ok) {
          // A merge drops an id that open appearances and buffered observations
          // may still carry, so the next detection decides against the roster
          // that exists now — the same reason delete-person resets.
          this.tracker.reset();
          this.broadcastAppearances();
          await this.broadcastPeople();
        }
        return;
      }
      case "remove-face": {
        const result = await this.people.removeFace(msg.personId, msg.faceId);
        this.hub.broadcast({
          type: "vision-roster-result",
          action: "remove-face",
          ok: result.ok,
          personId: msg.personId,
          ...(result.ok ? {} : { error: result.reason }),
        });
        if (result.ok) {
          this.tracker.reset();
          this.broadcastAppearances();
          await this.broadcastPeople();
        }
        return;
      }
      case "add-face-from-image": {
        await this.addFaceFromImage(msg.personId, msg.jpegBase64).catch((err: unknown) => {
          // Every path out must answer, including the unexpected one — the same
          // defect the camera enrolment path already records: without this the
          // client sits on a spinner and the only trace is a server log.
          this.hub.broadcast({
            type: "vision-roster-result",
            action: "add-face",
            ok: false,
            personId: msg.personId,
            error: `Could not add that face: ${err instanceof Error ? err.message : String(err)}`,
          });
        });
        return;
      }
      case "confirm-candidate": {
        // "Yes, that was Steve." The face joins that person, so the next match
        // has one more pose to compare against.
        //
        // Taken from the queue first, exactly as naming does: a face that
        // becomes part of a person must stop being a candidate in the same
        // step, or a failure leaves it in both places.
        const taken = await this.candidates.take(msg.id);
        if (!taken) {
          this.hub.broadcast({
            type: "vision-roster-result",
            action: "confirm",
            ok: false,
            error: "That face is no longer waiting.",
          });
          return;
        }

        let added = false;
        try {
          added = await this.people.addFace(msg.personId, taken.embedding, taken.thumbnail);
        } catch (err) {
          // Already out of the queue, so a throw here would destroy the face —
          // gone from triage, never added to anyone, and silent. Put it back.
          await this.candidates.offer(taken.embedding, taken.thumbnail, this.config().candidateFaces).catch(() => undefined);
          await this.broadcastCandidates();
          this.hub.broadcast({
            type: "vision-roster-result",
            action: "confirm",
            ok: false,
            personId: msg.personId,
            error: `Could not add that face: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }

        if (!added) {
          await this.candidates.offer(taken.embedding, taken.thumbnail, this.config().candidateFaces).catch(() => undefined);
          await this.broadcastCandidates();
          this.hub.broadcast({
            type: "vision-roster-result",
            action: "confirm",
            ok: false,
            personId: msg.personId,
            error: "That person is no longer on the roster.",
          });
          return;
        }

        // The gallery changed, so an open appearance decided against the old one
        // must decide again — the same reason every other roster mutation resets.
        this.tracker.reset();
        this.queued.clear();
        this.broadcastAppearances();
        await this.broadcastPeople();
        await this.broadcastCandidates();
        this.hub.broadcast({ type: "vision-roster-result", action: "confirm", ok: true, personId: msg.personId });
        return;
      }
      case "set-profile": {
        const result = await this.people.setProfile(msg.id, msg.profile);
        this.hub.broadcast({
          type: "vision-roster-result",
          action: "profile",
          ok: result.ok,
          personId: msg.id,
          ...(result.ok ? {} : { error: result.reason }),
        });
        // No tracker reset: a profile changes what HAL is told about someone,
        // not who it thinks it is looking at.
        if (result.ok) await this.broadcastPeople();
        return;
      }
      case "set-operator": {
        const result = await this.people.setOperator(msg.id);
        this.hub.broadcast({
          type: "vision-roster-result",
          action: "operator",
          ok: result.ok,
          ...(msg.id ? { personId: msg.id } : {}),
          ...(result.ok ? {} : { error: result.reason }),
        });
        if (result.ok) await this.broadcastPeople();
        return;
      }
      case "count-biometrics": {
        const [people, candidates] = await Promise.all([this.people.tally(), this.candidates.count()]);
        this.hub.broadcast({ type: "biometric-tally", ...people, candidates });
        return;
      }
      case "purge-biometrics": {
        // R39. Counted before the delete, because afterwards there is nothing
        // left to count and the client still has to be told what went.
        const [people, candidates] = await Promise.all([this.people.tally(), this.candidates.count()]);
        await this.people.clear();
        await this.candidates.clear();
        // Same reason as delete-person, one scale up: an open appearance still
        // carries an identity decided against a gallery that no longer exists.
        this.tracker.reset();
        this.broadcastAppearances();
        await this.broadcastPeople();
        await this.broadcastCandidates();
        this.hub.broadcast({ type: "biometric-purged", ...people, candidates });
        return;
      }
      default:
        return;
    }
  }

  /**
   * One-shot enrolment from the frame currently in view.
   *
   * The brief makes the triage queue the enrolment path; this slice has no
   * queue, so this is the only way into the gallery. Every refusal below has a
   * reason the user can act on, which is why the result is a typed reply rather
   * than a generic error.
   *
   * Exactly one face is required. Enrolling from a frame with two people in it
   * would silently attach the wrong face to a name, and without a queue there
   * would be nothing to correct it with.
   */
  private async enrol(rawName: string, candidateId?: string): Promise<void> {
    const name = rawName.trim();
    const fail = (error: string): void => {
      this.hub.broadcast({ type: "vision-enrol-result", ok: false, error });
    };

    if (!name) return fail("A person needs a name.");

    // Naming a face HAL kept earlier. This needs no camera, no recogniser and
    // nobody in view — the embedding was computed when the face was seen. It
    // is also how enrolment works with two people in frame: the face is chosen
    // rather than assumed.
    if (candidateId) {
      const taken = await this.candidates.take(candidateId);
      if (!taken) return fail("That face is no longer waiting to be named.");

      let person;
      try {
        ({ person } = await this.people.enrolByName(name, taken.embedding, taken.thumbnail));
      } catch (err) {
        // The candidate is already out of the queue at this point, so a failure
        // here would otherwise destroy the face: gone from triage, never added
        // to anyone, and silent because the throw only reaches a log. Put it
        // back and say so.
        await this.candidates
          .offer(taken.embedding, taken.thumbnail, this.config().candidateFaces)
          .catch(() => undefined);
        await this.broadcastCandidates();
        return fail(`Could not save that person: ${err instanceof Error ? err.message : String(err)}`);
      }

      this.tracker.reset();
      this.queued.clear();
      this.broadcastAppearances();
      await this.broadcastPeople();
      await this.broadcastCandidates();
      this.hub.broadcast({ type: "vision-enrol-result", ok: true, personId: person.id });
      return;
    }

    const cfg = this.config();
    if (!cfg.enabled) return fail("Vision is off, so there is nothing to enrol from.");
    if (!cfg.recognitionEnabled) return fail("Recognition is off.");

    const jpeg = this.camera.grab();
    if (!jpeg) return fail("No frame from the camera yet.");

    let faces;
    try {
      faces = (await this.recogniser(cfg.recogniserEndpoint).detect(jpeg)).faces;
    } catch (err) {
      return fail(err instanceof RecogniserError ? err.message : "The recogniser could not be reached.");
    }

    if (faces.length === 0) return fail("No face in view. Look at the camera and try again.");
    if (faces.length > 1) {
      return fail(`${faces.length} faces are in view. Enrol with one person in frame so the right face is stored.`);
    }

    const face = faces[0]!;
    if (!face.embedding) {
      // Detected but not embedded — the recogniser's embedder is unavailable.
      // Storing a person with no vector would look enrolled and never match.
      return fail("The recogniser can see a face but cannot describe it yet. Check its readiness.");
    }

    const thumbnail = await cropFace(jpeg, face.box);
    if (!thumbnail) {
      // No silent fallback to the whole frame. That would put a picture of the
      // entire room — everyone in it, enrolled or not — into the gallery as
      // this one person's face.
      return fail("Could not crop that face. Check that ffmpeg is available.");
    }
    const { person } = await this.people.enrolByName(name, face.embedding, thumbnail);

    // The open appearance was decided before this person existed. Resetting
    // makes the next detection reconsider, so enrolling yourself takes effect
    // on the next interval rather than at the end of the current visit.
    this.tracker.reset();
    this.broadcastAppearances();
    await this.broadcastPeople();
    this.hub.broadcast({ type: "vision-enrol-result", ok: true, personId: person.id });
  }
}
