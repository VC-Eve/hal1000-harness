import { describe, expect, it } from "vitest";
import { renderChatContext, type ChatContextInputs } from "../../src/templates/chatContext.js";
import type { RecentSighting } from "../../../shared/src/prompts.js";

// The three sources a Conversation could not previously be told about.

const NOW = new Date(2026, 7, 10, 18, 22, 4);
const T = { recognition: 0.35, statement: 0.6 };
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const seen = (name: string, confidence: number, band: RecentSighting["band"], m: number): RecentSighting => ({
  name,
  confidence,
  band,
  at: ago(m),
});

const inputs = (over: Partial<ChatContextInputs> = {}): ChatContextInputs => ({
  presence: { watching: true, present: [] },
  lastLook: null,
  people: [],
  thresholds: T,
  entries: [],
  watchedSessionId: null,
  preamble: "",
  visionBudget: 4000,
  sessionBudget: 0,
  monitorBudget: 0,
  now: NOW,
  ...over,
});

describe("who was recognised lately", () => {
  const TPL = "{#vision_recent_people}Lately:\n{vision_recent_people}{/}";

  it("names someone who has since left, with how long ago", () => {
    const out = renderChatContext(TPL, inputs({ recentlySeen: [seen("Ada", 0.8, "stated", 12)] }));
    expect(out.text).toBe("Lately:\n- Ada 80%, last seen 12 minutes ago");
  });

  it("hedges a marginal reading exactly as the live list does", () => {
    const out = renderChatContext(TPL, inputs({ recentlySeen: [seen("Ada", 0.45, "hedged", 3)] }));
    expect(out.text).toContain("someone who looks like Ada 45%");
  });

  it("says nothing when the record holds nobody", () => {
    expect(renderChatContext(TPL, inputs({ recentlySeen: [] })).text).toBe("");
  });

  it("takes a count, so [1] is the most recent recognition alone", () => {
    const out = renderChatContext("{vision_recent_people[1]}", inputs({
      recentlySeen: [seen("Ada", 0.8, "stated", 2), seen("Bram", 0.9, "stated", 40)],
    }));
    expect(out.text).toContain("Ada");
    expect(out.text).not.toContain("Bram");
  });

  it("is silent when the sight source is off", () => {
    const out = renderChatContext(TPL, inputs({ visionBudget: 0, recentlySeen: [seen("Ada", 0.8, "stated", 1)] }));
    expect(out.text).toBe("");
  });
});

describe("what HAL has been saying about the logs", () => {
  const TPL = "{#monitor_remarks}Logs:\n{monitor_remarks}{/}";
  const entries = [
    { text: "The spooler stopped.", at: ago(9), monitorId: "m1" },
    { text: "It is back.", at: ago(2), monitorId: "m1" },
    { text: "Unrelated session chatter.", at: ago(5), sessionId: "s1" },
  ];
  const label = () => "windows event log";

  it("carries Monitor remarks, oldest first, named by monitor", () => {
    const out = renderChatContext(TPL, inputs({ entries, monitorLabel: label, monitorBudget: 4000 }));
    expect(out.text).toBe(
      "Logs:\n- [18:13:04] windows event log: The spooler stopped.\n- [18:20:04] windows event log: It is back.",
    );
  });

  it("excludes feed entries that are not a Monitor's", () => {
    const out = renderChatContext(TPL, inputs({ entries, monitorLabel: label, monitorBudget: 4000 }));
    expect(out.text).not.toContain("Unrelated session chatter");
  });

  it("is off unless the Monitor source is on", () => {
    expect(renderChatContext(TPL, inputs({ entries, monitorLabel: label })).text).toBe("");
  });

  it("says what the budget dropped rather than truncating in silence", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      text: `Remark ${i} about the log.`,
      at: ago(30 - i),
      monitorId: "m1",
    }));
    const out = renderChatContext(TPL, inputs({ entries: many, monitorLabel: label, monitorBudget: 260 }));
    expect(out.text).toMatch(/earlier log remarks? not recalled here/);
  });
});

describe("the date", () => {
  it("answers what day it is, which the clock alone cannot", () => {
    const out = renderChatContext(["Today is {date}.", "{vision_recent_people}"].join("\n"), inputs({
      recentlySeen: [seen("Ada", 0.8, "stated", 1)],
    }));
    expect(out.text).toContain("Today is Monday 10 August 2026.");
  });

  it("is furniture, not content: a template of only a date sends nothing", () => {
    // The same rule the clock follows. A heading with no reading under it is
    // not a context, and a date on its own is a heading.
    expect(renderChatContext("{date}", inputs()).text).toBe("");
  });
});

describe("the shipped default is unchanged for an install that has not opted in", () => {
  it("renders nothing extra while the Monitor source is off", () => {
    // The Monitor block is in the shipped template, which is only safe because
    // an off source renders empty and takes its block with it.
    const out = renderChatContext(null, inputs({
      presence: { watching: false, present: [] },
      visionBudget: 0,
      entries: [{ text: "The spooler stopped.", at: ago(2), monitorId: "m1" }],
      monitorLabel: () => "windows event log",
    }));
    expect(out.text).toBe("");
  });
});
