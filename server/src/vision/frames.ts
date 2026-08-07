import { promises as fs } from "node:fs";
import path from "node:path";

// Retained frames.
//
// A bounded rolling window, so an entry HAL produced can be traced back to what
// it was reacting to. Bounded and purgeable is the whole point: this is the
// only part of HAL that writes pictures of a person to disk, so "how many" is a
// setting and "delete them all" is one call.
export class FrameStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "vision-frames");
  }

  get directory(): string {
    return this.dir;
  }

  // Named by capture time so the sort order is chronological without stat()ing
  // anything, and so a file on disk says when it was taken.
  async save(jpeg: Buffer, at: Date, keep: number): Promise<string | null> {
    if (keep <= 0) {
      await this.clear();
      return null;
    }
    await fs.mkdir(this.dir, { recursive: true });
    const name = `${at.toISOString().replace(/[:.]/g, "-")}.jpg`;
    const file = path.join(this.dir, name);
    await fs.writeFile(file, jpeg);
    await this.prune(keep);
    return file;
  }

  async prune(keep: number): Promise<void> {
    const files = await this.list();
    // Oldest first, so the tail is what survives.
    const doomed = files.slice(0, Math.max(0, files.length - keep));
    for (const file of doomed) {
      await fs.rm(file, { force: true }).catch(() => {});
    }
  }

  async clear(): Promise<void> {
    await fs.rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }

  async list(): Promise<string[]> {
    const entries = await fs.readdir(this.dir).catch(() => [] as string[]);
    return entries
      .filter((e) => e.endsWith(".jpg"))
      .sort()
      .map((e) => path.join(this.dir, e));
  }
}
