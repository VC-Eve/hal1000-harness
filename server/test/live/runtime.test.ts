import { describe, it, expect } from "vitest";
import { WorldRuntime } from "../../src/live/runtime.js";
import { waitFor } from "../wait.js";
import type { ClipRef, Edge, LiveState, Parameter, World, WorldState } from "../../../shared/src/types.js";

const clip = (name: string, durationMs = 4000): ClipRef => ({ path: `clips/${name}.mp4`, durationMs });

const state = (id: string, sceneId: string, positionId: string, clipName: string | null): WorldState => ({
  id,
  sceneId,
  positionId,
  clip: clipName ? clip(clipName) : null,
});

const edge = (over: Partial<Edge> & Pick<Edge, "id" | "from" | "to">): Edge => ({
  kind: "pose",
  conditions: [],
  onClipEnd: true,
  clip: null,
  ...over,
});

const location: Parameter = { name: "location", values: ["couch", "floor", "booth"], defaultValue: "couch" };

function world(over: Partial<World> = {}): World {
  return {
    id: "lounge",
    name: "Lounge",
    positions: [],
    scenes: [],
    states: [],
    edges: [],
    parameters: [],
    struck: [],
    ...over,
  };
}

interface Rig {
  runtime: WorldRuntime;
  seen: LiveState[];
  last(): LiveState;
}

function rig(w: World, opts: { clipUsable?(c: ClipRef): Promise<boolean> } = {}): Rig {
  const seen: LiveState[] = [];
  const runtime = new WorldRuntime(w, { onChange: (live) => seen.push(live), ...opts });
  runtime.start();
  return { runtime, seen, last: () => seen[seen.length - 1]! };
}

