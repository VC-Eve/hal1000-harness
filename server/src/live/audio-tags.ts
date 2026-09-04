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

/**
 * The most of a file to walk looking for the first audio frame.
 *
 * A frame sync is two bytes wide and eleven bits of it are ones, so junk
 * matches it often. The walk is bounded for the same reason `MAX_ENTRIES` is:
 * a file whose bytes are not music must cost a read and stop, not a scan of
 * forty megabytes.
 */
const MAX_SYNC_SCAN_BYTES = 64 * 1024;

/**
 * The longest span this reader will call a length.
 *
 * `MAX_TRACK_MS` in `transport.ts`, arriving in a second place deliberately: a
 * number rejected there is a report refused, and one rejected here never
 * becomes a stored length in the first place.
 */
const MAX_DURATION_MS = 6 * 60 * 60 * 1_000;

/** The most frames a VBR header may claim before it is read as a corrupt field. */
const MAX_VBR_FRAMES = 10_000_000;

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
   * The track's length, read from the file's own header, else 0.
   *
   * Zero still means not known, and that has not softened: this number becomes
   * the server's transport clock, so a length is only reported when the bytes
   * state one — a FLAC's `STREAMINFO`, an MP3's VBR frame count, or an MP3's
   * own bitrate applied to its own audio byte count. Anything that does not
   * parse, or that parses into an implausible span, is 0 rather than a
   * plausible-looking guess.
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
    // end of the file, and it has no BPM field at all — so there is no tempo
    // further to look for, but the audio frames still state a length and the
    // transport needs it.
    return reading(null, await mpegDuration(handle, 0));
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
 * container's own arithmetic rather than an estimate. An MP3 states its length
 * nowhere so plainly, which is why it gets a section of its own below rather
 * than eight bytes here.
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
  // A v2.4 footer is ten further bytes the size field does not count. Missing it
  // would leave the audio walk starting inside the tag, which is exactly the
  // place a false frame sync is most likely to be found.
  const audioFrom = end + (major === 4 && (flags & 0x10) !== 0 ? 10 : 0);

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
  let raw: string | null = null;

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
      // The tag is found, and the walk stops — but the read does not return
      // here. The length is in the audio that follows the tag, and returning on
      // the tempo is what left every MP3 unmeasured: the transport then held it
      // for the whole unmeasured grace before advancing, so a set with an MP3
      // in it looked stuck for thirty seconds a track.
      raw = id3Text(body);
      break;
    }
    offset += size;
  }
  return reading(raw, await mpegDuration(handle, audioFrom));
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

// ---------------------------------------------------------------------------
// MPEG audio: the length, from the frames themselves
// ---------------------------------------------------------------------------
//
// The refusal to infer a length from a bitrate alone was right and is kept: a
// number this file reports becomes the transport's clock, and a wrong one is
// worse than none, because "not known" is a state the transport handles and a
// wrong length is one it paces against. What follows is not an inference. It
// reads the first frame's own header, prefers the frame count a VBR header
// states, and falls back to that frame's own bitrate over the file's own audio
// byte count — which is exact for the constant-bitrate encode it applies to.
//
// Everything here is bounded and nothing throws. A header that does not parse,
// a frame count that is absurd, a span outside the plausible band: each is 0,
// which is the value that already means not known.

/** Kilobits per second, by version group, layer and the four-bit index in the header. */
const BITRATES: Record<"1" | "2", Record<1 | 2 | 3, readonly number[]>> = {
  // MPEG 1.
  "1": {
    1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  },
  // MPEG 2 and 2.5, which share a table.
  "2": {
    1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  },
};

/** Samples per second, by the version in the header and the two-bit index. */
const SAMPLE_RATES: Record<1 | 2 | 25, readonly number[]> = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  25: [11025, 12000, 8000],
};

