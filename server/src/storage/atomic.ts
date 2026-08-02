import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const RETRIES = 5;
const RETRY_DELAY_MS = 50;

// Atomic JSON write: temp file in the same directory, then rename. Windows
// file locks (Defender, indexers) intermittently fail the rename with
// EPERM/EBUSY, so the rename retries briefly.
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  // Unique per write — a deterministic name would collide when two writes to
  // the same file overlap inside this one process.
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  let lastErr: unknown;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  await fs.rm(tmp, { force: true });
  throw lastErr;
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}
