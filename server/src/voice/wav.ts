// Float samples to a file an `<audio>` element will play.
//
// The model emits float32 at 24kHz and a browser media element will not take
// that. The conversion is here rather than in the worker so the thread boundary
// stays float32 — the worker's job is the model call and nothing else — and so
// the trim below happens on full-precision samples.

/** The model's output rate. Not configurable: it is a property of the graph. */
export const SAMPLE_RATE = 24000;

/**
 * Below this, a sample counts as silence for trimming.
 *
 * Kokoro pads every render, and untrimmed every line lands late by a tenth of a
 * second — measured in the sibling project's voiceover, where it put every line
 * behind its own shot. The floor is above the noise the model produces in its
 * padding and far below anything audible; it is deliberately not zero, because
 * the padding is not digital silence.
 */
const SILENCE_FLOOR = 1e-3;

/**
 * Trim the model's padding from both ends.
 *
 * Leading silence is the load-bearing half: it is what makes a line start when
 * it is supposed to. The trailing trim matters less but costs nothing, and it
 * keeps a sentence's measured duration equal to the length of the speech in it,
 * which is what the subtitle for that sentence is shown for.
 *
 * A buffer that is silent throughout returns empty rather than the whole thing:
 * there is nothing to say, and a caller that plays it would hold the transport
 * ducked for the length of the padding.
 */
export function trimSilence(samples: Float32Array): Float32Array {
  let start = 0;
  let end = samples.length;
  while (start < end && Math.abs(samples[start]!) < SILENCE_FLOOR) start += 1;
  while (end > start && Math.abs(samples[end - 1]!) < SILENCE_FLOOR) end -= 1;
  return samples.subarray(start, end);
}

/**
 * A 16-bit mono WAV.
 *
 * 16-bit rather than float32 because every browser plays it and the size is
 * halved; the model's output is well inside what 16 bits represents. Samples are
 * clamped before scaling — a value outside [-1, 1] would otherwise wrap and turn
 * a loud sample into the opposite sign, which sounds like a click rather than
 * like clipping.
 */
export function toWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Buffer {
  const bytesPerSample = 2;
  const dataBytes = samples.length * bytesPerSample;
  const out = Buffer.alloc(44 + dataBytes);

  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16); // PCM header length
  out.writeUInt16LE(1, 20); // format: PCM
  out.writeUInt16LE(1, 22); // channels: mono
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
  out.writeUInt16LE(bytesPerSample, 32); // block align
  out.writeUInt16LE(16, 34); // bits per sample
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    out.writeInt16LE(Math.round(clamped * 32767), 44 + i * bytesPerSample);
  }
  return out;
}

/** How long a buffer of samples lasts, in milliseconds. */
export function durationMs(samples: Float32Array, sampleRate = SAMPLE_RATE): number {
  return (samples.length / sampleRate) * 1000;
}
