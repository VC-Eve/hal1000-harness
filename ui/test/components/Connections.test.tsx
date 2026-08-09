import { describe, it, expect } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { SettingsPanel } from "../../src/components/SettingsPanel";
import { harness, mount, testSettings, testState } from "./harness";

// The connections area: two model backends, both named for what sends there,
// both visible at once.
//
// An earlier shape called one of them "shared" and made the other an override
// switched off by default. That hid the fact that matters — there are two
// destinations — behind a relationship that only held while one was off. These
// tests are written per card for the same reason: each is queried through its
// own container, because "which endpoint did that change" is the question the
// old layout made hard to answer.

function open(over: Parameters<typeof testState>[0] = {}) {
  const h = harness();
  const utils = mount(<SettingsPanel state={testState(over)} send={h.send} onClose={() => {}} />);
  return { h, ...utils };
}

const DEFAULT = "http://localhost:11434";

type SlotOver = Partial<{ endpoint: string; protocol: "auto" | "ollama" | "openai"; hasKey: boolean }>;

/** Backend settings live inside `settings`, not at the top of AppState. */
const withBackends = (chat: SlotOver = {}, observation: SlotOver = {}) => ({
  settings: testSettings({
    backends: {
      chat: { endpoint: DEFAULT, protocol: "auto", hasKey: false, ...chat },
      observation: { endpoint: DEFAULT, protocol: "auto", hasKey: false, ...observation },
    },
  }),
});

const card = (name: "chat" | "observation") => within(screen.getByTestId(`backend-${name}`));

