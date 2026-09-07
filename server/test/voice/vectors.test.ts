import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  VOICE_DIM,
  VOICE_ROWS,
  VoicePackError,
  blend,
  readVoicePack,
  styleRow,
  type VoicePack,
} from "../../src/voice/vectors.js";
import { FIXTURES, NO_VOICES, VOICES_PATH, VOICES_READY, describeWhen } from "./models-required.js";

const oracle = JSON.parse(fs.readFileSync(path.join(FIXTURES, "styles.json"), "utf8")) as {
  voices: string[];
  mixes: {
    name: string;
    weights: Record<string, number>;
    sha256: string;
    row0: number[];
    row509: number[];
  }[];
};

const asMix = (weights: Record<string, number>) =>
  Object.entries(weights).map(([voice, weight]) => ({ voice, weight }));

const digest = (v: Float32Array) => createHash("sha256").update(Buffer.from(v.buffer, v.byteOffset, v.byteLength)).digest("hex");

// A .npy of the right shape, built by hand so the parser's refusals can be
// tested without a 28MB file. Header padded to a multiple of 64 the way NumPy
// writes it, because a parser that only handles unpadded headers would pass
// every test here and fail on the real pack.
function npy(shape: string, descr = "<f4", floats = VOICE_ROWS * VOICE_DIM): Uint8Array {
  const dict = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape}), }`;
  const headerLength = Math.ceil((10 + dict.length + 1) / 64) * 64 - 10;
  const header = dict.padEnd(headerLength - 1, " ") + "\n";
  const out = new Uint8Array(10 + header.length + floats * 4);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]);
  new DataView(out.buffer).setUint16(8, header.length, true);
  for (let i = 0; i < header.length; i += 1) out[10 + i] = header.charCodeAt(i);
  return out;
}

/** A one-entry zip. `method` is written into both headers so a stored-only reader can refuse it. */
function zip(name: string, payload: Uint8Array, method = 0): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const local = new Uint8Array(30 + nameBytes.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(8, method, true);
  lv.setUint32(18, payload.length, true);
  lv.setUint32(22, payload.length, true);
  lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);

  const central = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(10, method, true);
  cv.setUint32(20, payload.length, true);
  cv.setUint32(24, payload.length, true);
  cv.setUint16(28, nameBytes.length, true);
  cv.setUint32(42, 0, true);
  central.set(nameBytes, 46);

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length + payload.length, true);

  const out = new Uint8Array(local.length + payload.length + central.length + eocd.length);
  out.set(local, 0);
  out.set(payload, local.length);
  out.set(central, local.length + payload.length);
  out.set(eocd, local.length + payload.length + central.length);
  return out;
}

it("refuses a compressed entry rather than reading it as floats", () => {
  // Deflated data read as stored yields plausible-looking noise, and a voice
  // made of noise has no symptom that points at the cause.
  expect(() => readVoicePack(zip("af_x.npy", npy("510, 1, 256"), 8))).toThrow(VoicePackError);
  expect(() => readVoicePack(zip("af_x.npy", npy("510, 1, 256"), 8))).toThrow(/compressed/);
});

it("refuses the wrong dtype, the wrong shape, and Fortran order", () => {
  expect(() => readVoicePack(zip("a.npy", npy("510, 1, 256", "<f8")))).toThrow(/dtype/);
  expect(() => readVoicePack(zip("a.npy", npy("128, 1, 256")))).toThrow(/shape/);
  const fortran = npy("510, 1, 256");
  const text = Buffer.from(fortran.buffer, 10, 100).toString("latin1").replace("False", "True ");
  Buffer.from(fortran.buffer, 10, 100).write(text, "latin1");
  expect(() => readVoicePack(fortran.length ? zip("a.npy", fortran) : fortran)).toThrow(/Fortran/);
});

it("refuses a truncated array", () => {
  expect(() => readVoicePack(zip("a.npy", npy("510, 1, 256", "<f4", 8)))).toThrow(/truncated/);
});

it("refuses something that is not a zip at all", () => {
  expect(() => readVoicePack(new Uint8Array(64))).toThrow(/not a zip archive/);
});

it("has no style row for an empty line", () => {
  expect(styleRow(new Float32Array(VOICE_ROWS * VOICE_DIM), 0)).toBeNull();
  expect(styleRow(new Float32Array(VOICE_ROWS * VOICE_DIM), -1)).toBeNull();
});

it("picks row n-1 for n tokens, and the last row above the cap", () => {
  // The off-by-one that does not error: row n would sound like a voice the
  // operator never authored, on every line, with nothing to point at.
  const vector = new Float32Array(VOICE_ROWS * VOICE_DIM);
  for (let row = 0; row < VOICE_ROWS; row += 1) vector[row * VOICE_DIM] = row;
  expect(styleRow(vector, 1)![0]).toBe(0);
  expect(styleRow(vector, 2)![0]).toBe(1);
  expect(styleRow(vector, 42)![0]).toBe(41);
  expect(styleRow(vector, VOICE_ROWS)![0]).toBe(VOICE_ROWS - 1);
  expect(styleRow(vector, VOICE_ROWS + 500)![0]).toBe(VOICE_ROWS - 1);
});

describeWhen(VOICES_READY, NO_VOICES, "against the real voice pack", () => {
  let pack: VoicePack;

  const load = () => (pack ??= readVoicePack(fs.readFileSync(VOICES_PATH)));

  it("reads every voice the oracle recorded", () => {
    expect(load().names).toEqual(oracle.voices);
    expect(load().names.length).toBe(54);
  });

  it("gives each voice the full set of rows", () => {
    const vector = load().vectors.get("am_michael")!;
    expect(vector.length).toBe(VOICE_ROWS * VOICE_DIM);
  });

  it("reproduces a single-voice mix exactly", () => {
    // Share is 1, so the arithmetic is a copy and the digest must match the
    // reference byte for byte.
    const mix = oracle.mixes.find((m) => m.name === "single")!;
    const blended = blend(load(), asMix(mix.weights))!;
    expect(digest(blended)).toBe(mix.sha256);
  });

  it("reproduces every blended mix the oracle recorded", () => {
    for (const mix of oracle.mixes) {
      const blended = blend(load(), asMix(mix.weights))!;
      expect(blended, mix.name).not.toBeNull();
      // Compared elementwise rather than by digest for the multi-voice mixes:
      // NumPy rounds each term to float32 before accumulating and JavaScript
      // accumulates in double and rounds on store, so the two can differ by an
      // ULP without either being wrong. The tolerance is far below anything
      // audible and far above that difference.
      for (let i = 0; i < 8; i += 1) {
        expect(blended[i], `${mix.name} row0[${i}]`).toBeCloseTo(mix.row0[i]!, 6);
        const last = (VOICE_ROWS - 1) * VOICE_DIM + i;
        expect(blended[last], `${mix.name} row509[${i}]`).toBeCloseTo(mix.row509[i]!, 6);
      }
    }
  });

  it("gives the same vector for a ratio however it is written", () => {
    const weighted = blend(load(), asMix({ am_michael: 0.6, bm_george: 0.4 }))!;
    const unnormalised = blend(load(), asMix({ am_michael: 6, bm_george: 4 }))!;
    for (let i = 0; i < 256; i += 1) expect(unnormalised[i]).toBeCloseTo(weighted[i]!, 6);
  });

  it("refuses a mix naming a voice the pack does not carry", () => {
    expect(blend(load(), [{ voice: "am_nobody", weight: 1 }])).toBeNull();
  });

  it("refuses a mix it cannot normalise", () => {
    expect(blend(load(), [])).toBeNull();
    expect(blend(load(), [{ voice: "am_michael", weight: 0 }])).toBeNull();
    expect(blend(load(), [{ voice: "am_michael", weight: Number.NaN }])).toBeNull();
  });

  it("ignores a voice weighted to zero beside one that sounds", () => {
    const alone = blend(load(), [{ voice: "am_michael", weight: 1 }])!;
    const withZero = blend(load(), [
      { voice: "am_michael", weight: 1 },
      { voice: "bm_george", weight: 0 },
    ])!;
    expect(digest(withZero)).toBe(digest(alone));
  });
});
