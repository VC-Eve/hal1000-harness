import path from "node:path";
import { promises as fs } from "node:fs";
import type { Playlist, PlaylistSummary, PlaylistTrack } from "../../../shared/src/audio.js";
import { usableBpm } from "../../../shared/src/audio.js";
import { pathSegmentSlug, validWorldId } from "./worlds.js";
import { readJson, writeJsonAtomic } from "./atomic.js";
import { audioDir } from "../paths.js";

/**
 * The shared audio store: `audio/` beside `worlds/`.
 *
 * `tracks/` holds the files themselves and `playlists/<id>.json` holds one index
 * each. A playlist belongs to no World (R9), which is the whole reason the store
 * is a sibling rather than a folder inside one — deleting a World must take no
 * track and no playlist with it (R13), and a store living under `worlds/<id>/`
 * could not promise that.
 *
 * Modelled on `WorldStore` throughout, deliberately rather than by coincidence:
 * an index is a small JSON file this process both reads and rewrites, so it
 * carries the same three hazards. It is rebuilt by spreading what was parsed, it
 * is written through `writeJsonAtomic`, and every write is serialized per
 * playlist.
 */

const PLAYLISTS_DIR = "playlists";
const TRACKS_DIR = "tracks";
const NAME_MAX = 60;

/**
 * How many tracks one playlist may hold.
 *
 * Every entry's path is resolved through two `realpath` calls when it is added
 * and again whenever the store is asked whether a track is reachable, so an
 * unbounded index is unbounded filesystem work behind one message — the reason
 * `MAX_CLIPS_PER_SET` exists, arriving in a second place. Refused rather than
 * trimmed, for the same reason a set over the cap is: silently dropping the tail
 * of somebody's selection is worse than saying no.
 */
export const MAX_TRACKS_PER_PLAYLIST = 500;

/**
 * The synthetic lock `create` runs under, so two creates cannot pick one id.
 *
 * The same key `WorldStore.create` uses, and for the same reason: no id
 * `validWorldId` accepts can contain a NUL, so it cannot collide with a real
 * playlist's lock.
 */
const CREATE_KEY = "\u0000create";

const NO_SUCH_PLAYLIST = "There is no playlist by that name.";
const CANNOT_APPLY = "That change could not be applied.";

export type PlaylistResult = { ok: true; playlist: Playlist } | { ok: false; error: string };

/** Why a track path was refused, or that the file is simply not there. */
export type TrackReason = "not-a-path" | "escapes-store" | "missing";

export type TrackResolution = { ok: true; file: string } | { ok: false; reason: TrackReason };

const REASONS: Record<TrackReason, string> = {
  "not-a-path": "That is not a track path.",
  "escapes-store": "That track is outside the audio store.",
  missing: "That track file is not in the audio store.",
};

/**
 * The id for a display name.
 *
 * `pathSegmentSlug` rather than the rule written out again here: the id becomes
 * a filename, so it needs the dot-run collapse, the trim after the slice and the
 * Windows device-name check that `worldSlug` already encodes — a playlist called
 * `con` can no more be a file than a World called `con` can be a directory.
 */
export function playlistSlug(name: string): string {
  return pathSegmentSlug(name, "playlist");
}

function displayName(name: unknown, fallback: string): string {
  const text = String(name ?? "").trim().slice(0, NAME_MAX);
  return text.length > 0 ? text : fallback;
}

/**
 * The entries of a `tracks` array that are shaped like entries at all.
 *
 * The rule `entries()` applies to a manifest, for the same reason: an index is
 * hand-editable and travels with the store, so the array can hold a null left by
 * a deletion. An entry missing a field this build knows about is kept — a track
 * with no readable BPM is `bpmOf`'s answer to give, not this function's to
 * delete.
 */
function trackEntries(value: unknown): PlaylistTrack[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is PlaylistTrack => typeof v === "object" && v !== null && !Array.isArray(v),
  );
}

