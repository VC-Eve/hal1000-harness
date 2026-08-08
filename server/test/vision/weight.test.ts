// Recognition weight (U4, R7-R9, AE3/AE4).
//
// Tested directly rather than through the capture loop. The failure modes here
// are silent and arithmetic — a decay that never reaches zero, a gain that
// exceeds its ceiling, a NaN that propagates — and the loop is a slow and noisy
// way to discover any of them.

import { describe, expect, it } from "vitest";
import { decayWeight, nextWeight, WEIGHT_FLOOR } from "../../src/vision/weight.js";

const HALF_LIFE = 120_000;
const GAIN = 0.35;
const opts = { halfLifeMs: HALF_LIFE, gain: GAIN };

describe("decayWeight", () => {
  it("halves over the half-life", () => {
    expect(decayWeight(0.8, HALF_LIFE, HALF_LIFE)).toBeCloseTo(0.4, 5);
    expect(decayWeight(0.8, HALF_LIFE * 2, HALF_LIFE)).toBeCloseTo(0.2, 5);
  });

  it("leaves a weight untouched when no time has passed", () => {
    expect(decayWeight(0.8, 0, HALF_LIFE)).toBeCloseTo(0.8, 5);
  });

  it("reaches the floor after a long absence, rather than lingering forever", () => {
    // Covers AE4. An exponential never mathematically reaches zero; a weight
    // that reads 1e-9 forever would make "seen a week ago" and "here now"
    // differ only in a decimal nobody looks at.
    expect(decayWeight(1, HALF_LIFE * 200, HALF_LIFE)).toBe(0);
  });

  it("is monotonic — more elapsed time never means more weight", () => {
    let previous = 1;
    for (let t = 0; t <= HALF_LIFE * 6; t += HALF_LIFE / 4) {
      const now = decayWeight(1, t, HALF_LIFE);
      expect(now).toBeLessThanOrEqual(previous + 1e-12);
      previous = now;
    }
  });

  it("composes — decaying twice equals decaying once over the total", () => {
    // The read applies decay from the stored timestamp to now. If this did not
    // hold, reading twice would double-count and a weight would fall faster for
    // being looked at.
    const once = decayWeight(0.9, 60_000, HALF_LIFE);
    const twice = decayWeight(decayWeight(0.9, 30_000, HALF_LIFE), 30_000, HALF_LIFE);
    expect(twice).toBeCloseTo(once, 6);
  });

  it("treats a non-finite weight or elapsed span as nothing", () => {
    // Supplied deliberately. This value is destined for a prompt, and NaN is
    // false against every comparison — a guard phrased as a negation would let
    // it through as confident.
    expect(decayWeight(NaN, 1_000, HALF_LIFE)).toBe(0);
    expect(decayWeight(0.8, NaN, HALF_LIFE)).toBe(0);
    expect(decayWeight(0.8, 1_000, NaN)).toBe(0);
    expect(decayWeight(Infinity, 1_000, HALF_LIFE)).toBe(0);
  });

  it("treats time running backwards as no time passing", () => {
    // A clock adjustment should not resurrect a weight.
    expect(decayWeight(0.8, -60_000, HALF_LIFE)).toBeCloseTo(0.8, 5);
  });
});

describe("nextWeight", () => {
  it("rises with each consecutive recognition", () => {
    // Covers AE3.
    let w = 0;
    const seen: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      w = nextWeight({ previous: w, elapsedMs: 15_000, confidence: 0.7, ...opts });
      seen.push(w);
    }
    expect(seen[9]!).toBeGreaterThan(seen[0]!);
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
  });

  it("never exceeds one, however long someone sits there", () => {
    let w = 0;
    for (let i = 0; i < 500; i += 1) {
      w = nextWeight({ previous: w, elapsedMs: 1_000, confidence: 1, ...opts });
    }
    expect(w).toBeLessThanOrEqual(1);
  });

  it("rises further for a confident match than a marginal one", () => {
    // "lower accuracy lowers the weight" — a hedged sighting is weaker evidence
    // than a stated one and should move the number less.
    const confident = nextWeight({ previous: 0.2, elapsedMs: 0, confidence: 0.9, ...opts });
    const marginal = nextWeight({ previous: 0.2, elapsedMs: 0, confidence: 0.55, ...opts });
    expect(confident).toBeGreaterThan(marginal);
  });

  it("decays before it adds, so a long gap is not erased by one sighting", () => {
    // Order matters. Adding first would let someone seen once after an hour
    // read as though they had been there the whole time.
    const afterGap = nextWeight({ previous: 0.9, elapsedMs: HALF_LIFE * 4, confidence: 0.7, ...opts });
    const continuous = nextWeight({ previous: 0.9, elapsedMs: 15_000, confidence: 0.7, ...opts });
    expect(afterGap).toBeLessThan(continuous);
  });

  it("falls when a check does not find the person", () => {
    // Absence is the decay. No separate penalty is needed, and adding one would
    // double-count the time that has passed.
    const w = nextWeight({ previous: 0.8, elapsedMs: HALF_LIFE, ...opts });
    expect(w).toBeCloseTo(0.4, 5);
  });

  it("stays inside the range for a non-finite confidence", () => {
    const w = nextWeight({ previous: 0.5, elapsedMs: 0, confidence: NaN, ...opts });
    expect(Number.isFinite(w)).toBe(true);
    expect(w).toBeGreaterThanOrEqual(0);
    expect(w).toBeLessThanOrEqual(1);
  });

  it("recovers from nothing", () => {
    const w = nextWeight({ previous: 0, elapsedMs: 0, confidence: 0.7, ...opts });
    expect(w).toBeGreaterThan(0);
  });

  it("floors rather than going negative", () => {
    expect(nextWeight({ previous: WEIGHT_FLOOR / 2, elapsedMs: HALF_LIFE * 10, ...opts })).toBe(0);
  });
});

describe("the restart case", () => {
  it("a weight recovered from an old event decays to what the gap deserves", () => {
    // R9. A restart is just another gap: the last event holds the value and its
    // time, and decaying that by elapsed wall-clock is the ordinary read. An
    // overnight gap therefore reads as absence rather than as last evening's
    // confidence.
    const overnight = 14 * 60 * 60 * 1000;
    expect(decayWeight(0.95, overnight, HALF_LIFE)).toBe(0);
  });

  it("a short restart keeps most of the evidence", () => {
    // The other half of the same rule — a ten-second restart mid-session should
    // not read as a departure.
    expect(decayWeight(0.8, 10_000, HALF_LIFE)).toBeGreaterThan(0.7);
  });
});
