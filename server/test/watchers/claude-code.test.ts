import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { ClaudeCodeWatcher, decodeSlug, extractEvents, summarizeToolInput } from "../../src/watchers/claude-code.js";
import { eventLine } from "../../src/narration/coalescer.js";
import type { SessionEvent, WatcherNotification } from "../../src/watchers/watcher.js";

// Reference sample of the real Claude Code log format — see fixtures/README.md
// for provenance and for how to re-inventory it when the format drifts.
const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "claude-code-session.jsonl");
const fixtureLines = async (): Promise<string[]> => (await fs.readFile(FIXTURE, "utf8")).split("\n").filter((l) => l.trim());

let root: string;
let projectsDir: string;
let stateFile: string;
let watcher: ClaudeCodeWatcher | null = null;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "hal1000-watch-"));
  projectsDir = path.join(root, "projects");
  stateFile = path.join(root, "watcher-state.json");
  await fs.mkdir(projectsDir, { recursive: true });
});

afterEach(() => {
  watcher?.stop();
  watcher = null;
});

function makeWatcher(overrides: Partial<ConstructorParameters<typeof ClaudeCodeWatcher>[0]> = {}): ClaudeCodeWatcher {
  watcher?.stop();
  watcher = new ClaudeCodeWatcher({
    projectsDir,
    stateFile,
    tailIntervalMs: 20,
    sweepIntervalMs: 40,
    parseErrorThreshold: 3,
    ...overrides,
  });
  return watcher;
}

async function makeSession(slug: string, sessionId: string, lines: string[] = []): Promise<string> {
  const dir = path.join(projectsDir, slug);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  await fs.writeFile(file, lines.map((l) => `${l}\n`).join(""), "utf8");
  return file;
}

const userLine = (text: string) => JSON.stringify({ type: "user", timestamp: "2026-08-02T10:00:00Z", message: { role: "user", content: text } });
const assistantLine = (text: string, tools: { name: string; input?: Record<string, unknown> }[] = []) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-02T10:00:01Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text },
        ...tools.map(({ name, input }) => ({ type: "tool_use", name, input: input ?? {} })),
      ],
    },
  });
const toolResultLine = (content: unknown, isError = false) =>
  JSON.stringify({
    type: "user",
    timestamp: "2026-08-02T10:00:02Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content, is_error: isError }] },
  });
