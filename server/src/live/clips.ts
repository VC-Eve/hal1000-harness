import path from "node:path";
import { promises as fs } from "node:fs";
import type { World } from "../../../shared/src/types.js";
import { resolveClipPath, type WorldStore } from "../storage/worlds.js";

/**
 * Video types the clip route will answer with.
 *
 * A table of its own rather than an addition to the static one: the static
 * table describes what the UI bundle is made of, and a `.mp4` appearing there
 * would make every unrelated file in `ui/dist` a candidate for the byte-range
 * path this route needs and that one does not have.
 */
const VIDEO_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".m4v": "video/mp4",
};

export function videoMime(file: string): string | null {
  return VIDEO_MIME[path.extname(file).toLowerCase()] ?? null;
}

/** Every clip path the manifest actually names. Clips live on States only. */
export function referencedClips(world: World): Set<string> {
  const paths = new Set<string>();
  for (const state of world.states ?? []) if (state.clip?.path) paths.add(state.clip.path);
  return paths;
}

export type ClipLookup =
  | { ok: true; file: string; size: number; mime: string }
  | { ok: false; status: 403 | 404 };

/**
 * Find the file behind a clip request, or refuse it.
 *
 * Confinement is the floor, not the whole rule. The route serves only clips the
 * World's manifest actually references, so dropping an unrelated file into
 * `clips/` — a video of something else, a copy of a document — does not make it
 * network-reachable. The confinement itself is the store's, called rather than
 * restated: two copies of one rule drift, and the copy that lags is the one
 * that leaks.
 */
export async function lookupClip(store: WorldStore, worldId: unknown, clipPath: unknown): Promise<ClipLookup> {
  if (typeof worldId !== "string" || typeof clipPath !== "string") return { ok: false, status: 404 };
  const dir = store.dirFor(worldId);
  if (!dir) return { ok: false, status: 404 };

  // Loaded without the confinement pass: that pass resolves every clip the
  // manifest names, two `realpath` calls apiece, and a seeking <video> issues a
  // Range request per scrub. Only the one path actually asked for is resolved
  // below, which is the check that matters here anyway.
  const loaded = await store.load(worldId, { validate: false });
  if (!loaded) return { ok: false, status: 404 };
  // A World whose manifest will not parse references nothing, so it serves
  // nothing — which is the same answer as an empty World and needs no branch.
  if (!referencedClips(loaded.world).has(clipPath)) return { ok: false, status: 404 };

  const resolved = await resolveClipPath(dir, clipPath);
  if (!resolved.ok) return { ok: false, status: resolved.reason === "missing" ? 404 : 403 };

  const mime = videoMime(resolved.file);
  if (!mime) return { ok: false, status: 403 };

  const stat = await fs.stat(resolved.file).catch(() => null);
  if (!stat?.isFile()) return { ok: false, status: 404 };
  return { ok: true, file: resolved.file, size: stat.size, mime };
}

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse one `Range: bytes=…` header against a known size.
 *
 * Returns null when there is no range to honour and `unsatisfiable` when the
 * client asked for bytes that do not exist — the two are different answers
 * (200 and 416) and collapsing them would make a seek past the end look like a
 * request for the whole file.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | null | "unsatisfiable" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  // A zero-length file can satisfy no range at all. Without this the suffix
  // branch below returns {start: 0, end: -1}, and `createReadStream` throws
  // ERR_OUT_OF_RANGE *after* the 206 headers have already gone out.
  if (size <= 0) return "unsatisfiable";

  if (rawStart === "") {
    // A suffix range: the last N bytes.
    const length = Number(rawEnd);
    if (!Number.isFinite(length) || length <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - length), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return "unsatisfiable";
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(end) || end < start) return "unsatisfiable";
  return { start, end };
}
