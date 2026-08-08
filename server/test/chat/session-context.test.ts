import { describe, expect, it } from "vitest";
import { sessionContextSection } from "../../../shared/src/prompts.js";

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
    // Between "one remark plus its notice fits" and "all three fit" — the
    // whole feed is 142 characters.
    const out = sessionContextSection(feed, WATCHED, 130);
    expect(out).toContain("Tests are running.");
    expect(out).not.toContain("I see it reading the router.");
    expect(out).toMatch(/\d+ earlier remarks? not recalled here/);
  });

  it("never exceeds its budget, notice included", () => {
    for (const budget of [80, 110, 150, 200, 400]) {
      expect(sessionContextSection(feed, WATCHED, budget).length).toBeLessThanOrEqual(budget);
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

  it("carries gap and status entries about the watched session", () => {
    // They are still what HAL said about that session.
    const withGap = [...feed, entry("I was away for a while.", 0)];
    expect(sessionContextSection(withGap, WATCHED, 10_000)).toContain("I was away for a while.");
  });
});
