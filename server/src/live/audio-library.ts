import path from "node:path";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import type { AudioListing } from "../../../shared/src/types.js";
import { normaliseTrackFilter, type PlaylistTrack } from "../../../shared/src/audio.js";
import { safeSegment } from "../storage/jsonl.js";
import { RESERVED } from "../storage/worlds.js";
import { audioMime } from "./audio.js";
import { readAudioTags } from "./audio-tags.js";

/**
 * Browsing for tracks, and bringing one in.
 *
 * `live/library.ts` for audio, and deliberately its parallel rather than a call
 * into it: the two differ in exactly one thing that matters — the extension
 * gate — and sharing a walk parameterised by that gate would have the clip
 * browser and the track browser answer with each other's shapes the first time
 * either grew a field. What is *not* duplicated is the gate itself, which lives
 * once in `live/audio.ts` and is what U5's byte route serves by.
 *
 * The surface note on `library.ts` applies here unchanged: this reads
 * directories HAL neither created nor was configured with, guarded by the hub's
 * origin refusal and per-boot token, and by nothing else.
 */

/**
 * How many folders one listing carries.
 *
 * Per kind, not shared, for the reason `LIST_MAX` in `library.ts` records: a
 * music root with five hundred artist folders spent a shared budget before
 * reaching a single file and showed the author an empty folder.
 */
const FOLDER_MAX = 500;

/**
 * How many tracks one listing carries.
 *
 * Four times the folder bound, and deliberately no longer the 500 this
 * inherited from `library.ts`: five hundred is generous for a folder of video
 * takes and small for a music folder, where a few thousand files in one
 * directory is ordinary. The author who reported this had 701 tracks in one
 * folder and could not reach the last 201 by any means — not by scrolling,
 * because they were never sent, and not by searching, because the search ran in
 * the browser over what had been.
 *
 * Still a bound, for the reasons it always was: a listing is one WS message,
 * every track in it costs a `stat`, and no number is large enough for a folder
 * somebody points at a whole drive. Past the cap the *filter* is the way
 * through, which is why it is applied before the cap and why the listing says
 * how many matched rather than only that it gave up.
 */
const TRACK_MAX = 2000;

/** How many times a colliding import name is nudged before giving up. */
const MAX_NAME_ATTEMPTS = 200;

/** Rename retries, and the wait between them. The policy `atomic.ts` keeps. */
const RENAME_RETRIES = 5;
const RENAME_DELAY_MS = 50;

/**
 * List one folder: the audio files in it and its immediate subfolders.
 *
 * One level at a time, for the reason `listFolder` gives: a recursive walk of a
 * root the user named is an unbounded amount of work behind a single message,
 * on a protocol with no way to cancel it. A music library is the case that
 * makes that concrete — a genre folder is thousands of albums deep.
 *
 * `filter` narrows the tracks to those whose name contains it, and is applied
 * before the cap. That ordering is the whole fix: with the filter in the client
 * it ran over the tracks the cap had already let through, so a track past the
 * cap was unreachable by scrolling and by searching alike. Subfolders are not
 * narrowed — see the loop.
 */
