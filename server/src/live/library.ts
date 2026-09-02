import path from "node:path";
import { promises as fs } from "node:fs";
import type { LibraryListing } from "../../../shared/src/types.js";
import { safeSegment } from "../storage/jsonl.js";
import { videoMime } from "./clips.js";

/**
 * Browsing for clips, and bringing one in.
 *
 * This is the one place the app reads a directory it does not own. Everywhere
 * else — the data dir, the watched projects dir — is a path HAL created or was
 * configured with. Browsing reaches wherever the user points it.
 *
 * That is not a privilege increase: the protocol this arrives on already
 * permits scheduling shell commands through `add-monitor`, and the per-boot
 * token is what guards both. It is a new surface, and it is recorded as one in
 * docs/residual-review-findings/.
 */

const LIST_MAX = 500;

/**
 * List one folder: its video files and its immediate subfolders.
 *
 * One level at a time, deliberately. A recursive walk of a root the user named
 * is an unbounded amount of work behind a single message, on a protocol with no
 * way to cancel it — so navigation is the client's, a folder at a time.
 *
 * A folder that cannot be read is reported rather than thrown: an unreadable
 * directory is a routine thing to click on, not a fault.
 */
export async function listFolder(folder: string): Promise<LibraryListing> {
  const at = path.resolve(folder);
  const parent = path.dirname(at);
  const listing: LibraryListing = {
    folder: at,
    parent: parent === at ? null : parent,
    folders: [],
    clips: [],
  };

  let entries;
  try {
    const stat = await fs.stat(at);
    if (!stat.isDirectory()) return { ...listing, error: "That is a file, not a folder." };
    entries = await fs.readdir(at, { withFileTypes: true });
  } catch (err) {
    return { ...listing, error: `That folder could not be read: ${(err as NodeJS.ErrnoException).code ?? "unknown"}` };
  }

  for (const entry of entries) {
    if (listing.folders.length + listing.clips.length >= LIST_MAX) break;
    const full = path.join(at, entry.name);
    if (entry.isDirectory()) {
      listing.folders.push({ name: entry.name, path: full });
      continue;
    }
    // The extension gate is the same one the clip route serves by, so what the
    // browser offers and what the route will play cannot drift apart.
    if (!entry.isFile() || !videoMime(entry.name)) continue;
    const size = await fs.stat(full).then((s) => s.size).catch(() => 0);
    listing.clips.push({ name: entry.name, path: full, sizeBytes: size });
  }

  listing.folders.sort((a, b) => a.name.localeCompare(b.name));
  listing.clips.sort((a, b) => a.name.localeCompare(b.name));
  return listing;
}

export type ImportResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Copy a clip into a World's `clips/`, and answer with the relative path.
 *
 * The copy is what keeps a World a folder that can be zipped and moved, and
 * what lets the clip route go on refusing every path outside it. The
 * destination name goes through `safeSegment` for the same reason every other
 * client-supplied name does, and a collision takes a numeric suffix rather than
 * overwriting somebody's clip.
 */
export async function importClip(worldDir: string, sourcePath: string): Promise<ImportResult> {
  if (typeof sourcePath !== "string" || sourcePath.trim().length === 0) {
    return { ok: false, error: "No file was named." };
  }
  const source = path.resolve(sourcePath);
  if (!videoMime(source)) return { ok: false, error: "That file is not a video HAL can play." };

  try {
    const stat = await fs.stat(source);
    if (!stat.isFile()) return { ok: false, error: "That is not a file." };
  } catch {
    return { ok: false, error: "That file could not be read." };
  }

  const clipsDir = path.join(worldDir, "clips");
  await fs.mkdir(clipsDir, { recursive: true });

  const extension = path.extname(source).toLowerCase();
  const stem = safeSegment(path.basename(source, path.extname(source)));
  let name = `${stem}${extension}`;
  for (let n = 2; await exists(path.join(clipsDir, name)); n += 1) {
    name = `${stem}-${n}${extension}`;
  }

  try {
    // `copyFile` with EXCL rather than a plain copy: the name was just checked,
    // and refusing to clobber is cheaper than reasoning about the gap between
    // the check and the write.
    await fs.copyFile(source, path.join(clipsDir, name), fs.constants.COPYFILE_EXCL);
  } catch (err) {
    return { ok: false, error: `That file could not be copied in: ${(err as NodeJS.ErrnoException).code ?? "unknown"}` };
  }

  // Relative, and with forward slashes: the manifest travels between machines,
  // and a backslash written on Windows is not a separator anywhere else.
  return { ok: true, path: `clips/${name}` };
}

async function exists(file: string): Promise<boolean> {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false);
}
