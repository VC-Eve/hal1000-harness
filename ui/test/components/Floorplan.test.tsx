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
    expect(screen.getAllByTestId(/^position-dot-/)).toHaveLength(2);
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

describe("authoring a World from the plan", () => {
  // Every control here was reachable over the protocol but had no UI, which
  // left the plan's own U9 verification — place, wire, drive — impossible from
  // the floorplan and possible only from a second, scripted client.

  it("declares a Parameter", () => {
    const h = harness();
    const world = testWorld({ parameters: [] });
    mount(<Floorplan state={plan(world)} send={h.send} />);

    const form = screen.getByTestId("parameter-form");
    fireEvent.change(within(form).getByLabelText("parameter name"), { target: { value: "location" } });
    fireEvent.change(within(form).getByLabelText("parameter values"), { target: { value: "couch, booth" } });
    fireEvent.click(within(form).getByRole("button", { name: "declare" }));

    expect(h.sent).toContainEqual({
      type: "declare-parameter",
      worldId: "lounge",
      parameter: { name: "location", values: ["couch", "booth"], defaultValue: "couch" },
    });
  });

  it("assigns a clip to a State, which is how a State gets its loop at all", () => {
    const h = harness();
    const world = testWorld();
    mount(<Floorplan state={plan(world)} send={h.send} />);

    fireEvent.click(screen.getByTestId("pairing-cam-p-couch"));
    const panel = screen.getByTestId("state-panel-cam-p-couch");
    fireEvent.change(within(panel).getByLabelText("state clip path"), { target: { value: "clips/couch-idle.mp4" } });
    fireEvent.click(within(panel).getByRole("button", { name: "assign clip" }));

    expect(h.sent).toContainEqual({
      type: "assign-clip",
      worldId: "lounge",
      target: { kind: "state", sceneId: "cam", positionId: "p-couch" },
      // Zero on purpose: nothing can measure the file until the manifest
      // references it, so the player reports the real length at first play.
      clip: { path: "clips/couch-idle.mp4", durationMs: 0 },
    });
  });

  it("strikes a derived pairing geometry got wrong, and restores it", () => {
    const h = harness();
    const world = testWorld();
    const { rerender } = mount(<Floorplan state={plan(world)} send={h.send} />);

    fireEvent.click(screen.getByTestId("pairing-cam-p-couch"));
    fireEvent.click(within(screen.getByTestId("state-panel-cam-p-couch")).getByRole("button", { name: "strike pairing" }));
    expect(h.sent).toContainEqual({ type: "strike-pairing", worldId: "lounge", sceneId: "cam", positionId: "p-couch", struck: true });

    // Struck, the pairing leaves coverage — so the restore control lives with
    // the Position that is now reported as uncovered.
    const withStrike = testWorld({ struck: [{ sceneId: "cam", positionId: "p-couch" }] });
    rerender(<Floorplan state={plan(withStrike)} send={h.send} />);
    expect(screen.queryByTestId("pairing-cam-p-couch")).not.toBeInTheDocument();
    expect(screen.getByTestId("uncovered-p-couch")).toBeInTheDocument();
  });

  it("connects two States into an edge", () => {
    const h = harness();
    const world = testWorld();
    mount(<Floorplan state={plan(world)} send={h.send} />);

    fireEvent.click(screen.getByTestId("pairing-cam-p-couch"));
    fireEvent.click(within(screen.getByTestId("state-panel-cam-p-couch")).getByRole("button", { name: "connect from" }));
    fireEvent.click(screen.getByTestId("pairing-cam-p-booth"));
    fireEvent.click(within(screen.getByTestId("state-panel-cam-p-booth")).getByRole("button", { name: "connect to" }));

    const builder = screen.getByTestId("edge-builder");
    expect(within(builder).getByTestId("edge-from")).toHaveTextContent("couch");
    expect(within(builder).getByTestId("edge-to")).toHaveTextContent("booth");
    fireEvent.change(within(builder).getByLabelText("edge kind"), { target: { value: "cut" } });
    fireEvent.click(within(builder).getByRole("button", { name: "add edge" }));

    expect(h.sent).toContainEqual({
      type: "add-edge",
      worldId: "lounge",
      edge: { kind: "cut", from: "s-couch", to: "s-booth" },
    });
  });

  it("will not build an edge with only one end chosen", () => {
    const h = harness();
    const world = testWorld();
    mount(<Floorplan state={plan(world)} send={h.send} />);

    fireEvent.click(within(screen.getByTestId("edge-builder")).getByRole("button", { name: "add edge" }));
    expect(h.countOf("add-edge")).toBe(0);
  });

  it("moves a Position on release, once per drag", () => {
    const h = harness();
    const world = testWorld();
    mount(<Floorplan state={plan(world)} send={h.send} />);

    fireEvent.pointerDown(screen.getByTestId("position-dot-p-couch"));
    fireEvent.pointerUp(screen.getByTestId("plan-svg"));

    expect(h.countOf("move-position")).toBe(1);
    expect(h.sent.find((m) => m.type === "move-position")).toMatchObject({
      type: "move-position",
      worldId: "lounge",
      positionId: "p-couch",
    });
  });
});

describe("placement mode does one thing at a time", () => {
  it("does not both select a camera and drop another on top of it", () => {
    const h = harness();
    const world = testWorld();
    mount(<Floorplan state={plan(world)} send={h.send} />);

    fireEvent.click(screen.getByRole("button", { name: "place camera" }));
    fireEvent.click(screen.getByTestId("scene-cam"));

    expect(h.countOf("add-scene")).toBe(1);
    expect(screen.queryByTestId("camera-panel-cam")).not.toBeInTheDocument();
  });

  it("selects a camera in select mode without placing anything", () => {
    const h = harness();
    const world = testWorld();
    mount(<Floorplan state={plan(world)} send={h.send} />);

    fireEvent.click(screen.getByTestId("scene-cam"));

    expect(h.countOf("add-scene")).toBe(0);
    expect(screen.getByTestId("camera-panel-cam")).toBeInTheDocument();
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
