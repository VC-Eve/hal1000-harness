import fs from "node:fs";
import { createHash } from "node:crypto";
import { readVoicePack, styleRow, blend } from "../server/src/voice/vectors.js";
import { Synthesiser } from "../server/src/voice/synth.js";
import * as ort from "onnxruntime-node";
const dir = process.env.HAL_VOICE_MODELS_DIR!;
const a = JSON.parse(fs.readFileSync("server/test/voice/fixtures/audio.json", "utf8"));
const pack = readVoicePack(fs.readFileSync(`${dir}/voices-v1.0.bin`));
const mix = Object.entries(a.preset.mix).map(([voice, weight]) => ({ voice, weight: weight as number }));
const style = styleRow(blend(pack, mix)!, a.tokens.length)!;
const s = new Synthesiser({ model: `${dir}/kokoro-v1.0.onnx` });
const r = await s.render(a.tokens, style, a.preset.speed);
await s.stop();
const sha = createHash("sha256").update(Buffer.from(r.samples.buffer, r.samples.byteOffset, r.samples.byteLength)).digest("hex");
fs.writeFileSync("server/test/voice/fixtures/rendered-node.json", JSON.stringify({
  note: "OUR output, not the oracle. A drift detector for dependency bumps: a change here means the character's voice moved. Re-record with: npx tsx scripts/record-node-render.mts",
  recordedOn: new Date().toISOString().slice(0, 10),
  onnxruntimeNode: (ort as unknown as { version?: string }).version ?? "unknown",
  line: a.text, preset: a.preset,
  samples: r.samples.length, sha256: sha,
  durationMs: Math.round(r.durationMs),
}, null, 2) + "\n");
console.log("samples", r.samples.length, "sha", sha.slice(0, 16));
