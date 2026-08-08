import { describe, expect, it } from "vitest";
import { enforceIdentityHedge, hedgedIdentity } from "../../../shared/src/prompts.js";

// R23's second half, and AE7's harder half. The input is shaped so the model
// never receives a bare name; this is the check on what it produces anyway,
// because a model can flatten a hedge it was given and a prompt rule telling it
// not to is the lever this project has measured failing three times.

describe("hedgedIdentity", () => {
  it("attributes rather than asserts", () => {
    expect(hedgedIdentity("Dave")).toBe("someone who looks like Dave");
  });
});

describe("enforceIdentityHedge", () => {
  it("rewrites a bare enrolled name the model emitted", () => {
    // Covers AE7 (output half).
    expect(enforceIdentityHedge("Dave is at the desk.", ["Dave"])).toBe(
      "someone who looks like Dave is at the desk.",
    );
  });

  it("leaves an already-hedged mention alone", () => {
    // The double-hedge is the obvious way to get this wrong, and it reads as a
    // bug to anyone who sees it in the feed.
    const already = "someone who looks like Dave is at the desk.";
    expect(enforceIdentityHedge(already, ["Dave"])).toBe(already);
  });

  it("is idempotent across repeated application", () => {
    const once = enforceIdentityHedge("Dave left.", ["Dave"]);
    expect(enforceIdentityHedge(once, ["Dave"])).toBe(once);
  });

  it("rewrites every occurrence, not just the first", () => {
    expect(enforceIdentityHedge("Dave sat down. Dave stood up.", ["Dave"])).toBe(
      "someone who looks like Dave sat down. someone who looks like Dave stood up.",
    );
  });

  it("ignores a name belonging to nobody enrolled", () => {
    const text = "Marvin is at the desk.";
    expect(enforceIdentityHedge(text, ["Dave"])).toBe(text);
  });

  it("respects word boundaries", () => {
    // A person called "Al" must not turn "Also" into "someone who looks like
    // Also" — the failure that would make the guarantee worse than useless.
    expect(enforceIdentityHedge("Also, the lamp is on.", ["Al"])).toBe("Also, the lamp is on.");
    expect(enforceIdentityHedge("Al is here.", ["Al"])).toBe("someone who looks like Al is here.");
  });

  it("does not fire inside a longer word", () => {
    expect(enforceIdentityHedge("The database is fine.", ["data"])).toBe("The database is fine.");
  });

  it("treats a name with regex metacharacters literally", () => {
    // A name is user input and reaches this as a pattern. Unescaped, "A." would
    // match any character and rewrite the whole entry.
    expect(enforceIdentityHedge("A. is at the desk.", ["A."])).toBe(
      "someone who looks like A. is at the desk.",
    );
    expect(enforceIdentityHedge("Ab is at the desk.", ["A."])).toBe("Ab is at the desk.");
  });

  it("handles a name that is a regex quantifier without throwing", () => {
    expect(() => enforceIdentityHedge("anything", ["*"])).not.toThrow();
    expect(() => enforceIdentityHedge("anything", ["("])).not.toThrow();
  });

  it("prefers the longer name when one is a prefix of another", () => {
    // "Ann" must not partially rewrite a mention of "Ann Marie".
    expect(enforceIdentityHedge("Ann Marie is here.", ["Ann", "Ann Marie"])).toBe(
      "someone who looks like Ann Marie is here.",
    );
  });

  it("hedges each enrolled person present", () => {
    expect(enforceIdentityHedge("Dave and Marvin are talking.", ["Dave", "Marvin"])).toBe(
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
    expect(enforceIdentityHedge("SW is at the desk.", ["sw"])).toBe(
      "someone who looks like sw is at the desk.",
    );
    expect(enforceIdentityHedge("The bill is paid.", ["Bill"])).toBe(
      "The someone who looks like Bill is paid.",
    );
  });

  it("does not double-hedge when the model capitalises the prefix it was given", () => {
    // The most likely output shape of all, and it used to slip through: the
    // summariser is HANDED "someone who looks like Dave" and naturally
    // capitalises it at the start of a sentence. The old lookbehind was
    // lowercase-only, so this produced "Someone who looks like someone who
    // looks like Dave".
    expect(enforceIdentityHedge("Someone who looks like Dave is at the desk.", ["Dave"])).toBe(
      "Someone who looks like Dave is at the desk.",
    );
  });

  it("tolerates extra whitespace inside a name", () => {
    expect(enforceIdentityHedge("Ann  Marie is here.", ["Ann Marie"])).toBe(
      "someone who looks like Ann Marie is here.",
    );
  });

  it("handles a name with a non-ASCII letter", () => {
    expect(enforceIdentityHedge("Zoë is at the desk.", ["Zoë"])).toBe(
      "someone who looks like Zoë is at the desk.",
    );
    // And does not fire on a longer word that merely starts with it.
    expect(enforceIdentityHedge("Zoës are plural.", ["Zoë"])).toBe("Zoës are plural.");
  });

  it("returns the text unchanged when nobody is enrolled", () => {
    const text = "The desk is empty.";
    expect(enforceIdentityHedge(text, [])).toBe(text);
  });

  it("ignores blank and whitespace-only names rather than rewriting everything", () => {
    const text = "The desk is empty.";
    expect(enforceIdentityHedge(text, ["", "   "])).toBe(text);
  });
});
