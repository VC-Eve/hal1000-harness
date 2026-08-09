import { describe, expect, it } from "vitest";
import { visionContextSection, relativeAge } from "../../../shared/src/prompts.js";

// U3 — what HAL can see, as a conversation receives it.
//
// Two invariants carry most of the weight. A caption is always quoted and
// always dated, because this is the one place the captioner's text reaches a
// conversation and it invents object counts. And only a stated band unlocks a
// profile, because handing HAL someone's history on a maybe is how a marginal
// match becomes a confident story about the wrong person.

const NOW = new Date("2026-08-08T12:00:00.000Z");
const THRESHOLDS = { recognition: 0.5, statement: 0.6 };
const BIG = 100_000;

const at = (secondsAgo: number): string => new Date(NOW.getTime() - secondsAgo * 1000).toISOString();

const seen = (name: string, confidence: number, sinceSeconds = 60) => ({
  match: { name, confidence },
  since: at(sinceSeconds),
});

const stranger = (sinceSeconds = 60) => ({ match: null, since: at(sinceSeconds) });

describe("vision context", () => {
  it("says it is not looking when the camera is off", () => {
    // Distinct from an empty room. A section claiming nobody is in view while
    // the camera is off would be inventing an observation.
    const out = visionContextSection({ watching: false, present: [] }, null, [], THRESHOLDS, BIG, NOW);
    expect(out).toContain("not looking");
    expect(out).not.toContain("no face I can place");
  });

  it("distinguishes a recognised-nobody from a closed eye", () => {
    const out = visionContextSection({ watching: true, present: [] }, null, [], THRESHOLDS, BIG, NOW);
    expect(out).toContain("no face I can place");
    expect(out).not.toContain("not looking");
  });

  it("does not claim the room is empty when recognition found no face", () => {
    // Found by running it. This line comes from face detection, so it means
    // "no face I can place" and nothing more — phrased as an empty room it
    // outranked a caption describing someone sitting in the frame, and HAL
    // answered "the room is empty" about an occupied one.
    const out = visionContextSection(
      { watching: true, present: [] },
      { caption: "A person sits in a chair, looking down.", at: at(18) },
      [],
      THRESHOLDS,
      BIG,
      NOW,
    );
    expect(out).toContain("that is not the same as nobody being there");
    expect(out).toContain("A person sits in a chair, looking down.");
  });

  it("carries the newest caption even when nobody is in view", () => {
    // The quiet-cycle case this feature exists for: the narration feed is
    // empty, and the caption is the only thing that can answer.
    const out = visionContextSection(
      { watching: true, present: [] },
      { caption: "An empty desk beside a window.", at: at(41) },
      [],
      THRESHOLDS,
      BIG,
      NOW,
    );
    expect(out).toContain('"An empty desk beside a window."');
    expect(out).toContain("41 seconds ago");
  });

  it("quotes and dates the caption rather than asserting it", () => {
    const out = visionContextSection(
      { watching: true, present: [] },
      { caption: "One person typing.", at: at(41) },
      [],
      THRESHOLDS,
      BIG,
      NOW,
    );
    expect(out).toContain('41 seconds ago at ');
    expect(out).toContain('"One person typing."');
    expect(out).toContain("My last look at the scene,");
  });

  it("carries a wall-clock time beside the age, so freshness can be checked", () => {
    // Without it "41 seconds ago" cannot be audited against anything, which is
    // what sent someone hunting for a bug in a file read that was correct.
    const out = visionContextSection(
      { watching: true, present: [] },
      { caption: "One person typing.", at: at(41) },
      [],
      THRESHOLDS,
      BIG,
      NOW,
    );
    expect(out).toMatch(/at \d{2}:\d{2}:\d{2}: "/);
  });

  it("stamps the presence line with the moment it was read", () => {
    const out = visionContextSection(
      { watching: true, present: [seen("Alice", 0.76)] },
      null,
      [],
      THRESHOLDS,
      BIG,
      NOW,
    );
    expect(out).toMatch(/Who I can see as of \d{2}:\d{2}:\d{2} \(/);
  });

  it("says what the percentage measures, so the number arrives with a unit", () => {
    const out = visionContextSection(
      { watching: true, present: [seen("Alice", 0.76)] },
      null,
      [],
      THRESHOLDS,
      BIG,
      NOW,
    );
    expect(out).toContain("how strongly that face matched");
    expect(out).toContain("Alice 76%");
  });

  it("dates a caption from a previous sitting so it cannot read as current", () => {
    const out = visionContextSection(
      { watching: true, present: [] },
      { caption: "A dark room.", at: at(4 * 3600) },
      [],
      THRESHOLDS,
      BIG,
      NOW,
    );
    expect(out).toContain("4 hours ago");
  });

  it("names a stated-band person and unlocks their profile", () => {
    const out = visionContextSection(
      { watching: true, present: [seen("Alice", 0.76)] },
      null,
      [{ name: "Alice", profile: "Writes the compiler." }],
      THRESHOLDS,
      BIG,
      NOW,
    );
    expect(out).toContain("Alice 76%");
    expect(out).toContain("Writes the compiler.");
  });

  it("attributes a hedged-band person and withholds their profile", () => {
    const out = visionContextSection(
      { watching: true, present: [seen("Alice", 0.55)] },
      null,
      [{ name: "Alice", profile: "Writes the compiler." }],
      THRESHOLDS,
      BIG,
      NOW,
    );
    expect(out).toContain("looks like Alice");
    expect(out).not.toContain("Writes the compiler.");
  });

  it("keeps a stranger in the set rather than dropping them", () => {
    const out = visionContextSection(
      { watching: true, present: [stranger()] },
      null,
      [],
      THRESHOLDS,
      BIG,
      NOW,
    );
    expect(out).toContain("someone I do not recognise");
  });

  it("delivers the operator's profile even when they are not in view", () => {
    // Who HAL is talking to is true with the camera off.
    const out = visionContextSection(
      { watching: true, present: [] },
      null,
      [{ name: "Steve", profile: "Whose machine this is.", isOperator: true }],
      THRESHOLDS,
      BIG,
      NOW,
    );
    expect(out).toContain("Whose machine this is.");
  });

  it("does not deliver a non-operator profile for someone absent", () => {
    const out = visionContextSection(
      { watching: true, present: [] },
      null,
      [{ name: "Alice", profile: "Writes the compiler." }],
      THRESHOLDS,
      BIG,
      NOW,
    );
    expect(out).not.toContain("Writes the compiler.");
  });

  it("reports how long someone has been in view", () => {
    const out = visionContextSection(
      { watching: true, present: [seen("Alice", 0.76, 20 * 60)] },
      null,
      [],
      THRESHOLDS,
      BIG,
      NOW,
    );
    expect(out).toContain("in view for 20 minutes");
  });

  it("returns empty on a zero budget", () => {
    expect(visionContextSection({ watching: true, present: [seen("Alice", 0.8)] }, null, [], THRESHOLDS, 0, NOW)).toBe("");
  });

  it("returns empty on a NaN budget rather than spending without limit", () => {
    expect(
      visionContextSection({ watching: true, present: [seen("Alice", 0.8)] }, null, [], THRESHOLDS, Number.NaN, NOW),
    ).toBe("");
  });

  it("states how many people it could not list when the budget runs out", () => {
    const crowd = Array.from({ length: 8 }, (_, i) => seen(`Person${i}`, 0.8));
    // Wide enough for the header plus a couple of people, not for eight.
    const out = visionContextSection({ watching: true, present: crowd }, null, [], THRESHOLDS, 220, NOW);
    expect(out).toMatch(/\d+ others? in view, not listed here/);
    expect(out.length).toBeLessThanOrEqual(220);
  });

  it("never exceeds its budget, profiles included", () => {
    const out = visionContextSection(
      { watching: true, present: [seen("Alice", 0.9)] },
      { caption: "x".repeat(500), at: at(10) },
      [{ name: "Alice", profile: "y".repeat(500), isOperator: true }],
      THRESHOLDS,
      300,
      NOW,
    );
    expect(out.length).toBeLessThanOrEqual(300);
  });

  it("emits no caption line at all rather than a bare one, on every branch", () => {
    // The mitigation for a caption reaching chat is that it is always quoted
    // and always dated. A branch that emitted it bare would defeat that, so no
    // output may contain the caption text outside the quoted form.
    const caption = "One person seated.";
    for (const presence of [
      { watching: false, present: [] },
      { watching: true, present: [] },
      { watching: true, present: [seen("Alice", 0.9)] },
      { watching: true, present: [stranger()] },
    ]) {
      const out = visionContextSection(presence, { caption, at: at(5) }, [], THRESHOLDS, BIG, NOW);
      if (out.includes(caption)) {
        expect(out).toContain(`: "${caption}"`);
        expect(out).toContain("My last look at the scene");
      }
    }
  });

  it("omits the caption when it is blank rather than quoting nothing", () => {
    const out = visionContextSection(
      { watching: true, present: [] },
      { caption: "   ", at: at(5) },
      [],
      THRESHOLDS,
      BIG,
      NOW,
    );
    expect(out).not.toContain("My last look");
  });
});

describe("relative age", () => {
  it("reads in seconds, minutes, hours and days", () => {
    expect(relativeAge(41_000)).toBe("41 seconds");
    expect(relativeAge(20 * 60_000)).toBe("20 minutes");
    expect(relativeAge(4 * 3_600_000)).toBe("4 hours");
    expect(relativeAge(3 * 86_400_000)).toBe("3 days");
  });

  it("singularises", () => {
    expect(relativeAge(1_000)).toBe("1 second");
    expect(relativeAge(2 * 3_600_000)).toBe("2 hours");
  });

  it("refuses to state an age it cannot compute", () => {
    expect(relativeAge(Number.NaN)).toBe("an unknown time");
    expect(relativeAge(-5)).toBe("an unknown time");
  });
});
