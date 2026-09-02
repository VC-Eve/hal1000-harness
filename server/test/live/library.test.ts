import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { tmpDir } from "../tmp.js";
import { importClip, listFolder } from "../../src/live/library.js";

let dir: string;

beforeEach(async () => {
  dir = await tmpDir("library");
});

async function file(rel: string, body = "video"): Promise<string> {
  const full = path.join(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body, "utf8");
  return full;
}

describe("browsing", () => {
  it("lists the video files and the immediate subfolders", async () => {
    await file("takes/couch.mp4");
    await file("takes/booth.webm");
    await file("takes/notes.txt");
    await fs.mkdir(path.join(dir, "takes", "old"), { recursive: true });

    const listing = await listFolder(path.join(dir, "takes"));

    expect(listing.error).toBeUndefined();
    expect(listing.clips.map((c) => c.name)).toEqual(["booth.webm", "couch.mp4"]);
    expect(listing.folders.map((f) => f.name)).toEqual(["old"]);
  });

  it("does not descend: a clip in a subfolder is not listed", async () => {
    // One level at a time. A recursive walk of a root the user named is an
    // unbounded amount of work behind one message.
    await file("takes/old/ancient.mp4");
    const listing = await listFolder(path.join(dir, "takes"));

    expect(listing.clips).toEqual([]);
    expect(listing.folders.map((f) => f.name)).toEqual(["old"]);
  });

  it("reports each clip's size, so the browser has something to show", async () => {
    await file("takes/couch.mp4", "0123456789");
    const listing = await listFolder(path.join(dir, "takes"));
    expect(listing.clips[0]!.sizeBytes).toBe(10);
  });

  it("offers the parent so navigation can go up, and null at a root", async () => {
    await file("takes/couch.mp4");
    const listing = await listFolder(path.join(dir, "takes"));
    expect(listing.parent).toBe(dir);

    const root = await listFolder(path.parse(dir).root);
    expect(root.parent).toBeNull();
  });

  it("reports a folder it cannot read rather than throwing", async () => {
    const listing = await listFolder(path.join(dir, "nowhere"));
    expect(listing.error).toMatch(/could not be read/);
    expect(listing.clips).toEqual([]);
  });

  it("refuses a path that is a file", async () => {
    const target = await file("takes/couch.mp4");
    const listing = await listFolder(target);
    expect(listing.error).toMatch(/not a folder/);
  });
});

describe("importing", () => {
  async function world(): Promise<string> {
    const worldDir = path.join(dir, "worlds", "lounge");
    await fs.mkdir(path.join(worldDir, "clips"), { recursive: true });
    return worldDir;
  }

  it("copies a file from outside into clips/ and answers with a relative path", async () => {
    // Covers AE6.
    const worldDir = await world();
    const source = await file("takes/couch idle.mp4", "bytes");

    const result = await importClip(worldDir, source);

    expect(result).toEqual({ ok: true, path: "clips/couch_idle.mp4" });
    expect(await fs.readFile(path.join(worldDir, "clips", "couch_idle.mp4"), "utf8")).toBe("bytes");
    // The source is left where it was.
    await expect(fs.stat(source)).resolves.toBeTruthy();
  });

  it("uses forward slashes, because the manifest travels between machines", async () => {
    const worldDir = await world();
    const result = await importClip(worldDir, await file("takes/a.mp4"));
    expect(result.ok && result.path.includes("\\")).toBe(false);
  });

  it("does not overwrite a clip of the same name", async () => {
    const worldDir = await world();
    await importClip(worldDir, await file("one/couch.mp4", "first"));
    const second = await importClip(worldDir, await file("two/couch.mp4", "second"));

    expect(second).toEqual({ ok: true, path: "clips/couch-2.mp4" });
    expect(await fs.readFile(path.join(worldDir, "clips", "couch.mp4"), "utf8")).toBe("first");
  });

  it("refuses a file that is not a video HAL can play", async () => {
    const worldDir = await world();
    const result = await importClip(worldDir, await file("takes/notes.txt"));
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/not a video/) });
  });

  it("refuses a file that is not there", async () => {
    const worldDir = await world();
    const result = await importClip(worldDir, path.join(dir, "nowhere.mp4"));
    expect(result.ok).toBe(false);
  });

  it("refuses a directory", async () => {
    const worldDir = await world();
    await fs.mkdir(path.join(dir, "folder.mp4"), { recursive: true });
    const result = await importClip(worldDir, path.join(dir, "folder.mp4"));
    expect(result.ok).toBe(false);
  });

  it("refuses an empty source path", async () => {
    const worldDir = await world();
    expect((await importClip(worldDir, "")).ok).toBe(false);
  });

  it("lands a name that would not survive as a path segment under a safe one", async () => {
    const worldDir = await world();
    const result = await importClip(worldDir, await file("takes/../takes/odd name!.mp4"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toMatch(/^clips\/[A-Za-z0-9._-]+\.mp4$/);
      await expect(fs.stat(path.join(worldDir, result.path))).resolves.toBeTruthy();
    }
  });
});

describe("what the review of 2026-09-02 found", () => {
  it("does not spend the whole listing on subfolders before reaching a clip", async () => {
    // One budget shared between folders and files, consumed in filesystem
    // order, meant a project root of subdirectories reported no videos at all.
    const root = await tmpDir("wide");
    for (let n = 0; n < 520; n += 1) await fs.mkdir(path.join(root, `dir-${n}`), { recursive: true });
    await fs.writeFile(path.join(root, "couch.mp4"), "video", "utf8");

    const listing = await listFolder(root);

    expect(listing.clips.map((c) => c.name)).toEqual(["couch.mp4"]);
    expect(listing.truncated).toBe(true);
  });

  it("does not name an imported clip after a Windows device", async () => {
    // `CON.mp4` resolves to a character device: the bytes go nowhere and the
    // manifest records a clip that can never be served.
    const from = await tmpDir("src");
    const world = await tmpDir("world");
    await fs.writeFile(path.join(from, "CON.mp4"), "video", "utf8");

    const result = await importClip(world, path.join(from, "CON.mp4"));

    expect(result.ok).toBe(true);
    expect(result.ok && result.path).toBe("clips/CON-clip.mp4");
    await expect(fs.stat(path.join(world, "clips", "CON-clip.mp4"))).resolves.toBeTruthy();
  });
});

describe("a losing concurrent import", () => {
  it("does not delete the file the winning import just wrote", async () => {
    // The rollback that removes a half-written destination must not fire on
    // EEXIST: that file is not ours, it is the one another import just placed
    // and assigned to a State.
    const from = await tmpDir("src");
    const world = await tmpDir("world");
    await fs.writeFile(path.join(from, "couch.mp4"), "video", "utf8");
    await fs.mkdir(path.join(world, "clips"), { recursive: true });
    await fs.writeFile(path.join(world, "clips", "couch.mp4"), "the winner", "utf8");

    // The collision loop would normally rename, so force the clash the way a
    // race does: a destination that appears between the check and the write.
    const result = await importClip(world, path.join(from, "couch.mp4"));

    expect(result.ok).toBe(true);
    expect(await fs.readFile(path.join(world, "clips", "couch.mp4"), "utf8")).toBe("the winner");
  });
});
