import { describe, it, expect } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { StateGraph } from "../../src/components/StateGraph";
import { harness, mount, testLive, testReports, testState, testWorld } from "./harness";
import type { TransportState, World } from "../../../shared/src/types";
import {
  AUDIO_BPM,
  AUDIO_LENGTH,
  AUDIO_PLAYING,
  AUDIO_READOUTS,
  AUDIO_REMAINING,
  AUDIO_TRACK,
  AUDIO_TRACKS,
} from "../../../shared/src/audio";

/** A transport holding a track, as the server publishes one. */
const transport = (over: Partial<TransportState> = {}): TransportState => ({
  playlistId: "warmup",
  generation: 1,
  index: 1,
  path: "tracks/2.flac",
  name: "2.flac",
  playing: true,
  positionMs: 61_000,
  durationMs: 300_000,
  volume: 1,
  tracks: 4,
  bpm: 128,
  audible: true,
  ...over,
});

/** One readout row's rendered value. */
const readoutRow = (name: string) =>
  within(screen.getByTestId("parameters-panel")).getByTestId(`parameter-${name}`);

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

  it("names the State and how many clips it draws from", () => {
    // A count rather than a filename: with a set there is no single clip to
    // name, and which one plays changes every loop.
    mount(<StateGraph state={graph(testWorld())} send={harness().send} />);

    const node = screen.getByTestId("node-s-couch");
    expect(within(node).getByText("couch")).toBeInTheDocument();
    expect(within(node).getByText("1 clip")).toBeInTheDocument();
  });

  it("counts a State that draws from several", () => {
    const world = testWorld({
      states: [
        {
          id: "s-couch",
          name: "couch",
          clips: [
            { clips: [{ path: "clips/a.mp4", durationMs: 1000 }] },
            { clips: [{ path: "clips/b.mp4", durationMs: 1000 }] },
            { clips: [{ path: "clips/c.mp4", durationMs: 1000 }] },
          ],
          x: 0,
          y: 0,
        },
      ],
      transitions: [],
    });
    mount(<StateGraph state={graph(world)} send={harness().send} />);

    expect(within(screen.getByTestId("node-s-couch")).getByText("3 clips")).toBeInTheDocument();
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
      states: [{ id: "s-couch", name: "couch", clips: [], x: 0, y: 0 }],
      transitions: [],
    });
    mount(<StateGraph state={graph(world)} send={harness().send} />);

    expect(boxOf("s-couch")).toContain("no-clip");
    expect(within(screen.getByTestId("node-s-couch")).getByText("no clips")).toBeInTheDocument();
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
          clips: [],
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

