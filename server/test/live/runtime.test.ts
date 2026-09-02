import { describe, it, expect } from "vitest";
import { WorldRuntime } from "../../src/live/runtime.js";
import { waitFor } from "../wait.js";
import { WORLD_VERSION } from "../../../shared/src/worlds.js";
import type { ClipRef, LiveState, Parameter, Transition, World, WorldState } from "../../../shared/src/types.js";

const clip = (name: string, durationMs = 4000): ClipRef => ({ path: `clips/${name}.mp4`, durationMs });

const state = (id: string, clipName: string | null = id, durationMs = 4000): WorldState => ({
  id,
  name: id,
  clip: clipName ? clip(clipName, durationMs) : null,
  x: 0,
  y: 0,
});

const transition = (over: Partial<Transition> & Pick<Transition, "id" | "to">): Transition => ({
  conditions: [],
  hasExitTime: true,
  exitTime: 1,
  order: 0,
  ...over,
});

const bool = (name: string, defaultValue = false): Parameter => ({ name, type: "bool", defaultValue });
const trigger = (name: string): Parameter => ({ name, type: "trigger", defaultValue: false });
const float = (name: string, defaultValue = 0): Parameter => ({ name, type: "float", defaultValue });

function world(over: Partial<World> = {}): World {
  return {
    version: WORLD_VERSION,
    id: "lounge",
    name: "Lounge",
    defaultStateId: "a",
    states: [],
    transitions: [],
    parameters: [],
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

/** Resolve the current wait through the seam and let the machine settle. */
async function stepThrough(r: Rig, times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await waitFor(() => !r.runtime.idle, "a clip to be playing");
    r.runtime.step();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("where it starts", () => {
  it("starts at the declared default, not at the first State in the file", () => {
    const r = rig(world({ defaultStateId: "b", states: [state("a"), state("b")] }));
    expect(r.last().stateId).toBe("b");
  });

  it("starts nowhere when the default names no State", () => {
    const r = rig(world({ defaultStateId: null, states: [state("a")] }));
    expect(r.last().stateId).toBeNull();
  });

  it("seeds every Parameter at its declared default", () => {
    const r = rig(world({ states: [state("a")], parameters: [bool("ready", true), float("energy", 0.4)] }));
    expect(r.last().parameters).toEqual({ ready: true, energy: 0.4 });
  });
});

describe("exit time", () => {
  const twoStates = (exitTime: number, conditions: Transition["conditions"] = []) =>
    world({
      states: [state("a", "a", 400), state("b")],
      parameters: [bool("ready")],
      transitions: [transition({ id: "t", from: "a", to: "b", exitTime, conditions })],
    });

  it("fires part way through the clip rather than at its end", async () => {
    // Covers AE1. 0.75 of a 400ms clip is 300ms; the end would be 400ms.
    const r = rig(twoStates(0.75));
    const started = Date.now();
    await waitFor(() => r.last().stateId === "b", "the transition to be taken");

    expect(Date.now() - started).toBeLessThan(390);
  });

  it("checks conditions only once the exit time is reached", async () => {
    // Covers AE2. The condition is true from the start; nothing may happen
    // before 0.75 of the clip.
    const r = rig(twoStates(0.75, [{ parameter: "ready", op: "is", value: true }]));
    r.runtime.setParameter("ready", true);

    // A negative assertion has no condition to poll, so the wait is the point.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(r.last().stateId).toBe("a");
    await waitFor(() => r.last().stateId === "b", "the exit time to arrive");
  });

  it("fires again on the next loop", async () => {
    const r = rig(
      world({
        states: [state("a", "a", 200), state("b")],
        parameters: [bool("ready")],
        transitions: [
          transition({
            id: "t",
            from: "a",
            to: "b",
            exitTime: 0.5,
            conditions: [{ parameter: "ready", op: "is", value: true }],
          }),
        ],
      }),
    );
    // Nothing is satisfied on the first pass, so the clip loops.
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(r.last().stateId).toBe("a");

    r.runtime.setParameter("ready", true);
    // A later loop's exit time picks it up, which is what "below 1 is checked
    // each loop" means.
    await waitFor(() => r.last().stateId === "b", "a later loop to take it");
  });

  it("wakes at the earlier of two exit times", async () => {
    const r = rig(
      world({
        states: [state("a", "a", 400), state("b"), state("c")],
        parameters: [bool("early"), bool("late")],
        transitions: [
          transition({
            id: "late",
            from: "a",
            to: "c",
            exitTime: 0.9,
            order: 0,
            conditions: [{ parameter: "late", op: "is", value: true }],
          }),
          transition({
            id: "early",
            from: "a",
            to: "b",
            exitTime: 0.2,
            order: 1,
            conditions: [{ parameter: "early", op: "is", value: true }],
          }),
        ],
      }),
    );
    r.runtime.setParameter("early", true);
    r.runtime.setParameter("late", true);
    await waitFor(() => r.last().stateId !== "a", "a wake point");

    // Both are satisfiable; the one due first is the one taken.
    expect(r.last().stateId).toBe("b");
  });

  it("takes a transition with no exit time only on a Parameter change", async () => {
    const r = rig(
      world({
        states: [state("a", "a", 150), state("b")],
        parameters: [bool("ready")],
        transitions: [
          transition({
            id: "t",
            from: "a",
            to: "b",
            hasExitTime: false,
            conditions: [{ parameter: "ready", op: "is", value: true }],
          }),
        ],
      }),
    );
    // Several full loops with the condition false: nothing happens.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(r.last().stateId).toBe("a");

    r.runtime.setParameter("ready", true);
    await waitFor(() => r.last().stateId === "b", "the immediate transition");
  });

  it("loops when nothing is satisfied at the end", async () => {
    const r = rig(world({ states: [state("a")] }));
    const before = r.last().generation;
    await stepThrough(r);
    expect(r.last().stateId).toBe("a");
    expect(r.last().generation).toBeGreaterThan(before);
  });

  it("holds silently in a State with no clip", async () => {
    const r = rig(
      world({
        states: [state("a", null), state("b")],
        transitions: [transition({ id: "t", from: "a", to: "b" })],
      }),
    );
    // Nothing to end, so nothing triggers.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(r.last().stateId).toBe("a");
    expect(r.runtime.idle).toBe(true);
  });
});

describe("Triggers", () => {
  const waveWorld = () =>
    world({
      states: [state("a"), state("wave")],
      parameters: [trigger("wave")],
      transitions: [
        transition({
          id: "t",
          from: "a",
          to: "wave",
          hasExitTime: false,
          conditions: [{ parameter: "wave", op: "is", value: true }],
        }),
      ],
    });

  it("is consumed by the transition that read it", async () => {
    // Covers AE3.
    const r = rig(waveWorld());
    r.runtime.setParameter("wave", true);
    await waitFor(() => r.last().stateId === "wave", "the wave");

    expect(r.last().parameters.wave).toBe(false);
  });

  it("does not fire the transition a second time without being set again", async () => {
    const r = rig(
      world({
        ...waveWorld(),
        states: [state("a", "a", 80), state("wave", "wave", 80)],
        transitions: [...waveWorld().transitions, transition({ id: "back", from: "wave", to: "a" })],
      }),
    );
    r.runtime.setParameter("wave", true);
    await waitFor(() => r.last().stateId === "wave", "the wave");
    await waitFor(() => r.last().stateId === "a", "the return");

    // Back at the start with the Trigger cleared, nothing pulls it out again.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(r.last().stateId).toBe("a");
  });

  it("stays set when no transition reads it, and is broadcast anyway", async () => {
    // A value the author set and the machine did not act on is still a value
    // they need to see — otherwise the control snaps back to the last broadcast.
    const r = rig(world({ states: [state("a")], parameters: [trigger("wave")] }));
    const before = r.seen.length;
    r.runtime.setParameter("wave", true);

    expect(r.seen.length).toBeGreaterThan(before);
    expect(r.last().parameters.wave).toBe(true);
    expect(r.runtime.parameters().wave).toBe(true);
  });
});

describe("Any State", () => {
  it("outranks a transition out of the current State", async () => {
    // Covers AE4.
    const r = rig(
      world({
        states: [state("a"), state("own"), state("any")],
        parameters: [bool("go")],
        transitions: [
          transition({
            id: "own",
            from: "a",
            to: "own",
            hasExitTime: false,
            conditions: [{ parameter: "go", op: "is", value: true }],
          }),
          transition({
            id: "any",
            fromAny: true,
            to: "any",
            hasExitTime: false,
            conditions: [{ parameter: "go", op: "is", value: true }],
          }),
        ],
      }),
    );
    r.runtime.setParameter("go", true);
    await waitFor(() => r.last().stateId !== "a", "a transition to be taken");
    expect(r.last().stateId).toBe("any");
  });

  it("is offered from every State", async () => {
    const r = rig(
      world({
        defaultStateId: "b",
        states: [state("a"), state("b"), state("wave")],
        parameters: [trigger("wave")],
        transitions: [
          transition({
            id: "any",
            fromAny: true,
            to: "wave",
            hasExitTime: false,
            conditions: [{ parameter: "wave", op: "is", value: true }],
          }),
        ],
      }),
    );
    r.runtime.setParameter("wave", true);
    await waitFor(() => r.last().stateId === "wave", "the wave from b");
  });
});

describe("mute, solo and order", () => {
  const two = (over: Partial<Transition>[] = [{}, {}]) =>
    world({
      states: [state("a"), state("first"), state("second")],
      parameters: [bool("go")],
      transitions: [
        transition({
          id: "first",
          from: "a",
          to: "first",
          order: 0,
          hasExitTime: false,
          conditions: [{ parameter: "go", op: "is", value: true }],
          ...over[0],
        }),
        transition({
          id: "second",
          from: "a",
          to: "second",
          order: 1,
          hasExitTime: false,
          conditions: [{ parameter: "go", op: "is", value: true }],
          ...over[1],
        }),
      ],
    });

  it("takes the first in order when both are satisfied", async () => {
    const r = rig(two());
    r.runtime.setParameter("go", true);
    await waitFor(() => r.last().stateId !== "a", "a transition");
    expect(r.last().stateId).toBe("first");
  });

  it("takes the other one when the order is swapped", async () => {
    const r = rig(two([{ order: 1 }, { order: 0 }]));
    r.runtime.setParameter("go", true);
    await waitFor(() => r.last().stateId !== "a", "a transition");
    expect(r.last().stateId).toBe("second");
  });

  it("never takes a muted transition", async () => {
    const r = rig(two([{ muted: true }, {}]));
    r.runtime.setParameter("go", true);
    await waitFor(() => r.last().stateId !== "a", "a transition");
    expect(r.last().stateId).toBe("second");
  });

  it("considers only the soloed one", async () => {
    // Covers AE5.
    const r = rig(two([{}, { solo: true }]));
    r.runtime.setParameter("go", true);
    await waitFor(() => r.last().stateId !== "a", "a transition");
    expect(r.last().stateId).toBe("second");
  });
});

describe("typed conditions", () => {
  it("takes a numeric transition when the comparison holds, and not otherwise", async () => {
    const r = rig(
      world({
        states: [state("a"), state("b")],
        parameters: [float("energy", 0)],
        transitions: [
          transition({
            id: "t",
            from: "a",
            to: "b",
            hasExitTime: false,
            conditions: [{ parameter: "energy", op: "gt", value: 0.5 }],
          }),
        ],
      }),
    );
    r.runtime.setParameter("energy", 0.2);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(r.last().stateId).toBe("a");

    r.runtime.setParameter("energy", 0.9);
    await waitFor(() => r.last().stateId === "b", "the comparison to hold");
  });

  it("refuses a value the Parameter's type cannot hold", () => {
    const r = rig(world({ states: [state("a")], parameters: [bool("ready")] }));
    expect(r.runtime.setParameter("ready", 1 as never)).toBe(false);
    expect(r.runtime.setParameter("missing", true)).toBe(false);
    expect(r.last().parameters.ready).toBe(false);
  });
});

describe("supersede, faults and teardown", () => {
  it("does not let a transition superseded during its destination check still land", async () => {
    let gate: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      gate = resolve;
    });
    let first = true;
    const r = rig(
      world({
        states: [state("a"), state("slow"), state("fast")],
        parameters: [bool("slow"), bool("fast")],
        transitions: [
          transition({
            id: "slow",
            from: "a",
            to: "slow",
            order: 0,
            hasExitTime: false,
            conditions: [{ parameter: "slow", op: "is", value: true }],
          }),
          transition({
            id: "fast",
            from: "a",
            to: "fast",
            order: 1,
            hasExitTime: false,
            conditions: [{ parameter: "fast", op: "is", value: true }],
          }),
        ],
      }),
      {
        // Deliberately slow: a fake that resolves immediately closes the very
        // window that breaks.
        clipUsable: async () => {
          if (first) {
            first = false;
            await held;
          }
          return true;
        },
      },
    );

    r.runtime.setParameter("slow", true);
    // The first transition is now suspended inside its destination check.
    // Clearing its condition and setting the other's is what makes the second
    // trigger pick a different transition rather than the same one again.
    r.runtime.setParameter("slow", false);
    r.runtime.setParameter("fast", true);
    await waitFor(() => r.last().stateId === "fast", "the superseding transition");
    gate!();
    await new Promise((resolve) => setImmediate(resolve));

    expect(r.last().stateId).toBe("fast");
    expect(r.seen.every((live) => live.stateId !== "slow")).toBe(true);
    expect(r.last().fault).toBeNull();
  });

  it("faults and rests when the destination's clip will not resolve", async () => {
    const r = rig(
      world({
        states: [state("a"), state("gone")],
        parameters: [bool("go")],
        transitions: [
          transition({
            id: "t",
            from: "a",
            to: "gone",
            hasExitTime: false,
            conditions: [{ parameter: "go", op: "is", value: true }],
          }),
        ],
      }),
      { clipUsable: async (c) => c.path !== "clips/gone.mp4" },
    );
    r.runtime.setParameter("go", true);
    await waitFor(() => r.last().fault !== null, "the fault");

    expect(r.last().stateId).toBe("a");
    expect(r.last().clip).toBeNull();
  });

  it("says nothing at all once stopped", async () => {
    const r = rig(world({ states: [state("a", "a", 60)] }));
    await waitFor(() => !r.runtime.idle, "the clip to be running");

    r.runtime.stop();
    const seen = r.seen.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(r.seen.length).toBe(seen);
  });

  it("clamps a duration past the 32-bit timer ceiling instead of firing every millisecond", async () => {
    const r = rig(world({ states: [{ ...state("a"), clip: { path: "clips/a.mp4", durationMs: 2 ** 40 } }] }));
    const seen = r.seen.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(r.seen.length).toBe(seen);
  });
});

describe("clip-end reports from a browser", () => {
  const looping = () =>
    world({
      states: [state("a"), state("b")],
      transitions: [transition({ id: "t", from: "a", to: "b" })],
    });

  it("advances once for two identical reports", async () => {
    const r = rig(looping());
    const live = r.last();

    expect(r.runtime.reportClipEnd(live.worldId, live.stateId!, live.generation)).toBe(true);
    expect(r.runtime.reportClipEnd(live.worldId, live.stateId!, live.generation)).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));

    expect(r.last().stateId).toBe("b");
  });

  it("discards a stale generation and another World's report", async () => {
    const r = rig(looping());
    const stale = r.last().generation;
    await stepThrough(r);

    expect(r.runtime.reportClipEnd("lounge", "b", stale)).toBe(false);
    expect(r.runtime.reportClipEnd("elsewhere", "b", r.last().generation)).toBe(false);
    expect(r.last().stateId).toBe("b");
  });
});

describe("with nothing watching", () => {
  it("drives the machine through two States on its own timer", async () => {
    // The headless case the server-side runtime exists for: real durations, no
    // seam, no socket.
    const runtime = new WorldRuntime(
      world({
        states: [state("a", "a", 40), state("b", "b", 40), state("c")],
        transitions: [
          transition({ id: "t1", from: "a", to: "b" }),
          transition({ id: "t2", from: "b", to: "c" }),
        ],
      }),
      { onChange: () => {} },
    );
    runtime.start();

    await waitFor(() => runtime.live().stateId === "c", "the machine to walk itself to c");
    runtime.stop();
  });
});
