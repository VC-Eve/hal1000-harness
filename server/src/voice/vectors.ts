// The voice pack, and the arithmetic that turns a preset into a style vector.
//
// `voices-v1.0.bin` is a NumPy `.npz`, which is a zip archive of `.npy` arrays —
// one per stock voice, each `(510, 1, 256)` little-endian float32. The entries
// are **stored**, not deflated, so reading one is a byte-range slice and this
// module needs no decompression. That is measured rather than assumed, and it is
// checked at read time rather than trusted: a future pack that deflates its
// entries must fail loudly instead of being read as garbage floats.
//
// The 510 rows are not 510 voices. They are one style vector per phoneme count:
// the row is chosen by how many tokens are being spoken, so a short line and a
// long one in the same voice use different rows. Getting that index wrong does
// not error — it produces a voice that is subtly not the one the operator
// authored, on every line. The reference picks `min(count, rows) - 1`, and the
// two padding tokens the model is handed are added *after* the row is chosen.

/** Rows per voice: one style vector per phoneme count, 1-based at the source. */
export const VOICE_ROWS = 510;

/** Floats per style vector. The model's `style` input is `[1, 256]`. */
export const VOICE_DIM = 256;

const NPY_MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]; // \x93NUMPY
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const STORED = 0;

/** A pack that could not be read. Its message names what was wrong. */
export class VoicePackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoicePackError";
  }
}

/**
 * The stock voices, read once.
 *
 * `vectors` holds each voice flat — `VOICE_ROWS * VOICE_DIM` floats, row-major —
 * because the middle axis of the source shape is 1 and a nested array would cost
 * 510 allocations per voice for nothing.
 */
export interface VoicePack {
  names: string[];
  vectors: Map<string, Float32Array>;
}

/**
 * Read a `.npz` voice pack.
 *
 * Walks the central directory rather than scanning for local headers: a local
 * header does not carry a reliable size when a data descriptor is used, and the
 * central directory is the archive's own index.
 */
export function readVoicePack(bytes: Uint8Array): VoicePack {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view, bytes.byteLength);
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const vectors = new Map<string, Float32Array>();
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new VoicePackError(`central directory entry ${i} is malformed`);
    }
    const method = view.getUint16(offset + 10, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decodeAscii(bytes, offset + 46, nameLength);

    if (method !== STORED) {
      // Not a limitation worth working around silently. A deflated pack read as
      // stored yields plausible-looking noise, and a voice made of noise is a
      // bug nobody can hear the cause of.
      throw new VoicePackError(
        `entry ${name} is compressed (method ${method}); this reader handles stored entries only`,
      );
    }

    vectors.set(stripSuffix(name), readNpyAt(bytes, view, localOffset, name));
    offset += 46 + nameLength + extraLength + commentLength;
  }

  if (vectors.size === 0) throw new VoicePackError("voice pack contains no voices");
  return { names: [...vectors.keys()].sort(), vectors };
}

/**
 * One voice blended from a preset's mix, or null if a name is not in the pack.
 *
 * Weights are normalised here and nowhere else that renders: `shares` in
 * `shared/src/voices.ts` answers the same question for the editor, and the two
 * agree because both divide by the same total. A zero total is refused upstream
 * by `cleanMix`; refused again here rather than dividing, because this function
 * is reachable from a hand-edited file.
 */
export function blend(
  pack: VoicePack,
  mix: readonly { voice: string; weight: number }[],
): Float32Array | null {
  if (mix.length === 0) return null;
  let total = 0;
  for (const entry of mix) {
    if (!Number.isFinite(entry.weight) || entry.weight < 0) return null;
    total += entry.weight;
  }
  if (!(total > 0)) return null;

  const out = new Float32Array(VOICE_ROWS * VOICE_DIM);
  for (const entry of mix) {
    const vector = pack.vectors.get(entry.voice);
    if (!vector) return null;
    const share = entry.weight / total;
    if (share === 0) continue;
    for (let i = 0; i < out.length; i += 1) out[i] = out[i]! + vector[i]! * share;
  }
  return out;
}

