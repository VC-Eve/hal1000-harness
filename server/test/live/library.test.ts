import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { tmpDir } from "../tmp.js";
import crypto from "node:crypto";
import { importClip, importOverlayImage, listFolder, removeOverlayImage } from "../../src/live/library.js";

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


describe("browsing for an image", () => {
  it("lists images beside clips from one walk of the folder", async () => {
    // One browse answers both pickers, so an operator looking for a logo in the
    // folder their clips came from does not navigate twice.
    await file("takes/couch.mp4");
    await file("takes/logo.png");
    await file("takes/band.webp");
    await file("takes/notes.txt");

    const listing = await listFolder(path.join(dir, "takes"));

    expect(listing.clips.map((c) => c.name)).toEqual(["couch.mp4"]);
    expect(listing.images.map((i) => i.name)).toEqual(["band.webp", "logo.png"]);
  });

  it("offers no file the image route would refuse to draw", async () => {
    // The gate here and the gate the route serves by are the same table, so
    // what the browser offers and what will draw cannot drift apart. An SVG is
    // a document that can carry script, and is deliberately not an image here.
    await file("takes/vector.svg");
    await file("takes/notes.txt");
    const listing = await listFolder(path.join(dir, "takes"));
    expect(listing.images).toEqual([]);
  });
});

describe("importing an image", () => {
  const hash = async (file: string) => crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
  const world = () => path.join(dir, "worlds", "lounge");

  it("copies the file in and answers a World-relative name", async () => {
    const source = await file("art/logo.png", "PNGBYTES");
    const result = await importOverlayImage(world(), source);

    expect(result).toEqual({ ok: true, path: "images/logo.png" });
    expect(await fs.readFile(path.join(world(), "images", "logo.png"), "utf8")).toBe("PNGBYTES");
    // Forward slashes: the manifest travels between machines, and a backslash
    // written on Windows is not a separator anywhere else.
    expect((result as { path: string }).path).not.toContain("\\");
  });

  it("makes a colliding name unique rather than overwriting", async () => {
    const first = await file("art/logo.png", "FIRST");
    const second = await file("other/logo.png", "SECOND");

    expect(await importOverlayImage(world(), first)).toEqual({ ok: true, path: "images/logo.png" });
    expect(await importOverlayImage(world(), second)).toEqual({ ok: true, path: "images/logo-2.png" });

    // Compared by content, never by name. The suffixing is exactly what makes
    // a filename lie about identity in this codebase — see
    // docs/solutions/a-scratch-data-dir-is-safe-until-you-invite-the-user-into-it.md.
    expect(await fs.readFile(path.join(world(), "images", "logo.png"), "utf8")).toBe("FIRST");
    expect(await fs.readFile(path.join(world(), "images", "logo-2.png"), "utf8")).toBe("SECOND");
  });

  it("leaves two Worlds' copies independent", async () => {
    const source = await file("art/logo.png", "ORIGINAL");
    const a = path.join(dir, "worlds", "one");
    const b = path.join(dir, "worlds", "two");
    await importOverlayImage(a, source);
    await importOverlayImage(b, source);

    const before = await hash(path.join(b, "images", "logo.png"));
    await fs.writeFile(path.join(a, "images", "logo.png"), "REPLACED", "utf8");

    expect(await hash(path.join(b, "images", "logo.png"))).toBe(before);
  });

  it("refuses a file it will not draw, and copies nothing", async () => {
    const source = await file("art/notes.txt", "words");
    const result = await importOverlayImage(world(), source);

    expect(result.ok).toBe(false);
    await expect(fs.readdir(path.join(world(), "images"))).rejects.toThrow();
  });

  it("refuses a name that is not a file, and a name that is nothing", async () => {
    expect((await importOverlayImage(world(), path.join(dir, "art"))).ok).toBe(false);
    expect((await importOverlayImage(world(), "")).ok).toBe(false);
    expect((await importOverlayImage(world(), path.join(dir, "absent.png"))).ok).toBe(false);
  });

  it("takes a copy back out when nothing ends up naming it", async () => {
    // The half of "no import leaves an orphan" that checking before the copy
    // cannot provide: the slot can go in the gap the copy takes.
    const source = await file("art/logo.png", "PNGBYTES");
    const copied = await importOverlayImage(world(), source);
    expect(copied.ok).toBe(true);

    await removeOverlayImage(world(), (copied as { path: string }).path);
    expect(await fs.readdir(path.join(world(), "images"))).toEqual([]);
  });

  it("will not remove anything outside the World's own images folder", async () => {
    // The path came back from the importer moments ago, but a delete that
    // trusts its argument is one refactor from deleting whatever it is handed.
    const outsider = await file("precious.png", "KEEP");
    await removeOverlayImage(world(), "../../precious.png");
    await removeOverlayImage(world(), outsider);
    expect(await fs.readFile(outsider, "utf8")).toBe("KEEP");
  });
});
