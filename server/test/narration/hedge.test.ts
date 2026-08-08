import { describe, expect, it } from "vitest";
import { enforceIdentityBands, hedgedIdentity } from "../../../shared/src/prompts.js";

// These fifteen cases predate the bands and each names a defect it prevents.
// They are kept exactly as they were, with one change: the roster they run
// against is now stated rather than implied. Passing bare names used to mean
// "hedge all of these"; that precondition is now optional, and a test that
// still assumed it would be testing the world before the change rather than
// after it. `allHedged` makes the assumption visible.
//
// Band behaviour is deliberately NOT added here — it lives in
// server/test/narration/bands-output.test.ts, in a block that never passes a
// bare name list.
const allHedged = (...names: string[]) => names.map((name) => ({ name, confidence: null, band: "hedged" as const }));

// R23's second half, and AE7's harder half. The input is shaped so the model
// never receives a bare name; this is the check on what it produces anyway,
// because a model can flatten a hedge it was given and a prompt rule telling it
// not to is the lever this project has measured failing three times.

describe("hedgedIdentity", () => {
  it("attributes rather than asserts", () => {
    expect(hedgedIdentity("Dave")).toBe("someone who looks like Dave");
  });
});

describe("enforceIdentityBands — the pre-band cases, unchanged", () => {
  it("rewrites a bare enrolled name the model emitted", () => {
    // Covers AE7 (output half).
    expect(enforceIdentityBands("Dave is at the desk.", allHedged("Dave"))).toBe(
      "someone who looks like Dave is at the desk.",
    );
  });

  it("leaves an already-hedged mention alone", () => {
    // The double-hedge is the obvious way to get this wrong, and it reads as a
    // bug to anyone who sees it in the feed.
    const already = "someone who looks like Dave is at the desk.";
    expect(enforceIdentityBands(already, allHedged("Dave"))).toBe(already);
  });

  it("is idempotent across repeated application", () => {
    const once = enforceIdentityBands("Dave left.", allHedged("Dave"));
    expect(enforceIdentityBands(once, allHedged("Dave"))).toBe(once);
  });

  it("rewrites every occurrence, not just the first", () => {
    expect(enforceIdentityBands("Dave sat down. Dave stood up.", allHedged("Dave"))).toBe(
      "someone who looks like Dave sat down. someone who looks like Dave stood up.",
    );
  });

  it("ignores a name belonging to nobody enrolled", () => {
    const text = "Marvin is at the desk.";
    expect(enforceIdentityBands(text, allHedged("Dave"))).toBe(text);
  });

  it("respects word boundaries", () => {
    // A person called "Al" must not turn "Also" into "someone who looks like
    // Also" — the failure that would make the guarantee worse than useless.
    expect(enforceIdentityBands("Also, the lamp is on.", allHedged("Al"))).toBe("Also, the lamp is on.");
    expect(enforceIdentityBands("Al is here.", allHedged("Al"))).toBe("someone who looks like Al is here.");
  });

  it("does not fire inside a longer word", () => {
    expect(enforceIdentityBands("The database is fine.", allHedged("data"))).toBe("The database is fine.");
  });

  it("treats a name with regex metacharacters literally", () => {
    // A name is user input and reaches this as a pattern. Unescaped, "A." would
    // match any character and rewrite the whole entry.
    expect(enforceIdentityBands("A. is at the desk.", allHedged("A."))).toBe(
      "someone who looks like A. is at the desk.",
    );
    expect(enforceIdentityBands("Ab is at the desk.", allHedged("A."))).toBe("Ab is at the desk.");
  });

  it("handles a name that is a regex quantifier without throwing", () => {
    expect(() => enforceIdentityBands("anything", allHedged("*"))).not.toThrow();
    expect(() => enforceIdentityBands("anything", allHedged("("))).not.toThrow();
  });

  it("prefers the longer name when one is a prefix of another", () => {
    // "Ann" must not partially rewrite a mention of "Ann Marie".
    expect(enforceIdentityBands("Ann Marie is here.", allHedged("Ann", "Ann Marie"))).toBe(
      "someone who looks like Ann Marie is here.",
    );
  });

  it("hedges each enrolled person present", () => {
    expect(enforceIdentityBands("Dave and Marvin are talking.", allHedged("Dave", "Marvin"))).toBe(
      "someone who looks like Dave and someone who looks like Marvin are talking.",
    );
  });

  it("hedges a re-cased name rather than letting it through bare", () => {
    // Deliberately changed. This used to assert case-SENSITIVE matching, so
    // "The bill is paid." survived a person named "Bill" — but the same rule
    // let a model that re-cased a name ship it bare, and a model re-cases names
    // constantly: sentence starts, and initialisms like "sw" written "SW".
    //
    // The trade is asymmetric. Over-hedging makes one sentence read oddly;
    // under-hedging states a human's name as fact, which is the single failure
    // this feature exists to prevent. So it over-hedges.
    expect(enforceIdentityBands("SW is at the desk.", allHedged("sw"))).toBe(
      "someone who looks like sw is at the desk.",
    );
    expect(enforceIdentityBands("The bill is paid.", allHedged("Bill"))).toBe(
      "The someone who looks like Bill is paid.",
    );
  });

  it("does not double-hedge when the model capitalises the prefix it was given", () => {
    // The most likely output shape of all, and it used to slip through: the
    // summariser is HANDED "someone who looks like Dave" and naturally
    // capitalises it at the start of a sentence. The old lookbehind was
    // lowercase-only, so this produced "Someone who looks like someone who
    // looks like Dave".
    expect(enforceIdentityBands("Someone who looks like Dave is at the desk.", allHedged("Dave"))).toBe(
      "Someone who looks like Dave is at the desk.",
    );
  });

  it("tolerates extra whitespace inside a name", () => {
    expect(enforceIdentityBands("Ann  Marie is here.", allHedged("Ann Marie"))).toBe(
      "someone who looks like Ann Marie is here.",
    );
  });

  it("handles a name with a non-ASCII letter", () => {
    expect(enforceIdentityBands("Zoë is at the desk.", allHedged("Zoë"))).toBe(
      "someone who looks like Zoë is at the desk.",
    );
    // And does not fire on a longer word that merely starts with it.
    expect(enforceIdentityBands("Zoës are plural.", allHedged("Zoë"))).toBe("Zoës are plural.");
  });

  it("returns the text unchanged when nobody is enrolled", () => {
    const text = "The desk is empty.";
    expect(enforceIdentityBands(text, allHedged())).toBe(text);
  });

  it("ignores blank and whitespace-only names rather than rewriting everything", () => {
    const text = "The desk is empty.";
    expect(enforceIdentityBands(text, allHedged("", "   "))).toBe(text);
  });
});