/**
 * Rebuild a playlist by spreading what was parsed.
 *
 * Never by naming every field, exactly as `rebuild` in `storage/worlds.ts` does
 * not: this store's read path is its write path, so a key the file carries that
 * this literal forgets is deleted by the next ordinary write. See
 * docs/solutions/rebuilding-a-cache-field-by-field-turns-a-read-into-a-delete.md.
 */
function rebuild(parsed: unknown, id: string): Playlist {
  const base = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Partial<Playlist>;
  // Taken out of the spread rather than written over it. A field this function
  // owns must not reach the result by the spread first: `shuffle: "yes"` is a
  // string on disk, and a later key of the same name would replace the value
  // while leaving nothing to replace it *with* when the answer is "off".
  const { shuffle, ...rest } = base;
  return {
    ...(rest as Playlist),
    // The filename is the identity, the way a World's directory is: an index
    // copied in from elsewhere names whatever id it had on the machine that
    // wrote it, and the file here is the one that is true.
    id,
    name: displayName(base.name, id),
    tracks: trackEntries(base.tracks),
    // An acceptance, not a coercion. An index is hand-editable, so a typed
    // `"no"` arrives as a string and every truthy test would turn it on — the
    // failure `usableBpm` is written the long way round to avoid. Absent rather
    // than `false` when off, so an index does not gain a field for every
    // playlist that has always played in order.
    ...(shuffle === true ? { shuffle: true } : {}),
  };
}