/** Drive one clip to its end through the seam and let the transition settle. */
async function stepThrough(r: Rig, times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await waitFor(() => !r.runtime.idle, "a clip to be playing");
    r.runtime.step();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("triggers", () => {
  it("takes an edge whose conditions a Parameter change satisfies", async () => {
    const r = rig(
      world({
        parameters: [location],
        states: [state("couch", "cam", "p-couch", "couch-idle"), state("floor", "cam", "p-floor", "floor-idle")],
        edges: [
          edge({
            id: "e1",
            from: "couch",
            to: "floor",
            kind: "travel",
            onClipEnd: false,
            conditions: [{ parameter: "location", op: "eq", value: "floor" }],
            clip: clip("walk"),
          }),
        ],
      }),
    );

    expect(r.last().stateId).toBe("couch");
    r.runtime.setParameter("location", "floor");
    await waitFor(() => r.last().clip?.path === "clips/walk.mp4", "the walk clip to start");
    await stepThrough(r);

    expect(r.last().stateId).toBe("floor");
    expect(r.last().clip?.path).toBe("clips/floor-idle.mp4");
  });

  it("leaves the State alone when a Parameter change satisfies nothing", async () => {
    const r = rig(
      world({
        parameters: [location],
        states: [state("couch", "cam", "p-couch", "couch-idle"), state("booth", "cam2", "p-booth", "booth-idle")],
        edges: [
          edge({
            id: "e1",
            from: "couch",
            to: "booth",
            onClipEnd: false,
            conditions: [{ parameter: "location", op: "eq", value: "floor" }],
          }),
        ],
      }),
    );

    r.runtime.setParameter("location", "booth");
    // A negative assertion has no condition to poll, so the wait is the point.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(r.last().stateId).toBe("couch");
  });

  it("takes an exit-time edge when the clip ends, with no Parameter change", async () => {
    const r = rig(
      world({
        states: [state("a", "cam", "p", "a-idle"), state("b", "cam", "p", "b-idle")],
        edges: [edge({ id: "e1", from: "a", to: "b", onClipEnd: true })],
      }),
    );

    await stepThrough(r);
    expect(r.last().stateId).toBe("b");
  });

  it("loops the same clip again when a clip ends and nothing is satisfied", async () => {
    const r = rig(world({ states: [state("a", "cam", "p", "a-idle")] }));

    const before = r.last().generation;
    await stepThrough(r);
    expect(r.last().stateId).toBe("a");
    expect(r.last().clip?.path).toBe("clips/a-idle.mp4");
    expect(r.last().generation).toBeGreaterThan(before);
  });

  it("fires clip end from its own timer, with no seam involved", async () => {
    // The seam must not be the only path tested: a seam every test uses leaves
    // the production trigger — the timer — entirely uncovered.
    const r = rig(
      world({
        states: [
          { id: "a", sceneId: "cam", positionId: "p", clip: { path: "clips/a.mp4", durationMs: 20 } },
          state("b", "cam", "p", "b-idle"),
        ],
        edges: [edge({ id: "e1", from: "a", to: "b", onClipEnd: true })],
      }),
    );

    await waitFor(() => r.last().stateId === "b", "the timer to end the clip and take the edge");
  });
});

describe("conditions over more than one Parameter", () => {
  it("reads both when two are non-default", async () => {
    const energy: Parameter = { name: "energy", values: ["low", "high"], defaultValue: "low" };
    const r = rig(
      world({
        parameters: [location, energy],
        states: [state("couch", "cam", "p", "couch-idle"), state("dance", "cam", "p", "dance")],
        edges: [
          edge({
            id: "e1",
            from: "couch",
            to: "dance",
            onClipEnd: false,
            conditions: [
              { parameter: "location", op: "eq", value: "floor" },
              { parameter: "energy", op: "eq", value: "high" },
            ],
          }),
        ],
      }),
    );

    r.runtime.setParameter("location", "floor");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(r.last().stateId).toBe("couch");

    r.runtime.setParameter("energy", "high");
    await waitFor(() => r.last().stateId === "dance", "both conditions to be read together");
  });
});

describe("a Cut", () => {
  const cutWorld = (samePosition = false) =>
    world({
      parameters: [location],
      states: [
        state("floor-a", "cam-a", "p-floor", "floor-a-idle"),
        state("floor-b", "cam-b", samePosition ? "p-floor" : "p-floor-b", "floor-b-idle"),
      ],
      edges: [
        edge({
          id: "cut",
          kind: "cut",
          from: "floor-a",
          to: "floor-b",
          onClipEnd: false,
          conditions: [{ parameter: "location", op: "eq", value: "booth" }],
          clip: clip("exit-right"),
          entryClip: clip("enter-left"),
          exitEdge: "right",
          entryEdge: "left",
        }),
      ],
    });

  it("plays exit then entry, changes Scene on the join, and arrives only at the end", async () => {
    // Covers F2.
    const r = rig(cutWorld());
    r.runtime.setParameter("location", "booth");

    await waitFor(() => r.last().clip?.path === "clips/exit-right.mp4", "the exit clip");
    expect(r.last().phase).toBe("playing");
    expect(r.last().sceneId).toBe("cam-a");
    expect(r.last().stateId).toBe("floor-a");

    await stepThrough(r);
    expect(r.last().clip?.path).toBe("clips/enter-left.mp4");
    expect(r.last().phase).toBe("cutting");
    // The camera changed on the join, before the destination State is reached.
    expect(r.last().sceneId).toBe("cam-b");
    expect(r.last().stateId).toBe("floor-a");

    await stepThrough(r);
    expect(r.last().stateId).toBe("floor-b");
    expect(r.last().phase).toBe("holding");
  });

  it("plays a re-frame with no travel clip between the two halves", async () => {
    // Covers R16: two States at the same Position, exit and entry, nothing else.
    const r = rig(cutWorld(true));
    r.runtime.setParameter("location", "booth");

    const paths: string[] = [];
    await waitFor(() => r.last().phase === "playing", "the Cut to start");
    paths.push(r.last().clip!.path);
    await stepThrough(r);
    paths.push(r.last().clip!.path);
    await stepThrough(r);

    expect(paths).toEqual(["clips/exit-right.mp4", "clips/enter-left.mp4"]);
    expect(r.last().stateId).toBe("floor-b");
  });
});

describe("one edge at a time", () => {
  const circuit = () =>
    world({
      parameters: [location],
      states: [
        state("couch", "cam-a", "p-couch", "couch-idle"),
        state("floor-a", "cam-a", "p-floor", "floor-a-idle"),
        state("floor-b", "cam-b", "p-floor", "floor-b-idle"),
        state("booth", "cam-b", "p-booth", "booth-idle"),
      ],
      edges: [
        edge({ id: "out1", kind: "travel", from: "couch", to: "floor-a", conditions: [{ parameter: "location", op: "eq", value: "booth" }], clip: clip("walk-out") }),
        edge({ id: "out2", kind: "cut", from: "floor-a", to: "floor-b", conditions: [{ parameter: "location", op: "eq", value: "booth" }], clip: clip("exit-r"), entryClip: clip("enter-l"), exitEdge: "right", entryEdge: "left" }),
        edge({ id: "out3", kind: "travel", from: "floor-b", to: "booth", conditions: [{ parameter: "location", op: "eq", value: "booth" }], clip: clip("walk-booth") }),
        edge({ id: "back1", kind: "travel", from: "booth", to: "floor-b", conditions: [{ parameter: "location", op: "eq", value: "couch" }], clip: clip("leave-booth") }),
        edge({ id: "back2", kind: "cut", from: "floor-b", to: "floor-a", conditions: [{ parameter: "location", op: "eq", value: "couch" }], clip: clip("exit-l"), entryClip: clip("enter-r"), exitEdge: "left", entryEdge: "right" }),
        edge({ id: "back3", kind: "travel", from: "floor-a", to: "couch", conditions: [{ parameter: "location", op: "eq", value: "couch" }], clip: clip("walk-back") }),
      ],
    });

  it("takes one edge and holds rather than chaining to the destination", async () => {
    // Covers R21. The destination is two hops away; one evaluation must not
    // walk the whole route.
    const r = rig(circuit());
    r.runtime.setParameter("location", "booth");

    // The couch idle ends, the walk plays, and the character arrives at
    // floor-a — one edge. The Cut waiting there is not also taken.
    await stepThrough(r, 2);
    expect(r.last().stateId).toBe("floor-a");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(r.last().stateId).toBe("floor-a");
  });

  it("drives the whole couch to booth to couch circuit and returns", async () => {
    const r = rig(circuit());

    r.runtime.setParameter("location", "booth");
    // couch idle, walk-out, floor-a idle, exit, entry, floor-b idle,
    // walk-booth: seven clips for three edges, which is what a claim about the
    // tenth transition rather than the first has to survive.
    await stepThrough(r, 7);
    expect(r.last().stateId).toBe("booth");

    r.runtime.setParameter("location", "couch");
    await stepThrough(r, 7);
    expect(r.last().stateId).toBe("couch");
    expect(r.last().clip?.path).toBe("clips/couch-idle.mp4");
  });
});

describe("supersede and faults", () => {
  it("supersedes an in-flight transition so the stale clip does not land", async () => {
    const r = rig(
      world({
        parameters: [location],
        states: [
          state("couch", "cam", "p1", "couch-idle"),
          state("floor", "cam", "p2", "floor-idle"),
          state("door", "cam", "p3", "door-idle"),
        ],
        edges: [
          edge({ id: "e1", kind: "travel", onClipEnd: false, from: "couch", to: "floor", conditions: [{ parameter: "location", op: "eq", value: "floor" }], clip: clip("walk-floor") }),
          edge({ id: "e2", kind: "travel", onClipEnd: false, from: "couch", to: "door", conditions: [{ parameter: "location", op: "eq", value: "booth" }], clip: clip("walk-door") }),
        ],
      }),
    );

    r.runtime.setParameter("location", "floor");
    await waitFor(() => r.last().clip?.path === "clips/walk-floor.mp4", "the first walk");
    r.runtime.setParameter("location", "booth");
    await waitFor(() => r.last().clip?.path === "clips/walk-door.mp4", "the superseding walk");
    await stepThrough(r);

    expect(r.last().stateId).toBe("door");
    // The superseded transition never arrived at its own destination.
    expect(r.seen.every((live) => live.stateId !== "floor")).toBe(true);
  });

  it("faults a transition whose clip will not resolve, rather than looping on", async () => {
    const r = rig(
      world({
        parameters: [location],
        states: [state("couch", "cam", "p1", "couch-idle"), state("floor", "cam", "p2", "gone")],
        edges: [
          edge({ id: "e1", kind: "travel", onClipEnd: false, from: "couch", to: "floor", conditions: [{ parameter: "location", op: "eq", value: "floor" }], clip: clip("walk") }),
        ],
      }),
      { clipUsable: async (c) => c.path !== "clips/gone.mp4" },
    );

    r.runtime.setParameter("location", "floor");
    await waitFor(() => r.last().fault !== null, "the fault to be reported");
    expect(r.last().stateId).toBe("couch");
    expect(r.last().clip).toBeNull();
  });
});

describe("triggers racing the pre-flight checks", () => {
  const twoWays = () =>
    world({
      parameters: [location],
      states: [
        state("couch", "cam", "p1", "couch-idle"),
        state("floor", "cam", "p2", "floor-idle"),
        state("door", "cam", "p3", "door-idle"),
      ],
      edges: [
        edge({ id: "e1", kind: "travel", onClipEnd: false, from: "couch", to: "floor", conditions: [{ parameter: "location", op: "eq", value: "floor" }], clip: clip("walk-floor") }),
        edge({ id: "e2", kind: "travel", onClipEnd: false, from: "couch", to: "door", conditions: [{ parameter: "location", op: "eq", value: "booth" }], clip: clip("walk-door") }),
      ],
    });

  it("does not let an edge superseded during its clip checks still land", async () => {
    // The generation used to be claimed AFTER the three clip-usability awaits.
    // Two triggers inside that window left two transitions in flight, and
    // whichever resumed second bumped blind and landed the character in a State
    // the other had already abandoned. `clipUsable` is deliberately slow here,
    // because a fake that resolves immediately closes the very window that
    // breaks.
    let gate: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      gate = resolve;
    });
    let first = true;
    const r = rig(twoWays(), {
      clipUsable: async () => {
        if (first) {
          first = false;
          await held;
        }
        return true;
      },
    });

    r.runtime.setParameter("location", "floor");
    // The first transition is now suspended inside its clip checks.
    r.runtime.setParameter("location", "booth");
    await waitFor(() => r.last().clip?.path === "clips/walk-door.mp4", "the superseding walk to start");
    gate!();
    await new Promise((resolve) => setImmediate(resolve));
    await stepThrough(r);

    expect(r.last().stateId).toBe("door");
    expect(r.seen.every((live) => live.stateId !== "floor")).toBe(true);
    expect(r.last().fault).toBeNull();
  });

  it("does not let a stale transition's fault wedge the one that replaced it", async () => {
    // A pre-flight check that lost its race used to call faulted(), which
    // cleared the live transition's pending clip and left the World stuck
    // behind a fault from an edge it was not taking.
    let gate: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      gate = resolve;
    });
    let first = true;
    const r = rig(twoWays(), {
      clipUsable: async (c) => {
        if (first) {
          first = false;
          await held;
          return false;
        }
        return c.path !== "clips/never.mp4";
      },
    });

    r.runtime.setParameter("location", "floor");
    r.runtime.setParameter("location", "booth");
    await waitFor(() => r.last().clip?.path === "clips/walk-door.mp4", "the superseding walk");
    gate!();
    await new Promise((resolve) => setImmediate(resolve));

    expect(r.last().fault).toBeNull();
    await stepThrough(r);
    expect(r.last().stateId).toBe("door");
  });
});

