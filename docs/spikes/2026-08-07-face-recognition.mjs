// Spike behind `docs/brainstorms/2026-08-07-vision-face-recognition-requirements.md`.
//
// It answered the brief's blocking question — can a Node sidecar detect and
// embed faces fast enough, on Windows, with no build step? — and produced the
// numbers in that brief's Measured Constraints section. It is not wired into
// the build and nothing imports it. It is kept because five non-obvious things
// below cost iterations to get right, and the real recogniser has to do all
// five:
//
//   1. YuNet returns 12 separate tensors across strides 8/16/32. The score is
//      sqrt(cls * obj) and box coordinates are offsets from the grid cell in
//      stride units — see decodeYunet.
//   2. The 2023mar export has a FIXED 640x640 input. Frames are letterboxed,
//      not squashed, and detection cost is therefore constant regardless of
//      camera resolution.
//   3. ffmpeg's `-f rawvideo -pix_fmt rgb24` yields raw pixels directly, so
//      there is no JPEG-decoder dependency to add.
//   4. Both models want BGR, NCHW, values left at 0-255. Get any of those
//      wrong and it runs happily and detects nothing.
//   5. ORT emits one warning per initializer for these models — hundreds of
//      lines that bury the result — unless logging is turned down.
//
// To run it (needs ffmpeg on PATH):
//   mkdir spike && cd spike && npm init -y && npm pkg set type=module
//   npm install onnxruntime-node
//   mkdir models
//   curl -L -o models/yunet.onnx https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
//   curl -L -o models/sface.onnx https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx
//   cp <this file> spike.mjs && node spike.mjs

import { spawn } from "node:child_process";
import ort from "onnxruntime-node";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Not hardcoded to the machine it was written on: pass a device or set
// HAL_SPIKE_DEVICE. Defaults differ per platform the same way
// `server/src/vision/capture.ts` branches — dshow names a device, v4l2 and
// avfoundation take a path or an index.
const DEVICE = process.argv[2] ?? process.env.HAL_SPIKE_DEVICE ?? defaultDevice();

function defaultDevice() {
  if (process.platform === "win32") return "video=Integrated Camera";
  if (process.platform === "darwin") return "0";
  return "/dev/video0";
}

const INPUT_FORMAT = process.platform === "win32" ? "dshow"
  : process.platform === "darwin" ? "avfoundation"
  : "v4l2";

// These models list their weights as graph inputs, which makes ORT emit one
// warning per initializer — hundreds of lines that bury the actual result.
ort.env.logLevel = "fatal";
const SESSION_OPTS = { logSeverityLevel: 4, graphOptimizationLevel: "all" };

// One frame from the webcam as raw rgb24 at the requested size. Going straight
// to rawvideo means no JPEG decoder dependency — ffmpeg already does it.
function grab(w, h) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-f", INPUT_FORMAT, "-i", DEVICE,
      "-frames:v", "1",
      // The 2023mar YuNet export has a fixed 640x640 input, so the frame is
      // letterboxed rather than squashed — aspect ratio matters to detection.
      "-vf", `scale=${w}:-1,pad=${w}:${h}:0:(${h}-ih)/2`,
      "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ];
    const child = spawn("ffmpeg", args, { shell: false });
    const chunks = [];
    let err = "";
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => { err += c.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      const buf = Buffer.concat(chunks);
      if (buf.length !== w * h * 3) {
        reject(new Error(`expected ${w * h * 3} bytes, got ${buf.length} (exit ${code}) ${err.slice(0, 300)}`));
        return;
      }
      resolve(buf);
    });
  });
}

// rgb24 buffer -> NCHW float32 in BGR order, values left at 0-255 (what both
// OpenCV Zoo models were exported expecting).
function toTensor(rgb, w, h) {
  const out = new Float32Array(3 * w * h);
  const plane = w * h;
  for (let i = 0; i < plane; i++) {
    out[i] = rgb[i * 3 + 2];             // B
    out[plane + i] = rgb[i * 3 + 1];     // G
    out[2 * plane + i] = rgb[i * 3];     // R
  }
  return new ort.Tensor("float32", out, [1, 3, h, w]);
}

