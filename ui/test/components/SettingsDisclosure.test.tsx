import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SettingsDisclosure, summarise } from "../../src/components/SettingsDisclosure";

// This file renders the control alone rather than through `harness.tsx`, which
// is where the rest of the component suite picks up its matchers and teardown.
// Without the teardown every case after the first queries a document still
// holding the earlier renders.
expect.extend(matchers);
afterEach(cleanup);

// Two behaviours of this control are relied on elsewhere and would be silently
// undone by a rewrite that "simplified" it to `{open && children}`.
//
// It must render nothing before the first open, because two assertions in
// SettingsPanel.test.tsx pick buttons out of the active section by index and
// fifty-two editors appearing in the tree would move them.
//
// It must keep children mounted after a collapse, because TemplateField and
// PhraseField each own their draft — unmounting throws away text the user typed
// and never applied. Both are asserted here rather than in the panel tests so
// the reason lives next to the code that owes it.

const body = (
  <label>
    child field
    <input data-testid="child-input" defaultValue="" />
  </label>
);

const mount = () =>
  render(
    <SettingsDisclosure label="the wording I wrap it in" summary="2, shipped" testId="probe">
      {body}
    </SettingsDisclosure>,
  );

const toggle = () => screen.getByTestId("disclosure-probe");

describe("SettingsDisclosure", () => {
  it("renders no children before it is first opened", () => {
    mount();

    expect(screen.queryByTestId("child-input")).toBeNull();
    expect(screen.queryByTestId("disclosure-body-probe")).toBeNull();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("reveals children on open and flips the caret", () => {
    mount();
    expect(toggle().textContent).toContain("▸");

    fireEvent.click(toggle());

    expect(screen.getByTestId("child-input")).toBeVisible();
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(toggle().textContent).toContain("▾");
  });

  it("keeps children mounted but hidden after collapsing", () => {
    mount();
    fireEvent.click(toggle());
    fireEvent.click(toggle());

    // Mounted, so the draft inside survives. Not visible, so role queries in
    // the panel tests still skip it. A null here means drafts are being lost.
    const child = screen.getByTestId("child-input");
    expect(child).toBeInTheDocument();
    expect(child).not.toBeVisible();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("preserves an unapplied draft across a collapse and re-open", () => {
    mount();
    fireEvent.click(toggle());
    fireEvent.change(screen.getByTestId("child-input"), { target: { value: "typed but not applied" } });

    fireEvent.click(toggle());
    fireEvent.click(toggle());

    expect(screen.getByTestId("child-input")).toHaveValue("typed but not applied");
  });

  it("shows the summary beside the label while collapsed", () => {
    mount();

    expect(toggle().textContent).toContain("the wording I wrap it in");
    expect(toggle().textContent).toContain("2, shipped");
  });
});

describe("summarise", () => {
  const clean = { edited: false, needsAttention: false };
  const edited = { edited: true, needsAttention: false };
  const attention = { edited: true, needsAttention: true };

  it("reports the count alone when everything is shipped", () => {
    expect(summarise([clean, clean])).toBe("2, shipped");
  });

  it("counts the edited ones", () => {
    expect(summarise([clean, edited, edited])).toBe("3, 2 edited");
  });

  it("lets attention beat edited, because it is the one worth a click", () => {
    expect(summarise([edited, edited, attention])).toBe("3, 1 needs attention");
  });

  it("survives an empty block rather than dividing by nothing", () => {
    expect(summarise([])).toBe("0, shipped");
  });
});
