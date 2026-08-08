// The three identity bands (U5, R1/R4/R5).
//
// Written against the pure helpers rather than through the service, because the
// question here is purely "what does this score read as", and routing it
// through a capture cycle would test the loop instead.

import { describe, it, expect } from "vitest";
import { formatIdentity, identityBand } from "../../../shared/src/prompts.js";

// The shipped pair. Named rather than inlined so a fixture cannot drift from
// the defaults it is meant to sit either side of.
const RECOGNITION = 0.5;
const STATEMENT = 0.6;
const band = (c: number) => identityBand(c, RECOGNITION, STATEMENT);

describe("identityBand", () => {
  it("places a score in each of the three bands", () => {
    // 0.44 / 0.55 / 0.71 — each chosen clear of both boundaries, so none is one
    // default change away from silently testing a neighbouring band.
    expect(band(0.44)).toBe("unrecognised");
    expect(band(0.55)).toBe("hedged");
    expect(band(0.71)).toBe("stated");
  });

  it("treats each threshold as inclusive of the band above", () => {
    // "at or above" in both requirements, so the boundary belongs upward.
    expect(band(RECOGNITION)).toBe("hedged");
    expect(band(STATEMENT)).toBe("stated");
  });

  it("treats a hair below a threshold as the lower band", () => {
    expect(band(STATEMENT - 0.0001)).toBe("hedged");
    expect(band(RECOGNITION - 0.0001)).toBe("unrecognised");
  });

  it("never states a non-finite score", () => {
    // Supplied deliberately. NaN is false against every comparison, so a guard
    // written as `score < threshold` would fall through to the most confident
    // answer and assert a name at NaN%. Nothing but a deliberate test finds
    // this — see docs/solutions/a-threshold-guard-written-as-a-negation-fails-open-on-nan.md.
    expect(band(NaN)).toBe("unrecognised");
    expect(band(-Infinity)).toBe("unrecognised");
  });

  it("states an impossibly high score rather than falling through", () => {
    expect(band(Infinity)).toBe("stated");
  });

  it("follows the thresholds it is given, not the shipped ones", () => {
    // Both are user settings; a helper that hardcoded either would ignore them.
    expect(identityBand(0.55, 0.3, 0.5)).toBe("stated");
    expect(identityBand(0.55, 0.6, 0.8)).toBe("unrecognised");
  });
});

describe("formatIdentity", () => {
  it("states the bare name with its confidence", () => {
    expect(formatIdentity("Jimbo", 0.71, "stated")).toBe("Jimbo 71%");
  });

  it("attributes rather than asserts in the hedged band, and still carries the number", () => {
    expect(formatIdentity("Jimbo", 0.55, "hedged")).toBe("someone who looks like Jimbo 55%");
  });

  it("never renders a hedged identity as a bare name", () => {
    // The negative worth asserting: falling through to the more confident
    // presentation is the dangerous direction to be wrong in.
    const hedged = formatIdentity("Jimbo", 0.55, "hedged");
    expect(hedged.startsWith("Jimbo")).toBe(false);
    expect(hedged).toContain("someone who looks like");
  });

  it("rounds the percentage rather than showing float debris", () => {
    expect(formatIdentity("Jimbo", 0.7142857, "stated")).toBe("Jimbo 71%");
    expect(formatIdentity("Jimbo", 0.999, "stated")).toBe("Jimbo 100%");
  });

  it("keeps a name that contains regex or spacing oddities intact", () => {
    // Names are user text. This one only has to survive being formatted; the
    // rewrite that has to survive it as a pattern is covered in the hedge tests.
    expect(formatIdentity("Ann Marie", 0.8, "stated")).toBe("Ann Marie 80%");
    expect(formatIdentity("A.", 0.8, "hedged")).toBe("someone who looks like A. 80%");
  });
});

// ---------------------------------------------------------------------------
// R5 — the lowest band observed in a cycle governs.
//
// Exercised against the private reducer rather than a full capture cycle: a
// cycle would need two captures at two different confidences with a gallery
// that changes its answer between them, which tests the loop's scheduling far
// more than it tests the rule.
// ---------------------------------------------------------------------------

import { VisionService } from "../../src/vision/service.js";
import type { VisionObservation } from "../../../shared/src/types.js";

// Only `identityMatch` is read by the reducer; the rest of an observation is
// irrelevant to it and inventing it would suggest otherwise.
const obs = (...matches: { personId: string; name: string; confidence: number }[]): VisionObservation =>
  ({ at: "2026-08-08T00:00:00.000Z", caption: "a person at a desk", identity: null, identityMatch: matches }) as VisionObservation;