export async function listAudioFolder(folder: string, filter?: string): Promise<AudioListing> {
  const at = path.resolve(folder);
  const parent = path.dirname(at);
  const needle = normaliseTrackFilter(filter);
  const listing: AudioListing = {
    folder: at,
    parent: parent === at ? null : parent,
    folders: [],
    tracks: [],
    matched: 0,
    ...(needle.length === 0 ? {} : { filter: needle }),
  };

  let entries;
  try {
    const stat = await fs.stat(at);
    if (!stat.isDirectory()) return { ...listing, error: "That is a file, not a folder." };
    entries = await fs.readdir(at, { withFileTypes: true });
  } catch (err) {
    return {
      ...listing,
      error: `That folder could not be read: ${(err as NodeJS.ErrnoException).code ?? "unknown"}`,
    };
  }

  // Gathered whole, then sorted, and only then capped. The order matters and it
  // is the second half of the same fix the filter is: `readdir` answers in
  // whatever order the filesystem holds, so capping first and sorting after
  // handed back an arbitrary 2000 of 3000 and then presented them
  // alphabetically — a list that looks like the first 2000 names and is not,
  // with no way to reach the rest and nothing saying which ones went. Sorted
  // first, the cap takes a meaningful prefix and the filter is the way past it.
  const folders: { name: string; path: string }[] = [];
  const files: { name: string; path: string }[] = [];
  for (const entry of entries) {
    const full = path.join(at, entry.name);
    if (entry.isDirectory()) {
      // Folders are deliberately *not* narrowed by the filter. The filter is
      // for finding a track inside the folder you are standing in, and hiding
      // the subfolders while one is typed takes away the only way out of a
      // folder whose tracks are all one level further down — a user searching
      // for `amen` in an artist root would be shown nothing at all and no way
      // to look. Navigation has to keep working while a search is being typed.
      folders.push({ name: entry.name, path: full });
      continue;
    }
    // The same gate the track route serves by, so what the browser offers and
    // what HAL will play cannot drift apart.
    if (!entry.isFile() || !audioMime(entry.name)) continue;
    // Before the cap, never after: a filter applied to what survived the cap is
    // the client-side filter this replaced, and it can only find what was
    // already in reach.
    if (needle.length > 0 && !entry.name.toLowerCase().includes(needle)) continue;
    files.push({ name: entry.name, path: full });
  }

  folders.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  // Counted whether or not they fit, because "40 of 701" is what tells the user
  // to type rather than to scroll.
  listing.matched = files.length;
  // Said out loud rather than left to look like an empty folder.
  if (folders.length > FOLDER_MAX || files.length > TRACK_MAX) listing.truncated = true;
  listing.folders = folders.slice(0, FOLDER_MAX);
  // Stat'd only for what is being sent: a `stat` per file is the listing's real
  // cost, and the ones past the cap are not going anywhere.
  for (const file of files.slice(0, TRACK_MAX)) {
    const size = await fs.stat(file.path).then((s) => s.size).catch(() => 0);
    listing.tracks.push({ name: file.name, path: file.path, sizeBytes: size });
  }
  return listing;
}

export type TrackImport =
  | { ok: true; track: PlaylistTrack; ignored?: string }
  | { ok: false; error: string };

/**
 * Copy one file into the store's `tracks/`, read its tag, and describe it.
 *
 * The copy is what keeps origin R11 true: nothing in an index ever names a path
 * outside the store, so a playlist survives the source drive being unplugged
 * and the byte route can go on refusing everything else.
 *
 * The entry this returns is not yet in any playlist — adding it is the caller's
 * next move, and a commit of several tracks is one index write rather than one
 * per file (origin R12).
 */
export async function importTrack(tracksDir: string, sourcePath: string): Promise<TrackImport> {
  if (typeof sourcePath !== "string" || sourcePath.trim().length === 0) {
    return { ok: false, error: "No file was named." };
  }
  const source = path.resolve(sourcePath);
  if (!audioMime(source)) return { ok: false, error: "That file is not audio HAL can play." };

  try {
    const stat = await fs.stat(source);
    if (!stat.isFile()) return { ok: false, error: "That is not a file." };
  } catch {
    return { ok: false, error: "That file could not be read." };
  }

  await fs.mkdir(tracksDir, { recursive: true });

  const extension = path.extname(source).toLowerCase();
  const stem = trackStem(path.basename(source, path.extname(source)));
  let name = `${stem}${extension}`;
  for (let n = 2; await exists(path.join(tracksDir, name)); n += 1) {
    // Bounded, for the reason `importClip` bounds its own loop: `exists`
    // answers true for anything that stats, and a path that always stats — a
    // device name that slipped the guard above — would spin here forever.
    if (n > MAX_NAME_ATTEMPTS) {
      return { ok: false, error: "That name could not be made unique in the audio store." };
    }
    name = `${stem}-${n}${extension}`;
  }

  const destination = path.join(tracksDir, name);
  const copied = await copyIntoStore(source, destination);
  if (!copied.ok) return copied;

  // Read after the bytes are in the store, from the store's copy: the source
  // may be on a drive that is about to go away, and this is the file the
  // playlist will name from here on.
  const tags = await readAudioTags(destination);
  return {
    ok: true,
    track: {
      // Relative and forward-slashed: the index travels between machines with
      // the store, and a backslash written on Windows is not a separator
      // anywhere else.
      path: `tracks/${name}`,
      name: path.basename(source),
      durationMs: tags.durationMs,
      ...(tags.bpm === null ? {} : { bpm: tags.bpm, bpmSource: "measured" as const }),
    },
    ...(tags.ignored ? { ignored: tags.ignored } : {}),
  };
}