const metaLine = () => JSON.stringify({ type: "file-history-snapshot", messageId: "x", snapshot: {} });
const sidechainLine = () => JSON.stringify({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent chatter" }] } });

function listen(w: ClaudeCodeWatcher): WatcherNotification[] {
  const notifications: WatcherNotification[] = [];
  w.subscribe((n) => notifications.push(n));
  return notifications;
}

async function waitUntil(fn: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}

const eventsOf = (ns: WatcherNotification[]) =>
  ns.filter((n): n is Extract<WatcherNotification, { kind: "session-events" }> => n.kind === "session-events").flatMap((n) => n.events);

describe("discovery", () => {
  it("lists sessions, skips jsonl-less dirs, classifies by mtime", async () => {
    const now = new Date();
    const liveFile = await makeSession("C--GitHub-my-app", "aaa", [userLine("hi")]);
    const idleFile = await makeSession("C--GitHub-other", "bbb", [userLine("hi")]);
    const endedFile = await makeSession("C--GitHub-old", "ccc", [userLine("hi")]);
    await fs.mkdir(path.join(projectsDir, "C--GitHub-empty", "memory"), { recursive: true });
    await fs.utimes(liveFile, now, now);
    await fs.utimes(idleFile, now, new Date(now.getTime() - 10 * 60_000));
    await fs.utimes(endedFile, now, new Date(now.getTime() - 2 * 60 * 60_000));

    const sessions = await makeWatcher().discoverSessions();
    expect(sessions.map((s) => s.id).sort()).toEqual(["aaa", "bbb", "ccc"]);
    const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
    expect(byId.aaa!.state).toBe("live");
    expect(byId.bbb!.state).toBe("idle");
    expect(byId.ccc!.state).toBe("ended");
    expect(byId.aaa!.projectName).toBe("app");
  });
});

describe("tailing", () => {
  it("emits parsed events for appended lines only, filtering meta and sidechain", async () => {
    const file = await makeSession("C--GitHub-my-app", "aaa", [userLine("history — must not narrate")]);
    const w = makeWatcher();
    const ns = listen(w);
    await w.attach("aaa");
    w.start();
    const tools = [{ name: "Bash", input: { command: "npm test" } }];
    await fs.appendFile(file, `${userLine("open the doors")}\n${metaLine()}\n${sidechainLine()}\n${assistantLine("I hear you", tools)}\n`);
    await waitUntil(() => eventsOf(ns).length >= 2);
    const events = eventsOf(ns);
    expect(events).toHaveLength(2);
    expect(events[0]!.kind).toBe("user");
    expect(events[0]!.text).toBe("open the doors");
    expect(events[1]!.kind).toBe("assistant");
    expect(events[1]!.toolUses).toEqual(["Bash(npm test)"]);
  });

  it("emits tool results so outcomes reach narration", async () => {
    const file = await makeSession("C--GitHub-my-app", "aaa");
    const w = makeWatcher();
    const ns = listen(w);
    await w.attach("aaa");
    w.start();
    await fs.appendFile(file, `${toolResultLine("2 files changed")}\n${toolResultLine("ENOENT: no such file", true)}\n`);
    await waitUntil(() => eventsOf(ns).length >= 2);
    const events = eventsOf(ns);
    expect(events[0]).toMatchObject({ kind: "tool-result", text: "2 files changed" });
    expect(events[1]).toMatchObject({ kind: "tool-result", text: "failed: ENOENT: no such file" });
  });

  it("holds a partial trailing line without counting it malformed (split append)", async () => {
    const file = await makeSession("C--GitHub-my-app", "aaa");
    const w = makeWatcher();
    const ns = listen(w);
    await w.attach("aaa");
    w.start();
    const full = userLine("split across two polls");
    await fs.appendFile(file, full.slice(0, 25));
    await new Promise((r) => setTimeout(r, 100));
    expect(eventsOf(ns)).toHaveLength(0);
    await fs.appendFile(file, `${full.slice(25)}\n`);
    await waitUntil(() => eventsOf(ns).length === 1);
    expect(eventsOf(ns)[0]!.text).toBe("split across two polls");
    expect(ns.some((n) => n.kind === "session-state" && n.state === "unreadable")).toBe(false);
  });

  it("goes unreadable past the malformed-line threshold without crashing", async () => {
    const file = await makeSession("C--GitHub-my-app", "aaa");
    const w = makeWatcher();
    const ns = listen(w);
    await w.attach("aaa");
    w.start();
    await fs.appendFile(file, "{garbage\n{more garbage\n{still garbage\n{worse garbage\n{worst garbage\n");
    await waitUntil(() => ns.some((n) => n.kind === "session-state" && n.state === "unreadable"));
  });

  it("recovers from unreadable once valid lines resume flowing", async () => {
    const file = await makeSession("C--GitHub-my-app", "aaa");
    const w = makeWatcher();
    const ns = listen(w);
    await w.attach("aaa");
    w.start();
    await fs.appendFile(file, "{g1\n{g2\n{g3\n{g4\n{g5\n");
    await waitUntil(() => ns.some((n) => n.kind === "session-state" && n.state === "unreadable"));
    await fs.appendFile(file, `${userLine("healthy again")}\n`);
    await waitUntil(() => eventsOf(ns).some((e) => e.text === "healthy again"));
    await waitUntil(() => ns.some((n, i) => n.kind === "session-state" && n.state === "live" && i > ns.findIndex((m) => m.kind === "session-state" && m.state === "unreadable")));
  });

  it("decodes multi-byte UTF-8 characters split across two polls", async () => {
    const file = await makeSession("C--GitHub-my-app", "aaa");
    const w = makeWatcher();
    const ns = listen(w);
    await w.attach("aaa");
    w.start();
    const full = Buffer.from(`${userLine("emoji test 🚀 done")}\n`, "utf8");
    const splitAt = full.indexOf(Buffer.from("🚀", "utf8")) + 2; // inside the 4-byte emoji
    await fs.appendFile(file, full.subarray(0, splitAt));
    await new Promise((r) => setTimeout(r, 80));
    await fs.appendFile(file, full.subarray(splitAt));
    await waitUntil(() => eventsOf(ns).length === 1);
    expect(eventsOf(ns)[0]!.text).toBe("emoji test 🚀 done");
  });

  it("goes unreadable when the file shrinks", async () => {
    const file = await makeSession("C--GitHub-my-app", "aaa", [userLine("one"), userLine("two")]);
    const w = makeWatcher();
    const ns = listen(w);
    await w.attach("aaa");
    w.start();
    await fs.truncate(file, 10);
    await waitUntil(() => ns.some((n) => n.kind === "session-state" && n.state === "unreadable"));
  });

  it("re-syncs with a gap notice when the file is replaced (identity change)", async () => {
    const file = await makeSession("C--GitHub-my-app", "aaa", [userLine("original")]);
    const w = makeWatcher();
    const ns = listen(w);
    await w.attach("aaa");
    w.start();
    const replacement = path.join(projectsDir, "replacement.tmp");
    await fs.writeFile(replacement, `${userLine("replaced content that is long enough to exceed")}\n`, "utf8");
    // Renamed straight over the original, with no `rm` first. The delete-then-
    // rename pair left a window — a millisecond, but the tail ticks every 20ms
    // here — in which the watcher saw the session file simply MISSING rather
    // than replaced, reset its state, and then found what looked like a fresh
    // file with no identity change to report. No gap notice, and the test timed
    // out on a condition that could no longer become true. It failed about
    // three times in twenty full runs, and passed every time in isolation,
    // which is the signature of a setup racing the thing it is setting up.
    // `fs.rename` replaces an existing file atomically on Windows as well as
    // POSIX, so the intermediate state simply does not exist.
    await fs.rename(replacement, file);
    await waitUntil(() => ns.some((n) => n.kind === "gap"));
    // After re-sync, new appends narrate normally again.
    await fs.appendFile(file, `${userLine("fresh after replace")}\n`);
    await waitUntil(() => eventsOf(ns).some((e) => e.text === "fresh after replace"));
  });
});

describe("restart and switching", () => {
  it("re-attaches at EOF with a single gap notice for missed activity (R14)", async () => {
    const file = await makeSession("C--GitHub-my-app", "aaa", [userLine("before")]);
    const w1 = makeWatcher();
    await w1.attach("aaa");
    w1.stop();
    // Activity while HAL was down.
    await fs.appendFile(file, `${userLine("missed one")}\n${userLine("missed two")}\n`);

    const w2 = makeWatcher();
    const ns = listen(w2);
    await w2.attach("aaa");
    w2.start();
    expect(ns.filter((n) => n.kind === "gap")).toHaveLength(1);
    await fs.appendFile(file, `${userLine("fresh")}\n`);
    await waitUntil(() => eventsOf(ns).length >= 1);
    // Missed lines are not replayed; only fresh activity narrates.
    expect(eventsOf(ns).map((e) => e.text)).toEqual(["fresh"]);
  });

  // Switching used to stop the old tail, because one session was all that
  // could be watched. Both are followed now, so switching moves the selection
  // and nothing goes deaf — each session's events stay tagged with their own id.
  it("keeps following the previous session after switching the selection", async () => {
    const fileA = await makeSession("C--GitHub-my-app", "aaa");
    const fileB = await makeSession("C--GitHub-my-app", "bbb");
    const w = makeWatcher();
    const ns = listen(w);
    await w.attach("aaa");
    w.start();
    await w.attach("bbb");
    await fs.appendFile(fileA, `${userLine("to the old session")}\n`);
    await fs.appendFile(fileB, `${userLine("to the new session")}\n`);
    await waitUntil(() => eventsOf(ns).length >= 2);

    expect(w.watchedSessionId()).toBe("bbb");
    expect(new Set(w.followedSessionIds())).toEqual(new Set(["aaa", "bbb"]));
    const batches = ns.filter((n) => n.kind === "session-events") as Extract<WatcherNotification, { kind: "session-events" }>[];
    const bySession = new Map(batches.map((b) => [b.sessionId, b.events.map((e) => e.text)]));
    expect(bySession.get("aaa")).toEqual(["to the old session"]);
    expect(bySession.get("bbb")).toEqual(["to the new session"]);
  });

  it("follows every live session without anything being selected", async () => {
    const fileA = await makeSession("C--GitHub-my-app", "aaa");
    const fileB = await makeSession("C--GitHub-other", "bbb");
    const w = makeWatcher();
    const ns = listen(w);
    w.start();
    await waitUntil(() => w.followedSessionIds().length === 2);
    expect(w.watchedSessionId()).toBe(null);

    await fs.appendFile(fileA, `${userLine("from a")}\n`);
    await fs.appendFile(fileB, `${userLine("from b")}\n`);
    await waitUntil(() => eventsOf(ns).length >= 2);
    expect(new Set(eventsOf(ns).map((e) => e.text))).toEqual(new Set(["from a", "from b"]));
  });
});

describe("extractEvents", () => {
  it("maps entry shapes and skips non-narration types", () => {
    expect(extractEvents(JSON.parse(userLine("hi")))).toMatchObject([{ kind: "user", text: "hi" }]);
    expect(extractEvents(JSON.parse(assistantLine("ok", [{ name: "Read", input: { file_path: "C:/a/b/app.ts" } }])))).toMatchObject([
      { kind: "assistant", toolUses: ["Read(b/app.ts)"] },
    ]);
    expect(extractEvents(JSON.parse(metaLine()))).toEqual([]);
    expect(extractEvents(JSON.parse(sidechainLine()))).toEqual([]);
    expect(extractEvents({ type: "user", isMeta: true, message: { content: "caveat" } })).toEqual([]);
    expect(extractEvents({ type: "system", content: "hook ran", timestamp: "t" })).toMatchObject([{ kind: "system", text: "hook ran" }]);
  });

  it("splits a mixed assistant turn into thinking and reply events", () => {
    const entry = {
      type: "assistant",
      timestamp: "t",
      message: {
        content: [
          { type: "thinking", thinking: "weighing the options" },
          { type: "text", text: "here is the plan" },
          { type: "tool_use", name: "Edit", input: { file_path: "server/src/app.ts" } },
        ],
      },
    };
    expect(extractEvents(entry)).toMatchObject([
      { kind: "thinking", text: "weighing the options" },
      { kind: "assistant", text: "here is the plan", toolUses: ["Edit(src/app.ts)"] },
    ]);
  });

  it("ignores thinking blocks whose content the log redacted", () => {
    const entry = { type: "assistant", timestamp: "t", message: { content: [{ type: "thinking", thinking: "", signature: "abc" }] } };
    expect(extractEvents(entry)).toEqual([]);
  });

  it("reads tool_result blocks in list form and reports empty output", () => {
    const entry = JSON.parse(toolResultLine([{ type: "text", text: "" }]));
    expect(extractEvents(entry)).toMatchObject([{ kind: "tool-result", text: "(no output)" }]);
  });
});

describe("summarizeToolInput", () => {
  it("picks the most identifying argument, shortening paths", () => {
    expect(summarizeToolInput({ command: "git status", description: "check" })).toBe("git status");
    expect(summarizeToolInput({ file_path: "C:/GitHub/app/server/src/ws.ts" })).toBe("src/ws.ts");
    expect(summarizeToolInput({ pattern: "**/*.ts" })).toBe("**/*.ts");
    // Unknown tools (MCP, plugins) still get a usable label.
    expect(summarizeToolInput({ mystery_arg: "some value" })).toBe("some value");
    expect(summarizeToolInput({ count: 3 })).toBe("");
    expect(summarizeToolInput(undefined)).toBe("");
  });
});

// The original suite synthesized its own log lines, so shapes the real format
// actually carries (tool_result above all) had zero coverage and the extractor
// could starve the narrator while staying green. These replay the reference
// sample instead and assert on the informational value of the output, not just
// that events arrive. See docs/solutions/session-log-extraction-drops-tool-io.md.
describe("real-format fixture", () => {
  const replay = async (): Promise<SessionEvent[]> =>
    (await fixtureLines()).flatMap((l) => extractEvents(JSON.parse(l) as Record<string, unknown>));

  it("tails the reference sample and filters metadata and sidechain traffic", async () => {
    const file = await makeSession("C--work-demo-project", "aaa");
    const w = makeWatcher();
    const ns = listen(w);
    await w.attach("aaa");
    w.start();
    const expected = (await replay()).length;
    await fs.appendFile(file, `${(await fixtureLines()).join("\n")}\n`);
    await waitUntil(() => eventsOf(ns).length >= expected);
    const texts = eventsOf(ns).map((e) => e.text);
    expect(texts).toContain("add a health endpoint to the server");
    expect(texts.some((t) => t.includes("subagent chatter"))).toBe(false);
    expect(texts.some((t) => t.includes("turn_summary"))).toBe(false);
  });

  it("carries a target on every tool use, including unknown MCP tools", async () => {
    const toolUses = (await replay()).flatMap((e) => e.toolUses);
    expect(toolUses.length).toBeGreaterThan(0);
    // A bare tool name is the exact defect this fixture exists to catch.
    expect(toolUses.filter((t) => !/\(.+\)$/.test(t))).toEqual([]);
    expect(toolUses).toContain("Bash(npm test)");
    expect(toolUses).toContain("mcp__demo__lookup(health-check)");
  });

  it("surfaces tool outcomes, failures, and empty results", async () => {
    const results = (await replay()).filter((e) => e.kind === "tool-result");
    expect(results.length).toBeGreaterThanOrEqual(4);
    expect(results.some((e) => e.text.startsWith("failed: "))).toBe(true);
    expect(results.some((e) => e.text === "(no output)")).toBe(true);
    // List-form tool_result content must read the same as string form.
    expect(results.some((e) => e.text.includes("server/src/http.ts"))).toBe(true);
  });

  it("keeps system entries that carry content and drops metadata-only ones", async () => {
    const system = (await replay()).filter((e) => e.kind === "system");
    expect(system).toHaveLength(1);
    expect(system[0]!.text).toContain("Reloaded: 1 plugin");
  });

  it("renders mostly informative lines — the health metric that was missing", async () => {
    // Wrapped rather than passed bare: `eventLine` takes phrases as a second
    // argument, and `map` would hand it the index.
    const lines = (await replay()).map((e) => eventLine(e));
    // "[assistant]" with no text and no tools was the shape that dominated the
    // feed before the fix; a high rate here means the extractor is starving.
    const contentFree = lines.filter((l) => /^\[\w[\w-]*\]\s*$/.test(l));
    expect(contentFree).toEqual([]);
    expect(lines.length).toBeGreaterThan(10);
  });
});

describe("decodeSlug", () => {
  it("produces a readable last-segment label", () => {
    expect(decodeSlug("C--GitHub-hal1000-harness")).toBe("harness");
    expect(decodeSlug("plain")).toBe("plain");
  });
});