describe("teardown", () => {
  it("resolves a clip a stopped runtime was waiting on, rather than suspending it forever", async () => {
    // stop() used to clear the pending timer without resolving its promise, so
    // a take() suspended mid-Cut never resumed — one leaked coroutine per stop,
    // and a Cut that had already changed the camera never arriving.
    const r = rig(
      world({
        parameters: [location],
        states: [state("a", "cam", "p", "a-idle"), state("b", "cam2", "p", "b-idle")],
        edges: [
          edge({ id: "cut", kind: "cut", from: "a", to: "b", onClipEnd: false, conditions: [{ parameter: "location", op: "eq", value: "booth" }], clip: clip("exit"), entryClip: clip("entry"), exitEdge: "right", entryEdge: "left" }),
        ],
      }),
    );
    r.runtime.setParameter("location", "booth");
    await waitFor(() => r.last().clip?.path === "clips/exit.mp4", "the exit clip");

    r.runtime.stop();
    await new Promise((resolve) => setImmediate(resolve));

    // Restarted, the World holds at its default State. The abandoned Cut must
    // not resume and deliver its destination on top of that — which is what a
    // transition still suspended on an unresolved promise would eventually do.
    r.runtime.start();
    await waitFor(() => r.last().stateId === "a" && r.last().phase === "holding", "a clean restart");
    const after = r.seen.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(r.seen.slice(after).every((live) => live.stateId !== "b")).toBe(true);
  });

  it("says nothing at all once stopped", async () => {
    // Switching Worlds stops the outgoing runtime; a transition still unwinding
    // inside it must not broadcast the closed World's clip to clients already
    // showing the new one.
    const r = rig(
      world({
        parameters: [location],
        states: [state("a", "cam", "p", "a-idle"), state("b", "cam2", "p", "b-idle")],
        edges: [edge({ id: "e1", from: "a", to: "b", onClipEnd: true, clip: clip("walk") })],
      }),
    );
    await waitFor(() => !r.runtime.idle, "the loop to arm");

    r.runtime.stop();
    const seen = r.seen.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(r.seen.length).toBe(seen);
  });
});

