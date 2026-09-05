import path from "node:path";
import { promises as fs } from "node:fs";
import type { LibraryListing } from "../../../shared/src/types.js";
import { safeSegment } from "../storage/jsonl.js";
import { RESERVED } from "../storage/worlds.js";
import { videoMime } from "./clips.js";
import { imageMime } from "./images.js";

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

/**
 * How many folders, and how many clips, one listing carries.
 *
 * A budget per kind rather than one shared between them. Shared, a project root
 * with five hundred subdirectories spent the whole allowance before reaching a
 * single video, and the author was shown an empty folder.
 */
const LIST_MAX = 500;

/** How many times a colliding import name is nudged before giving up. */
const MAX_NAME_ATTEMPTS = 200;

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
    images: [],
  };

  let entries;
  try {
    const stat = await fs.stat(at);
    if (!stat.isDirectory()) return { ...listing, error: "That is a file, not a folder." };
    entries = await fs.readdir(at, { withFileTypes: true });
  } catch (err) {
    return { ...listing, error: `That folder could not be read: ${(err as NodeJS.ErrnoException).code ?? "unknown"}` };
  }

  let truncated = false;
  for (const entry of entries) {
    const full = path.join(at, entry.name);
    if (entry.isDirectory()) {
      if (listing.folders.length >= LIST_MAX) truncated = true;
      else listing.folders.push({ name: entry.name, path: full });
      continue;
    }
    if (!entry.isFile()) continue;
    // The extension gates are the same ones the two routes serve by, so what
    // the browser offers and what a route will draw cannot drift apart.
    const kind = videoMime(entry.name) ? "clips" : imageMime(entry.name) ? "images" : null;
    if (kind === null) continue;
    // A budget per kind, not one shared between them — the rule the clips and
    // folders already keep. Shared, a folder of five hundred stills would spend
    // the whole allowance before reaching a single video.
    if (listing[kind].length >= LIST_MAX) {
      truncated = true;
      continue;
    }
    const size = await fs.stat(full).then((s) => s.size).catch(() => 0);
    listing[kind].push({ name: entry.name, path: full, sizeBytes: size });
  }
  // Said out loud rather than left to look like an empty folder: "nothing here"
  // and "more than I will show" are different answers.
  if (truncated) listing.truncated = true;

  listing.folders.sort((a, b) => a.name.localeCompare(b.name));
  listing.clips.sort((a, b) => a.name.localeCompare(b.name));
  listing.images.sort((a, b) => a.name.localeCompare(b.name));
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
  const stem = clipStem(path.basename(source, path.extname(source)));
  let name = `${stem}${extension}`;
  for (let n = 2; await exists(path.join(clipsDir, name)); n += 1) {
    // Bounded: `exists` answers true for anything that stats, and a path that
    // always stats — a device name that slipped the guard above — would spin
    // here forever rather than failing.
    if (n > MAX_NAME_ATTEMPTS) {
      return { ok: false, error: "That name could not be made unique in this World." };
    }
    name = `${stem}-${n}${extension}`;
  }

  const destination = path.join(clipsDir, name);
  try {
    // `copyFile` with EXCL rather than a plain copy: the name was just checked,
    // and refusing to clobber is cheaper than reasoning about the gap between
    // the check and the write.
    await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // `copyFile` opens the destination before it streams into it, so a failure
    // part way leaves a truncated file under a name the collision loop will
    // then treat as taken. EEXIST is the exception and must not be tidied up:
    // that file is not ours — it is the one a concurrent import just wrote and
    // assigned, and removing it would delete a clip somebody is using.
    if (code !== "EEXIST") await fs.rm(destination, { force: true }).catch(() => {});
    return { ok: false, error: `That file could not be copied in: ${code ?? "unknown"}` };
  }

  // Relative, and with forward slashes: the manifest travels between machines,
  // and a backslash written on Windows is not a separator anywhere else.
  return { ok: true, path: `clips/${name}` };
}

/**
 * Copy an image into a World's `images/`, and answer with the relative path.
 *
 * `importClip`'s twin, and written out rather than folded into it with a
 * parameter: the two differ in their gate, their destination and their answer,
 * and a shared function taking a "kind" would have to be read twice to learn
 * what either one does. What they genuinely share — `safeSegment`, the reserved
 * device-name guard, the bounded collision loop, `COPYFILE_EXCL` and the
 * EEXIST rule — is shared as functions, not as a flag.
 */
export async function importOverlayImage(worldDir: string, sourcePath: string): Promise<ImportResult> {
  if (typeof sourcePath !== "string" || sourcePath.trim().length === 0) {
    return { ok: false, error: "No file was named." };
  }
  const source = path.resolve(sourcePath);
  if (!imageMime(source)) return { ok: false, error: "That file is not an image HAL can draw." };

  try {
    const stat = await fs.stat(source);
    if (!stat.isFile()) return { ok: false, error: "That is not a file." };
  } catch {
    return { ok: false, error: "That file could not be read." };
  }

  const imagesDir = path.join(worldDir, "images");
  await fs.mkdir(imagesDir, { recursive: true });

  const extension = path.extname(source).toLowerCase();
  const stem = clipStem(path.basename(source, path.extname(source)));
  let name = `${stem}${extension}`;
  for (let n = 2; await exists(path.join(imagesDir, name)); n += 1) {
    // Bounded for `importClip`'s reason: a path that always stats — a device
    // name that slipped the guard — would spin here rather than failing.
    if (n > MAX_NAME_ATTEMPTS) {
      return { ok: false, error: "That name could not be made unique in this World." };
    }
    name = `${stem}-${n}${extension}`;
  }

  const destination = path.join(imagesDir, name);
  try {
    await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EEXIST is the one failure that must not be tidied up: that file belongs
    // to a concurrent import that has already attached it. See `importClip`.
    if (code !== "EEXIST") await fs.rm(destination, { force: true }).catch(() => {});
    return { ok: false, error: `That file could not be copied in: ${code ?? "unknown"}` };
  }

  return { ok: true, path: `images/${name}` };
}

/**
 * Remove an imported image the World does not name.
 *
 * Best effort, `removeClipFile`'s rule: failing to tidy up must not turn a
 * refusal into a fault. Called when an attach fails *after* the copy landed —
 * the half of "no import leaves an orphan" that checking before the copy
 * cannot provide.
 */
export async function removeOverlayImage(worldDir: string, relative: string): Promise<void> {
  const resolved = path.resolve(worldDir, relative);
  const root = path.resolve(worldDir, "images");
  // Confined before removing. This path came back from `importOverlayImage`
  // moments ago, but a delete that trusts its argument is one refactor away
  // from deleting whatever a caller hands it.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return;
  await fs.rm(resolved, { force: true }).catch(() => {});
}

/**
 * The destination stem for an imported clip.
 *
 * `safeSegment` handles traversal, separators and the characters a path cannot
 * carry. What it does not know about is the Windows device names: a file called
 * `CON.mp4` resolves to a character device, so the bytes go nowhere and the
 * manifest records a clip that can never be served. `worldSlug` already guards
 * its own segments this way.
 */
function clipStem(raw: string): string {
  const base = safeSegment(raw);
  // Win32 reads the device name from the text before the *first* dot, so
  // `NUL.take3` is still the NUL device. Testing the whole stem missed that —
  // and because the destination then stats successfully as a device, the
  // collision loop below would keep finding it taken forever.
  const [head] = base.split(".");
  return RESERVED.has((head ?? "").toUpperCase()) ? `${base}-clip` : base;
}

async function exists(file: string): Promise<boolean> {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false);
}
