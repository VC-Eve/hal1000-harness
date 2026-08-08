import { describe, it, expect } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { SettingsPanel } from "../../src/components/SettingsPanel";
import { harness, mount, testState } from "./harness";

function open(over: Parameters<typeof testState>[0] = {}) {
  const h = harness();
  const utils = mount(<SettingsPanel state={testState(over)} send={h.send} onClose={() => {}} />);
  return { h, ...utils };
}

const category = (name: string) => screen.getByRole("button", { name });

describe("SettingsPanel — one category at a time", () => {
  it("lists every category in the rail", () => {
    open();
    for (const name of ["provider", "sessions", "log monitors", "vision", "chat", "interface", "readiness"]) {
      expect(category(name)).toBeInTheDocument();
    }
  });

  // A new install cannot do anything until the provider is reachable, so that
  // is where the panel opens rather than on whatever happens to be first.
  it("opens on the provider category", () => {
    open();
    expect(category("provider")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("group-vision")).not.toBeVisible();
  });

  it("shows only the category you pick", () => {
    open();
    fireEvent.click(category("vision"));

    expect(screen.getByTestId("group-vision")).toBeVisible();
    expect(screen.getByTestId("group-sessions")).not.toBeVisible();
    expect(screen.getByTestId("group-monitors")).not.toBeVisible();
    expect(screen.getByTestId("group-readiness")).not.toBeVisible();
  });

  it("marks the selected category in the rail", () => {
    open();
    fireEvent.click(category("chat"));

    expect(category("chat")).toHaveAttribute("aria-current", "page");
    expect(category("provider")).not.toHaveAttribute("aria-current");
  });

  /**
   * The reason the sections are hidden rather than conditionally rendered.
   *
   * `MonitorsPanel` asks the server for monitors and suggestions from a mount
   * effect. Rendering only the active category would unmount it on every switch
   * away and re-run that effect on every switch back, turning navigation into a
   * request generator — the shape `MonitorsPanel.test.tsx` exists to prevent.
   * Hiding keeps it mounted, so the count stays at one however much the user
   * moves around.
   */
  it("does not re-request monitors when moving between categories", () => {
    const { h } = open();
    expect(h.countOf("list-monitors")).toBe(1);
    expect(h.countOf("list-monitor-suggestions")).toBe(1);

    for (const name of ["log monitors", "vision", "chat", "log monitors", "provider", "log monitors"]) {
      fireEvent.click(category(name));
    }

    expect(h.countOf("list-monitors")).toBe(1);
    expect(h.countOf("list-monitor-suggestions")).toBe(1);
  });

  // Readiness reports what HAL can reach; it changes nothing. It was under
  // `interface` only because that was the last section in the old column.
  it("gives readiness its own category rather than burying it in interface", () => {
    open();
    fireEvent.click(category("interface"));
    expect(screen.getByTestId("group-readiness")).not.toBeVisible();

    fireEvent.click(category("readiness"));
    expect(screen.getByTestId("group-readiness")).toBeVisible();
    expect(screen.getByText("no probe yet")).toBeInTheDocument();
  });

  // Drafts are component state, so navigating away and back must not silently
  // discard something the user typed but has not applied yet.
  it("keeps an unapplied prompt draft across a category switch", () => {
    open();
    fireEvent.click(category("chat"));
    // Scoped to the chat group: several prompt fields are legitimately empty,
    // so a document-wide value query is ambiguous.
    const draft = document.querySelector('[data-testid="group-chat"] textarea')!;
    fireEvent.change(draft, { target: { value: "a prompt I have not applied yet" } });

    fireEvent.click(category("vision"));
    fireEvent.click(category("chat"));

    expect(draft).toHaveValue("a prompt I have not applied yet");
  });
});

// ---------------------------------------------------------------------------
// Recognition settings and the roster
// ---------------------------------------------------------------------------

const person = (over: Partial<{ id: string; name: string; createdAt: string; faceCount: number; thumbnail: string }> = {}) => ({
  id: "p1",
  name: "Dave",
  createdAt: "2026-08-07T12:00:00.000Z",
  faceCount: 1,
  thumbnail: "data:image/jpeg;base64,AAAA",
  ...over,
});

