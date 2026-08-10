import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_PREAMBLE,
  sessionContextSection,
  visionContextSection,
} from "../../../shared/src/prompts.js";

// The byte-identity oracle for R16.
//
// These snapshots were taken from the hand-assembled implementation before the
// template renderer replaced it. They are not a description of what the code
// should say — they are a record of what it DID say, and the whole point is
// that moving the assembly onto templates changes none of it. A diff here on a
// refactor means every existing install would have started hearing something
// different on upgrade.
//
// Do not re-record these to make a change pass. If the wording genuinely should
// move, that is a change to a shipped default template and it belongs in a
// commit that says so.

// Built from local components, not a UTC string. `clockTime` and `entryStamp`
// read local hours, so a UTC literal would bake this machine's offset into
// every snapshot and break the suite on a machine set to another zone.
const NOW = new Date(2026, 7, 9, 18, 22, 4);
const THRESHOLDS = { recognition: 0.35, statement: 0.6 };

const stamp = (minutesAgo: number): string => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

const remark = (n: number, minutesAgo: number, sessionId: string | null = "s1") => ({
  text: `Remark number ${n} about the work.`,
  at: stamp(minutesAgo),
  sessionId,
  sessionLabel: "Claude Code [a408c0a1]",
});

const face = (
  name: string | null,
  confidence: number,
  opts: { since?: number; weight?: number } = {},
) => ({
  match: name === null ? null : { name, confidence },
  ...(opts.since !== undefined ? { since: stamp(opts.since) } : {}),
  ...(opts.weight !== undefined ? { weight: opts.weight } : {}),
});

describe("session context — golden", () => {
  it("no watched session", () => {
    expect(sessionContextSection([remark(1, 5)], null, 4000, NOW)).toMatchSnapshot();
  });

  it("watched session with no matching remarks", () => {
    expect(sessionContextSection([remark(1, 5, "other")], "s1", 4000, NOW)).toMatchSnapshot();
  });

  it("a handful of remarks, oldest first", () => {
    const entries = [remark(1, 30), remark(2, 20), remark(3, 5)];
    expect(sessionContextSection(entries, "s1", 4000, NOW)).toMatchSnapshot();
  });

  it("a remark from a previous day carries its date", () => {
    const entries = [remark(1, 60 * 30), remark(2, 5)];
    expect(sessionContextSection(entries, "s1", 4000, NOW)).toMatchSnapshot();
  });

  it("truncated, with the notice the give-back made room for", () => {
    const entries = Array.from({ length: 40 }, (_, i) => remark(i, 40 - i));
    expect(sessionContextSection(entries, "s1", 400, NOW)).toMatchSnapshot();
  });

  it("a budget too small for even one remark", () => {
    const entries = [remark(1, 5), remark(2, 4)];
    expect(sessionContextSection(entries, "s1", 90, NOW)).toMatchSnapshot();
  });

  it("a zero budget", () => {
    expect(sessionContextSection([remark(1, 5)], "s1", 0, NOW)).toMatchSnapshot();
  });
});

