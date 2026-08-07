import crypto from "node:crypto";
import type {
  ClientMessage,
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
  isBlankPrompt,
  resolvePrompt,
  visionSensitivityInstruction,
} from "../../../shared/src/prompts.js";
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

  constructor(
    private readonly hub: VisionHub,
    private readonly settings: SettingsStore,
    private readonly frames: FrameStore,
    private readonly sink: VisionSink,
    private readonly queue: ProviderQueue,
    private readonly providerFactory: ProviderFactory,
    private readonly makeCaptioner: (endpoint: string) => Captioner = (endpoint) => new HttpCaptioner(endpoint),
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
    if (this.state === "off") this.publish("idle");

    // Idempotent, and re-targets if the device setting changed. Holding the
    // camera for as long as Vision is on is what lets the preview and the
    // capture share one exclusive device.
    this.camera.start(cfg.device);

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

      this.lastFrame = { at: at.toISOString(), dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}` };
      this.hub.broadcast({ type: "vision-frame", ...this.lastFrame });
      await this.frames.save(jpeg, at, cfg.retainFrames).catch((err: unknown) => {
        // Reported rather than swallowed: a full or unwritable disk silently
        // disables retention, and the only symptom would be an empty folder.
        console.error(`vision frame save failed: ${err instanceof Error ? err.message : String(err)}`);
      });

      this.publish("captioning");
      const prompt = resolvePrompt(cfg.captionPrompt, DEFAULT_VISION_CAPTION_PROMPT);
      const caption = await this.captioner(cfg.captionerEndpoint).caption(jpeg, prompt);
      if (superseded()) return;

      // identity is null and present rather than absent: face recognition later
      // fills this field instead of changing this shape (R21).
      const observation: VisionObservation = { at: at.toISOString(), caption, identity: null };
      this.buffer.push(observation);
      if (this.buffer.length > BUFFER_CAP) this.buffer = this.buffer.slice(-BUFFER_CAP);
      this.cycleStartedAt ??= this.now();

      this.hub.broadcast({ type: "vision-observation", observation });
      this.publish("idle");
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
      const trimmed = text.trim();
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
      this.publish("idle");
    } catch (err) {
      if (isAborted(err)) {
        // Chat preempted this cycle. An abort is scheduling, not failure, so
        // the observations go back and are summarised on the next tick.
        this.buffer = [...batch, ...this.buffer].slice(-BUFFER_CAP);
        this.cycleStartedAt = 0;
        this.publish("idle");
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
    const lines = batch.map((o) => `${o.identity ? `[${o.identity}] ` : ""}${o.caption}`).join("\n");
    const framing = `${visionSensitivityInstruction(cfg.sensitivity)}\n\nFrames from the last period:`;

    // Enqueued as narration: chat still preempts, and the single-lane contract
    // is unchanged. Only this half touches Ollama — the captioner never does.
    return this.queue.enqueue("narration", async (signal) => {
      const provider = this.providerFactory(s.providerEndpoint);
      let out = "";
      const stream = provider.chatStream({
        model,
        messages: [
          ...(isBlankPrompt(prompt) ? [] : [{ role: "system" as const, content: prompt }]),
          { role: "user" as const, content: `${framing}\n${lines}` },
        ],
        signal,
        options: { num_ctx: NARRATION_NUM_CTX },
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
      default:
        return;
    }
  }
}
