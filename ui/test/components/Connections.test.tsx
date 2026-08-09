import { describe, it, expect } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { SettingsPanel } from "../../src/components/SettingsPanel";
import { harness, mount, testSettings, testState } from "./harness";

// The connections area: every endpoint HAL talks to, in one place, named by
// what it does.
//
// The slots are grouped by location and not flattened into a uniform list,
// because they are not interchangeable — a chat model cannot describe a frame,
// and the recogniser is not a model server at all. So these tests assert that
// each keeps its own fields and sends its own shape, rather than that they look
// alike.

function open(over: Parameters<typeof testState>[0] = {}) {
  const h = harness();
  const utils = mount(<SettingsPanel state={testState(over)} send={h.send} onClose={() => {}} />);
  return { h, ...utils };
}

/** Backend settings live inside `settings`, not at the top of AppState. */
const withBackends = (
  shared: Partial<{ endpoint: string; protocol: "auto" | "ollama" | "openai"; hasKey: boolean }>,
  chat: Partial<{ enabled: boolean; endpoint: string; protocol: "auto" | "ollama" | "openai"; hasKey: boolean }> = {},
) => ({
  settings: testSettings({
    backends: {
      shared: { endpoint: "http://localhost:11434", protocol: "auto", hasKey: false, ...shared },
      chat: { enabled: false, endpoint: "", protocol: "auto", hasKey: false, ...chat },
    },
  }),
});

const chatOn = withBackends({}, { enabled: true, endpoint: "https://api.example.com", protocol: "openai" });

describe("the connections area", () => {
  it("applies the shared endpoint, relists models, and rechecks readiness", () => {
    const { h } = open();

    const input = screen
      .getAllByRole("textbox")
      .find((i) => (i as HTMLInputElement).value === "http://localhost:11434")!;
    fireEvent.change(input, { target: { value: "http://127.0.0.1:8080" } });
    fireEvent.click(screen.getAllByRole("button", { name: "apply" })[0]!);

    expect(h.sent).toContainEqual({
      type: "update-settings",
      patch: { backends: { shared: { endpoint: "http://127.0.0.1:8080" } } },
    });
    expect(h.sent).toContainEqual({ type: "list-models" });
    expect(h.sent).toContainEqual({ type: "check-readiness" });
  });

  it("does not send on every keystroke", () => {
    // The slower form of the unstable-send loop AGENTS.md warns about: one
    // settings write per character typed.
    const { h } = open();
    const input = screen
      .getAllByRole("textbox")
      .find((i) => (i as HTMLInputElement).value === "http://localhost:11434")!;

    fireEvent.change(input, { target: { value: "http://127.0.0.1:80" } });
    fireEvent.change(input, { target: { value: "http://127.0.0.1:808" } });
    fireEvent.change(input, { target: { value: "http://127.0.0.1:8080" } });

    expect(h.sent.filter((m) => m.type === "update-settings")).toHaveLength(0);
  });

  it("sets the protocol override without touching the endpoint", () => {
    const { h } = open();
    const select = screen.getByDisplayValue("detect from the endpoint");
    fireEvent.change(select, { target: { value: "openai" } });

    expect(h.sent).toContainEqual({
      type: "update-settings",
      patch: { backends: { shared: { protocol: "openai" } } },
    });
  });

  it("keeps the chat backend's fields hidden until it is switched on", () => {
    open();
    expect(screen.queryByDisplayValue("https://api.example.com")).not.toBeInTheDocument();
  });

  it("shows the chat backend's own fields once on", () => {
    open(chatOn);
    expect(screen.getByDisplayValue("https://api.example.com")).toBeInTheDocument();
  });

  it("patches only the chat slot when the chat endpoint changes", () => {
    const { h } = open(chatOn);
    const input = screen.getByDisplayValue("https://api.example.com");
    fireEvent.change(input, { target: { value: "https://openrouter.ai/api" } });
    fireEvent.click(screen.getAllByRole("button", { name: "apply" })[1]!);

    expect(h.sent).toContainEqual({
      type: "update-settings",
      patch: { backends: { chat: { endpoint: "https://openrouter.ai/api" } } },
    });
  });

  it("turns the chat backend off without restating its configuration", () => {
    const { h } = open(chatOn);
    fireEvent.click(screen.getAllByRole("button", { name: "off" })[0]!);

    expect(h.sent).toContainEqual({
      type: "update-settings",
      patch: { backends: { chat: { enabled: false } } },
    });
  });
});

describe("keys in the connections area", () => {
  it("never renders a stored key, only that one is held", () => {
    // The server does not send the key, so there is nothing to render. What the
    // control can honestly offer is replace or clear.
    open(withBackends({ hasKey: true }));

    const key = screen.getByPlaceholderText("a key is set") as HTMLInputElement;
    expect(key.value).toBe("");
    expect(key.type).toBe("password");
  });

  it("says none when no key is held", () => {
    open();
    expect(screen.getByPlaceholderText("none")).toBeInTheDocument();
  });

  it("sends a typed key and clears the field afterwards", () => {
    const { h } = open();
    const key = screen.getByPlaceholderText("none") as HTMLInputElement;
    fireEvent.change(key, { target: { value: "sk-typed-here" } });
    fireEvent.click(screen.getAllByRole("button", { name: "set" })[0]!);

    expect(h.sent).toContainEqual({
      type: "update-settings",
      patch: { backends: { shared: { apiKey: "sk-typed-here" } } },
    });
    expect(key.value).toBe("");
  });

  it("clears a held key with null rather than an empty patch", () => {
    const { h } = open(withBackends({ hasKey: true }));
    fireEvent.click(screen.getAllByRole("button", { name: "clear" })[0]!);

    expect(h.sent).toContainEqual({
      type: "update-settings",
      patch: { backends: { shared: { apiKey: null } } },
    });
  });

  it("offers nothing to clear when no key is held", () => {
    open();
    expect(screen.getAllByRole("button", { name: "clear" })[0]).toBeDisabled();
  });
});

describe("readiness rows", () => {
  const withReadiness = (over: Record<string, unknown>) =>
    testState({
      readiness: {
        sharedBackend: "ok",
        chatBackend: "disabled",
        models: "ok",
        claudeLogs: "ok",
        captioner: "disabled",
        recogniser: "disabled",
        ...over,
      },
    } as Parameters<typeof testState>[0]);

  it("reports the two backends separately", () => {
    const h = harness();
    mount(
      <SettingsPanel
        state={withReadiness({ chatBackend: "unreachable" })}
        send={h.send}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "readiness" }));

    expect(screen.getByText(/shared backend: ok/)).toBeInTheDocument();
    expect(screen.getByText(/chat backend: unreachable/)).toBeInTheDocument();
  });

  it("shows a disabled chat leg as a choice rather than a fault", () => {
    const h = harness();
    mount(<SettingsPanel state={withReadiness({})} send={h.send} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "readiness" }));

    const row = screen.getByText(/chat backend: disabled/).closest("li")!;
    expect(row.className).toBe("neutral");
  });
});
