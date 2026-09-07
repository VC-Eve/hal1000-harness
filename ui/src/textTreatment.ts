/**
 * What a treated text slot looks like, as the properties the layer sets.
 *
 * A pure module with its own suite, `overlay.ts`'s precedent and for its reason:
 * jsdom applies no stylesheet and lays nothing out, so the arithmetic between a
 * stored number and a drawn mark is the whole of what can be asserted in Node.
 * What the mark *looks like* is settled by `scripts/treatment-check.mjs` in a
 * real browser, and nowhere else.
 *
 * Everything arrives as a percentage of the slot's own type size and leaves as
 * `em`, so a treatment scales with its words: the small player on `/live` and a
 * fullscreened `/broadcast` then draw the same proportions, which is the
 * property the whole layer is built around.
 */

import type { CSSProperties } from "react";
import type { TextOutline, TextShadow, TextSlot } from "../../shared/src/overlays.js";

/**
 * How many decimals an `em` value carries.
 *
 * Enough that a 1% step is visible at any size, few enough that the value is
 * one string rather than a float's tail — a test can then assert what was
 * written, and two engines cannot disagree about the last digit.
 */
const PLACES = 4;

/** A percentage of the type size as an `em` value. */
function em(percent: number): string {
  return `${Number((percent / 100).toFixed(PLACES))}em`;
}

/**
 * A stored colour and an opacity percentage as one CSS colour.
 *
 * `rgba()` rather than an eight-digit hex because the opacity is a separate
 * stored field and this is the one place the two meet; absent means opaque,
 * which is `ImageSlot.opacity`'s rule and is decided by the caller, never by a
 * `??` inside a guard.
 */
function rgba(color: string, opacity?: number): string {
  const hex = color.replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const alpha = Number(((opacity ?? 100) / 100).toFixed(2));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * The `text-shadow` value one shadow draws.
 *
 * The angle is the direction the shadow is cast, clockwise from straight up, so
 * 135° is down and to the right: x grows with the sine, and y grows with the
 * *negative* cosine because a page's y axis points down. A distance of 0
 * collapses both offsets and leaves the blur alone, which is what a glow is —
 * one dial says direction and "no direction", and there is no glow mode.
 */
export function shadowCss(shadow: TextShadow): string {
  const radians = (shadow.angle * Math.PI) / 180;
  const x = Math.sin(radians) * shadow.distance;
  const y = -Math.cos(radians) * shadow.distance;
  return `${em(x)} ${em(y)} ${em(shadow.blur)} ${rgba(shadow.color, shadow.opacity)}`;
}

/**
 * The properties one outline draws.
 *
 * `paintOrder: "stroke fill"` is the half that matters: without it the stroke
 * is centred on the glyph edge and eats inward, so raising the width thickens
 * the letter instead of bordering it. With it the stroke is painted first and
 * the fill covers its inner half, which is the requirement — a border that
 * leaves the letterform the shape it was.
 *
 * Whether an engine honours that on live text is a claim about a browser, and
 * `scripts/treatment-check.mjs` is what settles it — in pixels, because a
 * stroke changes no layout metric in any engine and every width comparison
 * therefore reports the same number stroked or bare. It screenshots one word
 * outlined and the same word untreated and counts the white: painted behind the
 * fill the letter keeps its white, painted over it the stroke eats the stem.
 * Measured 2026-09-07 on chromium at 92.9% kept, so the fallback below is not
 * in force.
 *
 * That fallback, if an engine ever fails the check: the ring of offsets the old
 * fixed `backing-shadow` drew, generated from these same numbers. It would live
 * in this function and its suite, and would move neither the layer nor anything
 * stored.
 */
export function outlineCss(outline: TextOutline): CSSProperties {
  return {
    WebkitTextStrokeWidth: em(outline.width),
    WebkitTextStrokeColor: outline.color,
    paintOrder: "stroke fill",
  };
}

/**
 * Everything a text slot's treatment adds to its inline style.
 *
 * An empty object when nothing was asked for, so the layer's spread adds no
 * property at all and an untreated slot draws exactly what it drew before this
 * existed. Inline rather than a class per treatment: the values are authored
 * per slot and there is no finite set of them, and an inline style cannot lose
 * a cascade contest on one surface and win it on the other.
 */
export function treatmentStyle(slot: TextSlot): CSSProperties {
  return {
    ...(slot.shadow === undefined ? {} : { textShadow: shadowCss(slot.shadow) }),
    ...(slot.outline === undefined ? {} : outlineCss(slot.outline)),
  };
}