const reduce = (svc: VisionService, batch: VisionObservation[]) =>
  (svc as unknown as { cycleBands(b: VisionObservation[]): Map<string, { name: string; confidence: number; band: string }> })
    .cycleBands(batch);

// A service that only needs to answer `config()`; the reducer touches nothing
// else. Built from the shipped defaults so the thresholds are the real ones.
function reducerOnly(): VisionService {
  const settings = {
    get: () => ({ vision: { confidenceThreshold: RECOGNITION, statementThreshold: STATEMENT } }),
  };
  return new VisionService(
    { broadcast: () => {}, onMessage: () => {}, onConnection: () => {}, sendTo: () => {} },
    settings as never,
    {} as never,
    { record: () => {} },
    {} as never,
    (() => ({})) as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe("cycle bands (R5)", () => {
  it("takes the lowest reading, so one good frame cannot license a flat assertion", () => {
    const svc = reducerOnly();
    const bands = reduce(svc, [
      obs({ personId: "p1", name: "Dave", confidence: 0.9 }),
      obs({ personId: "p1", name: "Dave", confidence: 0.55 }),
    ]);
    expect(bands.get("p1")?.band).toBe("hedged");
    expect(bands.get("p1")?.confidence).toBeCloseTo(0.55);
  });

  it("states a person whose every reading cleared the threshold", () => {
    const svc = reducerOnly();
    const bands = reduce(svc, [
      obs({ personId: "p1", name: "Dave", confidence: 0.9 }),
      obs({ personId: "p1", name: "Dave", confidence: 0.71 }),
    ]);
    expect(bands.get("p1")?.band).toBe("stated");
  });

  it("bands two people independently within one cycle", () => {
    const svc = reducerOnly();
    const bands = reduce(svc, [
      obs({ personId: "p1", name: "Dave", confidence: 0.9 }, { personId: "p2", name: "Marvin", confidence: 0.52 }),
    ]);
    expect(bands.get("p1")?.band).toBe("stated");
    expect(bands.get("p2")?.band).toBe("hedged");
  });

  it("ignores a non-finite reading instead of letting it decide the band", () => {
    // Math.min would propagate NaN and take the whole cycle's band with it, so
    // the reduction filters explicitly. Asserted with a real reading present,
    // because the interesting failure is the good value being discarded.
    const svc = reducerOnly();
    const bands = reduce(svc, [
      obs({ personId: "p1", name: "Dave", confidence: NaN }),
      obs({ personId: "p1", name: "Dave", confidence: 0.71 }),
    ]);
    expect(bands.get("p1")?.band).toBe("stated");
    expect(Number.isFinite(bands.get("p1")?.confidence ?? NaN)).toBe(true);
  });

  it("drops a person whose only reading was non-finite", () => {
    const svc = reducerOnly();
    const bands = reduce(svc, [obs({ personId: "p1", name: "Dave", confidence: NaN })]);
    expect(bands.has("p1")).toBe(false);
  });

  it("returns nothing for a cycle in which nobody was recognised", () => {
    const svc = reducerOnly();
    expect(reduce(svc, [obs()]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// R4 — the percentage reaches the model, not only the pane.
//
// A deliberate bet rather than a free win. `docs/solutions/an-instruction-that-
// fights-its-own-input-loses.md` records timestamps and ordinals both becoming
// the subject of the narration once they were supplied, and its first rule is
// to stop supplying a label rather than write a rule against it. The pane
// already renders the confidence, so handing it to the summariser too is the
// same class of label. It ships anyway because the user asked for it — so it
// gets a test that can fail rather than a caveat that cannot.
// ---------------------------------------------------------------------------

describe("what the summariser is handed (R4)", () => {
  it("puts the banded identity, percentage and all, on the caption line", () => {
    // Asserted at the formatter, which is what `narrate` interpolates. The
    // shape of the line — one bracketed identity, no timestamps, no ordinals —
    // is covered where the line itself is built.
    expect(formatIdentity("Dave", 0.71, "stated")).toBe("Dave 71%");
    expect(formatIdentity("Dave", 0.55, "hedged")).toBe("someone who looks like Dave 55%");
  });

  it("renders one identity per person even when a cycle saw them repeatedly", () => {
    // Two appearances of one person in one cycle collapse to a single lowest
    // band, so the line cannot read "Dave 71% and Dave 55%".
    const svc = reducerOnly();
    const bands = reduce(svc, [
      obs({ personId: "p1", name: "Dave", confidence: 0.71 }),
      obs({ personId: "p1", name: "Dave", confidence: 0.55 }),
    ]);
    expect(bands.size).toBe(1);
    expect(formatIdentity(bands.get("p1")!.name, bands.get("p1")!.confidence, bands.get("p1")!.band as never)).toBe(
      "someone who looks like Dave 55%",
    );
  });
});