describe("SettingsPanel — recognition", () => {
  it("toggles recognition independently of Vision", () => {
    // The preference is stored on its own, so switching Vision off and on again
    // does not silently lose it.
    const { h } = open();
    fireEvent.click(category("vision"));
    fireEvent.click(screen.getAllByRole("button", { name: "on" })[1]!);

    expect(h.sent).toContainEqual({
      type: "update-settings",
      patch: { vision: { recognitionEnabled: true } },
    });
  });

  it("applies the recogniser endpoint and rechecks readiness", () => {
    const { h } = open();
    fireEvent.click(category("vision"));

    const inputs = screen.getAllByRole("textbox");
    const endpoint = inputs.find((i) => (i as HTMLInputElement).value === "http://127.0.0.1:8100")!;
    fireEvent.change(endpoint, { target: { value: "http://gpu-box:8100" } });
    fireEvent.click(screen.getAllByRole("button", { name: "apply" })[1]!);

    expect(h.sent).toContainEqual({
      type: "update-settings",
      patch: { vision: { recogniserEndpoint: "http://gpu-box:8100" } },
    });
    expect(h.sent).toContainEqual({ type: "check-readiness" });
  });

  it("does not send the endpoint on every keystroke", () => {
    // The unstable-send loop AGENTS.md warns about, in its slower form: one
    // settings write per character typed.
    const { h } = open();
    fireEvent.click(category("vision"));

    const inputs = screen.getAllByRole("textbox");
    const endpoint = inputs.find((i) => (i as HTMLInputElement).value === "http://127.0.0.1:8100")!;
    fireEvent.change(endpoint, { target: { value: "http://a" } });
    fireEvent.change(endpoint, { target: { value: "http://ab" } });

    // The panel already sends on mount, so the assertion is on writes.
    expect(h.sent.filter((m) => m.type === "update-settings")).toEqual([]);
  });

  it("commits the detection interval on blur rather than per keystroke", () => {
    const { h } = open();
    fireEvent.click(category("vision"));

    const spin = screen.getAllByRole("spinbutton");
    const detection = spin.find((i) => (i as HTMLInputElement).value === "3")!;
    fireEvent.change(detection, { target: { value: "10" } });
    expect(h.sent.filter((m) => m.type === "update-settings")).toEqual([]);

    fireEvent.blur(detection);
    expect(h.sent).toContainEqual({
      type: "update-settings",
      patch: { vision: { detectionIntervalSeconds: 10 } },
    });
  });

  it("says nobody is enrolled when the roster is empty", () => {
    open();
    fireEvent.click(category("vision"));
    expect(screen.getByTestId("people-roster").textContent).toContain("Nobody enrolled");
  });

  it("lists an enrolled person with their face count", () => {
    open({ visionPeople: [person({ faceCount: 2 })] });
    fireEvent.click(category("vision"));

    const row = screen.getByTestId("person-row");
    expect(row.textContent).toContain("Dave");
    expect(row.textContent).toContain("2 faces");
  });

  it("requires a confirmation before deleting a person", () => {
    // R27 destroys biometric data, so it is never one click.
    const { h } = open({ visionPeople: [person()] });
    fireEvent.click(category("vision"));

    fireEvent.click(screen.getByTestId("delete-person"));
    expect(h.sent.filter((m) => m.type === "delete-person")).toEqual([]);

    fireEvent.click(screen.getByTestId("confirm-delete-person"));
    expect(h.sent).toContainEqual({ type: "delete-person", id: "p1" });
  });

  it("names who is being forgotten in the confirmation", () => {
    // "Are you sure" tells the user nothing. Whose data, and how much, does.
    open({ visionPeople: [person()] });
    fireEvent.click(category("vision"));
    fireEvent.click(screen.getByTestId("delete-person"));

    expect(screen.getByTestId("confirm-delete-person").textContent).toContain("Dave");
  });

  it("lets a confirmation be cancelled without deleting", () => {
    const { h } = open({ visionPeople: [person()] });
    fireEvent.click(category("vision"));

    fireEvent.click(screen.getByTestId("delete-person"));
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));

    expect(h.sent.filter((m) => m.type === "delete-person")).toEqual([]);
    expect(screen.getByTestId("delete-person")).toBeInTheDocument();
  });

  it("shows the recogniser as its own readiness leg", () => {
    open({
      readiness: {
        ollama: "ok",
        models: "ok",
        claudeLogs: "ok",
        captioner: "ok",
        recogniser: "degraded",
      },
    });
    fireEvent.click(category("readiness"));

    const list = screen.getByRole("list");
    expect(list.textContent).toContain("vision recogniser");
    // Degraded, not failed: it can detect but not match, and that is a
    // different thing to tell the user.
    expect(list.textContent).toContain("degraded");
  });
});
