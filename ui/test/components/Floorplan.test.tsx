import { describe, it, expect } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { Floorplan } from "../../src/components/Floorplan";
import { harness, mount, testLive, testReports, testState, testWorld } from "./harness";
import type { World } from "../../../shared/src/types";

// The floorplan owns geometry only: where the cameras are and what their cones
// reach. Everything about the state machine is authored in the graph, and its
// tests live in StateGraph.test.tsx.
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

  it("places a camera with a cone it can then be given", () => {
    const h = harness();
    const world = testWorld();
    mount(<Floorplan state={plan(world)} send={h.send} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "dj cam" } });
    fireEvent.click(screen.getByRole("button", { name: "place camera" }));
    fireEvent.click(screen.getByTestId("plan-svg"));

    expect(h.sent.find((m) => m.type === "add-scene")).toMatchObject({
      type: "add-scene",
      name: "dj cam",
      camera: { fov: 90, range: 20 },
    });
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

  it("moves a Position on release, once per drag", () => {
    const h = harness();
    const world = testWorld();
    mount(<Floorplan state={plan(world)} send={h.send} />);

    fireEvent.pointerDown(screen.getByTestId("position-dot-p-couch"));
    fireEvent.pointerUp(screen.getByTestId("plan-svg"));

    expect(h.countOf("move-position")).toBe(1);
    expect(h.sent.find((m) => m.type === "move-position")).toMatchObject({ positionId: "p-couch" });
  });
});

describe("aiming a camera", () => {
  it("selects it and sends the aim", () => {
    const h = harness();
    const world = testWorld();
    mount(<Floorplan state={plan(world)} send={h.send} />);

    fireEvent.click(screen.getByTestId("camera-dot-cam"));
    fireEvent.change(screen.getByLabelText("couch cam facing"), { target: { value: "45" } });

    expect(h.sent).toContainEqual({ type: "aim-camera", worldId: "lounge", sceneId: "cam", camera: { facing: 45 } });
  });

  it("does not both select a camera and drop another on top of it", () => {
    const h = harness();
    const world = testWorld();
    mount(<Floorplan state={plan(world)} send={h.send} />);

    fireEvent.click(screen.getByRole("button", { name: "place camera" }));
    fireEvent.click(screen.getByTestId("camera-dot-cam"));

    expect(h.countOf("add-scene")).toBe(1);
    expect(screen.queryByTestId("camera-panel-cam")).not.toBeInTheDocument();
  });
});

describe("what the cones reach", () => {
  it("lists the coverage a camera derives", () => {
    const world = testWorld();
    mount(<Floorplan state={plan(world)} send={harness().send} />);

    const panel = screen.getByTestId("plan-reports");
    expect(within(panel).getByText(/couch cam sees couch/)).toBeInTheDocument();
    expect(within(panel).getByText(/couch cam sees booth/)).toBeInTheDocument();
  });

  it("marks and names a Position no camera covers", () => {
    const world = testWorld({
      positions: [...testWorld().positions, { id: "p-corridor", name: "corridor", x: 500, y: 500 }],
    });
    mount(<Floorplan state={plan(world)} send={harness().send} />);

    expect(within(screen.getByTestId("position-p-corridor")).getByTestId("uncovered-p-corridor")).toBeInTheDocument();
    expect(within(screen.getByTestId("plan-reports")).getByText(/corridor is covered by no camera/)).toBeInTheDocument();
    expect(screen.queryByTestId("uncovered-p-couch")).not.toBeInTheDocument();
  });

  it("marks where the character is", () => {
    const world = testWorld();
    mount(<Floorplan state={plan(world)} send={harness().send} />);

    expect(screen.getByTestId("position-dot-p-couch").getAttribute("class")).toContain("current");
    expect(screen.getByTestId("position-dot-p-booth").getAttribute("class")).not.toContain("current");
  });
});
