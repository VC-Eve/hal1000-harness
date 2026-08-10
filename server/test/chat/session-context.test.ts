import { describe, expect, it } from "vitest";
import { sessionContextSection } from "../support/legacyContextSections.js";

// U4 — what HAL has been saying about the session the user singled out.
//
// The structural point: entries are selected by session id, so vision and
// monitor entries are excluded because they carry none — not by a second rule
// that could drift from the first.

const WATCHED = "sess-a";

const entry = (
  text: string,
  minutesAgo: number,
  sessionId: string | null = WATCHED,
  sessionLabel = "Claude [a3f9c21e]",
) => ({
  text,
  at: new Date(Date.parse("2026-08-08T12:00:00.000Z") - minutesAgo * 60_000).toISOString(),
  sessionId,
  ...(sessionId ? { sessionLabel } : {}),
});

// Oldest first, the order the feed holds them in.
const feed = [entry("I see it reading the router.", 9), entry("It is editing the parser.", 5), entry("Tests are running.", 1)];

describe("session context", () => {
  it("returns empty when no session is being watched", () => {
    // The switch is on and there is nothing to send. Saying so is the
    // control's job; a conversation told "you are watching nothing" would
    // discuss it.
    expect(sessionContextSection(feed, null, 10_000)).toBe("");
  });

  it("returns empty when the watched session has no entries yet", () => {
    expect(sessionContextSection([entry("x", 1, "sess-b")], WATCHED, 10_000)).toBe("");
  });

  it("carries the watched session's entries", () => {
    const out = sessionContextSection(feed, WATCHED, 10_000);
    expect(out).toContain("It is editing the parser.");
    expect(out).toContain("Tests are running.");
  });

  it("excludes another followed session's entries", () => {
    const mixed = [...feed, entry("Something else entirely.", 2, "sess-b")];
    const out = sessionContextSection(mixed, WATCHED, 10_000);
    expect(out).not.toContain("Something else entirely.");
  });

  it("excludes vision and monitor entries, which carry no session id", () => {
    const mixed = [
      ...feed,
      { text: "Someone is at the desk.", at: entry("", 2).at, sessionId: null },
      { text: "A disk is filling up.", at: entry("", 3).at },
    ];
    const out = sessionContextSection(mixed, WATCHED, 10_000);
    expect(out).not.toContain("Someone is at the desk.");
    expect(out).not.toContain("A disk is filling up.");
  });

  it("renders oldest first even though it selects newest first", () => {
    const out = sessionContextSection(feed, WATCHED, 10_000);
    expect(out.indexOf("reading the router")).toBeLessThan(out.indexOf("editing the parser"));
    expect(out.indexOf("editing the parser")).toBeLessThan(out.indexOf("Tests are running"));
  });

  it("drops the oldest when the budget cannot hold them all, and says so", () => {
    // Between "one remark plus its notice fits" and "all three fit".
    const out = sessionContextSection(feed, WATCHED, 175);
    expect(out).toContain("Tests are running.");
    expect(out).not.toContain("I see it reading the router.");
    expect(out).toMatch(/\d+ earlier remarks? not recalled here/);
  });

  it("never exceeds its budget, notice included", () => {
    for (const budget of [80, 110, 150, 200, 400]) {
      expect(sessionContextSection(feed, WATCHED, budget).length).toBeLessThanOrEqual(budget);
    }
  });

  it("never exceeds its budget at any size", () => {
    // A sweep rather than five sampled values. The accounting once counted each
    // line's text but not the newline the render joins it with, so the section
    // overran by one character per line — and of the five budgets above, only
    // 200 landed on a boundary that exposed it. Nothing downstream re-measures,
    // so an overrun spends the window the System Prompt is sitting in.
    for (let budget = 1; budget <= 400; budget += 1) {
      const out = sessionContextSection(feed, WATCHED, budget);
      expect(
        out.length,
        `budget ${budget} produced ${out.length} characters`,
      ).toBeLessThanOrEqual(budget);
    }
  });

  it("returns empty rather than a header alone when nothing fits", () => {
    // Including the case where one remark fits but its truncation notice does
    // not: a list that looks complete and is not is the outcome to avoid, so
    // sending nothing is the honest answer and the readout reports zero.
    expect(sessionContextSection(feed, WATCHED, 40)).toBe("");
    expect(sessionContextSection(feed, WATCHED, 110)).toBe("");
  });

  it("returns empty on a zero or NaN budget", () => {
    expect(sessionContextSection(feed, WATCHED, 0)).toBe("");
    expect(sessionContextSection(feed, WATCHED, Number.NaN)).toBe("");
  });

  it("names the session it is talking about", () => {
    expect(sessionContextSection(feed, WATCHED, 10_000)).toContain("Claude [a3f9c21e]");
  });

  describe("when each remark happened", () => {
    const NOW = new Date("2026-08-08T12:00:00.000Z");

    it("stamps every entry, so order is not the only thing HAL knows", () => {
      // Selection and ordering were always by time; the time was then thrown
      // away, leaving HAL able to say what happened but never when.
      const out = sessionContextSection(feed, WATCHED, 10_000, NOW);
      for (const line of out.split("\n").filter((l) => l.startsWith("- "))) {
        expect(line).toMatch(/^- \[\d{2}:\d{2}:\d{2}\] /);
      }
    });

    it("anchors the stamps with the current time", () => {
      // Without a "now", per-entry clocks give the model no way to work out
      // how long ago anything was.
      const out = sessionContextSection(feed, WATCHED, 10_000, NOW);
      expect(out).toMatch(/it is now \d{2}:\d{2}:\d{2}:/);
    });

    it("adds a date to an entry from another day", () => {
      // A bare clock on yesterday's remark reads as this morning, and is wrong
      // by however long HAL was off.
      const old = [
        { ...entry("Something from before.", 0), at: "2026-08-06T09:15:00.000Z" },
        entry("Something from today.", 2),
      ];
      const out = sessionContextSection(old, WATCHED, 10_000, NOW);
      expect(out).toMatch(/\[Aug \d+ \d{2}:\d{2}:\d{2}\] Something from before\./);
      expect(out).toMatch(/\[\d{2}:\d{2}:\d{2}\] Something from today\./);
    });

    it("stamps an unparseable time without inventing one", () => {
      const bad = [{ text: "No idea when.", at: "not a date", sessionId: WATCHED, sessionLabel: "Claude [a3f9c21e]" }];
      expect(sessionContextSection(bad, WATCHED, 10_000, NOW)).toContain("[??:??:??]");
    });
  });

  it("carries gap and status entries about the watched session", () => {
    // They are still what HAL said about that session.
    const withGap = [...feed, entry("I was away for a while.", 0)];
    expect(sessionContextSection(withGap, WATCHED, 10_000)).toContain("I was away for a while.");
  });
});
