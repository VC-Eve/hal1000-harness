import { describe, it, expect } from "vitest";
import { initialState, reducer, type AppState } from "../src/store";
import type { Conversation, NarrationEntry, ServerMessage } from "../../shared/src/types";

const server = (state: AppState, msg: ServerMessage) => reducer(state, { type: "server", msg });

const convo = (id: string, model = "m1"): Conversation => ({
  id,
  title: "t",
  model,
  createdAt: "c",
  updatedAt: "u",
  messages: [],
});

const entry = (id: string): NarrationEntry => ({ id, at: "2026-08-02T10:00:00Z", kind: "narration", text: `text-${id}` });

describe("store reducer", () => {
  it("accumulates streamed tokens for the active conversation and finalizes on done", () => {
    let s = server(initialState, { type: "conversation", conversation: convo("a") });
    s = server(s, { type: "chat-token", conversationId: "a", token: "I am " });
    s = server(s, { type: "chat-token", conversationId: "a", token: "HAL." });
    expect(s.streaming).toBe("I am HAL.");
    s = server(s, { type: "chat-done", conversationId: "a", message: { role: "assistant", content: "I am HAL.", at: "t" } });
    expect(s.streaming).toBeNull();
    expect(s.active!.messages).toHaveLength(1);
  });

  it("ignores tokens for a non-active conversation", () => {
    let s = server(initialState, { type: "conversation", conversation: convo("a") });
    s = server(s, { type: "chat-token", conversationId: "other", token: "x" });
    expect(s.streaming).toBeNull();
  });

  it("does not replace the active conversation while another is mid-stream", () => {
    let s = server(initialState, { type: "conversation", conversation: convo("a") });
    s = server(s, { type: "chat-token", conversationId: "a", token: "streaming" });
    s = server(s, { type: "conversation", conversation: convo("b") });
    expect(s.active!.id).toBe("a");
  });

  it("preserves per-conversation drafts across switches", () => {
    let s = server(initialState, { type: "conversation", conversation: convo("a") });
    s = reducer(s, { type: "draft", conversationId: "a", value: "half-typed thought" });
    s = server(s, { type: "conversation", conversation: convo("b") });
    s = server(s, { type: "conversation", conversation: convo("a") });
    expect(s.drafts.a).toBe("half-typed thought");
  });

  it("clears streaming and records the error on chat-error", () => {
    let s = server(initialState, { type: "conversation", conversation: convo("a") });
    s = server(s, { type: "chat-token", conversationId: "a", token: "par" });
    s = server(s, { type: "chat-error", conversationId: "a", code: "provider_unavailable", message: "down" });
    expect(s.streaming).toBeNull();
    expect(s.chatError!.code).toBe("provider_unavailable");
  });

  it("clears a phantom stream when the connection reopens", () => {
    let s = server(initialState, { type: "conversation", conversation: convo("a") });
    s = server(s, { type: "chat-token", conversationId: "a", token: "stranded" });
    s = reducer(s, { type: "conn", value: "lost" });
    s = reducer(s, { type: "conn", value: "open" });
    expect(s.streaming).toBeNull();
  });

  it("distinguishes empty model list from provider-down", () => {
    const empty = server(initialState, { type: "models", models: [] });
    expect(empty.modelsError).toBe(false);
    const down = server(initialState, { type: "models", models: [], error: "provider_unavailable" });
    expect(down.modelsError).toBe(true);
  });

  it("replays the narration backlog on reconnect without losing feed shape", () => {
    let s = server(initialState, { type: "narration-entry", entry: entry("1") });
    s = server(s, {
      type: "narration-backlog",
      entries: [entry("1"), entry("2")],
      watchedSessionId: "sess",
      status: "narrating",
      sessionState: "idle",
    });
    expect(s.narration.map((e) => e.id)).toEqual(["1", "2"]);
    expect(s.watchedSessionId).toBe("sess");
    expect(s.narrationStatus).toBe("narrating");
    expect(s.sessionState).toBe("idle");
  });

  it("tracks session status only for the watched session", () => {
    let s = server(initialState, { type: "watch-started", sessionId: "sess" });
    s = server(s, { type: "session-status", sessionId: "other", state: "ended" });
    expect(s.sessionState).toBeNull();
    s = server(s, { type: "session-status", sessionId: "sess", state: "idle" });
    expect(s.sessionState).toBe("idle");
  });

  it("clears watch state on watch-stopped and surfaces new-session offers", () => {
    let s = server(initialState, { type: "watch-started", sessionId: "sess" });
    s = server(s, {
      type: "new-session-available",
      session: { id: "n", projectSlug: "p", projectName: "proj", state: "live", lastActivity: "t" },
    });
    expect(s.newSession!.id).toBe("n");
    s = server(s, { type: "watch-stopped" });
    expect(s.watchedSessionId).toBeNull();
    expect(s.sessionState).toBeNull();
  });

  it("stores readiness and settings, mirroring watchedSessionId", () => {
    let s = server(initialState, { type: "readiness", readiness: { ollama: "ok", models: "none", claudeLogs: "missing" } });
    expect(s.readiness!.models).toBe("none");
    s = server(s, {
      type: "settings",
      settings: {
        providerEndpoint: "http://localhost:11434",
        chatModel: "m",
        narrationModel: null,
        personaIntensity: "high",
        watchedSessionId: "w1",
      },
    });
    expect(s.watchedSessionId).toBe("w1");
    expect(s.settings!.personaIntensity).toBe("high");
  });
});