interface FrameHeader {
  /** Where the frame's first byte is in the file. */
  offset: number;
  version: 1 | 2 | 25;
  layer: 1 | 2 | 3;
  bitrateKbps: number;
  sampleRate: number;
  /** How long the whole frame is, padding included. */
  frameBytes: number;
  /** 1152 for MPEG1 Layer III, 576 for MPEG2 and 2.5 — the divisor a frame count needs. */
  samplesPerFrame: number;
  /** Three is mono, and it is the one thing that moves a Xing header's offset. */
  channelMode: number;
}

/**
 * The length of an MPEG audio stream starting at or after `from`.
 *
 * Zero for anything that does not read as audio. The caller has an open handle
 * and already knows where the ID3v2 tag ended, which is why this takes both
 * rather than reopening the file and reparsing the tag.
 */
async function mpegDuration(handle: FileHandle, from: number): Promise<number> {
  try {
    const { size } = await handle.stat();
    if (!(Number.isFinite(size) && size > from)) return 0;
    // An ID3v1 tag is 128 bytes of text at the very end of the file. Counting it
    // as audio would add about eight seconds to a 128kbps track — small, and
    // exactly the kind of small a `remaining lt 5` condition lives inside.
    const audioEnd = size - (await trailingTagBytes(handle, size));
    if (audioEnd <= from) return 0;

    const frame = await findFrame(handle, from, audioEnd);
    if (!frame) return 0;

    const frames = await vbrFrameCount(handle, frame);
    if (frames > 0) return plausible((frames * frame.samplesPerFrame * 1_000) / frame.sampleRate);

    // Constant bitrate: the file's own audio bytes at the first frame's own
    // rate. Bytes times eight over kilobits per second is milliseconds directly.
    return plausible(((audioEnd - frame.offset) * 8) / frame.bitrateKbps);
  } catch {
    // The contract the rest of this file keeps: a header that cannot be read is
    // a file with nothing to say, never a failed import.
    return 0;
  }
}

/** How many bytes at the end of the file are a tag rather than audio. */
async function trailingTagBytes(handle: FileHandle, size: number): Promise<number> {
  if (size < 128) return 0;
  const tail = await readAt(handle, size - 128, 3);
  return tail.length === 3 && tail.toString("latin1") === "TAG" ? 128 : 0;
}

/**
 * The first frame that reads as one, walking forward from `from`.
 *
 * A sync is eleven set bits, so junk matches it every few hundred bytes and a
 * reader that believed the first hit would report a length taken from a cover
 * image. A candidate is accepted only when a second frame sits exactly where
 * this one's own length says it should — or when it runs to the end of the
 * audio, which is what a file holding one frame looks like.
 */
async function findFrame(
  handle: FileHandle,
  from: number,
  audioEnd: number,
): Promise<FrameHeader | null> {
  const window = await readAt(handle, from, Math.min(MAX_SYNC_SCAN_BYTES, audioEnd - from));
  for (let at = 0; at + 4 <= window.length; at += 1) {
    if (window[at] !== 0xff || (window[at + 1]! & 0xe0) !== 0xe0) continue;
    const frame = parseFrame(window, at, from + at);
    if (!frame) continue;
    const next = frame.offset + frame.frameBytes;
    if (next >= audioEnd) return frame;
    const ahead = await readAt(handle, next, 2);
    if (ahead.length === 2 && ahead[0] === 0xff && (ahead[1]! & 0xe0) === 0xe0) return frame;
  }
  return null;
}

