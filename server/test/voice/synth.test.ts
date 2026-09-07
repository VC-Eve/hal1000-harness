import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readVoicePack, styleRow, blend } from "../../src/voice/vectors.js";
import { MAX_TOKENS, SynthUnavailable, Synthesiser } from "../../src/voice/synth.js";
import { SAMPLE_RATE, durationMs, toWav, trimSilence } from "../../src/voice/wav.js";
import { FIXTURES, MODEL_PATH, MODEL_READY, NO_MODEL, VOICES_PATH, VOICES_READY, describeWhen } from "./models-required.js";

const audio = JSON.parse(fs.readFileSync(path.join(FIXTURES, "audio.json"), "utf8")) as {
  tokens: number[];
  preset: { mix: Record<string, number>; speed: number };
  styleRow: number;
  samples: number;
  trimmedSamples: number;
  trimmedSha256: string;
  trimmedFirst8: number[];
  peak: number;
  silenceFloor: number;
};

const digest = (v: Float32Array) =>
  createHash("sha256").update(Buffer.from(v.buffer, v.byteOffset, v.byteLength)).digest("hex");

describe("trimSilence", () => {
  it("removes padding from both ends and keeps what is between", () => {
    const samples = Float32Array.from([0, 0, 0.5, -0.4, 0, 0]);
    expect(trimSilence(samples)).toEqual(Float32Array.from([0.5, -0.4]));
  });

  it("does not clip a quiet sample between loud ones", () => {
    const samples = Float32Array.from([0, 0.5, 0.0001, -0.5, 0]);
    expect(trimSilence(samples)).toEqual(Float32Array.from([0.5, 0.0001, -0.5]));
  });

  it("returns nothing for a buffer that is silent throughout", () => {
    // A caller that played this would hold the transport ducked for the length
    // of the padding with nothing being said.
    expect(trimSilence(Float32Array.from([0, 0, 0])).length).toBe(0);
  });
});

describe("toWav", () => {
  it("writes a header agreeing with the samples", () => {
    const wav = toWav(Float32Array.from([0, 0.5, -0.5]));
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(SAMPLE_RATE);
    expect(wav.readUInt16LE(34)).toBe(16); // bit depth
    expect(wav.readUInt32LE(40)).toBe(3 * 2); // data length
    expect(wav.length).toBe(44 + 3 * 2);
    expect(wav.readUInt32LE(4)).toBe(36 + 3 * 2);
  });

  it("clamps rather than wrapping", () => {
    // A sample past full scale that wrapped would flip sign and click.
    const wav = toWav(Float32Array.from([2, -2]));
    expect(wav.readInt16LE(44)).toBe(32767);
    expect(wav.readInt16LE(46)).toBe(-32767);
  });

  it("reports a duration that matches the rate", () => {
    expect(durationMs(new Float32Array(SAMPLE_RATE))).toBe(1000);
    expect(durationMs(new Float32Array(SAMPLE_RATE / 2))).toBe(500);
  });
});

describe("Synthesiser, without starting a thread", () => {
  const synth = new Synthesiser({ model: "unused.onnx" });

  it("has no thread until something asks it to speak", () => {
    // R18 wants the model resident, not resident from boot. Most sessions never
    // speak, and 325MB is too much to spend on the ones that do not.
    expect(synth.status).toBe("idle");
  });

  it("refuses a sequence past the model's cap before starting anything", async () => {
    // The only bound on a run, because a run cannot be cancelled once started —
    // terminating the thread mid-inference aborts the process.
    const tokens = Array.from({ length: MAX_TOKENS + 1 }, () => 16);
    await expect(synth.render(tokens, new Float32Array(256), 1)).rejects.toThrow(/exceeds/);
    expect(synth.status).toBe("idle");
  });

  it("refuses an empty sequence", async () => {
    await expect(synth.render([], new Float32Array(256), 1)).rejects.toThrow(/nothing to synthesise/);
    expect(synth.status).toBe("idle");
  });
});

