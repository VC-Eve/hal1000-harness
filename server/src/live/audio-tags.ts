import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { MAX_BPM, MIN_BPM, usableBpm } from "../../../shared/src/audio.js";

/**
 * What a file says about itself, read from its own header.
 *
 * Hand-written rather than taken from a dependency, and that is the smaller
 * choice rather than the braver one. The two things wanted here are one integer
 * (`TBPM` in an ID3v2 tag, `BPM=` in a Vorbis comment) and, where the container
 * states it exactly, a length. A tag library brings a parser for every field of
 * every container to deliver those two, and the alternatives that also decode
 * bring a native binary or a second runtime — which origin R30 rules out for the
 * detector and there is no reason to accept here.
 *
 * Nothing in this file trusts what it reads. Every length is bounded before it
 * is used as a length, every frame walk has a ceiling, and the BPM goes through
 * `usableBpm` before it is called a tempo: a tag is a number a stranger's
 * software wrote into a file (origin R29).
 */

/** The most of a metadata block that is worth reading to find one integer. */
const MAX_BLOCK_BYTES = 1024 * 1024;

/** The most frames or blocks to walk before giving up on a malformed header. */
const MAX_ENTRIES = 512;

/** The most of a text frame to read. A BPM is three characters. */
const MAX_TEXT_BYTES = 4096;

/** How much of an unusable tag to quote back. */
const QUOTE_MAX = 24;

export interface TagReading {
  /** The tempo the file's tag claims, when it claims a usable one. */
  bpm: number | null;
  /**
   * Why a tag that *was* present is not being used.
   *
   * Set only when there was something to reject. A file with no BPM tag at all
   * is the ordinary case — most of the library, per origin R30 — and saying
   * something about it on every import would bury the tags that were wrong.
   */
  ignored?: string;
  /**
   * The track's length, when the container states it exactly, else 0.
   *
   * Zero means not known. Nothing here estimates: this number becomes the
   * server's transport clock in U6, and a length guessed from a bitrate is a
   * drift the readouts would then broadcast as fact.
   */
  durationMs: number;
}

const NOTHING: TagReading = { bpm: null, durationMs: 0 };

/**
 * Read what a file's own header says.
 *
 * Never throws: an unreadable or truncated file is one with nothing to say, and
 * the import that called this has already copied the bytes in. A tag reader
 * that could fail an import would make a corrupt header worse than a missing
 * one.
 */