describe("a duration the manifest should not be trusted about", () => {
  it("clamps a duration past the 32-bit timer ceiling instead of firing every millisecond", async () => {
    // setTimeout truncates its delay to 32 bits: 2^40 ms becomes a ~1ms timer,
    // and the machine then advances and broadcasts a thousand times a second.
    const r = rig(
      world({
        states: [{ id: "a", sceneId: "cam", positionId: "p", clip: { path: "clips/a.mp4", durationMs: 2 ** 40 } }],
      }),
    );

    const seen = r.seen.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(r.seen.length).toBe(seen);
  });
});

describe("clip-end reports from a browser", () => {
  const looping = () =>
    world({
      states: [state("a", "cam", "p", "a-idle"), state("b", "cam", "p", "b-idle")],
      edges: [edge({ id: "e1", from: "a", to: "b", onClipEnd: true })],
    });

  it("advances once for two identical reports", async () => {
    const r = rig(looping());
    const live = r.last();

    expect(r.runtime.reportClipEnd(live.worldId, live.stateId!, live.generation)).toBe(true);
    expect(r.runtime.reportClipEnd(live.worldId, live.stateId!, live.generation)).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));

    expect(r.last().stateId).toBe("b");
  });

  it("discards a report naming a superseded generation", async () => {
    const r = rig(looping());
    const stale = r.last().generation;
    await stepThrough(r);

    expect(r.runtime.reportClipEnd("lounge", "b", stale)).toBe(false);
    expect(r.last().stateId).toBe("b");
  });

  it("discards a report naming another World", async () => {
    const r = rig(looping());
    const live = r.last();
    expect(r.runtime.reportClipEnd("somewhere-else", live.stateId!, live.generation)).toBe(false);
  });
});

