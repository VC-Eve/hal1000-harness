// What a voice is, and the one place the vocabulary for it lives.
//
// A voice is not a recording and not a file. It is a **preset**: a name, a
// weighted mix of the synthesiser's stock voices, and a speed. The synthesiser
// accepts a raw style vector as readily as a stock name, so a mix is arithmetic
// over vectors and the same preset renders the same audio every time — which is
// the whole of R1, and the reason a character can sound like itself across
// sessions without anyone storing audio.
//
// Both sides read this file. The editor composes a preset, the server renders
// one, and the store guards with it; two ideas of what a mix means would let a
// voice sound one way in the audition and another when it is saved.
//
// Weights are the author's numbers and are normalised at use, never at rest.
// Storing normalised shares would rewrite the operator's sliders behind them —
// setting two voices to 1 and 1 would come back as 0.5 and 0.5 — and the moment
// a third voice is added the stored numbers would all have to move. So the file
// keeps what was typed and `shares` answers what is heard. `ui` shows both,
// because two voices at weight 1 read as "1 and 1" while sounding 50/50.

/** One stock voice's contribution to a mix, as the author set it. */
export interface VoiceWeight {
  /** A stock voice name the model carries, e.g. `am_michael`. */
  voice: string;
  /** Any non-negative number. Meaning comes from the total, not the value. */
  weight: number;
}

/** A voice, as stored and as sent. */
export interface VoicePreset {
  /** Stable key. Unique across the store; never shown. */
  id: string;
  /** What the operator called it. */
  label: string;
  mix: VoiceWeight[];
  speed: number;
}

/**
 * The speed band the model accepts.
 *
 * Taken from the reference implementation, which raises outside it rather than
 * clamping. A speed of 0 is not a slow voice, it is a division by zero in the
 * duration predictor.
 */
export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2.0;
export const SPEED_DEFAULT = 1.0;

/**
 * How far the soundtrack may be dropped while the character speaks, in decibels
 * below its own level (R10).
 *
 * Zero is no duck at all, which is the right answer for someone who only ever
 * speaks over silence. Twenty-four is about as far down as is still music rather
 * than an absence; past that the bed is doing nothing and turning it off is
 * honest. The band is stated once here because the clamp on the server, the
 * multiplier on the client and the control in the settings drawer must all mean
 * the same thing — an earlier version clamped at 60, which no surface could
 * produce and which is inaudible rather than quiet.
 */
export const DUCK_MIN_DB = 0;
export const DUCK_MAX_DB = 24;
export const DUCK_DEFAULT_DB = 12;

/**
 * How many stock voices one mix may name.
 *
 * Not a model limit — the arithmetic would take any number. A bound exists so a
 * hand-written or agent-written preset cannot make the editor unusable, and
 * eight is well past the point where another voice changes what is heard.
 */
export const MIX_MAX = 8;

/** Bounds on the two strings, so a preset cannot become a wall of text. */
export const LABEL_MAX = 60;
export const ID_MAX = 64;

const ID_SHAPE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * A speed that may be used, or null.
 *
 * The acceptance negated once around the whole thing, so `NaN` and `Infinity`
 * fail closed — the `usableSize` shape in `overlays.ts`, and for its reason. See
 * `docs/solutions/a-threshold-guard-written-as-a-negation-fails-open-on-nan.md`.
 */
export function usableSpeed(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!(Number.isFinite(value) && value >= SPEED_MIN && value <= SPEED_MAX)) return null;
  return value;
}

/**
 * A weight that may be used, or null.
 *
 * Zero is allowed and negative is not. A voice at zero is one the author has
 * turned down to nothing but not yet removed, which is a normal state while
 * designing by ear; a negative weight would subtract a voice from a blend, which
 * is not a thing the model's style space means.
 */
export function usableWeight(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!(Number.isFinite(value) && value >= 0)) return null;
  return value;
}

/** Trimmed and bounded, or undefined for nothing — `cleanText`'s shape. */
export function cleanLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().slice(0, LABEL_MAX);
  return text.length > 0 ? text : undefined;
}

/**
 * An id as it is stored, or undefined.
 *
 * Lowercase, no spaces, no leading punctuation. Ids reach a filename only
 * indirectly — presets live in one file — but they are compared, sent, and shown
 * in errors, and a free-form id would let two presets differ by a space.
 */
export function cleanId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim().toLowerCase().slice(0, ID_MAX);
  return ID_SHAPE.test(id) ? id : undefined;
}

/** An id derived from a label, for a preset the operator is naming. */
export function idFromLabel(label: string): string | undefined {
  const id = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ID_MAX)
    .replace(/-+$/g, "");
  return cleanId(id);
}

/**
 * One mix as it arrived, or null.
 *
 * Refused rather than repaired, the `cleanSlot` rule: a mix naming the same
 * voice twice is two different intentions and picking one would be a guess. A
 * mix whose weights are all zero is refused here rather than at render time,
 * because `shares` cannot answer for it and a preset that cannot be rendered
 * should not reach the store.
 */
export function cleanMix(value: unknown): VoiceWeight[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0 || value.length > MIX_MAX) return null;

  const mix: VoiceWeight[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.voice !== "string") return null;
    const voice = raw.voice.trim();
    if (voice.length === 0 || seen.has(voice)) return null;
    const weight = usableWeight(raw.weight);
    if (weight === null) return null;
    seen.add(voice);
    mix.push({ voice, weight });
  }
  if (mix.every((entry) => entry.weight === 0)) return null;
  return mix;
}

/**
 * One preset as it arrived, or null.
 *
 * The canonical form carries exactly these four fields. A store rebuilds a
 * loaded preset by spreading the parsed value and re-adding defaults, so this is
 * the *shape* guard rather than the loader — see
 * `docs/solutions/rebuilding-a-cache-field-by-field-turns-a-read-into-a-delete.md`.
 */
export function cleanPreset(value: unknown): VoicePreset | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = cleanId(raw.id);
  const label = cleanLabel(raw.label);
  const mix = cleanMix(raw.mix);
  const speed = usableSpeed(raw.speed);
  if (id === undefined || label === undefined || mix === null || speed === null) return null;
  return { id, label, mix, speed };
}

/**
 * What each voice actually contributes, summing to 1.
 *
 * The one answer to "what am I hearing", so the renderer's arithmetic and the
 * editor's readout cannot disagree. Order follows the mix, because the editor
 * draws a row per entry and a reordered readout would look like a bug.
 *
 * Null for a mix that cannot be normalised, which `cleanMix` has already
 * refused — kept as a return rather than a throw so a caller holding an
 * unguarded value gets an answer it can render.
 */
export function shares(mix: readonly VoiceWeight[]): { voice: string; share: number }[] | null {
  if (mix.length === 0) return null;
  let total = 0;
  for (const entry of mix) {
    const weight = usableWeight(entry.weight);
    if (weight === null) return null;
    total += weight;
  }
  if (!(total > 0)) return null;
  return mix.map((entry) => ({ voice: entry.voice, share: entry.weight / total }));
}

/**
 * The voices a mix names that the model does not carry.
 *
 * Returned rather than thrown, and returned as a list rather than a boolean, so
 * the refusal can name what was wrong (R5). An empty list means the mix is
 * renderable against this pack.
 */
export function unknownVoices(mix: readonly VoiceWeight[], available: readonly string[]): string[] {
  const have = new Set(available);
  return mix.map((entry) => entry.voice).filter((voice) => !have.has(voice));
}
