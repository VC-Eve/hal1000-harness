import { describe, it, expect } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { StateGraph } from "../../src/components/StateGraph";
import { nodeKey } from "../../src/graph";
import { harness, mount, testLive, testReports, testState, testWorld } from "./harness";
import type { World } from "../../../shared/src/types";

// Every query is scoped with `within` on a per-entity testid. The surface is
// full of near-identical repeated controls — one row per condition, one node
// per pairing — which is the worst case for positional queries.
const graph = (world: World, over: Parameters<typeof testState>[0] = {}) =>
  testState({ world, worldReports: testReports(world), worldLive: testLive(), ...over });

const couch = nodeKey("cam", "p-couch");
const booth = nodeKey("cam", "p-booth");

describe("what the graph draws", () => {
  it("draws a node per Scene/Position pairing and an arrow per transition", () => {
    const world = testWorld();
    mount(<StateGraph state={graph(world)} send={harness().send} />);

    expect(screen.getByTestId(`node-${couch}`)).toBeInTheDocument();
    expect(screen.getByTestId(`node-${booth}`)).toBeInTheDocument();
    expect(screen.getByTestId("transition-e1")).toBeInTheDocument();
  });

  it("names the Position, the camera and the clip on the node", () => {
    const world = testWorld();
    mount(<StateGraph state={graph(world)} send={harness().send} />);

    const node = screen.getByTestId(`node-${couch}`);
    expect(within(node).getByText("couch")).toBeInTheDocument();
    expect(within(node).getByText(/couch cam · couch-idle\.mp4/)).toBeInTheDocument();
  });

  it("highlights the State the World is actually in", () => {
    const world = testWorld();
    const { rerender } = mount(<StateGraph state={graph(world)} send={harness().send} />);
    const boxOf = (key: string) => screen.getByTestId(`node-${key}`).querySelector("rect")!.getAttribute("class") ?? "";

    expect(boxOf(couch)).toContain("current");
    expect(boxOf(booth)).not.toContain("current");

    rerender(<StateGraph state={graph(world, { worldLive: testLive({ stateId: "s-booth" }) })} send={harness().send} />);
    expect(boxOf(booth)).toContain("current");
    expect(boxOf(couch)).not.toContain("current");
  });

  it("marks a dead-end State on its node, and only where there is one", () => {
    // Covers AE3 as the author sees it. In the fixture both States are dead
    // ends — `s-booth` has no edge out at all, and `s-couch`'s only edge needs
    // location to be booth — so the mark is proved conditional by giving couch
    // an unconditional way out and watching its flag go.
    const world = testWorld();
    const { rerender } = mount(<StateGraph state={graph(world)} send={harness().send} />);

    expect(screen.getByTestId(`node-dead-end-${booth}`)).toBeInTheDocument();
    expect(screen.getByTestId(`node-dead-end-${couch}`)).toBeInTheDocument();

    const wayOut = testWorld({
      edges: [...testWorld().edges, { id: "e2", kind: "travel", from: "s-couch", to: "s-booth", conditions: [], onClipEnd: true, clip: null }],
    });
    rerender(<StateGraph state={graph(wayOut)} send={harness().send} />);

    expect(screen.queryByTestId(`node-dead-end-${couch}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`node-dead-end-${booth}`)).toBeInTheDocument();
  });

  it("draws a covered pairing with no clip as a node waiting to become a State", () => {
    const world = testWorld({ states: [testWorld().states[0]!] });
    mount(<StateGraph state={graph(world, { worldLive: testLive() })} send={harness().send} />);

    const box = screen.getByTestId(`node-${booth}`).querySelector("rect")!.getAttribute("class") ?? "";
    expect(box).toContain("no-clip");
    expect(within(screen.getByTestId(`node-${booth}`)).getByText(/no clip/)).toBeInTheDocument();
  });

  it("says what to do when there is nothing to draw yet", () => {
    const world = testWorld({ positions: [], scenes: [], states: [], edges: [] });
    mount(<StateGraph state={graph(world)} send={harness().send} />);
    expect(screen.getByTestId("graph-empty")).toBeInTheDocument();
  });

  it("flags a reversed Cut on the arrow itself", () => {
    // Covers AE2 as the author sees it: the transition that reads as the
    // character turning around is the one drawn in red.
    const base = testWorld();
    const world = testWorld({
      edges: [
        { id: "out", kind: "cut", from: "s-couch", to: "s-booth", conditions: [], onClipEnd: true, clip: null, entryClip: null, exitEdge: "right", entryEdge: "left" },
        { id: "back", kind: "cut", from: "s-booth", to: "s-couch", conditions: [], onClipEnd: true, clip: null, entryClip: null, exitEdge: "right", entryEdge: "left" },
      ],
      states: base.states,
    });
    mount(<StateGraph state={graph(world)} send={harness().send} />);

    const path = screen.getByTestId("transition-out").querySelector("path.transition")!;
    expect(path.getAttribute("class")).toContain("reversed");
  });
});

describe("authoring the machine", () => {
  it("declares a Parameter", () => {
    const h = harness();
    const world = testWorld({ parameters: [] });
    mount(<StateGraph state={graph(world)} send={h.send} />);

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

  it("assigns the clip that loops while a State holds", () => {
    const h = harness();
    const world = testWorld();
    mount(<StateGraph state={graph(world)} send={h.send} />);

    fireEvent.click(screen.getByTestId(`node-${couch}`));
    const panel = screen.getByTestId(`node-panel-${couch}`);
    fireEvent.change(within(panel).getByLabelText("state clip path"), { target: { value: "clips/couch-idle.mp4" } });
    fireEvent.click(within(panel).getByRole("button", { name: "assign clip" }));

    expect(h.sent).toContainEqual({
      type: "assign-clip",
      worldId: "lounge",
      target: { kind: "state", sceneId: "cam", positionId: "p-couch" },
      // Zero on purpose: nothing can measure the file until the manifest
      // references it, so the player reports its real length at first play.
      clip: { path: "clips/couch-idle.mp4", durationMs: 0 },
    });
  });

  it("strikes a derived pairing geometry got wrong", () => {
    const h = harness();
    const world = testWorld();
    mount(<StateGraph state={graph(world)} send={h.send} />);

    fireEvent.click(screen.getByTestId(`node-${couch}`));
    fireEvent.click(within(screen.getByTestId(`node-panel-${couch}`)).getByRole("button", { name: "strike pairing" }));

    expect(h.sent).toContainEqual({ type: "strike-pairing", worldId: "lounge", sceneId: "cam", positionId: "p-couch", struck: true });
  });

  it("draws a transition from one node to another", () => {
    const h = harness();
    const world = testWorld();
    mount(<StateGraph state={graph(world)} send={h.send} />);

    fireEvent.click(screen.getByTestId(`node-${couch}`));
    fireEvent.change(within(screen.getByTestId(`node-panel-${couch}`)).getByLabelText("transition kind"), { target: { value: "cut" } });
    fireEvent.click(within(screen.getByTestId(`node-panel-${couch}`)).getByRole("button", { name: "make transition" }));
    expect(screen.getByTestId("connecting")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`node-${booth}`));

    expect(h.sent).toContainEqual({
      type: "add-edge",
      worldId: "lounge",
      edge: { kind: "cut", from: "s-couch", to: "s-booth" },
    });
  });

  it("will not draw a transition from a pairing that is not a State yet", () => {
    const h = harness();
    const world = testWorld({ states: [testWorld().states[0]!] });
    mount(<StateGraph state={graph(world)} send={h.send} />);

    fireEvent.click(screen.getByTestId(`node-${booth}`));
    const panel = screen.getByTestId(`node-panel-${booth}`);
    expect(within(panel).getByRole("button", { name: "make transition" })).toBeDisabled();
    expect(within(panel).getByText(/before drawing a transition/)).toBeInTheDocument();
  });

  it("cancels a half-drawn transition rather than connecting the wrong node", () => {
    const h = harness();
    const world = testWorld();
    mount(<StateGraph state={graph(world)} send={h.send} />);

    fireEvent.click(screen.getByTestId(`node-${couch}`));
    fireEvent.click(within(screen.getByTestId(`node-panel-${couch}`)).getByRole("button", { name: "make transition" }));
    fireEvent.click(within(screen.getByTestId(`node-panel-${couch}`)).getByRole("button", { name: "cancel" }));
    fireEvent.click(screen.getByTestId(`node-${booth}`));

    expect(h.countOf("add-edge")).toBe(0);
  });
});

describe("editing a transition", () => {
  const openTransition = (h: ReturnType<typeof harness>, world = testWorld()) => {
    mount(<StateGraph state={graph(world)} send={h.send} />);
    fireEvent.click(screen.getByTestId("transition-e1"));
    return screen.getByTestId("transition-panel-e1");
  };

  it("opens on selection and names both ends", () => {
    const panel = openTransition(harness());
    expect(within(panel).getByText(/couch · couch cam → booth · couch cam/)).toBeInTheDocument();
  });

  it("edits a condition's parameter, operator and value", () => {
    const h = harness();
    const panel = openTransition(h);

    fireEvent.change(within(panel).getByLabelText("condition 0 value"), { target: { value: "couch" } });
    expect(h.sent.at(-1)).toMatchObject({ type: "update-edge", edgeId: "e1", patch: { conditions: [{ value: "couch" }] } });

    fireEvent.change(within(panel).getByLabelText("condition 0 operator"), { target: { value: "ne" } });
    expect(h.sent.at(-1)).toMatchObject({ patch: { conditions: [{ op: "ne" }] } });
  });

  it("adds and removes conditions", () => {
    const h = harness();
    const panel = openTransition(h);

    fireEvent.click(within(panel).getByRole("button", { name: "add condition" }));
    expect(h.sent.at(-1)).toMatchObject({ patch: { conditions: [{ value: "booth" }, { value: "couch" }] } });

    fireEvent.click(within(panel).getByRole("button", { name: "remove" }));
    expect(h.sent.at(-1)).toMatchObject({ patch: { conditions: [] } });
  });

  it("toggles has exit time, and says what each setting means", () => {
    const h = harness();
    const panel = openTransition(h);

    expect(within(panel).getByText(/Waits for the current clip to finish/)).toBeInTheDocument();
    fireEvent.click(within(panel).getByLabelText("has exit time"));
    expect(h.sent.at(-1)).toMatchObject({ patch: { onClipEnd: false } });
  });

  it("records the frame edges a Cut leaves and enters through", () => {
    const h = harness();
    const world = testWorld({
      edges: [
        { id: "e1", kind: "cut", from: "s-couch", to: "s-booth", conditions: [], onClipEnd: true, clip: null, entryClip: null, exitEdge: null, entryEdge: null },
      ],
    });
    const panel = openTransition(h, world);

    fireEvent.change(within(panel).getByLabelText("exitEdge"), { target: { value: "right" } });
    expect(h.sent).toContainEqual({ type: "update-edge", worldId: "lounge", edgeId: "e1", patch: { exitEdge: "right" } });
  });

  it("assigns both halves of a Cut", () => {
    const h = harness();
    const world = testWorld({
      edges: [
        { id: "e1", kind: "cut", from: "s-couch", to: "s-booth", conditions: [], onClipEnd: true, clip: null, entryClip: null, exitEdge: "right", entryEdge: "left" },
      ],
    });
    const panel = openTransition(h, world);

    fireEvent.change(within(panel).getByLabelText("clip path"), { target: { value: "clips/exit.mp4" } });
    fireEvent.click(within(panel).getByRole("button", { name: "assign exit clip" }));
    expect(h.sent.at(-1)).toMatchObject({ target: { kind: "edge", edgeId: "e1", slot: "clip" } });

    fireEvent.change(within(panel).getByLabelText("clip path"), { target: { value: "clips/enter.mp4" } });
    fireEvent.click(within(panel).getByRole("button", { name: "assign entry clip" }));
    expect(h.sent.at(-1)).toMatchObject({ target: { kind: "edge", edgeId: "e1", slot: "entry" } });
  });
});

describe("driving it while it runs", () => {
  it("renders the current State and sends a Parameter change", () => {
    const h = harness();
    const world = testWorld();
    mount(<StateGraph state={graph(world)} send={h.send} />);

    const panel = screen.getByTestId("parameters-panel");
    expect(within(panel).getByTestId("current-state")).toHaveTextContent("couch · couch cam");
    fireEvent.change(within(panel).getByLabelText("location"), { target: { value: "booth" } });

    expect(h.sent).toContainEqual({ type: "set-parameter", worldId: "lounge", name: "location", value: "booth" });
  });

  it("shows the runtime's fault where the author is looking", () => {
    const world = testWorld();
    mount(
      <StateGraph
        state={graph(world, { worldLive: testLive({ fault: "That edge's clip could not be played." }) })}
        send={harness().send}
      />,
    );
    expect(within(screen.getByTestId("parameters-panel")).getByText(/could not be played/)).toBeInTheDocument();
  });
});
