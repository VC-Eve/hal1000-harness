// Recognition weight: what a minute of watching supports, rather than what one
// frame happened to score.
//
// A single frame's confidence is the least stable evidence available —
// independent captures of one person score 0.53 to 0.78, per
// docs/solutions/a-measurement-on-synthetic-variants-measures-your-own-transform.md
// — so the band visibly flickers across one continuous visit. Weight is the
// accumulation nothing was keeping.
//
// It decides NOTHING. Banding, narration, profile delivery and the
// uncertain-match queue all continue to read the current frame's confidence.
// Weight is recorded and shown, alongside the band it would have chosen, so
// promoting it later is a measurement rather than a hunch. The single easiest
// way to get this feature wrong is to wire this module into one of those four
// call sites.
//
// Every comparison here is phrased as acceptance rather than as a negated
// inequality. NaN is false against every comparison, so `if (x < bound)` treats
// a non-finite value as passing — the shape recorded in
// docs/solutions/a-threshold-guard-written-as-a-negation-fails-open-on-nan.md.
// This number is destined for a prompt, so it gets the same care as the
// threshold that decides whether a human is named.

// Below this, a weight is nothing.
//
// An exponential never mathematically reaches zero, and a value that reads
// 1e-9 forever would make "seen a week ago" and "here now" differ only in a
// decimal nobody looks at. Snapping to zero is what lets a gap read as absence.
export const WEIGHT_FLOOR = 0.01;

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * A weight after `elapsedMs` of not being reinforced.
 *
 * Decay is against wall-clock, not against checks. Decaying per check would
 * freeze a weight exactly when nothing is happening — which is the case the
 * rule exists for: Vision switched off overnight would otherwise leave last
 * evening's confidence looking current in the morning.
 *
 * Exponential, so it composes: decaying twice over two spans equals decaying
 * once over their sum. That property is what makes it safe to evaluate on every
 * read rather than only on write.
 */
export function decayWeight(weight: number, elapsedMs: number, halfLifeMs: number): number {
  if (!finite(weight) || !finite(elapsedMs) || !finite(halfLifeMs)) return 0;
  if (!(halfLifeMs > 0)) return 0;
  // Time running backwards — a clock adjustment — must not resurrect a weight.
  const elapsed = elapsedMs > 0 ? elapsedMs : 0;
  const decayed = weight * Math.pow(0.5, elapsed / halfLifeMs);
  if (!(decayed >= WEIGHT_FLOOR)) return 0;
  return decayed > 1 ? 1 : decayed;
}

export interface NextWeightOptions {
  /** The last known value. */
  previous: number;
  /** How long since that value was computed. */
  elapsedMs: number;
  /** The confidence this check matched at, or absent when it did not. */
  confidence?: number;
  halfLifeMs: number;
  gain: number;
}

/**
 * The weight after one check.
 *
 * Decays first, then adds — the order matters. Adding first would let someone
 * seen once after an hour read as though they had been there throughout, which
 * is exactly the confusion the decay rule exists to prevent.
 *
 * A check that did not find the person adds nothing: the decay IS the fall. A
 * separate absence penalty would double-count the time that has already passed.
 *
 * The rise is asymptotic toward one and scaled by the confidence of the match,
 * so a marginal sighting is weaker evidence than a confident one and moves the
 * number less.
 */
export function nextWeight({ previous, elapsedMs, confidence, halfLifeMs, gain }: NextWeightOptions): number {
  const decayed = decayWeight(previous, elapsedMs, halfLifeMs);
  if (!finite(confidence)) return decayed;
  if (!finite(gain)) return decayed;

  const strength = confidence > 1 ? 1 : confidence < 0 ? 0 : confidence;
  const step = gain > 1 ? 1 : gain < 0 ? 0 : gain;
  const raised = decayed + (1 - decayed) * step * strength;

  if (!(raised >= WEIGHT_FLOOR)) return 0;
  return raised > 1 ? 1 : raised;
}
