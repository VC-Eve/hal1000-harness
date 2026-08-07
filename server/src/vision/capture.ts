import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Frame capture through ffmpeg.
//
// ffmpeg rather than a native binding because it is already the thing that
// works on all three targets and needs no build step. The cost is a process per
// capture, which at minutes-scale intervals is irrelevant.

export class CaptureError extends Error {
  constructor(
    message: string,
    readonly kind: "no-ffmpeg" | "no-camera" | "failed",
  ) {
    super(message);
  }
}

// Warmup frames. A webcam's first frames are dark and unfocused while exposure
// settles, so capturing one frame reliably captures the worst one. Twelve costs
// about half a second and is the difference between a black rectangle and a
// picture.
const WARMUP_FRAMES = 12;

const FFMPEG = process.env.HAL_FFMPEG ?? "ffmpeg";

function run(args: string[], timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    // No shell: a device name is user-supplied and would otherwise be a command
    // string on Windows, where a stray quote is an injection rather than a
    // parse error. Arguments go to the process directly.
    const child = spawn(FFMPEG, args, { shell: false });
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      // Bounded: a wedged ffmpeg can emit indefinitely and this is only ever
      // read for its last few lines.
      stderr = (stderr + chunk.toString()).slice(-8_000);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new CaptureError("ffmpeg is not installed or not on PATH.", "no-ffmpeg"));
        return;
      }
      reject(new CaptureError(err.message, "failed"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

// A camera in use elsewhere is the ordinary case on Windows, not an edge case,
// so it gets its own kind and its own sentence rather than a raw ffmpeg dump.
function classify(stderr: string): CaptureError {
  if (/already in use|Device or resource busy|Could not run graph/i.test(stderr)) {
    return new CaptureError("The camera is in use by another application.", "no-camera");
  }
  if (/I\/O error|Could not find video device|No such file or directory|cannot open/i.test(stderr)) {
    return new CaptureError("No camera could be opened.", "no-camera");
  }
  const line = stderr.trim().split("\n").filter(Boolean).pop() ?? "ffmpeg failed";
  return new CaptureError(line, "failed");
}

// The input half of the command, which is the only part that differs per OS.
// mjpeg is requested on Windows because a typical USB webcam offers 720p only
// in that codec — its raw modes stop well below it.
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

// Windows without the mjpeg/size demand. A camera that has no 1280x720 mjpeg
// mode fails the preferred form outright, and falling back is the difference
// between "works" and "buy a different webcam".
function fallbackInputArgs(device: string | null): string[] {
  if (process.platform !== "win32") return [];
  return ["-f", "dshow", "-i", `video=${device ?? "0"}`];
}

/**
 * Capture one settled frame as JPEG bytes.
 *
 * Throws CaptureError. `no-camera` means the device could not be opened —
 * usually because something else holds it — and is reported rather than
 * narrated, because HAL going blind is not an observation about the developer.
 */
export async function captureFrame(device: string | null, timeoutMs = 20_000): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-vision-"));
  const pattern = path.join(dir, "f-%03d.jpg");
  try {
    const attempts = [inputArgs(device), fallbackInputArgs(device)].filter((a) => a.length > 0);
    let last: CaptureError | null = null;
    for (const input of attempts) {
      const { code, stderr } = await run(
        ["-hide_banner", "-loglevel", "error", "-y", ...input, "-frames:v", String(WARMUP_FRAMES), pattern],
        timeoutMs,
      );
      // ffmpeg reports decoder complaints on stderr while still writing usable
      // frames — some webcams emit malformed MJPEG APP fields on every frame.
      // Whether a frame landed is the only reliable success signal.
      const frames = (await fs.readdir(dir)).filter((f) => f.endsWith(".jpg")).sort();
      if (frames.length > 0) {
        return await fs.readFile(path.join(dir, frames[frames.length - 1]!));
      }
      last = classify(stderr || `ffmpeg exited with ${code ?? "no code"}`);
    }
    throw last ?? new CaptureError("ffmpeg produced no frames.", "failed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Video capture device names as this OS reports them.
 *
 * ffmpeg exits non-zero for every enumeration form — the listing is a side
 * effect of failing to open a dummy input — so the exit code is ignored and
 * only the parsed output matters.
 */
export async function listDevices(): Promise<string[]> {
  if (process.platform === "win32") {
    const { stderr } = await run(["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], 15_000);
    return [...stderr.matchAll(/"([^"]+)"\s+\(video\)/g)].map((m) => m[1]!);
  }
  if (process.platform === "darwin") {
    const { stderr } = await run(["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], 15_000);
    const video = stderr.split(/AVFoundation audio devices/)[0] ?? "";
    return [...video.matchAll(/\[\d+\]\s+(.+)/g)].map((m) => m[1]!.trim());
  }
  const entries = await fs.readdir("/dev").catch(() => [] as string[]);
  return entries.filter((e) => /^video\d+$/.test(e)).map((e) => `/dev/${e}`);
}
