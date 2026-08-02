import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { ClaudeCodeWatcher, decodeSlug, extractEvent } from "../../src/watchers/claude-code.js";
import type { WatcherNotification } from "../../src/watchers/watcher.js";

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
const assistantLine = (text: string, tools: string[] = []) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-02T10:00:01Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text },
        ...tools.map((name) => ({ type: "tool_use", name, input: {} })),
      ],
    },
  });
const metaLine = () => JSON.stringify({ type: "file-history-snapshot", messageId: "x", snapshot: {} });
const sidechainLine = () => JSON.stringify({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent chatter" }] } });

function listen(w: ClaudeCodeWatcher): WatcherNotification[] {
  const notifications: WatcherNotification[] = [];
  w.subscribe((n) => notifications.push(n));
  return notifications;
}

async function waitUntil(fn: () => boolean, timeoutMs = 3000): Promise<void> {
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
    await fs.appendFile(file, `${userLine("open the doors")}\n${metaLine()}\n${sidechainLine()}\n${assistantLine("I hear you", ["Bash"])}\n`);
    await waitUntil(() => eventsOf(ns).length >= 2);
    const events = eventsOf(ns);
    expect(events).toHaveLength(2);
    expect(events[0]!.kind).toBe("user");
    expect(events[0]!.text).toBe("open the doors");
    expect(events[1]!.kind).toBe("assistant");
    expect(events[1]!.toolUses).toEqual(["Bash"]);
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
    await fs.rm(file);
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

  it("stops the old tail cleanly when switching sessions (R18)", async () => {
    const fileA = await makeSession("C--GitHub-my-app", "aaa");
    const fileB = await makeSession("C--GitHub-my-app", "bbb");
    const w = makeWatcher();
    const ns = listen(w);
    await w.attach("aaa");
    w.start();
    await w.attach("bbb");
    await fs.appendFile(fileA, `${userLine("to the old session")}\n`);
    await fs.appendFile(fileB, `${userLine("to the new session")}\n`);
    await waitUntil(() => eventsOf(ns).length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    const events = eventsOf(ns);
    expect(events.map((e) => e.text)).toEqual(["to the new session"]);
    expect(ns.filter((n) => n.kind === "session-events").every((n) => n.sessionId === "bbb")).toBe(true);
  });
});

describe("extractEvent", () => {
  it("maps entry shapes and skips non-narration types", () => {
    expect(extractEvent(JSON.parse(userLine("hi")))).toMatchObject({ kind: "user", text: "hi" });
    expect(extractEvent(JSON.parse(assistantLine("ok", ["Read"])))).toMatchObject({ kind: "assistant", toolUses: ["Read"] });
    expect(extractEvent(JSON.parse(metaLine()))).toBeNull();
    expect(extractEvent(JSON.parse(sidechainLine()))).toBeNull();
    expect(extractEvent({ type: "user", isMeta: true, message: { content: "caveat" } })).toBeNull();
    expect(extractEvent({ type: "system", content: "hook ran", timestamp: "t" })).toMatchObject({ kind: "system", text: "hook ran" });
  });
});

describe("decodeSlug", () => {
  it("produces a readable last-segment label", () => {
    expect(decodeSlug("C--GitHub-hal1000-harness")).toBe("harness");
    expect(decodeSlug("plain")).toBe("plain");
  });
});
