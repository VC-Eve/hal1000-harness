import { promises as fs } from "node:fs";

// Reads a byte range from a file, closing the handle on every path.
//
// Shared because both tailers need exactly this and had identical copies: a
// Windows-specific fix applied to one would silently not apply to the other.
// The surrounding offset and partial-line policy stays with each tailer, since
// a JSONL session log and a plain text log genuinely differ there.
export async function readByteRange(file: string, from: number, to: number): Promise<Buffer> {
  const handle = await fs.open(file, "r");
  try {
    const length = to - from;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, from);
    return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