describe("what the review of 2026-09-02 found", () => {
  it("does not write an exit time of 0 when the field is cleared to retype", () => {
    // `Number("")` is 0, and an exit time of 0 was a transition that could never
    // be taken. The Parameter number field already guards on the raw text.
    const h = harness();
    const world = testWorld();
    const transition = world.transitions[0]!;
    mount(<StateGraph state={testState({ world, worldReports: testReports(world) })} send={h.send} />);

    fireEvent.click(screen.getByTestId(`transition-${transition.id}`));
    fireEvent.change(screen.getByLabelText("exit time"), { target: { value: "" } });

    expect(h.sent.filter((m) => m.type === "update-transition")).toEqual([]);
  });

  it("does not send a move for a click that never moved the node", () => {
    // A plain click is a pointerdown and a pointerup with nothing between them.
    // Writing on those sent a manifest write and a broadcast per click.
    const h = harness();
    const world = testWorld();
    const node = world.states[0]!;
    mount(<StateGraph state={testState({ world, worldReports: testReports(world) })} send={h.send} />);

    const target = screen.getByTestId(`node-${node.id}`);
    fireEvent.pointerDown(target, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(target, { clientX: 10, clientY: 10 });

    expect(h.sent.filter((m) => m.type === "update-state")).toEqual([]);
  });

  it("still sends a move when the node actually moved", () => {
    const h = harness();
    const world = testWorld();
    const node = world.states[0]!;
    mount(<StateGraph state={testState({ world, worldReports: testReports(world) })} send={h.send} />);

    const target = screen.getByTestId(`node-${node.id}`);
    fireEvent.pointerDown(target, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(target, { clientX: 60, clientY: 40 });

    expect(h.sent.filter((m) => m.type === "update-state")).toHaveLength(1);
  });
});

describe("authoring a State's clip set", () => {
  const threeClips = () =>
    testWorld({
      states: [
        {
          id: "s-couch",
          name: "couch",
          clips: [
            { clips: [{ path: "clips/a.mp4", durationMs: 1000 }] },
            { clips: [{ path: "clips/b.mp4", durationMs: 1000 }] },
            { clips: [{ path: "clips/c.mp4", durationMs: 1000 }] },
          ],
          x: 0,
          y: 0,
        },
      ],
      transitions: [],
    });

  const openPanel = (h: ReturnType<typeof harness>, world = threeClips()) => {
    mount(<StateGraph state={graph(world)} send={h.send} />);
    fireEvent.click(screen.getByTestId("node-s-couch"));
  };

  it("lists every clip in the set, in order", () => {
    openPanel(harness());
    const set = screen.getByTestId("clip-set-s-couch");
    expect(within(set).getByText("a.mp4")).toBeInTheDocument();
    expect(within(set).getByText("c.mp4")).toBeInTheDocument();
  });

  it("says so when a State has none, rather than showing an empty list", () => {
    openPanel(harness(), testWorld({ states: [{ id: "s-couch", name: "couch", clips: [], x: 0, y: 0 }], transitions: [] }));
    expect(within(screen.getByTestId("clip-set-s-couch")).getByText(/No clips yet/)).toBeInTheDocument();
  });

  it("removes one member and keeps the rest in order", () => {
    const h = harness();
    openPanel(h);

    fireEvent.click(screen.getByLabelText("remove clips/b.mp4"));

    expect(h.sent.at(-1)).toMatchObject({
      type: "update-state",
      patch: { clips: [{ clips: [{ path: "clips/a.mp4", durationMs: 1000 }] }, { clips: [{ path: "clips/c.mp4", durationMs: 1000 }] }] },
    });
  });

  it("moves a member down without disturbing the others", () => {
    const h = harness();
    openPanel(h);

    fireEvent.click(screen.getByLabelText("move clips/a.mp4 down"));

    expect(
      (h.sent.at(-1) as { patch: { clips: { clips: { path: string }[] }[] } }).patch.clips.map(
        (s) => s.clips[0]!.path,
      ),
    ).toEqual(["clips/b.mp4", "clips/a.mp4", "clips/c.mp4"]);
  });

  it("says the order is the order clips play in", () => {
    // The opposite of what this panel said before sequences: order was
    // presentational then, and linking two rows makes it playback now. A note
    // that still called it arrangement would be describing the old machine.
    openPanel(harness());
    expect(screen.getByText(/the order they play in/)).toBeInTheDocument();
  });

  it("says nothing about order when there is only one clip", () => {
    openPanel(
      harness(),
      testWorld({
        states: [{ id: "s-couch", name: "couch", clips: [{ clips: [{ path: "clips/a.mp4", durationMs: 1 }] }], x: 0, y: 0 }],
        transitions: [],
      }),
    );
    expect(screen.queryByText(/the order they play in/)).not.toBeInTheDocument();
  });

  it("cannot move the first member up or the last one down", () => {
    openPanel(harness());
    expect(screen.getByLabelText("move clips/a.mp4 up")).toBeDisabled();
    expect(screen.getByLabelText("move clips/c.mp4 down")).toBeDisabled();
  });

  it("clears the whole set", () => {
    const h = harness();
    openPanel(h);

    fireEvent.click(screen.getByRole("button", { name: "clear" }));

    expect(h.sent.at(-1)).toMatchObject({ type: "update-state", patch: { clips: [] } });
  });
});

describe("while the machine is between States", () => {
  const crossing = () =>
    testState({
      world: testWorld(),
      worldReports: testReports(testWorld()),
      worldLive: testLive({ stateId: "s-couch", transitionId: "t1", clip: { path: "clips/walk.mp4", durationMs: 4000 } }),
    });

  it("marks the transition being crossed", () => {
    mount(<StateGraph state={crossing()} send={harness().send} />);
    const line = screen.getByTestId("transition-t1").querySelector("path.transition");
    expect(line?.getAttribute("class")).toContain("crossing");
  });

  it("marks no node as current, because it is not in one", () => {
    // Highlighting the source would claim the machine is playing footage it is
    // not — the bridge is a different clip entirely.
    mount(<StateGraph state={crossing()} send={harness().send} />);
    expect(boxOf("s-couch")).not.toContain("current");
  });

  it("says which transition it is crossing rather than naming a State", () => {
    mount(<StateGraph state={crossing()} send={harness().send} />);
    expect(screen.getByTestId("current-state")).toHaveTextContent("crossing couch → booth");
  });

  it("marks the node again once it lands", () => {
    mount(
      <StateGraph
        state={testState({
          world: testWorld(),
          worldReports: testReports(testWorld()),
          worldLive: testLive({ stateId: "s-couch", transitionId: null }),
        })}
        send={harness().send}
      />,
    );
    expect(boxOf("s-couch")).toContain("current");
  });
});

describe("authoring a transition's bridge", () => {
  const openTransition = (h: ReturnType<typeof harness>) => {
    mount(<StateGraph state={graph(testWorld())} send={h.send} />);
    fireEvent.click(screen.getByTestId("transition-t1"));
  };

  it("says an empty bridge means an instant cut", () => {
    openTransition(harness());
    expect(within(screen.getByTestId("clip-set-t1")).getByText(/instant cut/)).toBeInTheDocument();
  });

  it("removes a clip from the bridge", () => {
    const h = harness();
    const world = testWorld();
    world.transitions[0]!.clips = [
      { clips: [{ path: "clips/walk.mp4", durationMs: 4000 }] },
      { clips: [{ path: "clips/stroll.mp4", durationMs: 4000 }] },
    ];
    mount(<StateGraph state={graph(world)} send={h.send} />);
    fireEvent.click(screen.getByTestId("transition-t1"));

    fireEvent.click(screen.getByLabelText("remove clips/walk.mp4"));

    expect(h.sent.at(-1)).toMatchObject({
      type: "update-transition",
      patch: { clips: [{ clips: [{ path: "clips/stroll.mp4", durationMs: 4000 }] }] },
    });
  });
});

describe("linking clips into a run", () => {
  const threeClips = () =>
    testWorld({
      states: [
        {
          id: "s-couch",
          name: "couch",
          clips: [
            { clips: [{ path: "clips/a.mp4", durationMs: 1000 }] },
            { clips: [{ path: "clips/b.mp4", durationMs: 1000 }] },
            { clips: [{ path: "clips/c.mp4", durationMs: 1000 }] },
          ],
          x: 0,
          y: 0,
        },
      ],
      transitions: [],
    });

  const openPanel = (h: ReturnType<typeof harness>, world = threeClips()) => {
    mount(<StateGraph state={graph(world)} send={h.send} />);
    fireEvent.click(screen.getByTestId("node-s-couch"));
  };

  const sentClips = (h: ReturnType<typeof harness>) =>
    (h.sent.at(-1) as { patch: { clips: { clips: { path: string }[] }[] } }).patch.clips.map((s) =>
      s.clips.map((c) => c.path),
    );

  it("merges two adjacent rows into one run", () => {
    const h = harness();
    openPanel(h);

    fireEvent.click(screen.getByLabelText("link clips/a.mp4 to the next clip"));

    expect(sentClips(h)).toEqual([["clips/a.mp4", "clips/b.mp4"], ["clips/c.mp4"]]);
  });

  it("splits a run at the row the author unlinks", () => {
    const h = harness();
    const world = threeClips();
    world.states[0]!.clips = [
      {
        clips: [
          { path: "clips/a.mp4", durationMs: 1000 },
          { path: "clips/b.mp4", durationMs: 1000 },
          { path: "clips/c.mp4", durationMs: 1000 },
        ],
      },
    ];
    openPanel(h, world);

    fireEvent.click(screen.getByLabelText("unlink clips/b.mp4 from the next clip"));

    expect(sentClips(h)).toEqual([["clips/a.mp4", "clips/b.mp4"], ["clips/c.mp4"]]);
  });

  it("offers no link control after the last row", () => {
    openPanel(harness());
    expect(screen.queryByLabelText("link clips/c.mp4 to the next clip")).not.toBeInTheDocument();
  });

  it("marks the rows that belong to a run", () => {
    const world = threeClips();
    world.states[0]!.clips = [
      {
        clips: [
          { path: "clips/a.mp4", durationMs: 1000 },
          { path: "clips/b.mp4", durationMs: 1000 },
        ],
      },
      { clips: [{ path: "clips/c.mp4", durationMs: 1000 }] },
    ];
    openPanel(harness(), world);

    expect(screen.getByTestId("clip-0-s-couch").className).toContain("in-run");
    expect(screen.getByTestId("clip-1-s-couch").className).toContain("in-run");
    expect(screen.getByTestId("clip-2-s-couch").className).not.toContain("in-run");
  });

  it("holds every control until the edit sent has been answered", () => {
    // The whole-array patch means two edits from one snapshot lose each other,
    // which is why the existing controls wait. A new control that did not would
    // reopen exactly that hole.
    const h = harness();
    openPanel(h);

    fireEvent.click(screen.getByLabelText("link clips/a.mp4 to the next clip"));

    expect(screen.getByLabelText("link clips/b.mp4 to the next clip")).toBeDisabled();
    expect(screen.getByLabelText("move clips/b.mp4 down")).toBeDisabled();
    expect(screen.getByLabelText("remove clips/b.mp4")).toBeDisabled();
    expect(screen.getByLabelText("play the whole run")).toBeDisabled();
  });

  it("sends the atomicity switch as one patch", () => {
    const h = harness();
    openPanel(h);

    fireEvent.click(screen.getByLabelText("play the whole run"));

    expect(h.sent.at(-1)).toMatchObject({ type: "update-state", patch: { atomic: true } });
  });

  it("says what the switch costs when it is on", () => {
    const world = threeClips();
    world.states[0]!.atomic = true;
    openPanel(harness(), world);
    expect(screen.getByText(/Nothing is evaluated until the run ends/)).toBeInTheDocument();
  });
});

describe("a transition's set, now that its order decides playback", () => {
  const bridgeWorld = () => {
    const world = testWorld();
    world.transitions[0]!.clips = [
      { clips: [{ path: "clips/walk.mp4", durationMs: 4000 }] },
      { clips: [{ path: "clips/stroll.mp4", durationMs: 4000 }] },
    ];
    return world;
  };

  it("offers the reorder controls a State's set has always had", () => {
    // They were missing here while order was presentational. Order decides
    // playback on both owners now, so a panel without them offers half the
    // mechanism.
    const h = harness();
    mount(<StateGraph state={graph(bridgeWorld())} send={h.send} />);
    fireEvent.click(screen.getByTestId("transition-t1"));

    fireEvent.click(screen.getByLabelText("move clips/walk.mp4 down"));

    expect(
      (h.sent.at(-1) as { patch: { clips: { clips: { path: string }[] }[] } }).patch.clips.map(
        (s) => s.clips[0]!.path,
      ),
    ).toEqual(["clips/stroll.mp4", "clips/walk.mp4"]);
  });

  it("links a bridge's two clips into one run", () => {
    const h = harness();
    mount(<StateGraph state={graph(bridgeWorld())} send={h.send} />);
    fireEvent.click(screen.getByTestId("transition-t1"));

    fireEvent.click(screen.getByLabelText("link clips/walk.mp4 to the next clip"));

    expect(h.sent.at(-1)).toMatchObject({
      type: "update-transition",
      patch: {
        clips: [
          {
            clips: [
              { path: "clips/walk.mp4", durationMs: 4000 },
              { path: "clips/stroll.mp4", durationMs: 4000 },
            ],
          },
        ],
      },
    });
  });

  it("offers no atomicity switch, because a crossing has no choice about it", () => {
    mount(<StateGraph state={graph(bridgeWorld())} send={harness().send} />);
    fireEvent.click(screen.getByTestId("transition-t1"));

    expect(screen.queryByLabelText("play the whole run")).not.toBeInTheDocument();
  });
});

describe("authoring Effects in the panel", () => {
  const swingWorld = (over: Partial<World> = {}) =>
    testWorld({
      states: [{ id: "s-couch", name: "couch", clips: [], x: 0, y: 0 }],
      transitions: [],
      parameters: [
        { name: "swing", type: "int", defaultValue: 0, min: 0, max: 2 },
        { name: "loose", type: "int", defaultValue: 0 },
      ],
      ...over,
    });

  const openState = (h: ReturnType<typeof harness>, world = swingWorld()) => {
    mount(<StateGraph state={graph(world)} send={h.send} />);
    fireEvent.click(screen.getByTestId("node-s-couch"));
  };

  it("adds an Effect to a State", () => {
    const h = harness();
    openState(h);

    // Both scopes render an editor, so scope the click to this State's.
    const panel = screen.getByTestId("effects-s-couch");
    fireEvent.click(within(panel).getByText("add effect"));

    expect(h.sent.at(-1)).toMatchObject({
      type: "update-state",
      stateId: "s-couch",
      patch: { effects: [{ parameter: "swing", intervalMs: 2000 }] },
    });
  });

  it("adds an Effect to the World through its own message", () => {
    // A World Effect has no owner to patch, so it does not ride update-state.
    const h = harness();
    mount(<StateGraph state={graph(swingWorld())} send={h.send} />);

    const worldEffects = screen.getByTestId("effects-lounge");
    fireEvent.click(within(worldEffects).getByText("add effect"));

    expect(h.sent.at(-1)).toMatchObject({ type: "set-world-effects", worldId: "lounge" });
  });

  it("offers only the operations the target Parameter can take", () => {
    // Read from the registry rather than a copy here, so an op the runtime would
    // decline is never offered — an Effect that fires and does nothing.
    const h = harness();
    openState(
      h,
      swingWorld({
        states: [
          {
            id: "s-couch",
            name: "couch",
            clips: [],
            effects: [{ parameter: "swing", op: "add", operand: 1, intervalMs: 2000 }],
            x: 0,
            y: 0,
          },
        ],
      }),
    );

    const ops = within(screen.getByLabelText("operation for swing"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(ops).toContain("bounce");
    expect(ops).not.toContain("toggle");
  });

  it("does not offer bounce for a Parameter with no declared range", () => {
    const h = harness();
    openState(
      h,
      swingWorld({
        states: [
          {
            id: "s-couch",
            name: "couch",
            clips: [],
            effects: [{ parameter: "loose", op: "add", operand: 1, intervalMs: 2000 }],
            x: 0,
            y: 0,
          },
        ],
      }),
    );

    const ops = within(screen.getByLabelText("operation for loose"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(ops).not.toContain("bounce");
    expect(ops).not.toContain("random");
  });

  it("offers no Effect target at all when every Parameter is a Trigger", () => {
    const h = harness();
    openState(
      h,
      swingWorld({ parameters: [{ name: "go", type: "trigger", defaultValue: false }] }),
    );

    expect(screen.queryByLabelText("effect target for s-couch")).not.toBeInTheDocument();
  });

  it("removes an Effect", () => {
    const h = harness();
    openState(
      h,
      swingWorld({
        states: [
          {
            id: "s-couch",
            name: "couch",
            clips: [],
            effects: [
              { parameter: "swing", op: "add", operand: 1, intervalMs: 2000 },
              { parameter: "loose", op: "add", operand: 1, intervalMs: 2000 },
            ],
            x: 0,
            y: 0,
          },
        ],
      }),
    );

    fireEvent.click(screen.getByLabelText("remove effect on swing"));

    expect(h.sent.at(-1)).toMatchObject({
      patch: { effects: [{ parameter: "loose" }] },
    });
  });
});

describe("a Parameter's control while an Effect is writing it", () => {
  const ticking = () =>
    testWorld({
      states: [{ id: "s-couch", name: "couch", clips: [], x: 0, y: 0 }],
      transitions: [],
      parameters: [{ name: "swing", type: "int", defaultValue: 0, min: 0, max: 10 }],
    });

  it("does not overwrite what the author is typing", () => {
    // The panel bound this field straight to the live value, which was harmless
    // while writes were the author's own. An Effect arrives mid-keystroke.
    const h = harness();
    const world = ticking();
    const { rerender } = mount(<StateGraph state={graph(world, { worldLive: testLive({ parameters: { swing: 0 } }) })} send={h.send} />);

    const field = screen.getByLabelText("swing");
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "7" } });

    // A tick lands while the field has focus.
    rerender(<StateGraph state={graph(world, { worldLive: testLive({ parameters: { swing: 3 } }) })} send={h.send} />);

    expect((screen.getByLabelText("swing") as HTMLInputElement).value).toBe("7");
  });

  it("re-syncs to the live value once the author leaves the field", () => {
    const h = harness();
    const world = ticking();
    const { rerender } = mount(<StateGraph state={graph(world, { worldLive: testLive({ parameters: { swing: 0 } }) })} send={h.send} />);

    const field = screen.getByLabelText("swing");
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "7" } });
    fireEvent.blur(field);

    rerender(<StateGraph state={graph(world, { worldLive: testLive({ parameters: { swing: 3 } }) })} send={h.send} />);

    expect((screen.getByLabelText("swing") as HTMLInputElement).value).toBe("3");
  });

  it("edits a Parameter's bounds", () => {
    const h = harness();
    mount(<StateGraph state={graph(ticking())} send={h.send} />);

    fireEvent.change(screen.getByLabelText("swing maximum"), { target: { value: "4" } });

    expect(h.sent.at(-1)).toMatchObject({
      type: "declare-parameter",
      parameter: { name: "swing", max: 4 },
    });
  });

  it("gives a Parameter that has no range one, from either end first", () => {
    // The server keeps a range only as both halves, so an end committed on its
    // own was dropped and came back as 0. Neither end could be first, which
    // left the bounds of an unranged Parameter unreachable from the panel.
    const h = harness();
    const world = testWorld({
      states: [{ id: "s-couch", name: "couch", clips: [], x: 0, y: 0 }],
      transitions: [],
      parameters: [{ name: "swing", type: "int", defaultValue: 0 }],
    });
    const { rerender } = mount(<StateGraph state={graph(world)} send={h.send} />);

    const min = screen.getByLabelText("swing minimum");
    fireEvent.focus(min);
    fireEvent.change(min, { target: { value: "2" } });
    fireEvent.blur(min);

    // The World comes back without the range — that pair was still half-typed —
    // and the field holds what the author put in rather than resetting.
    rerender(<StateGraph state={graph(world)} send={h.send} />);
    expect((screen.getByLabelText("swing minimum") as HTMLInputElement).value).toBe("2");

    fireEvent.change(screen.getByLabelText("swing maximum"), { target: { value: "8" } });

    expect(h.sent.at(-1)).toMatchObject({
      type: "declare-parameter",
      parameter: { name: "swing", min: 2, max: 8 },
    });
  });

  it("offers no bounds for a Bool", () => {
    const h = harness();
    mount(
      <StateGraph
        state={graph(
          testWorld({
            states: [{ id: "s-couch", name: "couch", clips: [], x: 0, y: 0 }],
            transitions: [],
            parameters: [{ name: "ready", type: "bool", defaultValue: false }],
          }),
        )}
        send={h.send}
      />,
    );

    expect(screen.queryByLabelText("ready minimum")).not.toBeInTheDocument();
  });
});

