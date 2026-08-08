// Crop a face out of a captured frame, for the roster.
//
// The stored artifact is a face rather than the whole frame on purpose. A
// person's gallery entry is the one lasting record HAL keeps of them, and
// keeping a picture of the entire room — everyone else in it included — to
// illustrate one enrolled person would hold more than the feature needs and
// more than anyone agreed to.
//
// ffmpeg does the work because Vision already requires it; adding an image
// library to `server/` for one crop at enrolment time would put a second
// decoder in the tree for no gain.

import { spawn } from "node:child_process";

const FFMPEG = process.env.HAL_FFMPEG ?? "ffmpeg";

// Room around the detected box. The detector frames tightly on the face; a
// little context makes the roster thumbnail recognisable to a human, which is
// the only thing it is for.
const PAD = 0.35;

// Cropping one image is milliseconds. Past this, ffmpeg is stalled, not busy.
const CROP_TIMEOUT_MS = 10_000;

export interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A square-ish JPEG crop around `box`, or null if ffmpeg could not produce one.
 *
 * Null rather than throwing: a missing thumbnail costs a blank tile in the
 * roster, and refusing an enrolment over it would be a worse trade than
 * enrolling someone whose picture did not render.
 */
export async function cropFace(frame: Buffer, box: CropBox, size = 160): Promise<Buffer | null> {
  const padX = box.w * PAD;
  const padY = box.h * PAD;
  // Clamped at the frame edge by ffmpeg's own expressions rather than by us,
  // because we do not know the frame's dimensions here and asking would mean
  // decoding it.
  const x = Math.max(0, Math.round(box.x - padX));
  const y = Math.max(0, Math.round(box.y - padY));
  const w = Math.max(16, Math.round(box.w + padX * 2));
  const h = Math.max(16, Math.round(box.h + padY * 2));

  const filter = [
    `crop=min(${w}\\,iw-${x}):min(${h}\\,ih-${y}):${x}:${y}`,
    `scale=${size}:${size}:force_original_aspect_ratio=increase`,
    `crop=${size}:${size}`,
  ].join(",");

  return new Promise((resolve) => {
    const child = spawn(
      FFMPEG,
      ["-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-i", "pipe:0",
       "-vf", filter, "-frames:v", "1", "-q:v", "4", "-f", "image2", "pipe:1"],
      { shell: false },
    );
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (value: Buffer | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    // Cropping one small image is milliseconds of work. A missing ffmpeg errors
    // and a crashing one closes, but a STALLED one does neither — and without a
    // deadline this promise never settles, so `enrol()` awaits forever with
    // nothing reported. Every other outbound call in this feature carries a
    // deadline; this one did not.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, CROP_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", () => {});
    child.on("error", () => finish(null));
    child.on("close", () => {
      const out = Buffer.concat(chunks);
      finish(out.length > 0 ? out : null);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(frame);
  });
}
