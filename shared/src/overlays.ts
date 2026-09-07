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

import type { TransportState, Utterance } from "./types.js";
import { CONDITION_OPS } from "./worlds.js";
import type { Condition, World } from "./worlds.js";

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

/**
 * Where a slot's words come from.
 *
 * `speech` is the sentence the character is saying right now. Like
 * `playlist-header` and `track-description` it resolves from live state and
 * never from the manifest — the slot says *where and how*, and is the World's;
 * the words are decided when they are drawn. A World that carries no `speech`
 * slot therefore never puts a spoken word on its projector, which is how
 * subtitles are turned on and off, and why `/broadcast` goes on rendering only
 * what the operator arranged.
 */
export const SOURCES = ["title", "playlist-header", "track-description", "text", "speech"] as const;
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
 *
 * `outline`, `shadow` and `band` are how the words are treated, and all three
 * are optional with absent meaning none — the idiom `opacity` and `kind`
 * already use, so no existing manifest is rewritten and every slot written
 * before they existed draws exactly as it did.
 *
 * They replace `backing`, which named two fixed treatments the stylesheet drew
 * and which never had a control: it was reachable only by hand-editing a
 * manifest. A stored one is translated on read (`fromBacking`) and never
 * written back. Three flat fields rather than one `treatment` object for the
 * reason `states`, `conditions` and `fadeMs` are flat: they are independent of
 * each other, and only the editor groups them.
 */
export interface TextSlot extends SlotWhen {
  kind?: "text";
  position: OverlayPosition;
  source: OverlaySource;
  /** The words, for the `text` source only. */
  text?: string;
  font: string;
  size: number;
  color: string;
  outline?: TextOutline;
  shadow?: TextShadow;
  /**
   * A plate behind the words. `true` or absent, never a stored `false`, so
   * "no band" has one shape — `fadeMs`' rule.
   */
  band?: true;
}

/**
 * A border around the letters.
 *
 * `width` is a percentage of the slot's own type size, never pixels and never a
 * share of the picture: a border is a property of the letterform, so it has to
 * scale with the letters and not with the frame. Zero is legal and draws
 * nothing — the editor's own field holds it while a number is being typed.
 *
 * Drawn *outside* the letterform: raising the width thickens the border and
 * never thins the glyph. That is a statement about what the operator sees, not
 * about which CSS property draws it; the browser check is what settles it.
 */
export interface TextOutline {
  color: string;
  width: number;
}

/**
 * A shadow cast by the letters.
 *
 * `angle` is the direction it is cast, in degrees clockwise from straight up —
 * 135 is down and to the right, 180 straight down. `distance` and `blur` are
 * percentages of the slot's own type size, `width`'s reason.
 *
 * A distance of 0 casts evenly in every direction, which is what a glow is.
 * There is no glow mode and no fourth field: one dial says both.
 *
 * `opacity` is a percentage and absent means opaque, `ImageSlot.opacity`'s
 * rule. It is a field of its own rather than an alpha on the colour because a
 * colour is stored `#rrggbb` everywhere in this file and one place that stored
 * eight digits would be a second colour vocabulary.
 */
export interface TextShadow {
  color: string;
  opacity?: number;
  angle: number;
  distance: number;
  blur: number;
}

/**
 * When a slot is drawn, and how it arrives — the part both kinds share.
 *
 * The two halves are the two a transition has, and they are deliberately the
 * same two. `states` is the structural half: it is `from`/`fromAny` for
 * something that has no position in the graph, so naming none means every State
 * the way `fromAny` does. `conditions` is the filter, in the vocabulary
 * `world-graph.ts` owns, and all clauses conjoin. Both must be satisfied.
 *
 * A transition gets the structural half for free from where it sits. A slot sits
 * nowhere, so without `states` the only way to caption a State would be a bool
 * Parameter written by an Effect — which latches when the State is left, and
 * fires on a clock rather than on arrival. That is why there are two fields here
 * and not one.
 *
 * All three are absent-means-the-old-behaviour, the idiom `opacity`, `kind` and
 * `outline` already use: no States means every State, no conditions means
 * always, no fade means an instant cut. So every World written before this draws
 * exactly as it did and gains no key on its next save.
 */
