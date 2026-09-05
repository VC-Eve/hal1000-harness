// Colour normalization for adapter and chat text colours.
//
// Colour is the only carrier of adapter provenance in the feed, so a stored
// colour has to satisfy two rules before it is worth keeping:
//
//   1. Readability floor — WCAG contrast >= 4.5:1 against the pane
//      background, or the text is unreadable on HAL's near-black surface.
//   2. Reserved distance — perceptibly clear of HAL's own red and the status
//      amber, or an observation about a session silently masquerades as HAL
//      talking about himself.
//
// Both reference colours are the live values from `ui/src/styles.css`; keep
// them in sync if the stylesheet's custom properties change.
//
// Normalization is deterministic: the same input always yields the same
// output, and a colour that already clears both rules is returned unchanged.

import { hexColor } from "../../../shared/src/overlays.js";

// ui/src/styles.css --panel: the narration/chat pane surface.
export const PANE_BACKGROUND = "#0c0c0e";

// ui/src/styles.css --red (HAL's voice) and --amber (status reports).
export const RESERVED_COLORS = ["#e0301e", "#d9a521"] as const;

export const MIN_CONTRAST = 4.5;

// CIE76 deltaE. ~25 sits well above the "clearly different colour" range
// (deltaE > 10) with margin for the eye at small text sizes.
export const MIN_RESERVED_DISTANCE = 25;

// Used when neither lifting nor rotating can satisfy both rules — a calm
// blue that is far from every reserved hue and comfortably above the floor.
export const FALLBACK_COLOR = "#8ab4f8";

// Lightness lift: small enough that a colour is not overshot, bounded so a
// pathological input terminates.
const LIGHTNESS_STEP = 0.04;
const MAX_LIGHTNESS_STEPS = 25;

// Hue rotation: 15 degrees x 24 steps walks the full circle exactly once.
const HUE_STEP_DEGREES = 15;
const HUE_STEPS = 24;

interface Rgb {
  r: number;
  g: number;
  b: number;
}


// Accepts #rgb / #rrggbb, with or without the leading hash. Returns null for
// anything else so the caller can drop the field rather than store garbage.
export function parseHex(value: string): Rgb | null {
  // The shape and the shorthand expansion are `hexColor`'s, in shared, so
  // the overlay's colours and the feed's are one rule about what a hex is.
  const canonical = hexColor(value);
  if (canonical === null) return null;
  const full = canonical.slice(1);
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

export function toHex({ r, g, b }: Rgb): string {
  const part = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

function channelLuminance(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// --- Lab (D65) ------------------------------------------------------------

interface Lab {
  l: number;
  a: number;
  b: number;
}

function toLab(rgb: Rgb): Lab {
  const r = channelLuminance(rgb.r);
  const g = channelLuminance(rgb.g);
  const b = channelLuminance(rgb.b);

  // sRGB -> XYZ (D65), then normalized by the D65 white point.
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;

  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);

  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

// CIE76: plain Euclidean distance in Lab.
export function deltaE(a: Rgb, b: Rgb): number {
  const la = toLab(a);
  const lb = toLab(b);
  return Math.sqrt((la.l - lb.l) ** 2 + (la.a - lb.a) ** 2 + (la.b - lb.b) ** 2);
}

// --- HSL ------------------------------------------------------------------

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function toHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = 60 * (((gn - bn) / delta) % 6);
  else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
  else h = 60 * ((rn - gn) / delta + 4);
  return { h: (h + 360) % 360, s, l };
}

function fromHsl({ h, s, l }: Hsl): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  // Rounded to 8-bit channels here so every rule is evaluated against the
  // exact colour that will be written out — a float candidate can clear the
  // contrast floor and then fall under it once quantized to hex.
  const q = (n: number) => Math.round(Math.min(1, Math.max(0, n + m)) * 255);
  return { r: q(rgb[0]), g: q(rgb[1]), b: q(rgb[2]) };
}

// --- Rules ----------------------------------------------------------------

const BACKGROUND = parseHex(PANE_BACKGROUND)!;
const RESERVED = RESERVED_COLORS.map((hex) => parseHex(hex)!);

function meetsContrast(rgb: Rgb): boolean {
  return contrastRatio(rgb, BACKGROUND) >= MIN_CONTRAST;
}

function clearsReserved(rgb: Rgb): boolean {
  return RESERVED.every((reserved) => deltaE(rgb, reserved) >= MIN_RESERVED_DISTANCE);
}

// Raise lightness in fixed steps until the floor is met or the bound is
// exhausted. Returns the best candidate reached either way; the caller
// re-checks, so an exhausted lift simply fails the rule.
function liftToContrast(rgb: Rgb): Rgb {
  if (meetsContrast(rgb)) return rgb;
  const hsl = toHsl(rgb);
  for (let step = 1; step <= MAX_LIGHTNESS_STEPS; step++) {
    const lifted = fromHsl({ ...hsl, l: Math.min(1, hsl.l + step * LIGHTNESS_STEP) });
    if (meetsContrast(lifted)) return lifted;
  }
  return fromHsl({ ...hsl, l: 1 });
}

/**
 * Normalize a stored colour so it is readable on the pane background and
 * perceptibly distinct from HAL's reserved colours.
 *
 * Returns null when the input cannot be parsed — callers drop the field and
 * keep whatever was stored before rather than surfacing an error.
 */
export function normalizeColor(value: string): string | null {
  const parsed = parseHex(value);
  if (!parsed) return null;

  const hsl = toHsl(parsed);
  // Step 0 is the untouched hue, so a colour that already passes both rules
  // round-trips byte-identical (modulo hex casing/shorthand).
  for (let step = 0; step < HUE_STEPS; step++) {
    const rotated = step === 0 ? parsed : fromHsl({ ...hsl, h: hsl.h + step * HUE_STEP_DEGREES });
    const candidate = liftToContrast(rotated);
    if (meetsContrast(candidate) && clearsReserved(candidate)) {
      return toHex(candidate);
    }
  }
  return FALLBACK_COLOR;
}
