import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";

// Talking to the camera hardware through ffmpeg.
//
// ffmpeg rather than a native binding because it is already the thing that
// works on all three targets and needs no build step.
//
// Frames themselves come from `stream.ts`, which holds one long-running ffmpeg
// for as long as Vision is on: a webcam is an exclusive device, so a capture is
// a read from that stream rather than a process of its own. What remains here
// is device enumeration, which does not touch the camera, and the error type
// both modules report through.

export class CaptureError extends Error {
  constructor(
    message: string,
    readonly kind: "no-ffmpeg" | "no-camera" | "failed",
  ) {
    super(message);
  }
}

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