describeWhen(MODEL_READY && VOICES_READY, NO_MODEL, "against the real model", () => {
  const synth = new Synthesiser({ model: MODEL_PATH });
  afterAll(async () => {
    await synth.stop();
  });

  const style = () => {
    const pack = readVoicePack(fs.readFileSync(VOICES_PATH));
    const mix = Object.entries(audio.preset.mix).map(([voice, weight]) => ({ voice, weight }));
    return styleRow(blend(pack, mix)!, audio.tokens.length)!;
  };

  it(
    "renders the oracle's line to the same length and the same sound",
    async () => {
      // The check the oracle exists for. Recorded from the reference before this
      // implementation existed, so agreement is evidence rather than a
      // restatement of what this code does.
      //
      // Sample count is asserted **exactly**: it is the product of the tokens,
      // the style row, the speed and the trim, so an off-by-one in any of them
      // moves it. Sample *values* are compared with a tolerance instead, because
      // the two sides run different ONNX Runtime builds (1.29.0 under Python,
      // 1.27.0 here) and bit-identity across them is not achievable. Measured
      // difference is ~2e-6 on a signal that peaks near 0.58; the tolerance is
      // far below anything audible and far above the difference.
      const rendered = await synth.render(audio.tokens, style(), audio.preset.speed);
      expect(rendered.sampleRate).toBe(SAMPLE_RATE);
      expect(rendered.samples.length).toBe(audio.trimmedSamples);
      for (let i = 0; i < audio.trimmedFirst8.length; i += 1) {
        expect(rendered.samples[i], `sample ${i}`).toBeCloseTo(audio.trimmedFirst8[i]!, 4);
      }
    },
    { timeout: 120_000 },
  );

  it(
    "still renders what it rendered when this was written",
    async () => {
      // A drift detector, not an oracle: the digest is *our* output, recorded by
      // `scripts/record-node-render.mts`. An onnxruntime bump that changed a
      // kernel would move every voice HAL has, and nothing else in the suite
      // would notice. If this fails and the change is intended, re-record it and
      // say so in the commit — the character now sounds different.
      const expected = JSON.parse(
        fs.readFileSync(path.join(FIXTURES, "rendered-node.json"), "utf8"),
      ) as { samples: number; sha256: string };
      const rendered = await synth.render(audio.tokens, style(), audio.preset.speed);
      expect(rendered.samples.length).toBe(expected.samples);
      expect(digest(rendered.samples)).toBe(expected.sha256);
    },
    { timeout: 120_000 },
  );

  it("keeps the model resident, so the second line does not pay the load again", async () => {
    const started = Date.now();
    await synth.render(audio.tokens, style(), audio.preset.speed);
    // Not a benchmark — a resident-model assertion. A cold load is seconds; a
    // warm render of a three-second line is well under that.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(synth.status).toBe("ready");
  }, { timeout: 60_000 });

  it("trims the padding the model adds", async () => {
    const rendered = await synth.render(audio.tokens, style(), audio.preset.speed);
    expect(rendered.samples.length).toBeLessThan(audio.samples);
    expect(Math.abs(rendered.samples[0]!)).toBeGreaterThanOrEqual(audio.silenceFloor);
  }, { timeout: 60_000 });

  it("starts a replacement after a stop rather than staying broken", async () => {
    const revived = new Synthesiser({ model: MODEL_PATH });
    await revived.render(audio.tokens, style(), audio.preset.speed);
    await revived.stop();
    expect(revived.status).toBe("idle");
    const again = await revived.render(audio.tokens, style(), audio.preset.speed);
    expect(again.samples.length).toBe(audio.trimmedSamples);
    await revived.stop();
  }, { timeout: 180_000 });
});