export interface SlotWhen {
  /** The State ids this slot is drawn in. Absent or empty means every State. */
  states?: string[];
  /** Clauses that must all hold for the slot to be drawn. Absent or empty means always. */
  conditions?: Condition[];
  /** How long the slot takes to fade in and out. Absent means an instant cut. */
  fadeMs?: number;
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
 *
 * `image` is optional, and absent draws nothing while taking no space — the
 * rule a text slot with no words already keeps. That is what a row looks like
 * between being added and being filled, and treating it as damage instead would
 * have made an operator's first act on this feature look like a fault, and
 * would have had the editor's write filter drop the row it had just added.
 */
export interface ImageSlot extends SlotWhen {
  kind: "image";
  position: OverlayPosition;
  image?: string;
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
/** The longest State id a slot may name. Ids are generated far shorter; this bounds a hand edit. */
export const STATE_ID_MAX = 64;
/**
 * How many States one slot may name, and how many clauses it may carry.
 *
 * `MAX_OVERLAYS`' reason, one level down, and the reason it is a *count* and not
 * only a per-entry bound: the guard runs on every load, on every report and on
 * every render of both surfaces, so an unbounded list in a portable manifest is
 * unbounded work behind every ordinary edit — and the folder carries it to the
 * next machine. Far more than anyone would author by hand.
 */
export const MAX_SLOT_STATES = 64;
export const MAX_SLOT_CONDITIONS = 32;
/**
 * The fade band, in milliseconds. Absent means a cut; a stored 0 is dropped.
 *
 * The ceiling is `MAX_BLEND_MS`'s reason rather than its number: a fade longer
 * than a short clip would still be arriving when the picture it labels has gone.
 */
export const FADE_MIN = 0;
export const MAX_OVERLAY_FADE_MS = 4_000;

/**
 * The treatment bands, each a percentage of the slot's *type size* — not of the
 * picture's height, which is what `size` is a percentage of. Two referents in
 * one panel is the cost of authoring in the unit everything else here uses; the
 * editor labels which is which, and so does every comment that mentions one.
 *
 * The ceilings are what stops being a border and starts being a second glyph:
 * a quarter of the type size of border, half of it of offset, a whole type size
 * of blur for a glow that still belongs to its words.
 */
export const OUTLINE_WIDTH_MIN = 0;
export const OUTLINE_WIDTH_MAX = 25;
export const SHADOW_DISTANCE_MIN = 0;
export const SHADOW_DISTANCE_MAX = 50;
export const SHADOW_BLUR_MIN = 0;
export const SHADOW_BLUR_MAX = 100;
/**
 * The angle band, in degrees clockwise from straight up. 360 is refused rather
 * than folded to 0: two spellings of one direction is the thing every other
 * guard in this file refuses to store.
 */
export const SHADOW_ANGLE_MIN = 0;
export const SHADOW_ANGLE_MAX = 359;

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

/**
 * A fade that may be used, or null. `usableSize`'s shape and for its reason.
 */
export function usableFade(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!(Number.isFinite(value) && value >= FADE_MIN && value <= MAX_OVERLAY_FADE_MS)) return null;
  return value;
}

/**
 * A number inside a band, or null. `usableSize`'s shape and for its reason —
 * one acceptance, negated once around the whole thing, so `NaN` and `Infinity`
 * fail closed.
 *
 * Taken as a parameter rather than written out four more times, because the
 * four treatment bands differ only in their ends. It is not exported: the
 * bands it guards are, and a caller that wanted to invent a fifth one should
 * name it here first.
 */
function inBand(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number") return null;
  if (!(Number.isFinite(value) && value >= min && value <= max)) return null;
  return value;
}

/**
 * Whether a value is a clause the machine could evaluate.
 *
 * One acceptance, negated once around the whole thing, so `NaN` and `Infinity`
 * fail closed — docs/solutions/a-threshold-guard-written-as-a-negation-fails-open-on-nan.md.
 * The operator set is read from its one registration point rather than
 * re-assembled here from the two type-scoped halves, so a seventh operator is an
 * edit in `worlds.ts` and nowhere else.
 *
 * It does **not** ask whether the World declares the Parameter, or whether the
 * operator suits its type. Those are reports (`danglingConditions`,
 * `mismatchedOperators`), not refusals: a clause naming a Parameter that was
 * removed an hour ago is a fault to tell the operator about, and refusing the
 * whole slot for it would take the caption's words down with it.
 */
export function isCondition(value: unknown): value is Condition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (typeof raw.parameter !== "string" || raw.parameter.length === 0) return false;
  if (typeof raw.op !== "string" || !(CONDITION_OPS as readonly string[]).includes(raw.op)) return false;
  if (typeof raw.value === "boolean") return true;
  return typeof raw.value === "number" && Number.isFinite(raw.value);
}