// YuNet emits cls/obj/bbox/kps per stride. Standard decode: score is the
// geometric mean of classification and objectness, boxes are offsets from the
// cell centre in stride units.
function decodeYunet(outputs, w, h, thresh = 0.6) {
  const faces = [];
  for (const stride of [8, 16, 32]) {
    const cls = outputs[`cls_${stride}`].data;
    const obj = outputs[`obj_${stride}`].data;
    const bbox = outputs[`bbox_${stride}`].data;
    const kps = outputs[`kps_${stride}`].data;
    const cols = Math.floor(w / stride);
    const rows = Math.floor(h / stride);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const score = Math.sqrt(Math.max(0, cls[i]) * Math.max(0, obj[i]));
        if (score < thresh) continue;
        const cx = (c + bbox[i * 4]) * stride;
        const cy = (r + bbox[i * 4 + 1]) * stride;
        const bw = Math.exp(bbox[i * 4 + 2]) * stride;
        const bh = Math.exp(bbox[i * 4 + 3]) * stride;
        const landmarks = [];
        for (let k = 0; k < 5; k++) {
          landmarks.push([(c + kps[i * 10 + k * 2]) * stride, (r + kps[i * 10 + k * 2 + 1]) * stride]);
        }
        faces.push({ x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh, score, landmarks });
      }
    }
  }
  // Greedy NMS.
  faces.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const f of faces) {
    if (kept.some((k) => iou(k, f) > 0.3)) continue;
    kept.push(f);
  }
  return kept;
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter);
}