describe("both backends are visible", () => {
  it("shows a card for each without anything being switched on", () => {
    open();
    expect(screen.getByTestId("backend-chat")).toBeInTheDocument();
    expect(screen.getByTestId("backend-observation")).toBeInTheDocument();
  });

  it("starts both on the same server, which is the ordinary setup", () => {
    open();
    expect((card("chat").getByRole("textbox") as HTMLInputElement).value).toBe(DEFAULT);
    expect((card("observation").getByRole("textbox") as HTMLInputElement).value).toBe(DEFAULT);
  });

  it("names each by what sends there rather than by how they relate", () => {
    open();
    expect(card("observation").getByText(/narration, log monitors and vision/)).toBeInTheDocument();
    expect(card("chat").getByText(/where a conversation's replies come from/)).toBeInTheDocument();
  });
});

describe("changing one backend", () => {
  it("patches only that slot, and relists models and readiness", () => {
    const { h } = open();
    fireEvent.change(card("chat").getByRole("textbox"), { target: { value: "https://api.example.com" } });
    fireEvent.click(card("chat").getByRole("button", { name: "apply" }));

    expect(h.sent).toContainEqual({
      type: "update-settings",
      patch: { backends: { chat: { endpoint: "https://api.example.com" } } },
    });
    expect(h.sent).toContainEqual({ type: "list-models" });
    expect(h.sent).toContainEqual({ type: "check-readiness" });
  });

  it("leaves the other slot alone", () => {
    const { h } = open();
    fireEvent.change(card("observation").getByRole("textbox"), { target: { value: "http://127.0.0.1:8080" } });
    fireEvent.click(card("observation").getByRole("button", { name: "apply" }));

    const patches = h.sent.filter((m) => m.type === "update-settings");
    expect(patches).toHaveLength(1);
    expect(JSON.stringify(patches[0])).not.toContain("chat");
  });

  it("does not send on every keystroke", () => {
    // The slower form of the unstable-send loop AGENTS.md warns about: one
    // settings write per character typed.
    const { h } = open();
    const input = card("chat").getByRole("textbox");
    fireEvent.change(input, { target: { value: "http://127.0.0.1:80" } });
    fireEvent.change(input, { target: { value: "http://127.0.0.1:808" } });
    fireEvent.change(input, { target: { value: "http://127.0.0.1:8080" } });

    expect(h.sent.filter((m) => m.type === "update-settings")).toHaveLength(0);
  });

  it("sets a protocol override on the slot it belongs to", () => {
    const { h } = open();
    fireEvent.change(card("observation").getAllByRole("combobox")[0]!, { target: { value: "openai" } });

    expect(h.sent).toContainEqual({
      type: "update-settings",
      patch: { backends: { observation: { protocol: "openai" } } },
    });
  });
});

describe("copying one backend to the other", () => {
  it("offers to take the other slot's settings, naming which", () => {
    open(withBackends({ endpoint: "https://api.example.com" }));
    expect(card("chat").getByRole("button", { name: /use the same as observation/ })).toBeInTheDocument();
    expect(card("observation").getByRole("button", { name: /use the same as chat/ })).toBeInTheDocument();
  });

  it("asks the server to copy, rather than copying what the client can see", () => {
    // The key is why. A client is never told a credential, so a copy it
    // performed itself would silently drop the one part that is tedious to
    // retype.
    const { h } = open(withBackends({ endpoint: "https://api.example.com" }));
    fireEvent.click(card("chat").getByRole("button", { name: /use the same as observation/ }));

    expect(h.sent).toContainEqual({
      type: "update-settings",
      patch: { backends: { chat: { copyFrom: "observation" } } },
    });
  });

  it("has nothing to offer when the two already match", () => {
    open();
    expect(card("chat").getByRole("button", { name: /use the same as observation/ })).toBeDisabled();
    expect(card("chat").getByText(/already the same as observation/)).toBeInTheDocument();
  });

  it("counts a trailing slash as already the same", () => {
    open(withBackends({ endpoint: `${DEFAULT}/` }));
    expect(card("chat").getByRole("button", { name: /use the same as observation/ })).toBeDisabled();
  });
});

describe("keys", () => {
  it("never renders a stored key, only that one is held", () => {
    // The server does not send the key, so there is nothing to render. What the
    // control can honestly offer is replace or clear.
    open(withBackends({ hasKey: true }));
    const key = card("chat").getByPlaceholderText("a key is set") as HTMLInputElement;
    expect(key.value).toBe("");
    expect(key.type).toBe("password");
  });

  it("says none when no key is held", () => {
    open();
    expect(card("chat").getByPlaceholderText("none")).toBeInTheDocument();
  });

  it("sends a typed key on the right slot and clears the field", () => {
    const { h } = open();
    const key = card("observation").getByPlaceholderText("none") as HTMLInputElement;
    fireEvent.change(key, { target: { value: "sk-typed-here" } });
    fireEvent.click(card("observation").getByRole("button", { name: "set" }));

    expect(h.sent).toContainEqual({
      type: "update-settings",
      patch: { backends: { observation: { apiKey: "sk-typed-here" } } },
    });
    expect(key.value).toBe("");
  });

  it("clears a held key with null rather than an empty patch", () => {
    const { h } = open(withBackends({ hasKey: true }));
    fireEvent.click(card("chat").getByRole("button", { name: "clear" }));

    expect(h.sent).toContainEqual({
      type: "update-settings",
      patch: { backends: { chat: { apiKey: null } } },
    });
  });

  it("offers nothing to clear when no key is held", () => {
    open();
    expect(card("chat").getByRole("button", { name: "clear" })).toBeDisabled();
  });
});

describe("a backend with a great many models", () => {
  it("lists them all rather than truncating or stalling", () => {
    // A hosted aggregator reports hundreds. The pickers are native selects, so
    // the requirement is that nothing caps or chokes on the list — asserted
    // because "it is only a select" is exactly the assumption worth pinning.
    const many = Array.from({ length: 400 }, (_, i) => `vendor/model-${i}`);
    const h = harness();
    mount(<SettingsPanel state={testState({ models: many })} send={h.send} onClose={() => {}} />);

    const chatModel = screen
      .getAllByRole("combobox")
      .find((s) => s.querySelector('option[value=""]')?.textContent === "(none selected)")!;
    expect(chatModel.querySelectorAll("option")).toHaveLength(401);
  });
});

describe("readiness rows", () => {
  const withReadiness = (over: Record<string, unknown>) =>
    testState({
      readiness: {
        observationBackend: "ok",
        chatBackend: "ok",
        models: "ok",
        claudeLogs: "ok",
        captioner: "disabled",
        recogniser: "disabled",
        ...over,
      },
    } as Parameters<typeof testState>[0]);

  it("reports the two backends separately", () => {
    const h = harness();
    mount(<SettingsPanel state={withReadiness({ chatBackend: "unreachable" })} send={h.send} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "readiness" }));

    expect(screen.getByText(/chat backend: unreachable/)).toBeInTheDocument();
    expect(screen.getByText(/observation backend: ok/)).toBeInTheDocument();
  });
});
