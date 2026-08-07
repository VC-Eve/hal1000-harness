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