describe("vision context — golden", () => {
  const caption = { caption: "A person sits at a desk, facing the screen.", at: stamp(0.2) };

  it("camera off", () => {
    expect(
      visionContextSection({ watching: false, present: [] }, null, [], THRESHOLDS, 4000, NOW),
    ).toMatchSnapshot();
  });

  it("watching, nobody placed", () => {
    expect(
      visionContextSection({ watching: true, present: [] }, null, [], THRESHOLDS, 4000, NOW),
    ).toMatchSnapshot();
  });

  it("watching, nobody placed, with a caption", () => {
    expect(
      visionContextSection({ watching: true, present: [] }, caption, [], THRESHOLDS, 4000, NOW),
    ).toMatchSnapshot();
  });

  it("one stated face, held for minutes, run steady", () => {
    const presence = { watching: true, present: [face("Creator", 0.74, { since: 6, weight: 0.9 })] };
    expect(visionContextSection(presence, caption, [], THRESHOLDS, 4000, NOW)).toMatchSnapshot();
  });

  it("one hedged face", () => {
    const presence = { watching: true, present: [face("Creator", 0.45, { since: 2, weight: 0.3 })] };
    expect(visionContextSection(presence, caption, [], THRESHOLDS, 4000, NOW)).toMatchSnapshot();
  });

  it("an unrecognised face", () => {
    const presence = { watching: true, present: [face(null, 0, { since: 1 })] };
    expect(visionContextSection(presence, caption, [], THRESHOLDS, 4000, NOW)).toMatchSnapshot();
  });

  it("two faces, one stated and one unrecognised", () => {
    const presence = {
      watching: true,
      present: [face("Creator", 0.8, { since: 10, weight: 0.8 }), face(null, 0, { since: 1, weight: 0.1 })],
    };
    expect(visionContextSection(presence, caption, [], THRESHOLDS, 4000, NOW)).toMatchSnapshot();
  });

  it("a stated face unlocks a profile; the operator's is standing context", () => {
    const presence = { watching: true, present: [face("Creator", 0.8, { since: 10, weight: 0.8 })] };
    const people = [
      { name: "Creator", profile: "Builds HAL. Prefers blunt answers.", isOperator: true },
      { name: "Ada", profile: "Visits sometimes." },
    ];
    expect(visionContextSection(presence, caption, people, THRESHOLDS, 4000, NOW)).toMatchSnapshot();
  });

  it("a hedged face unlocks no profile", () => {
    const presence = { watching: true, present: [face("Ada", 0.45, { since: 2 })] };
    const people = [{ name: "Ada", profile: "Visits sometimes." }];
    expect(visionContextSection(presence, caption, people, THRESHOLDS, 4000, NOW)).toMatchSnapshot();
  });

  it("more faces than the budget holds, with the not-listed notice", () => {
    const presence = {
      watching: true,
      present: Array.from({ length: 12 }, (_, i) => face(`Person${i}`, 0.8, { since: i + 1, weight: 0.9 })),
    };
    expect(visionContextSection(presence, caption, [], THRESHOLDS, 320, NOW)).toMatchSnapshot();
  });

  it("a zero budget", () => {
    const presence = { watching: true, present: [face("Creator", 0.8, { since: 6 })] };
    expect(visionContextSection(presence, caption, [], THRESHOLDS, 0, NOW)).toMatchSnapshot();
  });
});

describe("assembled context — golden", () => {
  // The join `assembleContext` performs: preamble, then session, then sight,
  // separated by blank lines, and nothing at all when both parts are empty.
  const assemble = (parts: string[]): string => {
    const kept = parts.filter((p) => p.length > 0);
    if (kept.length === 0) return "";
    return [DEFAULT_CONTEXT_PREAMBLE, ...kept].join("\n\n");
  };

  const entries = [remark(1, 30), remark(2, 5)];
  const caption = { caption: "A person sits at a desk, facing the screen.", at: stamp(0.2) };
  const presence = { watching: true, present: [face("Creator", 0.74, { since: 6, weight: 0.9 })] };

  it("both sources present", () => {
    const session = sessionContextSection(entries, "s1", 2000, NOW);
    const sight = visionContextSection(presence, caption, [], THRESHOLDS, 2000, NOW);
    expect(assemble([session, sight])).toMatchSnapshot();
  });

  it("session only", () => {
    const session = sessionContextSection(entries, "s1", 2000, NOW);
    expect(assemble([session, ""])).toMatchSnapshot();
  });

  it("sight only", () => {
    const sight = visionContextSection(presence, caption, [], THRESHOLDS, 2000, NOW);
    expect(assemble(["", sight])).toMatchSnapshot();
  });

  it("neither, so no preamble either", () => {
    expect(assemble(["", ""])).toBe("");
  });
});