/**
 * Copy a large binary in, temp name first, then rename.
 *
 * **The guarantee is that no half-copied file is ever observable under a track
 * name.** A track is tens of megabytes, so unlike `writeJsonAtomic` this is not
 * one buffered write — a plain `copyFile` straight to the destination leaves a
 * growing, playable-looking, truncated FLAC in the store for as long as the copy
 * takes, and a crash leaves it there for good. The temp carries a leading dot
 * and a `.part` suffix, so it is not a name `audioMime` accepts and not a name
 * the collision loop above will hand out.
 *
 * The temp name is unique **per write** rather than per process, which
 * docs/solutions/windows-hardening-patterns.md records as the difference between
 * two overlapping imports and one of them truncating the other's temp. The
 * rename then retries on EPERM/EBUSY/EACCES only, on the same five-times-50ms
 * budget `atomic.ts` uses, because Defender and the search indexer hold files
 * they have just seen appear.
 *
 * What this deliberately does *not* provide is exclusive creation, which the
 * clip path gets from `copyFile(COPYFILE_EXCL)`: `rename` replaces silently on
 * POSIX. Two imports that pick the same free name in the same instant can have
 * one overwrite the other, and the collision loop narrows that window to a
 * single rename. The alternative — `link` then `unlink`, which does fail on an
 * existing name — is not available on every filesystem a music library sits on.
 */
async function copyIntoStore(
  source: string,
  destination: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const temp = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.part`,
  );
  try {
    await fs.copyFile(source, temp, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    // The temp is ours alone — a unique name nothing else can have picked — so
    // unlike the clip path there is no EEXIST case to leave alone.
    await fs.rm(temp, { force: true }).catch(() => {});
    return { ok: false, error: `That file could not be copied in: ${code(err)}` };
  }

  let last: unknown;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt += 1) {
    try {
      await fs.rename(temp, destination);
      return { ok: true };
    } catch (err) {
      last = err;
      const reason = code(err);
      if (reason !== "EPERM" && reason !== "EBUSY" && reason !== "EACCES") break;
      await new Promise((resolve) => setTimeout(resolve, RENAME_DELAY_MS));
    }
  }
  // Nothing was ever visible under the track name, so the only thing to undo is
  // the temp itself.
  await fs.rm(temp, { force: true }).catch(() => {});
  return { ok: false, error: `That file could not be moved into the store: ${code(last)}` };
}

/**
 * The destination stem for an imported track.
 *
 * `safeSegment` plus the Windows device-name check, the same rule and the same
 * reason as `clipStem` in `library.ts`: a file called `CON.mp3` resolves to a
 * character device, so the bytes go nowhere and the index records a track that
 * can never be served — and because the destination then stats successfully,
 * the collision loop would find every nudged name taken too.
 */
function trackStem(raw: string): string {
  const base = safeSegment(raw);
  // Win32 reads the device name from the text before the *first* dot, so
  // `NUL.take3` is still the NUL device.
  const [head] = base.split(".");
  return RESERVED.has((head ?? "").toUpperCase()) ? `${base}-track` : base;
}

function code(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? "unknown";
}

async function exists(file: string): Promise<boolean> {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false);
}
