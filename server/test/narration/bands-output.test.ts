// The band-aware output check (U6, R6/R7/R8).
//
// A fresh block on purpose. The pre-band cases in hedge.test.ts all pass a
// roster of bare names, which encodes the precondition "every enrolled name is
// hedged" — the very thing bands make optional. Adding band cases there would
// have meant retrofitting them onto fixtures built for the old world, and
// docs/solutions/a-removed-precondition-blinds-every-test-that-set-it.md
// records what that costs: tests that pass while measuring the world before the
// change.
//
// Fixtures here are shaped like real model output — re-cased, re-punctuated,
// echoing back what it was handed — rather than like what we wish it wrote.

import { describe, expect, it } from "vitest";
import { enforceIdentityBands, type RosterBand } from "../../../shared/src/prompts.js";

const stated = (name: string, confidence: number): RosterBand => ({ name, confidence, band: "stated" });
const hedged = (name: string, confidence: number | null = null): RosterBand => ({ name, confidence, band: "hedged" });

describe("the stated band", () => {
  it("gives a bare name its confidence", () => {
    expect(enforceIdentityBands("Dave is at the desk.", [stated("Dave", 0.71)])).toBe("Dave 71% is at the desk.");
  });

  it("leaves a name the model already qualified alone", () => {
    // Idempotence, and the failure it prevents is "Dave 71% 71%".
    expect(enforceIdentityBands("Dave 71% is at the desk.", [stated("Dave", 0.71)])).toBe("Dave 71% is at the desk.");
  });

  it("is idempotent across repeated application", () => {
    const once = enforceIdentityBands("Dave is at the desk.", [stated("Dave", 0.71)]);
    expect(enforceIdentityBands(once, [stated("Dave", 0.71)])).toBe(once);
  });

  it("recognises the percentage however the model punctuated it", () => {
    // A matcher tight enough to be pretty is loose enough to miss one of these
    // and double-annotate. All three are shapes a model actually writes.
    for (const written of ["Dave 71%", "Dave (71%)", "Dave 71 %"]) {
      const out = enforceIdentityBands(`${written} is at the desk.`, [stated("Dave", 0.71)]);
      expect(out, written).not.toMatch(/71.*71/);
    }
  });

  it("corrects a name the model re-cased", () => {
    // The enrolled spelling wins. A model writing an initialism as "SW" when
    // the roster says "sw" is ordinary behaviour.
    expect(enforceIdentityBands("SW is at the desk.", [stated("sw", 0.8)])).toBe("sw 80% is at the desk.");
  });

  it("keeps a hedge the model chose to write", () => {
    // Never makes HAL more confident than it already was. Removing a hedge
    // would be this function adding certainty rather than removing it.
    const out = enforceIdentityBands("someone who looks like Dave is at the desk.", [stated("Dave", 0.71)]);
    expect(out).toContain("someone who looks like Dave");
    expect(out.startsWith("Dave")).toBe(false);
  });
});

describe("the hedged band", () => {
  it("hedges a bare name and reports the reading behind it", () => {
    expect(enforceIdentityBands("Dave is at the desk.", [hedged("Dave", 0.55)])).toBe(
      "someone who looks like Dave 55% is at the desk.",
    );
  });

  it("hedges a name the model stated with a percentage", () => {
    // The dangerous direction: the model asserted a name the band does not
    // license. The percentage it wrote is kept; the assertion is not.
    const out = enforceIdentityBands("Dave 55% is at the desk.", [hedged("Dave", 0.55)]);
    expect(out).toBe("someone who looks like Dave 55% is at the desk.");
  });

  it("never leaves a hedged name bare, however the model cased it", () => {
    for (const written of ["dave", "Dave", "DAVE"]) {
      const out = enforceIdentityBands(`${written} is here.`, [hedged("Dave", 0.55)]);
      expect(out, written).toContain("someone who looks like Dave");
    }
  });

  it("is idempotent", () => {
    const once = enforceIdentityBands("Dave is at the desk.", [hedged("Dave", 0.55)]);
    expect(enforceIdentityBands(once, [hedged("Dave", 0.55)])).toBe(once);
  });
});

describe("a name with no live reading (R7, AE4)", () => {
  it("hedges a name HAL did not see this cycle", () => {
    // The operator's profile is standing context, so the model knows that name
    // even on a cycle in which nobody was detected. Without this the name would
    // pass through unbanded and be asserted flat.
    expect(enforceIdentityBands("Jimbo must have stepped out.", [hedged("Jimbo")])).toBe(
      "someone who looks like Jimbo must have stepped out.",
    );
  });

  it("invents no percentage for someone it did not see", () => {
    const out = enforceIdentityBands("Jimbo is around.", [hedged("Jimbo")]);
    expect(out).not.toMatch(/\d+%/);
  });

  it("bands the seen and the unseen differently in one entry", () => {
    const out = enforceIdentityBands("Dave and Jimbo are here.", [stated("Dave", 0.71), hedged("Jimbo")]);
    expect(out).toBe("Dave 71% and someone who looks like Jimbo are here.");
  });
});

describe("properties the pre-band implementation earned, under bands", () => {
  it("does not partially rewrite a longer name", () => {
    // Longest first. "Ann" must not consume the "Ann" inside "Ann Marie".
    const out = enforceIdentityBands("Ann Marie is here.", [stated("Ann", 0.9), stated("Ann Marie", 0.8)]);
    expect(out).toBe("Ann Marie 80% is here.");
  });

  it("respects word boundaries", () => {
    expect(enforceIdentityBands("Also, nothing happened.", [stated("Al", 0.9)])).toBe("Also, nothing happened.");
  });

  it("escapes regex metacharacters in a name", () => {
    expect(enforceIdentityBands("A. is at the desk.", [stated("A.", 0.9)])).toBe("A. 90% is at the desk.");
  });

  it("tolerates a whitespace run inside a name", () => {
    expect(enforceIdentityBands("Ann  Marie is here.", [stated("Ann Marie", 0.8)])).toBe("Ann Marie 80% is here.");
  });

  it("handles non-ASCII names", () => {
    expect(enforceIdentityBands("Zoë is at the desk.", [hedged("Zoë", 0.55)])).toBe(
      "someone who looks like Zoë 55% is at the desk.",
    );
  });

  it("rewrites every occurrence", () => {
    const out = enforceIdentityBands("Dave sat down. Dave stood up.", [stated("Dave", 0.71)]);
    expect(out).toBe("Dave 71% sat down. Dave 71% stood up.");
  });

  it("still over-hedges an ordinary word that is also a name", () => {
    // Accepted deliberately, and unchanged by bands: odd phrasing is cosmetic,
    // an unearned bare name is the failure this exists to prevent.
    expect(enforceIdentityBands("The bill is paid.", [hedged("Bill")])).toBe(
      "The someone who looks like Bill is paid.",
    );
  });

  it("leaves an entry mentioning nobody untouched", () => {
    expect(enforceIdentityBands("The room is empty.", [stated("Dave", 0.71)])).toBe("The room is empty.");
  });

  it("ignores a blank roster entry rather than matching everything", () => {
    expect(enforceIdentityBands("The room is empty.", [hedged("   ")])).toBe("The room is empty.");
  });
});