/**
 * The style row for a line of `tokenCount` tokens.
 *
 * `min(count, rows) - 1`, which is the reference's rule and is off-by-one from
 * the obvious guess. `tokenCount` is the count *before* the model's two padding
 * tokens are added; counting them would shift every line by one row.
 *
 * A count of zero has no row. The caller has nothing to synthesise in that case
 * and should not have got here, so this refuses rather than clamping to row 0.
 */
export function styleRow(vector: Float32Array, tokenCount: number): Float32Array | null {
  if (!Number.isInteger(tokenCount) || tokenCount < 1) return null;
  const row = Math.min(tokenCount, VOICE_ROWS) - 1;
  return vector.subarray(row * VOICE_DIM, (row + 1) * VOICE_DIM);
}

// ---------------------------------------------------------------------------

function findEocd(view: DataView, length: number): number {
  // The end-of-central-directory record is last, but a trailing comment can push
  // it back by up to 64KB, so it is found by scanning rather than by position.
  const earliest = Math.max(0, length - 22 - 0xffff);
  for (let i = length - 22; i >= earliest; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  throw new VoicePackError("not a zip archive: no end-of-central-directory record");
}

function readNpyAt(bytes: Uint8Array, view: DataView, localOffset: number, name: string): Float32Array {
  if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
    throw new VoicePackError(`entry ${name} has no local header`);
  }
  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const start = localOffset + 30 + nameLength + extraLength;

  for (let i = 0; i < NPY_MAGIC.length; i += 1) {
    if (bytes[start + i] !== NPY_MAGIC[i]) throw new VoicePackError(`entry ${name} is not a .npy`);
  }
  const major = bytes[start + 6]!;
  // v1 writes a 2-byte header length, v2 a 4-byte one. Reading the wrong width
  // puts the data offset in the middle of the header text.
  const headerLengthSize = major >= 2 ? 4 : 2;
  const headerStart = start + 8 + headerLengthSize;
  const headerLength =
    headerLengthSize === 2 ? view.getUint16(start + 8, true) : view.getUint32(start + 8, true);
  if (headerStart + headerLength > bytes.byteLength) {
    throw new VoicePackError(`entry ${name} has a truncated header`);
  }
  const header = decodeAscii(bytes, headerStart, headerLength);

  const descr = /'descr'\s*:\s*'([^']+)'/.exec(header)?.[1];
  if (descr !== "<f4") {
    throw new VoicePackError(`entry ${name} has dtype ${descr ?? "unknown"}, expected <f4`);
  }
  if (/'fortran_order'\s*:\s*True/.test(header)) {
    throw new VoicePackError(`entry ${name} is Fortran-ordered`);
  }
  const shape = /'shape'\s*:\s*\(([^)]*)\)/.exec(header)?.[1];
  const dims = (shape ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(Number);
  const expected = VOICE_ROWS * VOICE_DIM;
  if (dims.some((d) => !Number.isInteger(d)) || dims.reduce((a, b) => a * b, 1) !== expected) {
    throw new VoicePackError(`entry ${name} has shape (${shape ?? "?"}), expected ${expected} floats`);
  }

  const dataStart = headerStart + headerLength;
  if (dataStart + expected * 4 > bytes.byteLength) {
    throw new VoicePackError(`entry ${name} is truncated`);
  }
  // Copied rather than viewed: a subarray would pin the whole pack in memory for
  // the life of one voice, and the pack is 28MB.
  const out = new Float32Array(expected);
  for (let i = 0; i < expected; i += 1) out[i] = view.getFloat32(dataStart + i * 4, true);
  return out;
}

function decodeAscii(bytes: Uint8Array, start: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[start + i]!);
  return out;
}

function stripSuffix(name: string): string {
  return name.endsWith(".npy") ? name.slice(0, -4) : name;
}
