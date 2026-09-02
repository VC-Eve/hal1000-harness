import { describe, it, expect } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { StateGraph } from "../../src/components/StateGraph";
import { harness, mount, testLive, testReports, testState, testWorld } from "./harness";
import type { World } from "../../../shared/src/types";

// Every query is scoped with `within` on a per-entity testid. The surface is
// full of near-identical repeated controls — one row per condition, one per
// Parameter — which is the worst case for positional queries.
const graph = (world: World, over: Parameters<typeof testState>[0] = {}) =>
  testState({ world, worldReports: testReports(world), worldLive: testLive(), ...over });

const boxOf = (id: string) => screen.getByTestId(`node-${id}`).querySelector("rect")!.getAttribute("class") ?? "";

describe("what the graph draws", () => {
  it("draws a node per State and an arrow per transition", () => {
    mount(<StateGraph state={graph(testWorld())} send={harness().send} />);

    expect(screen.getByTestId("node-s-couch")).toBeInTheDocument();
    expect(screen.getByTestId("node-s-booth")).toBeInTheDocument();
    expect(screen.getByTestId("transition-t1")).toBeInTheDocument();
  });

  it("names the State and its clip on the node", () => {
    mount(<StateGraph state={graph(testWorld())} send={harness().send} />);

    const node = screen.getByTestId("node-s-couch");
    expect(within(node).getByText("couch")).toBeInTheDocument();
    expect(within(node).getByText("couch-idle.mp4")).toBeInTheDocument();
  });

  it("marks the default State, and the one the machine is in", () => {
    const world = testWorld();
    const { rerender } = mount(<StateGraph state={graph(world)} send={harness().send} />);

    expect(screen.getByTestId("node-default-s-couch")).toBeInTheDocument();
    expect(boxOf("s-couch")).toContain("current");

    rerender(<StateGraph state={graph(world, { worldLive: testLive({ stateId: "s-booth" }) })} send={harness().send} />);
    expect(boxOf("s-booth")).toContain("current");
    expect(boxOf("s-couch")).not.toContain("current");
  });

  it("marks a State with no clip", () => {
    const world = testWorld({
      states: [{ id: "s-couch", name: "couch", clip: null, x: 0, y: 0 }],
      transitions: [],
    });
    mount(<StateGraph state={graph(world)} send={harness().send} />);

    expect(boxOf("s-couch")).toContain("no-clip");
    expect(within(screen.getByTestId("node-s-couch")).getByText("no clip")).toBeInTheDocument();
  });

  it("marks an unreachable State — the machine can never arrive there", () => {
    // Covers AE7.
    const base = testWorld();
    const world = testWorld({
      states: [...base.states, { id: "s-orphan", name: "orphan", clip: null, x: 700, y: 100 }],
    });
    mount(<StateGraph state={graph(world)} send={harness().send} />);

    expect(screen.getByTestId("node-unreachable-s-orphan")).toBeInTheDocument();
    expect(screen.queryByTestId("node-unreachable-s-couch")).not.toBeInTheDocument();
  });

  it("marks a dead-end State", () => {
    // `s-booth` has no transition out, so it has no way out for either value
    // of `ready`.
    mount(<StateGraph state={graph(testWorld())} send={harness().send} />);
    expect(screen.getByTestId("node-dead-end-s-booth")).toBeInTheDocument();
  });

  it("draws the Any State node only when something comes from it", () => {
    const base = testWorld();
    expect(mount(<StateGraph state={graph(base)} send={harness().send} />).queryByTestId("node-any")).toBeNull();

    const world = testWorld({
      transitions: [
        ...base.transitions,
        { id: "any", fromAny: true, to: "s-booth", conditions: [], hasExitTime: false, exitTime: 1, order: 0 },
      ],
    });
    mount(<StateGraph state={graph(world)} send={harness().send} />);
    expect(screen.getByTestId("node-any")).toBeInTheDocument();
  });

  it("says what to do when there is nothing to draw yet", () => {
    const world = testWorld({ states: [], transitions: [], defaultStateId: null });
    mount(<StateGraph state={graph(world)} send={harness().send} />);
    expect(screen.getByTestId("graph-empty")).toBeInTheDocument();
  });

  it("says why a World cannot be edited, and disables the controls that would write", () => {
    const world = testWorld();
    mount(
      <StateGraph
        state={graph(world, { worldReadable: false, worldReadOnlyReason: "made by an earlier layout" })}
        send={harness().send}
      />,
    );

    expect(screen.getByTestId("read-only")).toHaveTextContent("earlier layout");
    expect(screen.getByRole("button", { name: "add state" })).toBeDisabled();
  });
});