function confined(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  // `path.relative`, not a string prefix — `audio/tracks` and `audio/tracks-2`
  // share a prefix and are different directories. Same rule, same reason, as
  // `confined` in storage/worlds.ts.
  return rel.length > 0 && !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

export class AudioStore {
  private readonly root: string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(dataDir: string) {
    this.root = audioDir(dataDir);
  }

  /** Where imported track files are copied to. */
  tracksDir(): string {
    return path.join(this.root, TRACKS_DIR);
  }

  /** The store root, for a caller resolving a store-relative path itself. */
  storeDir(): string {
    return this.root;
  }

  /** The index file for a playlist id, or null when the id is not one of ours. */
  fileFor(id: unknown): string | null {
    // `validWorldId`'s rule, imported rather than restated. A playlist id is one
    // path segment on the same filesystems a World id is, mixed case included:
    // an index copied in as `Warmup.json` must list rather than vanish.
    if (!validWorldId(id)) return null;
    const file = path.join(this.root, PLAYLISTS_DIR, `${id}.json`);
    return confined(this.root, file) ? file : null;
  }

  /**
   * Serialize writes to one playlist.
   *
   * The shape `WorldStore.withLock` uses. Not optional here: U8 lands a BPM per
   * track asynchronously against one index, which is N read-modify-write cycles
   * against one file — the last writer wins and the rest vanish, which
   * docs/solutions/windows-hardening-patterns.md records happening already.
   */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /** Every playlist id the store holds. */
  async ids(): Promise<string[]> {
    const dir = path.join(this.root, PLAYLISTS_DIR);
    await fs.mkdir(dir, { recursive: true });
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length))
      .filter((id) => validWorldId(id))
      .sort();
  }

  async list(): Promise<PlaylistSummary[]> {
    const out: PlaylistSummary[] = [];
    for (const id of await this.ids()) {
      const playlist = await this.load(id);
      if (playlist) out.push({ id, name: playlist.name, tracks: playlist.tracks.length });
    }
    return out;
  }

  /**
   * One playlist, or null.
   *
   * An index that will not parse is null rather than an empty playlist: an empty
   * one would have the next ordinary write replace a hand edit for good, which
   * is the loss the spread rebuild exists to prevent arriving by another route.
   */
  async load(id: string): Promise<Playlist | null> {
    const file = this.fileFor(id);
    if (!file) return null;
    const parsed = await readJson<unknown>(file);
    if (parsed === null) return null;
    return rebuild(parsed, id);
  }

  /**
   * Create a playlist from a display name.
   *
   * Under one synthetic lock, and the taken set is lowercased: the filesystem
   * folds case on Windows and macOS, so two playlists whose names differ only in
   * case must not resolve to one file. A collision nudges to `-2`, `-3` rather
   * than overwriting somebody's index.
   */
  async create(name: string): Promise<Playlist> {
    return this.withLock(CREATE_KEY, async () => {
      const taken = new Set((await this.ids()).map((id) => id.toLowerCase()));
      const base = playlistSlug(name);
      let id = base;
      for (let n = 2; taken.has(id.toLowerCase()); n += 1) id = `${base}-${n}`;

      const playlist: Playlist = { id, name: displayName(name, id), tracks: [] };
      await fs.mkdir(path.join(this.root, PLAYLISTS_DIR), { recursive: true });
      await writeJsonAtomic(path.join(this.root, PLAYLISTS_DIR, `${id}.json`), playlist);
      return playlist;
    });
  }

  /**
   * Apply a change to one index under its lock.
   *
   * The playlist is re-read inside the lock and written back whole, so what is
   * persisted is always the spread rebuild of what was on disk a moment ago —
   * the discipline `WorldStore.mutate` keeps, and the reason two BPM results
   * landing at once do not erase each other.
   */
  async update(id: string, apply: (playlist: Playlist) => Playlist | null): Promise<PlaylistResult> {
    const file = this.fileFor(id);
    if (!file) return { ok: false, error: NO_SUCH_PLAYLIST };
    return this.withLock(id, async () => {
      const current = await this.load(id);
      if (!current) return { ok: false, error: NO_SUCH_PLAYLIST };

      let next: Playlist | null;
      try {
        next = apply(current);
      } catch {
        // An index carrying an entry no edit function expected must not turn a
        // write into a rejected promise the caller can only log.
        return { ok: false, error: CANNOT_APPLY };
      }
      if (!next) return { ok: false, error: CANNOT_APPLY };
      // An edit that changed nothing is a success that need not be written.
      if (next === current) return { ok: true, playlist: current };
      if (next.tracks.length > MAX_TRACKS_PER_PLAYLIST) {
        return { ok: false, error: `A playlist holds at most ${MAX_TRACKS_PER_PLAYLIST} tracks.` };
      }
      await writeJsonAtomic(file, next);
      return { ok: true, playlist: next };
    });
  }

  /**
   * Delete a playlist.
   *
   * The index only. The tracks it named stay in the store, because another
   * playlist may name them and nothing here knows — collecting tracks no
   * playlist references is named as deferred work in the plan, not done by
   * accident here.
   */
  async remove(id: string): Promise<boolean> {
    const file = this.fileFor(id);
    if (!file) return false;
    return this.withLock(id, async () => {
      try {
        await fs.stat(file);
      } catch {
        return false;
      }
      await fs.rm(file, { force: true });
      return true;
    });
  }

  /**
   * Append tracks, resolving every path before anything is written.
   *
   * Resolution is what keeps R11 true — nothing in an index names a path outside
   * the store — and it is a filesystem question, which is why this is a store
   * method rather than one more pure edit.
   */
  async addTracks(id: string, arrivals: readonly PlaylistTrack[]): Promise<PlaylistResult> {
    const cleaned: PlaylistTrack[] = [];
    for (const arrival of arrivals) {
      const resolved = await this.resolveTrack(arrival?.path);
      if (!resolved.ok) return { ok: false, error: REASONS[resolved.reason] };
      cleaned.push(cleanTrack(arrival));
    }
    return this.update(id, (playlist) => ({ ...playlist, tracks: [...playlist.tracks, ...cleaned] }));
  }

  /**
   * Resolve a store-relative track path to a real file inside the store.
   *
   * `resolveClipPath`'s shape, and for the same reasons: an absolute path, a
   * Windows drive-relative `C:foo` and a `..` segment are all refused lexically,
   * and both sides then go through `fs.realpath` so a symlink in the store
   * pointing out of it is caught too.
   *
   * What `realpath` does not catch is a hard link, which has no separate identity
   * to resolve. So this bounds what a playlist may *name*, not what the
   * filesystem can be made to mean — the same limit
   * docs/residual-review-findings/feat-live-scene-worlds.md records for clips.
   */
  async resolveTrack(rel: unknown): Promise<TrackResolution> {
    if (typeof rel !== "string" || rel.trim().length === 0) return { ok: false, reason: "not-a-path" };
    if (path.isAbsolute(rel)) return { ok: false, reason: "escapes-store" };
    // `C:foo` is drive-relative on Windows and `path.isAbsolute` says false.
    if (/^[A-Za-z]:/.test(rel)) return { ok: false, reason: "escapes-store" };

    let root: string;
    try {
      root = await fs.realpath(this.root);
    } catch {
      return { ok: false, reason: "missing" };
    }
    const candidate = path.resolve(root, rel);
    if (!confined(root, candidate)) return { ok: false, reason: "escapes-store" };

    let real: string;
    try {
      real = await fs.realpath(candidate);
    } catch {
      return { ok: false, reason: "missing" };
    }
    if (!confined(root, real)) return { ok: false, reason: "escapes-store" };
    return { ok: true, file: real };
  }
}

