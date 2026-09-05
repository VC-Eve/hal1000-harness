// Text drawn over the video, and the one place the vocabulary for it lives.
//
// An overlay slot says *where* a line goes, *what* it says and *how* it looks.
// The words are the operator's — a title on the World, a header on the
// playlist, a description on a track — and the look is the World's, because the
// World is the show. Both sides read this file: the store guards with it, the
// layer resolves with it, the tests call it, and an agent asking what is on
// screen can answer from the same two messages a browser holds.
//
// Closed sets rather than free strings for position and source, for the reason
// `effects.ts` gives: a fourth kind of caption is an entry here and nothing
// else, and no consumer can drift out of step with the set.

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

/**
 * One line over the picture.
 *
 * `size` is a percentage of the picture's rendered height, never pixels, so the
 * small player on `/live` and a fullscreened `/broadcast` draw the same
 * proportions. `color` is a canonical `#rrggbb`. `font` is a family name the
 * browser resolves; a name it does not know falls back to the page's own.
 */
export interface OverlaySlot {
  position: OverlayPosition;
  source: OverlaySource;
  /** The words, for the `text` source only. */
  text?: string;
  font: string;
  size: number;
  color: string;
}

/** The longest title, header, description or fixed line stored. */
export const TEXT_MAX = 200;
/** The longest font family name stored. */
export const FONT_MAX = 60;
/** The most slots a World may hold. */
export const MAX_OVERLAYS = 20;
/** The size band, in percent of picture height. */
export const SIZE_MIN = 1;
export const SIZE_MAX = 25;

/** The page's own family, which is what a slot draws in until someone picks. */
export const DEFAULT_FONT = "Segoe UI";
export const DEFAULT_COLOR = "#ffffff";

/**
 * What every World starts with: the title at top centre, and the playlist's
 * header stacked above the track's description at bottom left.
 *
 * Sizes are provisional — replaced by U6 check 5 of the plan, which reads them
 * off a real output. Until that runs, these are what ships.
 */
export const DEFAULT_OVERLAYS: readonly OverlaySlot[] = [
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
 * 25 would draw something nobody asked for. A stray `text` on a slot that does
 * not read it is dropped, so the field means one thing.
 */
export function cleanSlot(value: unknown): OverlaySlot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Partial<Record<keyof OverlaySlot, unknown>>;
  if (!isPosition(raw.position) || !isSource(raw.source)) return null;
  const size = usableSize(raw.size);
  const color = hexColor(raw.color);
  if (size === null || color === null) return null;
  const font = cleanText(raw.font, FONT_MAX) ?? DEFAULT_FONT;
  const text = raw.source === "text" ? cleanText(raw.text) : undefined;
  return {
    position: raw.position,
    source: raw.source,
    ...(text === undefined ? {} : { text }),
    font,
    size,
    color,
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
 */
export function resolveSlot(
  slot: OverlaySlot,
  world: World | null | undefined,
  transport: TransportState | null | undefined,
): string | null {
  if (cleanSlot(slot) === null) return null;
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
