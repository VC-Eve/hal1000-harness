import { describe, it, expect } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { Floorplan } from "../../src/components/Floorplan";
import { LivePane } from "../../src/components/LivePane";
import { harness, mount, testLive, testReports, testState, testWorld } from "./harness";
import type { World } from "../../../shared/src/types";

// Every query is scoped with `within` on a per-entity testid. The surface is
// full of near-identical repeated controls — one panel per edge, one select per
// Parameter — which is the worst case for positional queries.
const plan = (world: World, over: Parameters<typeof testState>[0] = {}) =>
  testState({ world, worldReports: testReports(world), worldLive: testLive(), ...over });

describe("placing things", () => {
  it("sends the mutation with coordinates when a Position is placed", () => {
    const h = harness();
    const world = testWorld();
    mount(<Floorplan state={plan(world)} send={h.send} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "corridor" } });
    fireEvent.click(screen.getByRole("button", { name: "place position" }));
    fireEvent.click(screen.getByTestId("plan-svg"));

    const sent = h.sent.find((m) => m.type === "add-position");
    expect(sent).toMatchObject({ type: "add-position", worldId: "lounge", name: "corridor" });
    expect(Number.isFinite((sent as { x: number }).x)).toBe(true);
  });

  it("draws the broadcast World rather than anything it placed locally", () => {
    const h = harness();
    const world = testWorld();
    mount(<Floorplan state={plan(world)} send={h.send} />);

    fireEvent.click(screen.getByRole("button", { name: "place position" }));
    fireEvent.click(screen.getByTestId("plan-svg"));

    // The manifest is a folder on disk and the server is the only thing that
    // knows what landed in it, so nothing new appears until it says so.
    expect(screen.queryByTestId(/^position-(?!p-couch|p-booth)/)).not.toBeInTheDocument();
    expect(screen.getByTestId("position-p-couch")).toBeInTheDocument();
  });

  it("sends the aim and takes its coverage from the derived report", () => {
    const h = harness();
    const world = testWorld();
    mount(<Floorplan state={plan(world)} send={h.send} />);

    fireEvent.click(screen.getByTestId("scene-cam"));
    fireEvent.change(screen.getByLabelText("couch cam facing"), { target: { value: "45" } });

    expect(h.sent).toContainEqual({ type: "aim-camera", worldId: "lounge", sceneId: "cam", camera: { facing: 45 } });
  });
});

describe("the three reports", () => {
  it("marks a Position no camera covers", () => {
    const world = testWorld({
      positions: [...testWorld().positions, { id: "p-corridor", name: "corridor", x: 500, y: 500 }],
    });
    mount(<Floorplan state={plan(world)} send={harness().send} />);

    expect(within(screen.getByTestId("position-p-corridor")).getByTestId("uncovered-p-corridor")).toBeInTheDocument();
    expect(screen.queryByTestId("uncovered-p-couch")).not.toBeInTheDocument();
  });

  it("renders the warning for a Cut whose return reverses screen direction", () => {
    // Covers AE2. The assertion is the rendered flag, not that the manifest
    // holds two frame edges.
    const base = testWorld();
    const world = testWorld({
      states: [...base.states, { id: "s-booth-b", sceneId: "cam", positionId: "p-booth", clip: null }],
      edges: [
        { id: "out", kind: "cut", from: "s-couch", to: "s-booth", conditions: [], onClipEnd: true, clip: null, entryClip: null, exitEdge: "right", entryEdge: "left" },
        { id: "back", kind: "cut", from: "s-booth", to: "s-couch", conditions: [], onClipEnd: true, clip: null, entryClip: null, exitEdge: "right", entryEdge: "left" },
      ],
    });
    mount(<Floorplan state={plan(world)} send={harness().send} />);

    expect(within(screen.getByTestId("plan-reports")).getByTestId("reversed-out")).toHaveTextContent(/turning around/);
    expect(screen.getByTestId("edge-out").className.baseVal).toContain("reversed");
  });

  it("marks a dead-end State", () => {
    // Covers AE3 as the plan view renders it: `s-booth` has no edge out at all,
    // so it has no way out for either value of `location`.
    const world = testWorld();
    mount(<Floorplan state={plan(world)} send={harness().send} />);

    expect(screen.getByTestId("dead-end-p-booth")).toBeInTheDocument();
    expect(within(screen.getByTestId("plan-reports")).getAllByTestId("dead-end-report-s-booth").length).toBeGreaterThan(0);
  });
});