describe("authoring States", () => {
  it("adds a State with the typed name", () => {
    const h = harness();
    mount(<StateGraph state={graph(testWorld())} send={h.send} />);

    fireEvent.change(screen.getByLabelText("new state name"), { target: { value: "wave" } });
    fireEvent.click(screen.getByRole("button", { name: "add state" }));

    expect(h.sent.at(-1)).toMatchObject({ type: "add-state", worldId: "lounge", state: { name: "wave" } });
  });

  it("renames a State", () => {
    const h = harness();
    mount(<StateGraph state={graph(testWorld())} send={h.send} />);
    fireEvent.click(screen.getByTestId("node-s-couch"));

    fireEvent.change(within(screen.getByTestId("node-panel-s-couch")).getByLabelText("state name"), {
      target: { value: "couch idle" },
    });
    expect(h.sent.at(-1)).toMatchObject({ type: "update-state", stateId: "s-couch", patch: { name: "couch idle" } });
  });

  it("moves a State on release, once per drag", () => {
    const h = harness();
    mount(<StateGraph state={graph(testWorld())} send={h.send} />);

    fireEvent.pointerDown(screen.getByTestId("node-s-couch"), { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(screen.getByTestId("graph-svg"), { clientX: 60, clientY: 40 });

    expect(h.countOf("update-state")).toBe(1);
    expect(h.sent.at(-1)).toMatchObject({ type: "update-state", stateId: "s-couch", patch: { x: 150, y: 130 } });
  });

  it("makes a State the default", () => {
    const h = harness();
    mount(<StateGraph state={graph(testWorld())} send={h.send} />);
    fireEvent.click(screen.getByTestId("node-s-booth"));

    fireEvent.click(within(screen.getByTestId("node-panel-s-booth")).getByRole("button", { name: "make default" }));
    expect(h.sent.at(-1)).toEqual({ type: "set-default-state", worldId: "lounge", stateId: "s-booth" });
  });

  it("does not offer to re-default the State that already is", () => {
    mount(<StateGraph state={graph(testWorld())} send={harness().send} />);
    fireEvent.click(screen.getByTestId("node-s-couch"));

    expect(within(screen.getByTestId("node-panel-s-couch")).getByRole("button", { name: "is the default" })).toBeDisabled();
  });

  it("deletes a State", () => {
    const h = harness();
    mount(<StateGraph state={graph(testWorld())} send={h.send} />);
    fireEvent.click(screen.getByTestId("node-s-booth"));

    fireEvent.click(within(screen.getByTestId("node-panel-s-booth")).getByRole("button", { name: "delete state" }));
    expect(h.sent.at(-1)).toEqual({ type: "remove-state", worldId: "lounge", stateId: "s-booth" });
  });
});

describe("drawing transitions", () => {
  it("connects one node to another", () => {
    const h = harness();
    mount(<StateGraph state={graph(testWorld())} send={h.send} />);

    fireEvent.click(screen.getByTestId("node-s-booth"));
    fireEvent.click(within(screen.getByTestId("node-panel-s-booth")).getByRole("button", { name: "make transition" }));
    expect(screen.getByTestId("connecting")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("node-s-couch"));
    expect(h.sent.at(-1)).toEqual({
      type: "add-transition",
      worldId: "lounge",
      transition: { from: "s-booth", to: "s-couch" },
    });
  });

  it("draws one from Any State", () => {
    const h = harness();
    mount(<StateGraph state={graph(testWorld())} send={h.send} />);

    fireEvent.click(screen.getByRole("button", { name: "from Any State" }));
    fireEvent.click(screen.getByTestId("node-s-booth"));

    expect(h.sent.at(-1)).toEqual({
      type: "add-transition",
      worldId: "lounge",
      transition: { fromAny: true, to: "s-booth" },
    });
  });

  it("cancels a half-drawn transition rather than connecting the wrong node", () => {
    const h = harness();
    mount(<StateGraph state={graph(testWorld())} send={h.send} />);

    fireEvent.click(screen.getByTestId("node-s-booth"));
    fireEvent.click(within(screen.getByTestId("node-panel-s-booth")).getByRole("button", { name: "make transition" }));
    fireEvent.click(within(screen.getByTestId("node-panel-s-booth")).getByRole("button", { name: "cancel" }));
    fireEvent.click(screen.getByTestId("node-s-couch"));

    expect(h.countOf("add-transition")).toBe(0);
  });

  it("reorders a State's transitions, because order decides which is taken", () => {
    const h = harness();
    const base = testWorld();
    const world = testWorld({
      transitions: [
        ...base.transitions,
        { id: "t2", from: "s-couch", to: "s-booth", conditions: [], hasExitTime: true, exitTime: 1, order: 1 },
      ],
    });
    mount(<StateGraph state={graph(world)} send={h.send} />);
    fireEvent.click(screen.getByTestId("node-s-couch"));

    fireEvent.click(within(screen.getByTestId("order-s-couch")).getByLabelText("move 1 up"));
    expect(h.sent.at(-1)).toEqual({
      type: "reorder-transitions",
      worldId: "lounge",
      from: "s-couch",
      order: ["t2", "t1"],
    });
  });

  it("shows no ordering control for a single transition", () => {
    mount(<StateGraph state={graph(testWorld())} send={harness().send} />);
    fireEvent.click(screen.getByTestId("node-s-couch"));
    expect(screen.queryByTestId("order-s-couch")).not.toBeInTheDocument();
  });
});

describe("editing a transition", () => {
  const open = (h: ReturnType<typeof harness>, world = testWorld()) => {
    mount(<StateGraph state={graph(world)} send={h.send} />);
    fireEvent.click(screen.getByTestId("transition-t1"));
    return screen.getByTestId("transition-panel-t1");
  };

  it("opens on selection and names both ends", () => {
    expect(within(open(harness())).getByText("couch → booth")).toBeInTheDocument();
  });

  it("toggles has exit time, and says what each setting means", () => {
    const h = harness();
    const panel = open(h);

    expect(within(panel).getByText(/on every loop/)).toBeInTheDocument();
    fireEvent.click(within(panel).getByLabelText("has exit time"));
    expect(h.sent.at(-1)).toMatchObject({ patch: { hasExitTime: false } });
  });

  it("sets the exit time as a fraction of the clip", () => {
    const h = harness();
    const panel = open(h);

    fireEvent.change(within(panel).getByLabelText("exit time"), { target: { value: "0.75" } });
    expect(h.sent.at(-1)).toMatchObject({ patch: { exitTime: 0.75 } });
  });

  it("offers is / is not for a Bool", () => {
    const ops = within(open(harness())).getByLabelText("condition 0 operator").querySelectorAll("option");
    expect([...ops].map((o) => o.getAttribute("value"))).toEqual(["is", "isNot"]);
  });

  it("offers the comparisons for a Float", () => {
    const world = testWorld({
      parameters: [{ name: "energy", type: "float", defaultValue: 0 }],
      transitions: [
        {
          id: "t1",
          from: "s-couch",
          to: "s-booth",
          conditions: [{ parameter: "energy", op: "gt", value: 0.5 }],
          hasExitTime: true,
          exitTime: 1,
          order: 0,
        },
      ],
    });
    const ops = within(open(harness(), world)).getByLabelText("condition 0 operator").querySelectorAll("option");
    expect([...ops].map((o) => o.getAttribute("value"))).toEqual(["gt", "lt", "eq", "neq"]);
  });

  it("edits a condition's operator and value", () => {
    const h = harness();
    const panel = open(h);

    fireEvent.change(within(panel).getByLabelText("condition 0 operator"), { target: { value: "isNot" } });
    expect(h.sent.at(-1)).toMatchObject({ patch: { conditions: [{ op: "isNot" }] } });

    fireEvent.change(within(panel).getByLabelText("condition 0 value"), { target: { value: "false" } });
    expect(h.sent.at(-1)).toMatchObject({ patch: { conditions: [{ value: false }] } });
  });

  it("adds and removes conditions", () => {
    const h = harness();
    const panel = open(h);

    fireEvent.click(within(panel).getByRole("button", { name: "add condition" }));
    expect(h.sent.at(-1)).toMatchObject({ patch: { conditions: [{ parameter: "ready" }, { parameter: "ready" }] } });

    fireEvent.click(within(panel).getByRole("button", { name: "remove" }));
    expect(h.sent.at(-1)).toMatchObject({ patch: { conditions: [] } });
  });

  it("mutes and solos", () => {
    const h = harness();
    const panel = open(h);

    fireEvent.click(within(panel).getByLabelText("mute"));
    expect(h.sent.at(-1)).toMatchObject({ patch: { muted: true } });

    fireEvent.click(within(panel).getByLabelText("solo"));
    expect(h.sent.at(-1)).toMatchObject({ patch: { solo: true } });
  });

  it("deletes a transition", () => {
    const h = harness();
    const panel = open(h);
    fireEvent.click(within(panel).getByRole("button", { name: "delete transition" }));
    expect(h.sent.at(-1)).toEqual({ type: "remove-transition", worldId: "lounge", transitionId: "t1" });
  });
});

describe("driving it while it runs", () => {
  it("renders the current State and sets a Bool", () => {
    const h = harness();
    mount(<StateGraph state={graph(testWorld())} send={h.send} />);

    const panel = screen.getByTestId("parameters-panel");
    expect(within(panel).getByTestId("current-state")).toHaveTextContent("couch");

    fireEvent.click(within(panel).getByLabelText("ready"));
    expect(h.sent.at(-1)).toEqual({ type: "set-parameter", worldId: "lounge", name: "ready", value: true });
  });

  it("fires a Trigger rather than setting it, because it clears itself", () => {
    const h = harness();
    const world = testWorld({ parameters: [{ name: "wave", type: "trigger", defaultValue: false }] });
    mount(<StateGraph state={graph(world, { worldLive: testLive({ parameters: { wave: false } }) })} send={h.send} />);

    fireEvent.click(within(screen.getByTestId("parameter-wave")).getByRole("button", { name: "fire" }));
    expect(h.sent.at(-1)).toEqual({ type: "set-parameter", worldId: "lounge", name: "wave", value: true });
  });

  it("sets a number, and ignores one that is not a number", () => {
    const h = harness();
    const world = testWorld({ parameters: [{ name: "energy", type: "float", defaultValue: 0 }] });
    mount(<StateGraph state={graph(world, { worldLive: testLive({ parameters: { energy: 0 } }) })} send={h.send} />);

    const field = within(screen.getByTestId("parameter-energy")).getByLabelText("energy");
    fireEvent.change(field, { target: { value: "0.7" } });
    expect(h.sent.at(-1)).toEqual({ type: "set-parameter", worldId: "lounge", name: "energy", value: 0.7 });

    // Clearing the field is somebody midway through retyping, not a request
    // for zero — and `Number("")` is 0, so nothing must be sent.
    const before = h.countOf("set-parameter");
    fireEvent.change(field, { target: { value: "" } });
    expect(h.countOf("set-parameter")).toBe(before);
  });

  it("declares a Parameter of the chosen type", () => {
    const h = harness();
    mount(<StateGraph state={graph(testWorld())} send={h.send} />);

    const form = screen.getByTestId("parameter-form");
    fireEvent.change(within(form).getByLabelText("parameter name"), { target: { value: "wave" } });
    fireEvent.change(within(form).getByLabelText("parameter type"), { target: { value: "trigger" } });
    fireEvent.click(within(form).getByRole("button", { name: "declare" }));

    expect(h.sent.at(-1)).toEqual({
      type: "declare-parameter",
      worldId: "lounge",
      parameter: { name: "wave", type: "trigger", defaultValue: false },
    });
  });

  it("shows the runtime's fault where the author is looking", () => {
    const world = testWorld();
    mount(
      <StateGraph
        state={graph(world, { worldLive: testLive({ fault: "The clip waiting at the other end could not be played." }) })}
        send={harness().send}
      />,
    );
    expect(within(screen.getByTestId("parameters-panel")).getByText(/could not be played/)).toBeInTheDocument();
  });

  it("surfaces a clip the manifest names but cannot use", () => {
    const world = testWorld();
    mount(
      <StateGraph
        state={graph(world, {
          worldIncomplete: [{ stateId: "s-couch", path: "../escape.mp4", reason: "escapes-world" }],
        })}
        send={harness().send}
      />,
    );
    expect(within(screen.getByTestId("incomplete-clips")).getByText(/escapes-world/)).toBeInTheDocument();
  });
});