/**
 * The three shared fields as a client supplied them, or null to refuse the slot.
 *
 * Present-but-malformed refuses, the rule an unknown `kind` and a malformed
 * `outline` already follow: drawing a caption on a schedule nobody wrote is the
 * worse half of the trade. Empty is dropped rather than stored, so the canonical
 * form of a slot that is always drawn is the one every existing manifest has.
 *
 * A State id is not checked against the World here — this guard is per slot and
 * has no World. A slot naming a State that does not exist is `danglingStates`,
 * for the same reason a dangling Parameter is a report and not a refusal.
 */
function cleanWhen(raw: Record<string, unknown>): SlotWhen | null {
  const out: SlotWhen = {};
  if (raw.states !== undefined) {
    if (!Array.isArray(raw.states) || raw.states.length > MAX_SLOT_STATES) return null;
    // A Set for the duplicate test, not `Array.includes`: the list is bounded
    // now, but a linear scan per entry is quadratic and this runs on every load
    // and every render.
    const seen = new Set<string>();
    const states: string[] = [];
    for (const entry of raw.states) {
      if (typeof entry !== "string") return null;
      const id = entry.trim();
      if (id.length === 0 || id.length > STATE_ID_MAX) return null;
      // A repeat is dropped rather than refused: it says the same thing twice
      // and means what it already meant.
      if (!seen.has(id)) {
        seen.add(id);
        states.push(id);
      }
    }
    if (states.length > 0) out.states = states;
  }
  if (raw.conditions !== undefined) {
    if (!Array.isArray(raw.conditions) || raw.conditions.length > MAX_SLOT_CONDITIONS) return null;
    const conditions: Condition[] = [];
    for (const entry of raw.conditions) {
      if (!isCondition(entry)) return null;
      conditions.push({ parameter: entry.parameter, op: entry.op, value: entry.value });
    }
    if (conditions.length > 0) out.conditions = conditions;
  }
  if (raw.fadeMs !== undefined) {
    const fade = usableFade(raw.fadeMs);
    if (fade === null) return null;
    // Zero is a cut, and a cut is what absent means. One absent-shaped answer
    // downstream instead of two — `blendMs`' rule.
    if (fade > 0) out.fadeMs = fade;
  }
  return out;
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
  const treatment = cleanTreatment(raw);
  if (treatment === null) return null;
  const when = cleanWhen(raw);
  if (when === null) return null;
  // No `kind` in the canonical form: see the note at the top of this file. A
  // stored `kind: "text"` was accepted above and is dropped here.
  return {
    position,
    source: raw.source,
    ...(text === undefined ? {} : { text }),
    font,
    size,
    color,
    ...treatment,
    ...when,
  };
}

/** How the words are treated, as a client supplied it, or null to refuse. */
interface Treatment {
  outline?: TextOutline;
  shadow?: TextShadow;
  band?: true;
}

/**
 * The three treatment fields, or null to refuse the slot.
 *
 * Absent stays absent. A present-but-malformed value refuses rather than
 * falling back to none, the rule an unknown `kind` follows: drawing something
 * nobody asked for because a word was misspelled is the worse half. A number
 * outside its band refuses rather than being clamped, `usableSize`'s reason — a
 * width of 90 is not a width, and drawing 25 instead draws something nobody
 * asked for.
 *
 * A stored `backing` is read here and nowhere else, so the translation happens
 * once for every reader, and the key leaves the manifest on that World's next
 * save. An authored field beats the old one when both are present: the operator
 * is the later author.
 */
