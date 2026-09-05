// What is drawn over the video, and the one place the vocabulary for it lives.
//
// An overlay slot says *where* something goes and *how* it looks. There are two
// kinds. A text slot says what it says — the words are the operator's, a title
// on the World, a header on the playlist, a description on a track — and a
// picture slot names an image the World holds. Both are the World's, because the
// World is the show. Every side reads this file: the store guards with it, the
// layer draws from it, the route decides what it will serve by it, the tests
// call it, and an agent asking what is on screen can answer from the same two
// messages a browser holds.
//
// Closed sets rather than free strings for position, source and kind, for the
// reason `effects.ts` gives: a fourth kind of caption is an entry in `SOURCES`
// and nothing else, and no consumer can drift out of step with the set.
//
// A stored slot that does not say which kind it is, is a text slot. That is what
// keeps every World written before pictures existed loading unchanged, and it is
// why the canonical form of a text slot carries no `kind` — adding one would
// rewrite every manifest on its owner's next edit. An unknown kind is refused
// rather than read as text: drawing a caption because a word was misspelled is
// worse than drawing nothing.

import type { TransportState } from "./types.js";
import type { World } from "./worlds.js";

/** Where a slot sits over the picture: a three-by-three grid. */
export const POSITIONS = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;
export type OverlayPosition = (typeof POSITIONS)[number];

/** Where a slot's words come from. */
export const SOURCES = ["title", "playlist-header", "track-description", "text"] as const;
export type OverlaySource = (typeof SOURCES)[number];

/** What a slot draws. Absent on a stored slot means `text`. */
export const SLOT_KINDS = ["text", "image"] as const;
export type OverlaySlotKind = (typeof SLOT_KINDS)[number];

/**
 * One line over the picture.
 *
 * `size` is a percentage of the picture's rendered height, never pixels, so the
 * small player on `/live` and a fullscreened `/broadcast` draw the same
 * proportions. `color` is a canonical `#rrggbb`. `font` is a family name the
 * browser resolves; a name it does not know falls back to the page's own.
 *
 * `kind` is optional and the canonical form omits it — see the note at the top
 * of this file. A stored `kind: "text"` is accepted and dropped.
 */
export interface TextSlot {
  kind?: "text";
  position: OverlayPosition;
  source: OverlaySource;
  /** The words, for the `text` source only. */
  text?: string;
  font: string;
  size: number;
  color: string;
}

/**
 * One picture over the picture.
 *
 * `image` is a name relative to the World's own folder, never a path from
 * anywhere else: the route that serves it resolves it against that folder and
 * refuses everything outside, and a World stays a directory that can be zipped
 * and moved. `size` means exactly what it means on a text slot — a percentage
 * of the picture's rendered height — and the width follows the file's own aspect
 * ratio, so one number describes both kinds.
 *
 * `opacity` is a percentage, and absent means opaque. Absent rather than a
 * stored 100 so a World written before pictures existed gains no key, and so a
 * slot that never asked to be faded says nothing about fading.
 *
 * No font and no colour: neither means anything for a picture, and carrying
 * them so one guard could serve both kinds would be two dead fields on every
 * image slot.
 */
export interface ImageSlot {
  kind: "image";
  position: OverlayPosition;
  image: string;
  size: number;
  opacity?: number;
}

export type OverlaySlot = TextSlot | ImageSlot;

/** Whether a slot draws a picture. The partition every consumer shares. */
export function isImageSlot(slot: OverlaySlot): slot is ImageSlot {
  return slot.kind === "image";
}

/** Whether a slot draws words. */
export function isTextSlot(slot: OverlaySlot): slot is TextSlot {
  return slot.kind !== "image";
}

/** The longest title, header, description or fixed line stored. */
export const TEXT_MAX = 200;
/** The longest font family name stored. */
export const FONT_MAX = 60;
/** The longest World-relative image name stored. */
export const IMAGE_NAME_MAX = 120;
/** The most slots a World may hold. */
export const MAX_OVERLAYS = 20;
/** The size band, in percent of picture height. */
export const SIZE_MIN = 1;
export const SIZE_MAX = 25;
/** The opacity band, in percent. Absent means opaque; a stored 0 means invisible. */
export const OPACITY_MIN = 0;
export const OPACITY_MAX = 100;

/** The page's own family, which is what a slot draws in until someone picks. */
export const DEFAULT_FONT = "Segoe UI";

