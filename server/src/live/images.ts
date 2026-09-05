import path from "node:path";
import { promises as fs } from "node:fs";
import type { World } from "../../../shared/src/types.js";
import { IMAGE_NAME_MAX, cleanText, isImageSlot, overlayEntries } from "../../../shared/src/overlays.js";
import { resolveClipPath, type WorldStore } from "../storage/worlds.js";

/**
 * Image types the overlay route will answer with.
 *
 * A table of its own, beside `VIDEO_MIME` and for the reason that one is not
 * part of the static table: the static table describes what the UI bundle is
 * made of, and a `.png` appearing there would make every unrelated file in
 * `ui/dist` a candidate for this route.
 *
 * No SVG. Every other entry here is a picture and nothing else; an SVG is a
 * document that can carry script and external references, and nothing about an
 * overlay needs one.
 *
 * Animation is not in this table because it is not a type — a `.gif` and a
 * `.webp` may each be still or moving, and the build draws whichever it is
 * given. That is a stated decision, not an oversight; see the brief.
 */
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
};

export function imageMime(file: string): string | null {
  return IMAGE_MIME[path.extname(file).toLowerCase()] ?? null;
}

/**
 * Every image name the World's slots actually name.
 *
 * Walked loosely — any stored entry carrying an image name — rather than
 * through the strict guard, which is `referencedClips`' rule. A slot the guard
 * refuses for an unrelated fault, a hand-edited opacity of 300, still names a
 * file the operator imported on purpose; a route that refused it as well would
 * answer 404 for a second cause nobody asked about. Nothing is reachable this
 * way that the picture shows, because the layer does not draw a refused slot
 * either.
 */
export function referencedImages(world: World): Set<string> {
  const names = new Set<string>();
  for (const entry of overlayEntries(world.overlays) ?? []) {
    // The exported guard, not a local cast: one definition of "is this a
    // picture" that the layer, the editor and this route all share, so none of
    // them can drift from the others about what the word means.
    if (!isImageSlot(entry)) continue;
    // The *cleaned* name, because that is the one the layer asks for. Keying
    // this set on the raw stored value meant a hand-edited "  logo.png" was
    // allowed under a name nothing ever requests, while the request the layer
    // actually makes — trimmed by the same `cleanText` the guard applies — was
    // refused. The slot drew nothing and the route said 404 forever.
    const name = cleanText(entry.image, IMAGE_NAME_MAX);
    if (name !== undefined) names.add(name);
  }
  return names;
}

export type ImageLookup =
  | { ok: true; file: string; size: number; mime: string }
  | { ok: false; status: 403 | 404 };

/**
 * Find the file behind an image request, or refuse it.
 *
 * `lookupClip`'s shape, and deliberately not a call to it: the two differ in
 * what they will serve and in which set they check against, and a shared
 * function taking a "kind" would have to be read twice to answer either
 * question. What *is* shared is the confinement — `resolveClipPath` confines to
 * the World directory rather than to `clips/`, so it resolves `images/logo.png`
 * unchanged, and two copies of a path rule drift with the copy that lags being
 * the one that leaks.
 */
export async function lookupImage(
  store: WorldStore,
  worldId: unknown,
  imagePath: unknown,
): Promise<ImageLookup> {
  if (typeof worldId !== "string" || typeof imagePath !== "string") return { ok: false, status: 404 };
  const dir = store.dirFor(worldId);
  if (!dir) return { ok: false, status: 404 };

  // Loaded without the confinement pass, `lookupClip`'s reason: that pass
  // resolves every path the manifest names, and only the one asked for matters
  // here — it is resolved below, which is the check that counts.
  const loaded = await store.load(worldId, { validate: false });
  if (!loaded) return { ok: false, status: 404 };
  if (!referencedImages(loaded.world).has(imagePath)) return { ok: false, status: 404 };

  const resolved = await resolveClipPath(dir, imagePath);
  if (!resolved.ok) return { ok: false, status: resolved.reason === "missing" ? 404 : 403 };

  const mime = imageMime(resolved.file);
  if (!mime) return { ok: false, status: 403 };

  const stat = await fs.stat(resolved.file).catch(() => null);
  if (!stat?.isFile()) return { ok: false, status: 404 };
  return { ok: true, file: resolved.file, size: stat.size, mime };
}