function cleanTreatment(raw: Record<string, unknown>): Treatment | null {
  const legacy = fromBacking(raw.backing);
  if (legacy === null) return null;
  const out: Treatment = {};

  if (raw.outline !== undefined) {
    const outline = cleanOutline(raw.outline);
    if (outline === null) return null;
    out.outline = outline;
  } else if (legacy.outline !== undefined) {
    out.outline = legacy.outline;
  }

  if (raw.shadow !== undefined) {
    const shadow = cleanShadow(raw.shadow);
    if (shadow === null) return null;
    out.shadow = shadow;
  }

  if (raw.band !== undefined) {
    if (typeof raw.band !== "boolean") return null;
    // A stored `false` is dropped rather than kept, so "no band" has one shape
    // downstream — `fadeMs: 0`'s rule.
    if (raw.band) out.band = true;
  } else if (legacy.band) {
    out.band = true;
  }

  return out;
}

/**
 * What a stored `backing` means in the authored vocabulary, or null to refuse.
 *
 * `"shadow"` drew four blurred offsets of black; the nearest thing expressible
 * now is a black border at the same weight, which is the same kind of mark and
 * very slightly crisper. Exactness is not available — one shadow and one
 * outline cannot spell a four-offset ring — and it is not worth a fifth field,
 * because the field never had a control: nothing authored through the editor
 * has ever carried it.
 *
 * An unknown value still refuses the slot, exactly as it did when the field was
 * live.
 */
function fromBacking(value: unknown): Treatment | null {
  if (value === undefined) return {};
  if (value === "shadow") return { outline: { color: "#000000", width: 3 } };
  if (value === "band") return { band: true };
  return null;
}

function cleanOutline(value: unknown): TextOutline | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const color = hexColor(raw.color);
  const width = inBand(raw.width, OUTLINE_WIDTH_MIN, OUTLINE_WIDTH_MAX);
  if (color === null || width === null) return null;
  return { color, width };
}

function cleanShadow(value: unknown): TextShadow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const color = hexColor(raw.color);
  const angle = inBand(raw.angle, SHADOW_ANGLE_MIN, SHADOW_ANGLE_MAX);
  const distance = inBand(raw.distance, SHADOW_DISTANCE_MIN, SHADOW_DISTANCE_MAX);
  const blur = inBand(raw.blur, SHADOW_BLUR_MIN, SHADOW_BLUR_MAX);
  if (color === null || angle === null || distance === null || blur === null) return null;
  // Absent stays absent and means opaque — the one case `usableOpacity`
  // deliberately does not answer for, so `NaN` cannot arrive as "no opacity
  // asked for". A stored 0 is a shadow nobody can see, and is kept: it is a
  // legal thing to have typed on the way to 50.
  let opacity: number | undefined;
  if (raw.opacity !== undefined) {
    const asked = usableOpacity(raw.opacity);
    if (asked === null) return null;
    opacity = asked;
  }
  return {
    color,
    ...(opacity === undefined ? {} : { opacity }),
    angle,
    distance,
    blur,
  };
}

function cleanImageSlot(raw: Record<string, unknown>, position: OverlayPosition): ImageSlot | null {
  const size = usableSize(raw.size);
  if (size === null) return null;
  // Absent is allowed and stays absent: an unfilled row is a slot that draws
  // nothing, exactly as a text slot with no words does. `undefined` rather than
  // `""` so a cleared field removes the key.
  const image = cleanText(raw.image, IMAGE_NAME_MAX);
  // Absent stays absent — the one case `usableOpacity` deliberately does not
  // answer for. A present-but-unusable opacity refuses the slot rather than
  // falling back to opaque, so `NaN` cannot arrive as "no fade requested".
  let opacity: number | undefined;
  if (raw.opacity !== undefined) {
    const asked = usableOpacity(raw.opacity);
    if (asked === null) return null;
    opacity = asked;
  }
  const when = cleanWhen(raw);
  if (when === null) return null;
  return {
    kind: "image",
    position,
    ...(image === undefined ? {} : { image }),
    size,
    ...(opacity === undefined ? {} : { opacity }),
    ...when,
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
  speech?: Utterance | null,
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
    case "speech":
      // The sentence being spoken, never the whole line: each is rendered
      // separately and shown for its own measured duration (R16). Null before
      // the first sentence begins and after the last ends, which is what makes a
      // slot with nothing to say render no element at all.
      return cleanText(speech?.sentences[speech.current]?.text) ?? null;
  }
}