describe("what the reports say about Effects", () => {
  it("names an Effect whose Parameter is not declared", () => {
    const h = harness();
    const world = testWorld({
      states: [{ id: "s-couch", name: "couch", clips: [], x: 0, y: 0 }],
      transitions: [],
      parameters: [],
      effects: [{ parameter: "gone", op: "add", operand: 1, intervalMs: 2000 }],
    });
    mount(<StateGraph state={graph(world)} send={h.send} />);

    expect(within(screen.getByTestId("dangling-effects")).getByText(/fires and does nothing/)).toBeInTheDocument();
  });

  it("names a Parameter whose bounds are not in force", () => {
    const h = harness();
    const world = testWorld({
      states: [{ id: "s-couch", name: "couch", clips: [], x: 0, y: 0 }],
      transitions: [],
      parameters: [{ name: "swing", type: "int", defaultValue: 0, min: 2, max: 0 }],
    });
    mount(<StateGraph state={graph(world)} send={h.send} />);

    expect(within(screen.getByTestId("unusable-ranges")).getByText(/nothing is clamped/)).toBeInTheDocument();
  });
});

describe("the audio readouts in the editor", () => {

  it("re-seeds the operator when a condition is pointed at a different type", () => {
    // The bug this catches, found in a World in use: swapping a clause's
    // Parameter kept the old operator, so `dj is true` pointed at an int became
    // `audio.remaining is <something>` — which clauseHolds reads as "equals
    // false" and can never hold. The operator picker was already fixed to offer
    // the right operators; it decides what is *offered*, and this decides what
    // is *kept*.
    const world = testWorld({
      parameters: [{ name: "dj", type: "bool", defaultValue: false }],
      states: [
        { id: "a", name: "djing-left", clips: [], x: 0, y: 0 },
        { id: "b", name: "dance-floor1", clips: [], x: 0, y: 100 },
      ],
      transitions: [
        {
          id: "t",
          from: "a",
          to: "b",
          conditions: [{ parameter: "dj", op: "is", value: true }],
          hasExitTime: true,
          exitTime: 1,
          order: 0,
          clips: [],
        },
      ],
    });
    const h = harness();
    mount(<StateGraph state={testState({ world })} send={h.send} />);
    fireEvent.click(screen.getByTestId("transition-t"));

    fireEvent.change(screen.getByLabelText("condition 0 parameter"), {
      target: { value: AUDIO_REMAINING },
    });

    const sent = h.sent.filter((m) => m.type === "update-transition").at(-1) as
      | { patch?: { conditions?: { parameter: string; op: string; value: unknown }[] } }
      | undefined;
    const clause = sent?.patch?.conditions?.[0];
    expect(clause?.parameter).toBe(AUDIO_REMAINING);
    // A numeric operator, and a numeric value — `true` carried onto an int is
    // the other half of the same mistake.
    expect(["gt", "lt", "eq", "neq"]).toContain(clause?.op);
    expect(typeof clause?.value).toBe("number");
  });

  it("names a condition whose operator its type does not offer", () => {
    // The failure this catches never looks at the number: `is` against an int
    // reads as "equals false". A World carrying one has a transition that can
    // never fire, and nothing else says so — the equality report covers eq/neq,
    // which are true too briefly, not operators that are never true at all.
    const world = testWorld({
      parameters: [{ name: "energy", type: "int", defaultValue: 0 }],
      states: [
        { id: "a", name: "djing-left", clips: [], x: 0, y: 0 },
        { id: "b", name: "dance-floor1", clips: [], x: 0, y: 100 },
      ],
      transitions: [
        {
          id: "t",
          from: "a",
          to: "b",
          conditions: [{ parameter: AUDIO_REMAINING, op: "is", value: 90 }],
          hasExitTime: true,
          exitTime: 1,
          order: 0,
          clips: [],
        },
      ],
    });
    mount(
      <StateGraph
        state={testState({ world, worldReports: testReports(world) })}
        send={harness().send}
      />,
    );

    const shown = screen.getByTestId("mismatched-operators");
    expect(shown.textContent).toContain(AUDIO_REMAINING);
    expect(shown.textContent).toContain("dance-floor1");
  });
  const optionsOf = (select: HTMLElement) =>
    [...select.querySelectorAll("option")].map((o) => o.getAttribute("value"));

  const openTransition = (h: ReturnType<typeof harness>, world: World, id = "t1") => {
    mount(<StateGraph state={graph(world)} send={h.send} />);
    fireEvent.click(screen.getByTestId(`transition-${id}`));
    return screen.getByTestId(`transition-panel-${id}`);
  };

  it("offers every readout in the condition picker, alongside the World's own", () => {
    const picker = within(openTransition(harness(), testWorld())).getByLabelText("condition 0 parameter");

    expect(optionsOf(picker)).toEqual(["ready", ...AUDIO_READOUTS.map((r) => r.name)]);
  });

  it("offers a readout the operators its own type allows, not the bool default", () => {
    const world = testWorld({
      transitions: [
        {
          id: "t1",
          from: "s-couch",
          to: "s-booth",
          clips: [],
          conditions: [{ parameter: AUDIO_REMAINING, op: "lt", value: 5 }],
          hasExitTime: true,
          exitTime: 1,
          order: 0,
        },
      ],
    });
    const ops = within(openTransition(harness(), world)).getByLabelText("condition 0 operator");

    // `audio.remaining` is an int and is not in `world.parameters`, so the type
    // has to come from the registry — the old `?? "bool"` fallback offered
    // is / is not for a number.
    expect(optionsOf(ops)).toEqual(["gt", "lt", "eq", "neq"]);
  });

  it("adds an audio condition to a World that declares no Parameters at all", () => {
    const h = harness();
    const world = testWorld({
      parameters: [],
      transitions: [
        { id: "t1", from: "s-couch", to: "s-booth", clips: [], conditions: [], hasExitTime: true, exitTime: 1, order: 0 },
      ],
    });
    const panel = openTransition(h, world);

    fireEvent.click(within(panel).getByRole("button", { name: "add condition" }));
    expect(h.sent.at(-1)).toMatchObject({ patch: { conditions: [{ parameter: AUDIO_PLAYING }] } });
  });

  it("offers no readout as an Effect target", () => {
    const world = testWorld({ parameters: [{ name: "energy", type: "float", defaultValue: 0 }] });
    mount(<StateGraph state={graph(world)} send={harness().send} />);

    const target = screen.getByLabelText("effect target for lounge");
    expect(optionsOf(target)).toEqual(["energy"]);
  });

  it("offers no readout as an Effect target even if one reaches the Parameter list", () => {
    // The store drops a reserved declaration on load, so this World cannot come
    // off disk. The offer rule is what decides what an author can write, so it
    // refuses on its own rather than trusting a guard in another workspace.
    const world = testWorld({
      parameters: [
        { name: "energy", type: "float", defaultValue: 0 },
        { name: AUDIO_BPM, type: "float", defaultValue: 0 },
      ],
    });
    mount(<StateGraph state={graph(world)} send={harness().send} />);

    expect(optionsOf(screen.getByLabelText("effect target for lounge"))).toEqual(["energy"]);
  });

  it("shows a readout as a value with nothing to type in, and sends nothing", () => {
    const h = harness();
    mount(<StateGraph state={graph(testWorld())} send={h.send} />);

    const row = within(screen.getByTestId("parameters-panel")).getByTestId(`parameter-${AUDIO_BPM}`);
    expect(row.querySelectorAll("input, button, select")).toHaveLength(0);
    // Nothing playing and no transport yet, so the readout is absent from
    // `live.parameters` — the panel shows what it holds while silent rather
    // than `undefined`.
    expect(row).toHaveTextContent("0");
    expect(h.countOf("set-parameter")).toBe(0);
  });

  it("shows what the transport is actually holding", () => {
    // Driven by `audioTransport`, and it has to be: the readouts are kept out of
    // `live.parameters` on purpose — that absence is what stops a steady-state
    // World broadcasting once a second (origin R27) — so a panel reading them
    // there could only ever show the nothing-playing fallback. The fixture this
    // replaced put them in `live.parameters`, which is a state the server cannot
    // produce.
    mount(<StateGraph state={graph(testWorld(), { audioTransport: transport() })} send={harness().send} />);

    expect(readoutRow(AUDIO_BPM)).toHaveTextContent("128");
    expect(readoutRow(AUDIO_PLAYING)).toHaveTextContent("true");
    // One-based, as the readout is: the second of four.
    expect(readoutRow(AUDIO_TRACK)).toHaveTextContent("2");
    expect(readoutRow(AUDIO_TRACKS)).toHaveTextContent("4");
    expect(readoutRow(AUDIO_LENGTH)).toHaveTextContent("300");
    // Ceiling, so the number matches the one the machine evaluates against.
    expect(readoutRow(AUDIO_REMAINING)).toHaveTextContent("239");
  });

  it("says unknown where the machine has no value at all, never zero", () => {
    // A `durationMs` of 0 is *not measured* and an absent bpm is *not
    // established*: the runtime leaves both names out of the readout map, so no
    // clause naming them holds. Printed as `0` they would read as the values
    // that satisfy every below-threshold condition an author wrote.
    mount(
      <StateGraph
        state={graph(testWorld(), { audioTransport: transport({ durationMs: 0, bpm: null }) })}
        send={harness().send}
      />,
    );

    expect(readoutRow(AUDIO_LENGTH)).toHaveTextContent("unknown");
    expect(readoutRow(AUDIO_REMAINING)).toHaveTextContent("unknown");
    expect(readoutRow(AUDIO_BPM)).toHaveTextContent("unknown");
    // The three the transport does know are still numbers.
    expect(readoutRow(AUDIO_TRACKS)).toHaveTextContent("4");
  });

  it("falls back to the silent values when the transport holds nothing", () => {
    mount(
      <StateGraph
        state={graph(testWorld(), { audioTransport: transport({ index: -1, path: null, playing: false }) })}
        send={harness().send}
      />,
    );

    // The runtime publishes the whole idle set here, so the panel shows it —
    // zero everywhere, which is exactly the trap the audio-condition report
    // warns the author about.
    expect(readoutRow(AUDIO_PLAYING)).toHaveTextContent("false");
    expect(readoutRow(AUDIO_TRACK)).toHaveTextContent("0");
    expect(readoutRow(AUDIO_REMAINING)).toHaveTextContent("0");
  });

  it("names a playlist this World plays that the store does not hold", () => {
    const world = testWorld();
    mount(
      <StateGraph
        state={graph(world, {
          worldReports: { ...testReports(world), missingPlaylist: "warmup" },
        })}
        send={harness().send}
      />,
    );

    const section = within(screen.getByTestId("missing-playlist"));
    expect(section.getByText(/warmup/)).toBeInTheDocument();
    // What the author can do about it, which is the point of a report: the
    // reference is left in the manifest, so creating a playlist under that id
    // makes it true again.
    expect(section.getByText(/import the one it names/)).toBeInTheDocument();
  });

  it("says nothing about a playlist the store does hold", () => {
    const world = testWorld();
    mount(<StateGraph state={graph(world)} send={harness().send} />);
    expect(screen.queryByTestId("missing-playlist")).toBeNull();
  });

  it("names a reserved Parameter the manifest declared and the store dropped", () => {
    const world = testWorld({ droppedReserved: [{ name: AUDIO_BPM, type: "float", defaultValue: 0 }] });
    mount(<StateGraph state={graph(world)} send={harness().send} />);

    const section = within(screen.getByTestId("reserved-declarations"));
    expect(section.getByText(new RegExp(AUDIO_BPM))).toBeInTheDocument();
    expect(section.getByText(/Rename it there/)).toBeInTheDocument();
  });

  it("names a numeric audio condition with nothing testing that anything plays", () => {
    const world = testWorld({
      transitions: [
        {
          id: "t1",
          from: "s-couch",
          to: "s-booth",
          clips: [],
          conditions: [{ parameter: AUDIO_REMAINING, op: "lt", value: 5 }],
          hasExitTime: true,
          exitTime: 1,
          order: 0,
        },
      ],
    });
    mount(<StateGraph state={graph(world)} send={harness().send} />);

    expect(within(screen.getByTestId("audio-unguarded")).getByText(/holds in\s+silence/)).toBeInTheDocument();
  });

  it("names an audio condition written as an equality", () => {
    const world = testWorld({
      transitions: [
        {
          id: "t1",
          from: "s-couch",
          to: "s-booth",
          clips: [],
          conditions: [
            { parameter: AUDIO_PLAYING, op: "is", value: true },
            { parameter: AUDIO_REMAINING, op: "eq", value: 5 },
          ],
          hasExitTime: true,
          exitTime: 1,
          order: 0,
        },
      ],
    });
    mount(<StateGraph state={graph(world)} send={harness().send} />);

    expect(within(screen.getByTestId("audio-equality")).getByText(/passes unseen/)).toBeInTheDocument();
  });
});