export async function readAudioTags(file: string): Promise<TagReading> {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(file, "r");
    const magic = await readAt(handle, 0, 4);
    if (magic.length < 4) return NOTHING;
    if (magic.toString("latin1") === "fLaC") return await readFlac(handle);
    if (magic.toString("latin1", 0, 3) === "ID3") return await readId3(handle);
    // An MP3 with no ID3v2 tag. ID3v1 is the other place a tag could be, at the
    // end of the file, and it has no BPM field at all — so there is nothing
    // further to look for.
    return NOTHING;
  } catch {
    return NOTHING;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Bytes at an offset, however few of them exist.
 *
 * Reading a range rather than slurping the file is what keeps this bounded on a
 * 40MB FLAC: a frame's size is in its header, so a picture frame is skipped by
 * moving the offset past it without ever holding it.
 */
async function readAt(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  return buffer.subarray(0, bytesRead);
}

// ---------------------------------------------------------------------------
// FLAC: STREAMINFO for the length, VORBIS_COMMENT for the tempo
// ---------------------------------------------------------------------------

async function readFlac(handle: FileHandle): Promise<TagReading> {
  let offset = 4;
  let durationMs = 0;
  let raw: string | null = null;

  for (let n = 0; n < MAX_ENTRIES; n += 1) {
    const head = await readAt(handle, offset, 4);
    if (head.length < 4) break;
    const last = (head[0]! & 0x80) !== 0;
    const type = head[0]! & 0x7f;
    const size = head.readUIntBE(1, 3);
    offset += 4;

    if (type === 0 && size >= 34) {
      durationMs = flacDuration(await readAt(handle, offset, 34));
    } else if (type === 4 && size > 0 && size <= MAX_BLOCK_BYTES) {
      raw = vorbisBpm(await readAt(handle, offset, size));
    }

    offset += size;
    if (last) break;
  }
  return reading(raw, durationMs);
}

/**
 * The exact length of a FLAC, from the eight bytes that state it.
 *
 * Sample rate and total sample count are both in STREAMINFO, so this is the
 * container's own arithmetic rather than an estimate — which is why FLAC gets a
 * duration at import and MP3 does not.
 */
function flacDuration(block: Buffer): number {
  if (block.length < 18) return 0;
  // Twenty bits of sample rate, three of channel count, five of bit depth and
  // thirty-six of total samples, packed across the eight bytes at offset 10.
  const packed = block.readBigUInt64BE(10);
  const sampleRate = Number(packed >> 44n);
  const totalSamples = Number(packed & 0xf_ffff_ffffn);
  if (sampleRate <= 0 || totalSamples <= 0) return 0;
  const ms = Math.round((totalSamples * 1000) / sampleRate);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** The first BPM-ish comment in a VORBIS_COMMENT block, as written. */
function vorbisBpm(block: Buffer): string | null {
  let at = 0;
  const u32 = (): number | null => {
    if (at + 4 > block.length) return null;
    const value = block.readUInt32LE(at);
    at += 4;
    return value;
  };

  const vendor = u32();
  if (vendor === null || vendor < 0 || at + vendor > block.length) return null;
  at += vendor;
  const count = u32();
  if (count === null) return null;

  for (let n = 0; n < Math.min(count, MAX_ENTRIES); n += 1) {
    const length = u32();
    // A length past the end of the block is a malformed comment list, not a
    // reason to read somebody else's memory — stop rather than clamp.
    if (length === null || length < 0 || at + length > block.length) return null;
    const text = block.toString("utf8", at, at + length);
    at += length;
    const eq = text.indexOf("=");
    if (eq <= 0) continue;
    if (isBpmKey(text.slice(0, eq))) return text.slice(eq + 1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// ID3v2: the TBPM text frame
// ---------------------------------------------------------------------------

async function readId3(handle: FileHandle): Promise<TagReading> {
  const header = await readAt(handle, 0, 10);
  if (header.length < 10) return NOTHING;
  const major = header[3]!;
  if (major < 2 || major > 4) return NOTHING;
  const flags = header[5]!;
  const end = 10 + syncsafe(header, 6);

  let offset = 10;
  if ((flags & 0x40) !== 0) {
    // An extended header, whose own size is counted one way in v2.3 (the four
    // bytes exclude themselves, plain big-endian) and another in v2.4
    // (syncsafe, and inclusive). Getting this wrong lands the frame walk in the
    // middle of a field, where every id looks like padding.
    const ext = await readAt(handle, offset, 4);
    if (ext.length < 4) return NOTHING;
    offset += major === 4 ? syncsafe(ext, 0) : ext.readUInt32BE(0) + 4;
  }

  const idBytes = major === 2 ? 3 : 4;
  const headerBytes = major === 2 ? 6 : 10;

  for (let n = 0; n < MAX_ENTRIES && offset + headerBytes <= end; n += 1) {
    const frame = await readAt(handle, offset, headerBytes);
    if (frame.length < headerBytes) break;
    // A zero byte where an id belongs is the padding that follows the last
    // frame, not a frame with an odd name.
    if (frame[0] === 0) break;
    const id = frame.toString("latin1", 0, idBytes);
    const size =
      major === 2
        ? frame.readUIntBE(3, 3)
        : major === 4
          ? syncsafe(frame, 4)
          : frame.readUInt32BE(4);
    if (size <= 0) break;
    offset += headerBytes;

    if (id === "TBPM" || id === "TBP") {
      const body = await readAt(handle, offset, Math.min(size, MAX_TEXT_BYTES));
      return reading(id3Text(body), 0);
    }
    offset += size;
  }
  // No length: an MP3's duration is a frame scan or a Xing header this does not
  // read, and a guess here would become the transport clock. U6 owns it.
  return reading(null, 0);
}

/** Four bytes holding seven bits each — ID3's own way of never writing 0xFF. */
function syncsafe(buffer: Buffer, at: number): number {
  if (at + 4 > buffer.length) return 0;
  return (
    ((buffer[at]! & 0x7f) << 21) |
    ((buffer[at + 1]! & 0x7f) << 14) |
    ((buffer[at + 2]! & 0x7f) << 7) |
    (buffer[at + 3]! & 0x7f)
  );
}

/** One ID3 text frame's payload: an encoding byte, then the text in it. */
function id3Text(body: Buffer): string | null {
  if (body.length < 2) return null;
  const encoding = body[0]!;
  const text = body.subarray(1);
  switch (encoding) {
    case 1: {
      // UTF-16 with a byte-order mark. Swapped rather than decoded by hand,
      // because Node has no `utf16be`.
      if (text.length < 2) return null;
      const bigEndian = text[0] === 0xfe && text[1] === 0xff;
      const body16 = text.subarray(2);
      return trimText((bigEndian ? Buffer.from(body16).swap16() : body16).toString("utf16le"));
    }
    case 2:
      return trimText(Buffer.from(text).swap16().toString("utf16le"));
    case 3:
      return trimText(text.toString("utf8"));
    default:
      return trimText(text.toString("latin1"));
  }
}

function trimText(text: string): string | null {
  // Trailing NULs are ordinary in a text frame; a lone one is an empty tag.
  const trimmed = text.replace(/\0+$/, "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isBpmKey(key: string): boolean {
  const upper = key.trim().toUpperCase();
  return upper === "BPM" || upper === "TBPM";
}

/**
 * Turn what the tag said into what the store may hold.
 *
 * The one place a tag becomes a number, so the two ways of being unusable —
 * unparseable, and out of the band origin R31 holds a detector to — are both
 * *said* rather than silently dropped. `usableBpm` is the acceptance test:
 * `Number("")` is 0 and `Number("fast")` is `NaN`, and a comparison written as
 * a negation would let the second straight through.
 */
function reading(raw: string | null, durationMs: number): TagReading {
  // An empty value is a tag nobody filled in, not a tag that says something
  // wrong — `Number("")` is 0, which would otherwise be reported as a tempo
  // outside the range.
  if (raw === null || raw.trim().length === 0) return { bpm: null, durationMs };
  const parsed = Number(raw.trim());
  const usable = usableBpm(parsed);
  if (usable !== null) return { bpm: usable, durationMs };
  const quoted = raw.trim().slice(0, QUOTE_MAX);
  return {
    bpm: null,
    durationMs,
    ignored: Number.isFinite(parsed)
      ? `Its BPM tag reads ${quoted}, outside ${MIN_BPM}–${MAX_BPM}, so it was ignored.`
      : `Its BPM tag reads "${quoted}", which is not a tempo, so it was ignored.`,
  };
}
