import { describe, it, expect, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { CollapseButton, SectionRail } from "../../src/components/SectionRail";
import { mount } from "./harness";

describe("CollapseButton", () => {
  it("collapses on click", () => {
    const onCollapse = vi.fn();
    mount(<CollapseButton id="conversation" disabled={false} onCollapse={onCollapse} />);

    fireEvent.click(screen.getByTestId("collapse-conversation"));

    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it("does nothing while disabled", () => {
    // The last-visible guard reaches the user here. `layout.ts` refuses the
    // state change regardless, but a button that still fires would leave the
    // interface looking broken rather than deliberate.
    const onCollapse = vi.fn();
    mount(<CollapseButton id="observation" disabled onCollapse={onCollapse} />);

    const button = screen.getByTestId("collapse-observation");
    expect(button).toBeDisabled();

    fireEvent.click(button);
    expect(onCollapse).not.toHaveBeenCalled();
  });
});

describe("SectionRail", () => {
  it("expands on click and names its section", () => {
    const onExpand = vi.fn();
    mount(<SectionRail id="webcam" orientation="vertical" onExpand={onExpand} />);

    const rail = screen.getByTestId("rail-webcam");
    expect(rail).toHaveAttribute("aria-label", "Expand vision");

    fireEvent.click(rail);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});