/**
 * The families the editor offers.
 *
 * A list to choose from rather than a name to spell: a typo in a free text
 * field drew in the page's own font and said nothing about why. Windows is the
 * dev OS and these all ship with it; each is also either present on macOS and
 * Linux or resolves to something close, and the build ships no font files, so
 * a family a machine does not have falls back the way it always did.
 *
 * The list is what is *offered*, not what is *allowed*. A family stored by a
 * hand edit, by an agent, or by a build that offered a different list stays
 * stored and stays selected — `cleanSlot` bounds a family and never checks it
 * against this. Two sites, and only one of them is this list; see
 * docs/solutions/a-fix-to-what-a-picker-offers-is-not-a-fix-to-what-it-keeps.md.
 */
export const FONTS: readonly string[] = [
  DEFAULT_FONT,
  "Arial",
  "Calibri",
  "Cambria",
  "Comic Sans MS",
  "Consolas",
  "Courier New",
  "Franklin Gothic Medium",
  "Georgia",
  "Impact",
  "Lucida Console",
  "Palatino Linotype",
  "Tahoma",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
];
export const DEFAULT_COLOR = "#ffffff";

/**
 * What every World starts with: the title at top centre, and the playlist's
 * header stacked above the track's description at bottom left.
 *
 * Sizes were read off a real 1080p output on 2026-09-05 (U6 of the plan): the
 * title at 5% of the picture's height is 54px there, the header 32px and the
 * description 38px, all legible over a test pattern from across a room.
 */
export const DEFAULT_OVERLAYS: readonly TextSlot[] = [
  { position: "top-center", source: "title", font: DEFAULT_FONT, size: 5, color: DEFAULT_COLOR },
  { position: "bottom-left", source: "playlist-header", font: DEFAULT_FONT, size: 3, color: DEFAULT_COLOR },
  { position: "bottom-left", source: "track-description", font: DEFAULT_FONT, size: 3.5, color: DEFAULT_COLOR },
];

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * A colour as it is stored: lowercase `#rrggbb`, or null for anything else.
 *
 * Shape and canonical form only. The server's `normalizeColor` lifts contrast
 * against the chat pane and rotates hues away from HAL's own red and amber —
 * rules written so adapter text cannot pass for HAL's voice — and applied here
 * they would silently rewrite a black or red overlay the operator chose.
 */
export function hexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = HEX.exec(value.trim());
  if (!match) return null;
  const digits = match[1]!.toLowerCase();
  return `#${digits.length === 3 ? digits.replace(/./g, (c) => c + c) : digits}`;
}

/**
 * Text as it is stored: trimmed and bounded, or undefined for nothing.
 *
 * Undefined rather than `""`, so a cleared field removes the key the way a
 * cleared tempo does, and no index gains a field for every track that was never
 * described.
 */
export function cleanText(value: unknown, max = TEXT_MAX): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().slice(0, max);
  return text.length > 0 ? text : undefined;
}

/**
 * A size that may be used, or null.
 *
 * An acceptance, negated once around the whole thing, so `NaN` and `Infinity`
 * fail closed — see
 * docs/solutions/a-threshold-guard-written-as-a-negation-fails-open-on-nan.md.
 */
export function usableSize(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!(Number.isFinite(value) && value >= SIZE_MIN && value <= SIZE_MAX)) return null;
  return value;
}

/**
 * An opacity that may be used, or null.
 *
 * `usableSize`'s shape and for its reason — one negation around the whole
 * acceptance, so `NaN` and `Infinity` fail closed. Absent is *not* this
 * function's business: the caller decides that absent means opaque, because
 * `usableOpacity(undefined) ?? 100` and `usableOpacity(NaN) ?? 100` would
 * otherwise mean the same thing, and one of those is a refusal.
 */
export function usableOpacity(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!(Number.isFinite(value) && value >= OPACITY_MIN && value <= OPACITY_MAX)) return null;
  return value;
}

function isPosition(value: unknown): value is OverlayPosition {
  return typeof value === "string" && (POSITIONS as readonly string[]).includes(value);
}

function isSource(value: unknown): value is OverlaySource {
  return typeof value === "string" && (SOURCES as readonly string[]).includes(value);
}

/**
 * One slot as a client supplied it, or null.
 *
 * Refused rather than clamped: a size of 30 is not a size, and clamping it to
 * 25 would draw something nobody asked for. A field that means nothing to the
 * kind it arrived on is dropped, so every field means one thing — a stray `text`
 * on a non-text source, a `font` on a picture.
 *
 * The kind is read first and decides everything after it. `undefined` and
 * `"text"` are both text; anything else that is not `"image"` is refused rather
 * than read as text, because a misspelled kind should draw nothing rather than
 * a caption nobody asked for.
 */