describe("editing an edge", () => {
  it("opens the condition panel on selection and sends the edit", () => {
    const h = harness();
    const world = testWorld();
    mount(<Floorplan state={plan(world)} send={h.send} />);

    expect(screen.queryByTestId("edge-panel-e1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("edge-e1"));

    const panel = screen.getByTestId("edge-panel-e1");
    fireEvent.change(within(panel).getByLabelText("condition 0 value"), { target: { value: "couch" } });

    expect(h.sent).toContainEqual({
      type: "update-edge",
      worldId: "lounge",
      edgeId: "e1",
      patch: { conditions: [{ parameter: "location", op: "eq", value: "couch" }] },
    });
  });

  it("adds and removes a condition", () => {
    const h = harness();
    const world = testWorld();
    mount(<Floorplan state={plan(world)} send={h.send} />);
    fireEvent.click(screen.getByTestId("edge-e1"));
    const panel = screen.getByTestId("edge-panel-e1");

    fireEvent.click(within(panel).getByRole("button", { name: "add condition" }));
    expect(h.sent.at(-1)).toMatchObject({ patch: { conditions: [{ value: "booth" }, { value: "couch" }] } });

    fireEvent.click(within(panel).getByRole("button", { name: "remove" }));
    expect(h.sent.at(-1)).toMatchObject({ patch: { conditions: [] } });
  });

  it("sets the frame edges a Cut records", () => {
    const h = harness();
    const world = testWorld({
      edges: [
        { id: "cut", kind: "cut", from: "s-couch", to: "s-booth", conditions: [], onClipEnd: true, clip: null, entryClip: null, exitEdge: null, entryEdge: null },
      ],
    });
    mount(<Floorplan state={plan(world)} send={h.send} />);
    fireEvent.click(screen.getByTestId("edge-cut"));

    fireEvent.change(within(screen.getByTestId("edge-panel-cut")).getByLabelText("exitEdge"), { target: { value: "right" } });
    expect(h.sent).toContainEqual({ type: "update-edge", worldId: "lounge", edgeId: "cut", patch: { exitEdge: "right" } });
  });
});

describe("the live readout", () => {
  it("renders the current State and the Parameter values", () => {
    const world = testWorld();
    mount(<Floorplan state={plan(world)} send={harness().send} />);

    const readout = screen.getByTestId("live-readout");
    expect(within(readout).getByTestId("current-state")).toHaveTextContent("couch · couch cam");
    expect((within(readout).getByLabelText("location") as HTMLSelectElement).value).toBe("couch");
  });

  it("updates on a broadcast and sends a Parameter change", () => {
    const h = harness();
    const world = testWorld();
    const { rerender } = mount(<Floorplan state={plan(world)} send={h.send} />);

    fireEvent.change(within(screen.getByTestId("live-readout")).getByLabelText("location"), { target: { value: "booth" } });
    expect(h.sent).toContainEqual({ type: "set-parameter", worldId: "lounge", name: "location", value: "booth" });

    rerender(
      <Floorplan
        state={plan(world, { worldLive: testLive({ stateId: "s-booth", parameters: { location: "booth" } }) })}
        send={h.send}
      />,
    );
    expect(within(screen.getByTestId("live-readout")).getByTestId("current-state")).toHaveTextContent("booth · couch cam");
  });
});

describe("effect frequency", () => {
  it("asks for the World once across rerenders, including with an unstable send", () => {
    const h = harness();
    const unstable = () => (msg: Parameters<typeof h.send>[0]) => h.send(msg);
    const world = testWorld();
    const { rerender } = mount(<LivePane state={plan(world)} send={unstable()} />);
    for (let i = 0; i < 5; i += 1) rerender(<LivePane state={plan(world)} send={unstable()} />);

    expect(h.countOf("list-worlds")).toBe(1);
  });
});