/** One four-byte frame header, or null for four bytes that are not one. */
function parseFrame(buffer: Buffer, at: number, offset: number): FrameHeader | null {
  const b1 = buffer[at + 1]!;
  const b2 = buffer[at + 2]!;
  const b3 = buffer[at + 3]!;

  const versionBits = (b1 >> 3) & 0x03;
  // 1 is the reserved value: a file using it is one this reader has
  // misidentified rather than one with an unusual encoding.
  if (versionBits === 1) return null;
  const version: 1 | 2 | 25 = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25;

  const layerBits = (b1 >> 1) & 0x03;
  if (layerBits === 0) return null;
  const layer: 1 | 2 | 3 = layerBits === 3 ? 1 : layerBits === 2 ? 2 : 3;

  const bitrateIndex = (b2 >> 4) & 0x0f;
  // Free format (0) states no rate at all and 15 is forbidden. Neither can be
  // paced against, so neither is a frame this reader accepts.
  if (bitrateIndex === 0 || bitrateIndex === 15) return null;
  const bitrateKbps = BITRATES[version === 1 ? "1" : "2"][layer][bitrateIndex] ?? 0;
  if (bitrateKbps <= 0) return null;

  const rateIndex = (b2 >> 2) & 0x03;
  if (rateIndex === 3) return null;
  const sampleRate = SAMPLE_RATES[version][rateIndex] ?? 0;
  if (sampleRate <= 0) return null;

  const padding = (b2 >> 1) & 0x01;
  const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576;
  // Layer I counts its padding in four-byte slots; every other layer in bytes.
  const slot = layer === 1 ? 4 : 1;
  const frameBytes =
    Math.floor(((samplesPerFrame / 8) * bitrateKbps * 1_000) / sampleRate) + padding * slot;
  if (!(Number.isFinite(frameBytes) && frameBytes > 4)) return null;

  return {
    offset,
    version,
    layer,
    bitrateKbps,
    sampleRate,
    frameBytes,
    samplesPerFrame,
    channelMode: (b3 >> 6) & 0x03,
  };
}

/**
 * The frame count a VBR header states, or 0 for a frame carrying none.
 *
 * This is the number that makes a variable-bitrate file measurable at all: its
 * first frame's bitrate says nothing about the rest of the encode, so the
 * arithmetic below would be wrong by however much the encoder varied. Two
 * layouts exist and both are read — Xing/Info in the side-information area,
 * whose offset moves with the version and the channel mode, and VBRI at a fixed
 * offset written by one encoder family.
 */
async function vbrFrameCount(handle: FileHandle, frame: FrameHeader): Promise<number> {
  const mono = frame.channelMode === 3;
  const sideInfo = frame.version === 1 ? (mono ? 17 : 32) : mono ? 9 : 17;

  const xing = await readAt(handle, frame.offset + 4 + sideInfo, 12);
  if (xing.length === 12) {
    const tag = xing.toString("latin1", 0, 4);
    // "Info" is the same header written by an encoder that produced constant
    // bitrate. Its frame count is just as exact, and reading only "Xing" would
    // send every LAME CBR file down the arithmetic path for no reason.
    if (tag === "Xing" || tag === "Info") {
      const flags = xing.readUInt32BE(4);
      if ((flags & 0x01) !== 0) return countable(xing.readUInt32BE(8));
    }
  }

  const vbri = await readAt(handle, frame.offset + 4 + 32, 18);
  if (vbri.length === 18 && vbri.toString("latin1", 0, 4) === "VBRI") {
    return countable(vbri.readUInt32BE(14));
  }
  return 0;
}

/** An acceptance: a frame count is one only inside a band a real encode reaches. */
function countable(frames: number): number {
  return Number.isFinite(frames) && frames > 0 && frames <= MAX_VBR_FRAMES ? frames : 0;
}

/**
 * A span, or 0 for one nobody should pace against.
 *
 * Written as an acceptance rather than as a rejection, which is the rule
 * `docs/solutions/a-threshold-guard-written-as-a-negation-fails-open-on-nan.md`
 * records: `NaN > MAX` is false, so a guard phrased as "reject what is too
 * long" hands `NaN` straight through and the transport paces against it.
 */
function plausible(ms: number): number {
  const rounded = Math.round(ms);
  return Number.isFinite(rounded) && rounded >= 1 && rounded <= MAX_DURATION_MS ? rounded : 0;
}
