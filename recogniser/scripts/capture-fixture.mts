// Creates the local face fixture the detection and discrimination tests need.
//
// The fixture is NOT committed. A photograph of a person in git history is
// permanent and effectively unremovable, and this is a feature whose brief is
// substantially about not holding biometric data for people who did not ask to
// be held. So the capture is a script anyone can run on their own machine, the
// output is gitignored, and the tests that need it skip loudly when it is
// absent rather than quietly passing.
//
// It grabs a burst of frames and keeps the best one, because a single grab
// catches whatever the camera happened to see — the first attempt at this
// produced a backlit near-profile face at the edge of frame, whose landmarks
// were geometrically correct and useless: eyes foreshortened to 18px apart
// while the face stood 182px tall, which no similarity transform can reconcile.
//
// "Best" is not "highest detection score". A tool whose output is used as
// evidence has to fail loudly when it cannot tell a good result from a bad one
// — `docs/solutions/diagnosing-a-process-that-isnt-your-code.md` is four
// instances of that lesson. So a candidate must also produce a low alignment
// residual, which is the measure of whether the five landmarks actually fit a
// frontal face, and the script exits non-zero rather than writing a fixture
// that would silently weaken every test downstream.
//
// Usage (needs ffmpeg on PATH):
//   npx tsx recogniser/scripts/capture-fixture.mts [device]
//   npx tsx recogniser/scripts/capture-fixture.mts --list

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Detector } from "../src/detect.js";
import { decodeJpeg } from "../src/frame.js";
import { YUNET } from "../src/models.js";
import { estimateSimilarity } from "../src/warp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "test", "fixtures", "face.jpg");
const MODEL = path.join(HERE, "..", "models", YUNET.file);

const FRAMES = 24;
const INTERVAL_MS = 400;
// A frontal face clears this comfortably; the profile capture that prompted
// this scored 0.653. Set above that so a marginal pose cannot pass.
const MIN_SCORE = 0.85;
// Template pixels. A frontal face fits the canonical five points within a few;
// the profile capture left 11.8.
const MAX_RESIDUAL = 6;

const INPUT_FORMAT =
  process.platform === "win32" ? "dshow" : process.platform === "darwin" ? "avfoundation" : "v4l2";

function defaultDevice(): string {
  if (process.platform === "win32") return "video=Integrated Camera";
  if (process.platform === "darwin") return "0";
  return "/dev/video0";
}

function run(args: string[]): Promise<{ code: number | null; out: Buffer; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", args, { shell: false });
    const chunks: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", (e) => resolve({ code: 1, out: Buffer.alloc(0), err: e.message }));
    child.on("close", (code) => resolve({ code, out: Buffer.concat(chunks), err }));
  });
}

async function list(): Promise<void> {
  // ffmpeg writes the device roster to stderr and exits non-zero by design.
  const { err } = await run(["-hide_banner", "-f", INPUT_FORMAT, "-list_devices", "true", "-i", "dummy"]);
  console.log(err);
}

async function grab(device: string): Promise<Buffer | null> {
  const { out } = await run([
    "-hide_banner", "-loglevel", "error",
    "-f", INPUT_FORMAT, "-i", device,
    "-frames:v", "1", "-q:v", "3",
    "-f", "image2", "pipe:1",
  ]);
  return out.length > 0 ? out : null;
}

async function capture(device: string): Promise<void> {
  if (!fs.existsSync(MODEL)) {
    console.error(`the detector model is missing at ${MODEL} — this is a committed file, so the checkout is incomplete.`);
    process.exit(1);
  }
  const detector = await Detector.load(MODEL);

  console.log(`Capturing from ${device}.`);
  console.log(`Look at the camera. Taking ${FRAMES} frames over ${Math.round((FRAMES * INTERVAL_MS) / 1000)}s and keeping the best.\n`);

  let best: { jpeg: Buffer; score: number; residual: number } | null = null;

  for (let i = 0; i < FRAMES; i++) {
    const jpeg = await grab(device);
    if (!jpeg) continue;

    let line = `  frame ${String(i + 1).padStart(2)}: `;
    try {
      const frame = decodeJpeg(jpeg);
      const faces = await detector.detect(frame, 0.6, 0.3);
      if (faces.length === 0) {
        line += "no face";
      } else {
        // Strongest face in the frame; NMS has already deduplicated.
        const face = faces.reduce((a, b) => (b.score > a.score ? b : a));
        const residual = estimateSimilarity(face.landmarks).residual;
        line += `score ${face.score.toFixed(3)}  alignment ${residual.toFixed(1)}px`;
        const better = !best || face.score - residual / 20 > best.score - best.residual / 20;
        if (face.score >= MIN_SCORE && residual <= MAX_RESIDUAL && better) {
          best = { jpeg, score: face.score, residual };
          line += "  <- best so far";
        }
      }
    } catch (err) {
      line += `undecodable (${(err as Error).message})`;
    }
    console.log(line);
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }

  if (!best) {
    // Refusing beats writing a fixture that looks like proof. Every
    // face-dependent test would still run against a bad crop and would still
    // report green, having verified nothing.
    console.error(
      `\nNo frame produced a usable frontal face (needed score >= ${MIN_SCORE} and alignment <= ${MAX_RESIDUAL}px).`,
    );
    console.error("Nothing was written. Face the camera, check the lighting, and run it again.");
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, best.jpeg);
  console.log(`\nwrote ${OUT} (${best.jpeg.length} bytes)`);
  console.log(`  detection score ${best.score.toFixed(3)}, alignment residual ${best.residual.toFixed(1)}px`);
  console.log("This file is gitignored and stays on this machine.");
}

const arg = process.argv[2];
if (arg === "--list") await list();
else await capture(arg ?? process.env.HAL_RECOGNISER_DEVICE ?? defaultDevice());
