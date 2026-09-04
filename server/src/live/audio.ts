import path from "node:path";
import { promises as fs } from "node:fs";
import type { AudioStore } from "../storage/audio.js";

/**
 * Audio types the store accepts and the track route will answer with.
 *
 * A table of its own, exactly as `VIDEO_MIME` in `clips.ts` is one: the static
 * table describes what the UI bundle is made of, and an `.mp3` appearing there
 * would make every unrelated file in `ui/dist` a candidate for the byte-range
 * path this needs and that one does not have.
 *
 * Deliberately the *single* gate. The browser offers what this table names and
 * the byte route serves what this table names, so what the author can pick and
 * what HAL can play cannot drift apart — the same rule `videoMime` establishes,
 * and the reason it lives here rather than inside either caller.
 *
 * Small on purpose. Origin R1 permits any format the browser already decodes,
 * but a format listed here is one the import path claims to understand — it
 * reads its tag, and U8 decodes it to measure a tempo. Adding `.ogg` to be
 * generous would offer files whose tag nothing here can read, which reads to
 * the author as a broken import rather than as an unsupported format.
 */
const AUDIO_MIME: Record<string, string> = {
  ".flac": "audio/flac",
  ".mp3": "audio/mpeg",
};

export function audioMime(file: string): string | null {
  return AUDIO_MIME[path.extname(file).toLowerCase()] ?? null;
}

/**
 * Every track path some playlist actually names.
 *
 * The store's equivalent of `referencedClips`, and it exists for the same
 * reason: confinement is the floor, not the whole rule. A file dropped into
 * `tracks/` by hand — a copy of something else, a track whose playlist was
 * deleted — is inside the store and passes `resolveTrack`, and that must not be
 * enough to make it network-reachable.
 *
 * It reads every index rather than one, because a track belongs to no single
 * playlist: the store is shared (R9), the same file may be named by several, and
 * the element asking for bytes knows a path and nothing else. The cost is
 * recorded in docs/residual-review-findings/feat-live-audio-soundtrack.md rather
 * than optimised away with a cache, which would be a second copy of the
 * authorisation rule that can lag behind the indexes.
 */
export async function referencedTracks(store: AudioStore): Promise<Set<string>> {
  const paths = new Set<string>();
  for (const id of await store.ids()) {
    const playlist = await store.load(id);
    // An index that will not parse loads as null and so references nothing —
    // the same answer as an empty playlist, and it needs no branch.
    for (const track of playlist?.tracks ?? []) {
      if (typeof track?.path === "string") paths.add(track.path);
    }
  }
  return paths;
}

export type TrackLookup =
  | { ok: true; file: string; size: number; mime: string }
  | { ok: false; status: 403 | 404 };

/**
 * Find the file behind a track request, or refuse it.
 *
 * `lookupClip`'s shape, step for step, because the two routes defend the same
 * thing: the authorisation is that the *store's own index* names the file, the
 * confinement is the store's and is called rather than restated, and the
 * extension gate is `audioMime` — the single table the browser already offers
 * from, so what an author can pick and what HAL will serve cannot drift apart.
 */
export async function lookupTrack(store: AudioStore, trackPath: unknown): Promise<TrackLookup> {
  if (typeof trackPath !== "string") return { ok: false, status: 404 };

  // Asked before any filesystem work, as `lookupClip` asks about the manifest
  // first: an unreferenced path is refused without two `realpath` calls being
  // spent on it.
  if (!(await referencedTracks(store)).has(trackPath)) return { ok: false, status: 404 };

  const resolved = await store.resolveTrack(trackPath);
  if (!resolved.ok) return { ok: false, status: resolved.reason === "missing" ? 404 : 403 };

  const mime = audioMime(resolved.file);
  if (!mime) return { ok: false, status: 403 };

  const stat = await fs.stat(resolved.file).catch(() => null);
  if (!stat?.isFile()) return { ok: false, status: 404 };
  return { ok: true, file: resolved.file, size: stat.size, mime };
}