// The lifecycle, against a thread that answers instantly and dies on request.
// Exercised here rather than against the real model because loading 325MB to
// check that a queue drains is slow, and the only way to make the real thread
// die on demand is to terminate it mid-run — which aborts the process.
describe("the synthesis lifecycle", () => {
  const STUB = new URL("./stub-worker.mjs", import.meta.url);
  const style = new Float32Array(256);
  const make = () => new Synthesiser({ model: "unused.onnx", boot: STUB });
  /** Let a queued `render` get past its `await start()` and be dispatched. */
  const settle = () => new Promise((done) => setTimeout(done, 20));

  it("starts on the first request and stays ready", async () => {
    const synth = make();
    expect(synth.status).toBe("idle");
    await synth.render([16], style, 1);
    expect(synth.status).toBe("ready");
    await synth.stop();
  });

  it("fails every queued and in-flight request when the thread dies", async () => {
    // The case `measureInWorker` exists to handle: a thread that dies leaves the
    // queue holding a slot for a worker that is gone, and a promise nobody
    // settles is a request that hangs forever.
    const synth = make();
    await synth.render([16], style, 1);
    const dying = synth.render([9001], style, 1);
    const behind = synth.render([16], style, 1);
    await expect(dying).rejects.toBeInstanceOf(SynthUnavailable);
    await expect(behind).rejects.toBeInstanceOf(SynthUnavailable);
    expect(synth.status).toBe("failed");
    await synth.stop();
  });

  it("starts a replacement on the next request after a death", async () => {
    const synth = make();
    await synth.render([16], style, 1);
    await expect(synth.render([9001], style, 1)).rejects.toBeInstanceOf(SynthUnavailable);
    expect(synth.status).toBe("failed");
    const after = await synth.render([16], style, 1);
    expect(after.samples.length).toBeGreaterThan(0);
    expect(synth.status).toBe("ready");
    await synth.stop();
  });

  it("tells a refused input apart from a thread that could not run", async () => {
    // One is a bad line and the other is a fault to report. A caller that
    // could not tell them apart would show a fault for a typo.
    const synth = make();
    await expect(synth.render([9002], style, 1)).rejects.not.toBeInstanceOf(SynthUnavailable);
    expect(synth.status).toBe("ready");
    await synth.stop();
  });

  it("drops queued work on a supersede without touching what is in flight", async () => {
    // 9003 holds the thread long enough for a second request to be queued behind
    // it. A supersede drops what has not been sent; the one already inside the
    // thread cannot be recalled and is left to finish.
    const synth = make();
    await synth.render([16], style, 1);
    const kept = synth.render([9003], style, 1);
    const dropped = synth.render([16], style, 1);
    // `render` awaits the start before it queues, so both requests are still a
    // microtask away from existing. Waiting for the dispatch is the test being
    // honest about the API rather than reaching into it.
    await settle();
    synth.dropQueued(() => true);
    await expect(dropped).rejects.toThrow(/superseded/);
    await expect(kept).resolves.toBeDefined();
    await synth.stop();
  });

  it("stops safely while a render is in flight, waiting it out", async () => {
    // The hazard the whole design is built around: terminating a thread during a
    // run aborts the process. `stop()` waits rather than asking callers to be
    // careful — the first version of this test stopped over the top of a live
    // render and hung for two minutes, which is the point.
    const synth = make();
    await synth.render([16], style, 1); // warm, so the next one is dispatched at once
    const rendering = synth.render([9003], style, 1);
    await settle();
    await synth.stop();
    await expect(rendering).resolves.toBeDefined();
    expect(synth.status).toBe("idle");
  });

  it("refuses a request that arrives while it is stopping", async () => {
    // `render` awaits the start, so a stop can land in the gap. A request queued
    // against a synthesiser that is no longer running would never be dispatched
    // and never settle.
    const synth = make();
    await synth.render([16], style, 1);
    const stopping = synth.stop();
    await expect(synth.render([16], style, 1)).rejects.toBeInstanceOf(SynthUnavailable);
    await stopping;
  });

  it("trims the padding off what the thread returns", async () => {
    // The stub pads a silent sample at each end, so a trim that took the wrong
    // end or none at all shows up in the length.
    const synth = new Synthesiser({ model: "unused.onnx", boot: STUB });
    const rendered = await synth.render([16], style, 1);
    expect(rendered.samples.length).toBe(6);
    expect(rendered.durationMs).toBeCloseTo((6 / SAMPLE_RATE) * 1000, 6);
    await synth.stop();
  });
});