// ---------------------------------------------------------------------------
// Index edits
//
// Pure functions over a playlist, the way the manifest edits at the foot of
// storage/worlds.ts are: every one is testable without a disk, and one that
// names something absent returns null, which the store reports as a refusal
// rather than writing an unchanged file.
// ---------------------------------------------------------------------------

/**
 * What of a client-supplied entry is allowed into the index.
 *
 * Named field by field here, and *only* here: this value never came off disk, so
 * there is nothing of the author's to lose and a stray key would be persisted
 * forever. A duration that is not a finite number is zero rather than `NaN`, and
 * BPM goes through `usableBpm` so an out-of-range tag arrives as not-yet-known
 * rather than as a value (origin R29, R34).
 */
function cleanTrack(track: PlaylistTrack): PlaylistTrack {
  // Forward slashes, always. The index travels between machines with the store,
  // and a backslash written on Windows is not a separator anywhere else — the
  // rule `importClip` keeps when it answers `clips/<name>`.
  const forwardSlashes = String(track.path).replace(/\\/g, "/");
  const bpm = usableBpm(track.bpm);
  return {
    path: forwardSlashes,
    name: displayName(track.name, path.posix.basename(forwardSlashes)),
    durationMs: Number.isFinite(track.durationMs) && track.durationMs > 0 ? track.durationMs : 0,
    ...(bpm === null ? {} : { bpm, bpmSource: track.bpmSource === "set" ? "set" : "measured" }),
    ...(track.unplayable === true ? { unplayable: true } : {}),
  };
}

export function renamePlaylist(playlist: Playlist, name: unknown): Playlist | null {
  const next = displayName(name, "");
  if (next.length === 0) return null;
  if (next === playlist.name) return playlist;
  return { ...playlist, name: next };
}

/**
 * Put the tracks in a new order, named by path.
 *
 * The whole order, like `reorderTransitions`: a partial one is refused rather
 * than appended to, because an order naming half the playlist would silently
 * decide where the other half went.
 */
export function reorderTracks(playlist: Playlist, order: unknown): Playlist | null {
  if (!Array.isArray(order)) return null;
  if (order.length !== playlist.tracks.length) return null;
  const byPath = new Map(playlist.tracks.map((track) => [track.path, track]));
  const next: PlaylistTrack[] = [];
  for (const entry of order) {
    const track = typeof entry === "string" ? byPath.get(entry) : undefined;
    // Refused rather than skipped: a path this playlist does not hold means the
    // client is ordering a list it no longer has, and the honest answer is to
    // leave the index alone.
    if (!track || next.includes(track)) return null;
    next.push(track);
  }
  return { ...playlist, tracks: next };
}

export function removeTrack(playlist: Playlist, trackPath: unknown): Playlist | null {
  if (!playlist.tracks.some((track) => track.path === trackPath)) return null;
  return { ...playlist, tracks: playlist.tracks.filter((track) => track.path !== trackPath) };
}