export function cleanSlot(value: unknown): OverlaySlot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isPosition(raw.position)) return null;
  if (raw.kind === "image") return cleanImageSlot(raw, raw.position);
  if (raw.kind !== undefined && raw.kind !== "text") return null;
  return cleanTextSlot(raw, raw.position);
}

function cleanTextSlot(raw: Record<string, unknown>, position: OverlayPosition): TextSlot | null {
  if (!isSource(raw.source)) return null;
  const size = usableSize(raw.size);
  const color = hexColor(raw.color);
  if (size === null || color === null) return null;
  const font = cleanText(raw.font, FONT_MAX) ?? DEFAULT_FONT;
  const text = raw.source === "text" ? cleanText(raw.text) : undefined;
  // No `kind` in the canonical form: see the note at the top of this file. A
  // stored `kind: "text"` was accepted above and is dropped here.
  return {
    position,
    source: raw.source,
    ...(text === undefined ? {} : { text }),
    font,
    size,
    color,
  };
}

function cleanImageSlot(raw: Record<string, unknown>, position: OverlayPosition): ImageSlot | null {
  const size = usableSize(raw.size);
  if (size === null) return null;
  const image = cleanText(raw.image, IMAGE_NAME_MAX);
  // A picture slot with no picture is not a slot. This is also the state a row
  // sits in between being added and being filled, which is why the editor keeps
  // its own empty state rather than reading a refusal as damage.
  if (image === undefined) return null;
  // Absent stays absent — the one case `usableOpacity` deliberately does not
  // answer for. A present-but-unusable opacity refuses the slot rather than
  // falling back to opaque, so `NaN` cannot arrive as "no fade requested".
  let opacity: number | undefined;
  if (raw.opacity !== undefined) {
    const asked = usableOpacity(raw.opacity);
    if (asked === null) return null;
    opacity = asked;
  }
  return {
    kind: "image",
    position,
    image,
    size,
    ...(opacity === undefined ? {} : { opacity }),
  };
}

/**
 * The whole list as a client supplied it, or null — the strict guard, for
 * `set-world-overlays` only.
 *
 * One bad slot refuses the list, the way `cleanEffects` refuses: the client is
 * sending what it thinks the World holds, and writing part of it would leave the
 * two disagreeing.
 */
export function cleanOverlays(value: unknown): OverlaySlot[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_OVERLAYS) return null;
  const out: OverlaySlot[] = [];
  for (const entry of value) {
    const slot = cleanSlot(entry);
    if (slot === null) return null;
    out.push(slot);
  }
  return out;
}

/**
 * The entries of a stored `overlays` that are shaped like entries at all — the
 * lenient guard, for the manifest on disk.
 *
 * `effectEntries`' rule, and for its reason: a manifest is hand-editable, and a
 * strict guard here would answer nothing for a list holding one `size: 30`, so
 * the next node drag would write the World without its slots. Kept whole, and
 * judged one at a time when they are drawn (`resolveSlot`). Undefined when the
 * key is absent, so a World written before this existed stays that way.
 */
export function overlayEntries(value: unknown): OverlaySlot[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is OverlaySlot => typeof v === "object" && v !== null && !Array.isArray(v),
  );
}

/**
 * The slots a World draws.
 *
 * Absent means the defaults, so a World written before this feature has the
 * three the brief asks for without a write on open — the `shuffle`-absent idiom.
 * An explicit `[]` means none. A null World draws nothing, so the layer can
 * mount before the first `world` message lands.
 */
export function slotsOf(world: World | null | undefined): readonly OverlaySlot[] {
  if (!world) return [];
  return world.overlays ?? DEFAULT_OVERLAYS;
}

/**
 * What one slot says right now, or null for nothing.
 *
 * The one place a slot's words are decided, so the layer, the tests and an
 * agent all agree. Null for an empty source and for a stored slot that is not
 * usable — an unknown position, a size outside the band — because an unusable
 * slot is skipped, never the list (see `overlayEntries`).
 *
 * Null for a picture slot too, which is not a hedge: a picture says nothing.
 * This function answers "the words this slot draws", and the honest answer for
 * a picture is that there are none — the layer asks `isImageSlot` first and
 * never reaches here for one.
 */
export function resolveSlot(
  slot: OverlaySlot,
  world: World | null | undefined,
  transport: TransportState | null | undefined,
): string | null {
  if (cleanSlot(slot) === null) return null;
  if (isImageSlot(slot)) return null;
  switch (slot.source) {
    case "title":
      return cleanText(world?.title) ?? null;
    case "playlist-header":
      return cleanText(transport?.header) ?? null;
    case "track-description":
      return cleanText(transport?.description) ?? null;
    case "text":
      return cleanText(slot.text) ?? null;
  }
}
