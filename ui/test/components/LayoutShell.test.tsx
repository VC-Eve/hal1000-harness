import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { LayoutShell } from "../../src/components/LayoutShell";
import { harness, mount, testState } from "./harness";

// jsdom supplies a real localStorage, so the persistence assertion below
// exercises the same path a browser would rather than a stand-in.
beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

const shell = () => {
  const h = harness();
  const view = mount(<LayoutShell state={testState()} send={h.send} dispatch={() => {}} intensity="medium" onOpenSettings={() => {}} />);
  return { h, view };
};

const collapseSection = (id: string) => fireEvent.click(screen.getByTestId(`collapse-${id}`));
const expandSection = (id: string) => fireEvent.click(screen.getByTestId(`rail-${id}`));

describe("LayoutShell — default", () => {
  it("renders all three sections with both dividers", () => {
    shell();

    expect(screen.getByTestId("chat-pane")).toBeInTheDocument();
    expect(screen.getByTestId("webcam-pane")).toBeInTheDocument();
    expect(screen.getByTestId("narration-pane")).toBeInTheDocument();
    expect(screen.getByTestId("divider-vertical")).toBeInTheDocument();
    expect(screen.getByTestId("divider-horizontal")).toBeInTheDocument();
  });

  it("keeps each pane's own content intact through the restructure", () => {
    // The riskiest edit in this change: ChatPane's root became a three-track
    // grid with a header spanning both columns, and both panes gained a level
    // of nesting under the left column. A broken grid row or a missing
    // min-height:0 shows up as content that vanishes or stops scrolling, and
    // asserting only on the pane containers would miss all of it.
    shell();

    expect(screen.getByRole("button", { name: /new conversation/i })).toBeInTheDocument();
    expect(screen.getByText("conversation")).toBeInTheDocument();
    expect(screen.getByText("session observation")).toBeInTheDocument();
    expect(screen.getByText("vision")).toBeInTheDocument();
  });

  it("sends nothing on mount", () => {
    // The layout is a local preference. If wiring it ever starts a request the
    // whole "this stays out of the WS contract" decision has quietly reversed.
    const { h } = shell();
    expect(h.sent).toHaveLength(0);
  });
});

describe("LayoutShell — collapsing", () => {
  it("swaps a collapsed section for its rail and leaves the others mounted", () => {
    shell();
    collapseSection("conversation");

    expect(screen.queryByTestId("chat-pane")).not.toBeInTheDocument();
    expect(screen.getByTestId("rail-conversation")).toBeInTheDocument();
    expect(screen.getByTestId("webcam-pane")).toBeInTheDocument();
    expect(screen.getByTestId("narration-pane")).toBeInTheDocument();
  });

  it("drops the horizontal divider once one left section is gone", () => {
    shell();
    collapseSection("webcam");

    expect(screen.queryByTestId("divider-horizontal")).not.toBeInTheDocument();
    expect(screen.getByTestId("divider-vertical")).toBeInTheDocument();
  });

  it("lays a lone collapsed left rail flat and stands both edge rails on end", () => {
    // Orientation is the difference between a rail that hugs an edge and one
    // that leaves a dead band beside it for the column's whole width.
    shell();
    collapseSection("conversation");
    expect(screen.getByTestId("rail-conversation")).toHaveClass("horizontal");

    collapseSection("webcam");
    expect(screen.getByTestId("rail-conversation")).toHaveClass("vertical");
    expect(screen.getByTestId("rail-webcam")).toHaveClass("vertical");
  });

  it("leaves no vertical divider when both left sections are collapsed", () => {
    // The point of the whole feature: with the left column reduced to rails
    // there is no bar between it and the feed, so nothing stops the feed
    // reaching the edge.
    shell();
    collapseSection("conversation");
    collapseSection("webcam");

    expect(screen.getByTestId("rail-conversation")).toBeInTheDocument();
    expect(screen.getByTestId("rail-webcam")).toBeInTheDocument();
    expect(screen.queryByTestId("divider-vertical")).not.toBeInTheDocument();
    expect(screen.queryByTestId("divider-horizontal")).not.toBeInTheDocument();
    expect(screen.getByTestId("narration-pane")).toBeInTheDocument();
  });

  it("collapses observation to a rail and keeps the left column", () => {
    shell();
    collapseSection("observation");

    expect(screen.queryByTestId("narration-pane")).not.toBeInTheDocument();
    expect(screen.getByTestId("rail-observation")).toBeInTheDocument();
    expect(screen.getByTestId("chat-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("divider-vertical")).not.toBeInTheDocument();
  });

  it("disables the last visible section's collapse control", () => {
    shell();
    collapseSection("conversation");
    collapseSection("webcam");

    expect(screen.getByTestId("collapse-observation")).toBeDisabled();
  });

  it("restores a section from its rail and brings the divider back", () => {
    shell();
    collapseSection("conversation");
    expandSection("conversation");

    expect(screen.getByTestId("chat-pane")).toBeInTheDocument();
    expect(screen.getByTestId("divider-horizontal")).toBeInTheDocument();
    expect(screen.getByTestId("divider-vertical")).toBeInTheDocument();
  });
});

describe("LayoutShell — persistence", () => {
  it("restores the collapse state on a fresh mount", () => {
    const { view } = shell();
    collapseSection("webcam");
    view.unmount();

    shell();

    expect(screen.getByTestId("rail-webcam")).toBeInTheDocument();
    expect(screen.queryByTestId("webcam-pane")).not.toBeInTheDocument();
  });
});
