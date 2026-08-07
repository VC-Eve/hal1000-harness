import { describe, it, expect } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { WebcamPane } from "../../src/components/WebcamPane";
import { harness, mount, testSettings, testState } from "./harness";
import type { VisionObservation, VisionState } from "../../../shared/src/types";

const watching = (over: Partial<ReturnType<typeof testSettings>["vision"]> = {}) =>
  testSettings({ vision: { ...testSettings().vision, enabled: true, ...over } });

const observation = (over: Partial<VisionObservation> = {}): VisionObservation => ({
  at: "2026-08-06T21:00:00.000Z",
  caption: "A person sits at a desk.",
  identity: null,
  ...over,
});

const props = (h: ReturnType<typeof harness>, state = testState()) => ({
  state,
  send: h.send,
  collapseDisabled: false,
  onCollapse: () => {},
});

describe("WebcamPane — mount", () => {
  it("sends nothing on mount", () => {
    // The pane is a view, not a requester. An effect firing here would run on
    // every store broadcast, which is how a request loop starts.
    const h = harness();
    mount(<WebcamPane {...props(h)} />);

    expect(h.sent).toEqual([]);
  });

  it("still sends nothing when handed a fresh send on every render", () => {
    // The shape of the bug this suite exists for: a component that depends on
    // `send` in an effect re-runs forever when its caller re-creates `send`.
    const h = harness();
    const unstable = () => (msg: Parameters<typeof h.send>[0]) => h.send(msg);
    const state = testState({ settings: watching() });

    const { rerender } = mount(<WebcamPane {...props(h, state)} send={unstable()} />);
    for (let i = 0; i < 5; i += 1) {
      rerender(
        <WebcamPane
          {...props(h, testState({ settings: watching(), visionObservations: [observation()] }))}
          send={unstable()}
        />,
      );
    }

    expect(h.sent).toEqual([]);
  });
});

describe("WebcamPane — controls", () => {
  it("starts Vision through a settings patch", () => {
    const h = harness();
    mount(<WebcamPane {...props(h)} />);

    fireEvent.click(screen.getByRole("button", { name: "start" }));

    expect(h.sent).toEqual([{ type: "update-settings", patch: { vision: { enabled: true } } }]);
  });

  it("stops Vision when it is already watching", () => {
    const h = harness();
    mount(<WebcamPane {...props(h, testState({ settings: watching() }))} />);

    fireEvent.click(screen.getByRole("button", { name: "stop" }));

    expect(h.sent).toEqual([{ type: "update-settings", patch: { vision: { enabled: false } } }]);
  });

  it("refuses to offer an on-demand look while Vision is off", () => {
    // The server rejects the message in this state, so an enabled button would
    // be an affordance that does nothing.
    const h = harness();
    mount(<WebcamPane {...props(h)} />);

    expect(screen.getByRole("button", { name: "look now" })).toBeDisabled();
  });

  it("asks for a look while Vision is watching", () => {
    const h = harness();
    mount(<WebcamPane {...props(h, testState({ settings: watching() }))} />);

    fireEvent.click(screen.getByRole("button", { name: "look now" }));

    expect(h.sent).toEqual([{ type: "vision-capture-now" }]);
  });

  it("disables the look button while a capture is already running", () => {
    const h = harness();
    const state = testState({ settings: watching(), visionState: "captioning" });
    mount(<WebcamPane {...props(h, state)} />);

    expect(screen.getByRole("button", { name: "look now" })).toBeDisabled();
  });
});

describe("WebcamPane — what it shows", () => {
  it("shows no live feed until Vision is enabled", () => {
    // R15: the preview is camera access, so nothing may request the stream
    // before the user switches Vision on.
    const h = harness();
    mount(<WebcamPane {...props(h)} />);

    expect(screen.queryByAltText("the live camera")).toBeNull();
    expect(screen.getByText("not watching")).toBeInTheDocument();
  });

  it("requests the live stream once watching", () => {
    const h = harness();
    mount(<WebcamPane {...props(h, testState({ settings: watching() }))} />);

    expect(screen.getByAltText("the live camera")).toHaveAttribute("src", "/api/vision/stream");
  });

  it("renders each observation's caption", () => {
    const h = harness();
    const state = testState({
      settings: watching(),
      visionObservations: [observation({ caption: "Nobody is here." }), observation({ at: "2026-08-06T21:01:00.000Z" })],
    });
    mount(<WebcamPane {...props(h, state)} />);

    expect(screen.getByText(/Nobody is here\./)).toBeInTheDocument();
    expect(screen.getByText(/A person sits at a desk\./)).toBeInTheDocument();
  });

  it("marks a fault state and shows its detail", () => {
    const h = harness();
    const state = testState({
      settings: watching(),
      visionState: "no-camera" as VisionState,
      visionDetail: "The camera is in use by another application.",
    });
    mount(<WebcamPane {...props(h, state)} />);

    expect(screen.getByTestId("vision-state")).toHaveClass("fail");
    expect(screen.getByTestId("vision-fault")).toHaveTextContent("in use by another application");
  });

  it("does not mark an ordinary working state as a fault", () => {
    const h = harness();
    const state = testState({ settings: watching(), visionState: "capturing" as VisionState });
    mount(<WebcamPane {...props(h, state)} />);

    expect(screen.getByTestId("vision-state")).not.toHaveClass("fail");
    expect(screen.queryByTestId("vision-fault")).toBeNull();
  });
});