describe("with nothing watching", () => {
  it("drives a full Cut to its destination with no client attached", async () => {
    // The headless case KTD1 exists for. Real durations, no seam, no socket:
    // a browser-sourced clip-end signal would take one edge here and freeze,
    // possibly mid-Cut with the camera already changed.
    const short = (name: string): ClipRef => ({ path: `clips/${name}.mp4`, durationMs: 15 });
    const runtime = new WorldRuntime(
      world({
        parameters: [location],
        states: [
          { id: "floor-a", sceneId: "cam-a", positionId: "p", clip: short("floor-a-idle") },
          { id: "floor-b", sceneId: "cam-b", positionId: "p", clip: short("floor-b-idle") },
        ],
        edges: [
          edge({
            id: "cut",
            kind: "cut",
            from: "floor-a",
            to: "floor-b",
            onClipEnd: false,
            conditions: [{ parameter: "location", op: "eq", value: "booth" }],
            clip: short("exit"),
            entryClip: short("entry"),
            exitEdge: "right",
            entryEdge: "left",
          }),
        ],
      }),
      { onChange: () => {} },
    );
    runtime.start();
    runtime.setParameter("location", "booth");

    await waitFor(() => runtime.live().stateId === "floor-b" && runtime.live().phase === "holding", "the Cut to complete unattended");
    runtime.stop();
  });
});
