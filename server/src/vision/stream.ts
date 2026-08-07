import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { CaptureError } from "./capture.js";

// One long-running ffmpeg holding the camera, feeding everyone.
//
// A webcam is an exclusive device: the browser cannot take it with
// getUserMedia while the server also wants to capture from it. So the server
// owns it exactly once and fans the frames out — the live preview and the
// interval capture read the same stream. That also makes a capture instant,
// because it is a buffer read rather than a process spawn.

const FFMPEG = process.env.HAL_FFMPEG ?? "ffmpeg";

// JPEG frame markers. The MJPEG muxer emits whole JPEGs back to back with no
// container framing, so start-of-image and end-of-image are the only boundaries
// there are.
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

// A frame this large is a decoder that lost sync rather than a real picture;
// resetting beats growing a buffer without limit.
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

// Backoff after ffmpeg exits. A camera unplugged mid-stream would otherwise
// respawn a process every few milliseconds forever.
const RESTART_MS = 5_000;

function inputArgs(device: string | null): string[] {
  switch (process.platform) {
    case "win32":
      return ["-f", "dshow", "-vcodec", "mjpeg", "-video_size", "1280x720", "-i", `video=${device ?? "0"}`];
    case "darwin":
      return ["-f", "avfoundation", "-framerate", "30", "-video_size", "1280x720", "-i", device ?? "0"];
    default:
      return ["-f", "v4l2", "-video_size", "1280x720", "-i", device ?? "/dev/video0"];
  }
}

export type FrameListener = (jpeg: Buffer) => void;

// The camera as everything else sees it. An interface so the service can be
// driven by a fake in tests without spawning ffmpeg, and so http.ts can consume
// frames without knowing what produces them.
export interface CameraFeed {
  start(device: string | null): void;
  stop(): void;
  onFrame(listener: FrameListener): () => void;
  grab(): Buffer | null;
  grabWhenReady(timeoutMs?: number): Promise<Buffer>;
  readonly running: boolean;
  readonly lastError: string | null;
}

export class CameraStream implements CameraFeed {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private latest: Buffer | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<FrameListener>();
  private device: string | null = null;
  private problem: string | null = null;
  private stopped = true;

  // Frames per second pushed to the preview. Low on purpose: this is a
  // presence indicator, not a video call, and every frame crosses an HTTP
  // response for a picture that changes slowly.
  constructor(private readonly fps = 6) {}

  get lastError(): string | null {
    return this.problem;
  }

  get running(): boolean {
    return this.child !== null;
  }

  // Idempotent, and re-targets when the device changes — which is what makes
  // this safe to call from a tick loop that reads settings every time.
  start(device: string | null): void {
    this.stopped = false;
    if (this.child && this.device === device) return;
    this.stop();
    this.stopped = false;
    this.device = device;
    this.spawn();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.child?.kill();
    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.latest = null;
  }

  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The most recent frame, or null when none has arrived yet. */
  grab(): Buffer | null {
    return this.latest;
  }

  /** Waits briefly for a first frame — the stream needs a moment after spawn. */
  async grabWhenReady(timeoutMs = 8_000): Promise<Buffer> {
    if (this.latest) return this.latest;
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new CaptureError(this.problem ?? "No frame arrived from the camera.", "no-camera"));
      }, timeoutMs);
      const off = this.onFrame((jpeg) => {
        clearTimeout(timer);
        off();
        resolve(jpeg);
      });
    });
  }

  private spawn(): void {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      ...inputArgs(this.device),
      "-r",
      String(this.fps),
      "-f",
      "mjpeg",
      "-q:v",
      "6",
      "pipe:1",
    ];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(FFMPEG, args, { shell: false });
    } catch (err) {
      this.problem = err instanceof Error ? err.message : String(err);
      this.scheduleRestart();
      return;
    }
    this.child = child;

    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (!text) return;
      this.problem = /already in use|Could not run graph|Device or resource busy/i.test(text)
        ? "The camera is in use by another application."
        : text.split("\n").pop()!;
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      this.problem = err.code === "ENOENT" ? "ffmpeg is not installed or not on PATH." : err.message;
    });
    child.on("close", () => {
      if (this.child === child) this.child = null;
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped) this.spawn();
    }, RESTART_MS);
    this.restartTimer.unref?.();
  }

  // Splits the byte stream back into whole JPEGs. Scanning for the end marker
  // is enough because the muxer writes one complete image before the next.
  private consume(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_FRAME_BYTES) {
      // Lost sync. Resync from the next start marker rather than keeping bytes
      // that will never terminate.
      const next = this.buffer.indexOf(SOI, 1);
      this.buffer = next === -1 ? Buffer.alloc(0) : this.buffer.subarray(next);
      return;
    }
    for (;;) {
      const start = this.buffer.indexOf(SOI);
      if (start === -1) return;
      const end = this.buffer.indexOf(EOI, start + 2);
      if (end === -1) {
        if (start > 0) this.buffer = this.buffer.subarray(start);
        return;
      }
      const frame = this.buffer.subarray(start, end + 2);
      this.buffer = this.buffer.subarray(end + 2);
      this.latest = frame;
      // A frame arriving means the camera is working; a stale complaint from
      // an earlier failed spawn must not outlive it.
      this.problem = null;
      for (const listener of this.listeners) listener(frame);
    }
  }
}
