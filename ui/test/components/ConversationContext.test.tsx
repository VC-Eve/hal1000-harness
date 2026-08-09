import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { testSettings } from "./harness";
import { ConversationContext } from "../../src/components/ConversationContext";
import type { ClientMessage, Conversation, Settings } from "../../../shared/src/types";

// U7 — the control.
//
// Narrow on purpose: what gets sent, what is disabled, and the two states a
// reader would otherwise discover from HAL's reply rather than from the pane.
// Appearance is a screenshot's job.

const convo = (over: Partial<Conversation> = {}): Conversation => ({
  id: "c1",
  title: "t",
  model: "m",
  systemPrompt: "",
  createdAt: "2026-08-08T12:00:00.000Z",
  updatedAt: "2026-08-08T12:00:00.000Z",
  messages: [],
  ...over,
});

function setup(over: {
  conversation?: Conversation;
  settings?: Settings;
  modelTokens?: number;
  watchedSessionId?: string | null;
  disabled?: boolean;
} = {}) {
  const sent: ClientMessage[] = [];
  const send = vi.fn((m: ClientMessage) => sent.push(m));
  render(
    <ConversationContext
      conversation={over.conversation ?? convo()}
      settings={over.settings ?? testSettings()}
      modelTokens={"modelTokens" in over ? over.modelTokens : 8192}
      watchedSessionId={over.watchedSessionId ?? null}
      send={send}
      disabled={over.disabled ?? false}
    />,
  );
  return { sent, send };
}

const open = () => fireEvent.click(screen.getByRole("button"));

describe("ConversationContext", () => {
  it("summarises as none when both switches are off", () => {
    setup();
    expect(screen.getByRole("button").textContent).toContain("none");
  });

  it("labels each level with the characters it buys on this model", () => {
    setup({ modelTokens: 8192 });
    open();
    // 8192 tokens * 4 chars * 25% = 8,192. Both sources offer the same ladder.
    expect(screen.getAllByText(/large — 8,192 chars/)).toHaveLength(2);
  });

  it("relabels the same level for a smaller model", () => {
    // The reason a level is a share: one label cannot mean the same thing on a
    // 2k model and a 32k one.
    setup({ modelTokens: 2048 });
    open();
    expect(screen.getAllByText(/large — 2,048 chars/)).toHaveLength(2);
  });

  it("falls back to the conservative window when the model's is unknown", () => {
    // Unknown must not read as generous. 4,096 tokens is the shared fallback,
    // the same one the server uses, so the label matches the request.
    setup({ modelTokens: undefined });
    open();
    expect(screen.getAllByText(/large — 4,096 chars/)).toHaveLength(2);
  });

  it("sends one message when a level is picked", () => {
    const { sent, send } = setup();
    open();
    fireEvent.change(screen.getAllByRole("combobox")[0]!, { target: { value: "medium" } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(sent[0]).toEqual({
      type: "set-conversation-context",
      conversationId: "c1",
      context: { vision: "medium" },
    });
  });

  it("moves one source without restating the other", () => {
    const { sent } = setup({ conversation: convo({ context: { vision: "large", session: "off" } }) });
    open();
    fireEvent.change(screen.getAllByRole("combobox")[1]!, { target: { value: "small" } });
    expect(sent[0]).toEqual({
      type: "set-conversation-context",
      conversationId: "c1",
      context: { session: "small" },
    });
  });

  it("disables both pickers while the connection is down", () => {
    setup({ disabled: true });
    open();
    for (const select of screen.getAllByRole("combobox")) expect(select).toBeDisabled();
  });

  it("says the session source will send nothing when no session is watched", () => {
    // Two controls, one invisible dependency. Without this the user learns it
    // from a reply that knows nothing about their session.
    setup({
      conversation: convo({ context: { vision: "off", session: "large" } }),
      watchedSessionId: null,
    });
    open();
    expect(screen.getByText(/no session is being watched/)).toBeInTheDocument();
  });

  it("stops saying so once a session is watched", () => {
    setup({
      conversation: convo({ context: { vision: "off", session: "large" } }),
      watchedSessionId: "sess-a",
    });
    open();
    expect(screen.queryByText(/no session is being watched/)).not.toBeInTheDocument();
  });

  it("excludes an unwatched session source from the total", () => {
    setup({
      conversation: convo({ context: { vision: "off", session: "large" } }),
      watchedSessionId: null,
    });
    expect(screen.getByRole("button").textContent).toContain("~0 chars");
  });

  it("counts both sources when both are on", () => {
    setup({
      conversation: convo({ context: { vision: "small", session: "small" } }),
      watchedSessionId: "sess-a",
      modelTokens: 8192,
    });
    // 5% of 32,768 chars, twice.
    expect(screen.getByRole("button").textContent).toContain("~3,276 chars");
  });

  describe("a provider that is not on this machine", () => {
    const remote = () => testSettings({ backends: { chat: { endpoint: "http://192.168.1.50:11434", protocol: "auto", hasKey: false }, observation: { endpoint: "http://localhost:11434", protocol: "auto", hasKey: false } } });

    it("says nothing will be sent, and names what would leave", () => {
      setup({
        conversation: convo({ context: { vision: "large", session: "off" } }),
        settings: remote(),
      });
      open();
      expect(screen.getByText(/nothing will be sent/)).toBeInTheDocument();
      expect(screen.getByText(/character profiles/)).toBeInTheDocument();
    });

    it("summarises as withheld rather than as a character count", () => {
      setup({
        conversation: convo({ context: { vision: "large", session: "off" } }),
        settings: remote(),
      });
      expect(screen.getByRole("button").textContent).toContain("withheld");
    });

    it("acknowledges as part of turning a source on", () => {
      const { sent } = setup({ settings: remote() });
      open();
      fireEvent.change(screen.getAllByRole("combobox")[0]!, { target: { value: "large" } });
      expect(sent[0]).toEqual({ type: "acknowledge-off-machine", accepted: true });
      expect(sent[1]!.type).toBe("set-conversation-context");
    });

    it("does not acknowledge when turning a source off", () => {
      const { sent } = setup({
        conversation: convo({ context: { vision: "large", session: "off" } }),
        settings: remote(),
      });
      open();
      fireEvent.change(screen.getAllByRole("combobox")[0]!, { target: { value: "off" } });
      expect(sent.some((m) => m.type === "acknowledge-off-machine")).toBe(false);
    });

    it("counts normally once acknowledged", () => {
      setup({
        conversation: convo({ context: { vision: "large", session: "off" } }),
        settings: testSettings({
          backends: {
            chat: { endpoint: "http://192.168.1.50:11434", protocol: "auto", hasKey: false },
            observation: { endpoint: "http://localhost:11434", protocol: "auto", hasKey: false },
          },
          offMachineAcknowledged: true,
        }),
      });
      expect(screen.getByRole("button").textContent).toContain("~8,192 chars");
    });

    it("treats an unparseable endpoint as remote, matching the server", () => {
      setup({
        conversation: convo({ context: { vision: "large", session: "off" } }),
        settings: testSettings({ backends: { chat: { endpoint: "not a url", protocol: "auto", hasKey: false }, observation: { endpoint: "http://localhost:11434", protocol: "auto", hasKey: false } } }),
      });
      expect(screen.getByRole("button").textContent).toContain("withheld");
    });
  });
});