/**
 * Record a tempo for one track, or that none is known.
 *
 * `null` clears it back to not-yet-known rather than writing a zero, and a value
 * outside the range is refused with the field left as it was — origin R32, and
 * the reason `usableBpm` is an acceptance rather than a negation.
 */
export function setTrackBpm(
  playlist: Playlist,
  trackPath: unknown,
  bpm: unknown,
  source: "measured" | "set" = "measured",
): Playlist | null {
  const index = playlist.tracks.findIndex((track) => track.path === trackPath);
  if (index < 0) return null;
  const current = playlist.tracks[index]!;
  if (bpm === null) {
    const { bpm: _bpm, bpmSource: _source, ...rest } = current;
    return { ...playlist, tracks: playlist.tracks.map((track, i) => (i === index ? rest : track)) };
  }
  const usable = usableBpm(bpm);
  if (usable === null) return null;
  return {
    ...playlist,
    tracks: playlist.tracks.map((track, i) =>
      i === index ? { ...track, bpm: usable, bpmSource: source } : track,
    ),
  };
}

/**
 * Record a track's real length, as a client measured it.
 *
 * `recordClipDuration` in `storage/worlds.ts` is the pattern and the reason:
 * the server stores the number it was given and inspects no media itself. A
 * FLAC's length is in its `STREAMINFO` and is known at import, but an MP3's
 * cannot be known without decoding, and U4 refused to infer one from bitrate
 * because this number becomes the transport's clock. So `durationMs === 0`
 * means **not known**, and this is how it stops being that.
 *
 * Refused rather than clamped for a value that is not a usable length: an
 * acceptance, so `NaN` and `Infinity` — both reachable through `JSON.parse` —
 * fail closed rather than becoming a duration nothing can pace against.
 */
export function setTrackDuration(
  playlist: Playlist,
  trackPath: unknown,
  durationMs: unknown,
): Playlist | null {
  if (!(typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0)) return null;
  const index = playlist.tracks.findIndex((track) => track.path === trackPath);
  if (index < 0) return null;
  if (playlist.tracks[index]!.durationMs === durationMs) return playlist;
  return {
    ...playlist,
    tracks: playlist.tracks.map((track, i) => (i === index ? { ...track, durationMs } : track)),
  };
}

/**
 * Mark a track as one that will not play, or take the mark off again.
 *
 * The entry itself is left exactly as it was (R14) — the ordering is the
 * author's work, and a track whose file comes back is playable again, which is
 * why this clears as well as sets. Absent rather than `false` when clear, so an
 * index does not accumulate a field for every track that has always been fine.
 */
/**
 * Turn shuffle on or off for a playlist.
 *
 * The tracks are not touched — the whole of the decision. What is drawn is the
 * transport's business and what is written is the author's ordering, and this
 * writes one switch between them. Absent rather than `false` when off, for the
 * reason `setTrackUnplayable` clears rather than writing one.
 */
export function setPlaylistShuffle(playlist: Playlist, shuffle: unknown): Playlist | null {
  // An acceptance, as `rebuild` reads it: the only two things a client may ask
  // for are on and off, and anything else is a message this build cannot honour
  // rather than a value to coerce.
  if (typeof shuffle !== "boolean") return null;
  if ((playlist.shuffle === true) === shuffle) return playlist;
  const { shuffle: _was, ...rest } = playlist;
  return shuffle ? { ...rest, shuffle: true } : rest;
}

export function setTrackUnplayable(
  playlist: Playlist,
  trackPath: unknown,
  unplayable: boolean,
): Playlist | null {
  const index = playlist.tracks.findIndex((track) => track.path === trackPath);
  if (index < 0) return null;
  const current = playlist.tracks[index]!;
  if ((current.unplayable === true) === unplayable) return playlist;
  const { unplayable: _was, ...rest } = current;
  const next = unplayable ? { ...rest, unplayable: true } : rest;
  return { ...playlist, tracks: playlist.tracks.map((track, i) => (i === index ? next : track)) };
}