// Bilinear crop-and-resize to SFace's 112x112. Not a landmark-aligned warp —
// good enough to tell same-person from different-person, which is all the
// spike needs to prove.
function cropResize(rgb, w, h, box, size = 112) {
  const pad = 0.15;
  const x0 = Math.max(0, box.x - box.w * pad);
  const y0 = Math.max(0, box.y - box.h * pad);
  const x1 = Math.min(w - 1, box.x + box.w * (1 + pad));
  const y1 = Math.min(h - 1, box.y + box.h * (1 + pad));
  const out = new Float32Array(3 * size * size);
  const plane = size * size;
  for (let oy = 0; oy < size; oy++) {
    const sy = y0 + ((y1 - y0) * oy) / (size - 1);
    const iy = Math.min(h - 1, Math.max(0, Math.round(sy)));
    for (let ox = 0; ox < size; ox++) {
      const sx = x0 + ((x1 - x0) * ox) / (size - 1);
      const ix = Math.min(w - 1, Math.max(0, Math.round(sx)));
      const src = (iy * w + ix) * 3;
      const dst = oy * size + ox;
      out[dst] = rgb[src + 2];
      out[plane + dst] = rgb[src + 1];
      out[2 * plane + dst] = rgb[src];
    }
  }
  return new ort.Tensor("float32", out, [1, 3, size, size]);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const ms = (t) => `${t.toFixed(1)}ms`;

function stats(times) {
  const s = [...times].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { mean, p50: s[Math.floor(s.length * 0.5)], p95: s[Math.floor(s.length * 0.95)] || s.at(-1) };
}

async function main() {
  console.log(`node ${process.version}  onnxruntime-node ${ort.version ?? "(unknown)"}\n`);

  const det = await ort.InferenceSession.create(path.join(HERE, "models", "yunet.onnx"), SESSION_OPTS);
  const rec = await ort.InferenceSession.create(path.join(HERE, "models", "sface.onnx"), SESSION_OPTS);
  console.log(`yunet  in=${det.inputNames}  out=${det.outputNames.length} tensors`);
  console.log(`sface  in=${rec.inputNames}  out=${rec.outputNames}\n`);

  for (const [w, h] of [[640, 640]]) {
    console.log(`--- ${w}x${h} ---`);
    const rgb = await grab(w, h);
    const input = toTensor(rgb, w, h);

    // Warm up: first run pays graph init and allocator setup.
    await det.run({ [det.inputNames[0]]: input });

    const times = [];
    let faces = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      const out = await det.run({ [det.inputNames[0]]: input });
      times.push(performance.now() - t);
      if (i === 0) faces = decodeYunet(out, w, h);
    }
    const d = stats(times);
    console.log(`detect  mean ${ms(d.mean)}  p50 ${ms(d.p50)}  p95 ${ms(d.p95)}   faces=${faces.length}` +
      (faces.length ? `  top score=${faces[0].score.toFixed(3)}` : ""));

    if (faces.length) {
      const crop = cropResize(rgb, w, h, faces[0]);
      await rec.run({ [rec.inputNames[0]]: crop });
      const et = [];
      let emb = null;
      for (let i = 0; i < 20; i++) {
        const t = performance.now();
        const out = await rec.run({ [rec.inputNames[0]]: crop });
        et.push(performance.now() - t);
        if (i === 0) emb = out[rec.outputNames[0]].data;
      }
      const e = stats(et);
      console.log(`embed   mean ${ms(e.mean)}  p50 ${ms(e.p50)}  p95 ${ms(e.p95)}   dims=${emb.length}`);
      console.log(`total per detected face: ${ms(d.mean + e.mean)}`);
      globalThis.__last = { w, h, rec, det, emb };
    }
    console.log();
  }

  // Correctness: two independent captures of the same scene should embed close
  // together. If this number is low, we measured a fast pipeline that does not
  // work, which is worse than measuring nothing.
  const last = globalThis.__last;
  if (last) {
    const { w, h, det, rec } = last;
    const embs = [];
    for (let i = 0; i < 2; i++) {
      const rgb = await grab(w, h);
      const out = await det.run({ [det.inputNames[0]]: toTensor(rgb, w, h) });
      const faces = decodeYunet(out, w, h);
      if (!faces.length) { console.log(`capture ${i + 1}: no face found`); continue; }
      const r = await rec.run({ [rec.inputNames[0]]: cropResize(rgb, w, h, faces[0]) });
      embs.push(r[rec.outputNames[0]].data);
    }
    if (embs.length === 2) {
      console.log(`--- correctness ---`);
      console.log(`same face, two captures:  ${cosine(embs[0], embs[1]).toFixed(4)}  (want > 0.5)`);

      // Consistency alone proves nothing: an embedder that returns the same
      // vector for every input would score 1.0 here. Embed a background patch
      // and a deliberately wrong crop; if those also score high, the pipeline
      // is degenerate and the latency number describes something useless.
      const rgb = await grab(w, h);
      const out = await det.run({ [det.inputNames[0]]: toTensor(rgb, w, h) });
      const faces = decodeYunet(out, w, h);
      if (faces.length) {
        const faceEmb = (await rec.run({ [rec.inputNames[0]]: cropResize(rgb, w, h, faces[0]) }))[rec.outputNames[0]].data;

        const corner = { x: 4, y: 4, w: 150, h: 150 };
        const cornerEmb = (await rec.run({ [rec.inputNames[0]]: cropResize(rgb, w, h, corner) }))[rec.outputNames[0]].data;
        console.log(`same face vs background:  ${cosine(faceEmb, cornerEmb).toFixed(4)}  (want clearly lower)`);

        const shifted = { x: faces[0].x + faces[0].w * 1.6, y: faces[0].y, w: faces[0].w, h: faces[0].h };
        const shiftedEmb = (await rec.run({ [rec.inputNames[0]]: cropResize(rgb, w, h, shifted) }))[rec.outputNames[0]].data;
        console.log(`same face vs off-target:  ${cosine(faceEmb, shiftedEmb).toFixed(4)}  (want clearly lower)`);

        // Visual proof the detector found a face and not a lamp.
        const size = 112, plane = size * size;
        const t = cropResize(rgb, w, h, faces[0]);
        const png = Buffer.alloc(plane * 3);
        for (let i = 0; i < plane; i++) {
          png[i * 3] = t.data[2 * plane + i];
          png[i * 3 + 1] = t.data[plane + i];
          png[i * 3 + 2] = t.data[i];
        }
        const { writeFileSync } = await import("node:fs");
        writeFileSync(path.join(HERE, "crop.raw"), png);
        console.log(`\nwrote crop.raw (${size}x${size} rgb24) — convert with ffmpeg to inspect`);
        console.log(`detected box: x=${faces[0].x.toFixed(0)} y=${faces[0].y.toFixed(0)} w=${faces[0].w.toFixed(0)} h=${faces[0].h.toFixed(0)}`);
      }
    }
  }
}

main().catch((e) => { console.error(`SPIKE FAILED: ${e.message}`); process.exit(1); });
