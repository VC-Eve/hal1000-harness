import { describe, it, expect, vi } from "vitest";
import { MAX_BRIDGE_MS, MIN_CLIP_MS, WorldRuntime } from "../../src/live/runtime.js";
import { waitFor } from "../wait.js";
import { WORLD_VERSION } from "../../../shared/src/worlds.js";
import type { ClipRef, ClipSequence, LiveState, Parameter, Transition, World, WorldState } from "../../../shared/src/types.js";

const clip = (name: string, durationMs = 4000): ClipRef => ({ path: `clips/${name}.mp4`, durationMs });

/** One clip as a run of one — what a set held before sequences existed. */
const solo = (name: string, durationMs = 4000): ClipSequence => ({ clips: [clip(name, durationMs)] });

/** Several clips as one run, played in order. */
const run = (names: string[], durationMs = 4000): ClipSequence => ({
  clips: names.map((n) => clip(n, durationMs)),
});

const state = (id: string, clipName: string | null = id, durationMs = 4000): WorldState => ({
  id,
  name: id,
  clips: clipName ? [solo(clipName, durationMs)] : [],
  x: 0,
  y: 0,
});

/** A State holding several runs — the shape the single-clip fixtures cannot reach. */
const stateOf = (id: string, names: string[], durationMs = 4000): WorldState => ({
  id,
  name: id,
  clips: names.map((n) => solo(n, durationMs)),
  x: 0,
  y: 0,
});

/** A State holding one run of several clips. */
const stateRun = (id: string, names: string[], durationMs = 4000, atomic = false): WorldState => ({
  id,
  name: id,
  clips: [run(names, durationMs)],
  atomic,
  x: 0,
  y: 0,
});

const transition = (over: Partial<Transition> & Pick<Transition, "id" | "to">): Transition => ({
  clips: [],
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

function rig(
  w: World,
  opts: { clipUsable?(c: ClipRef): Promise<boolean>; random?(): number } = {},
): Rig {
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
    const r = rig(world({ states: [{ ...state("a"), clips: [{ clips: [{ path: "clips/a.mp4", durationMs: 2 ** 40 }] }] }] }));
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
    // The clip has to actually be playing before a report about it means
    // anything — the wait is armed once its usability is proved.
    await waitFor(() => !r.runtime.idle, "the clip");
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

describe("what the review of 2026-09-02 found", () => {
  it("does not restart the playing clip for a mutation that leaves it alone", async () => {
    // A rename sends one message per keystroke. Restarting on each was a visible
    // stutter, and it reset how far through the clip the machine believed it
    // was — so an exit time near the end could never be reached while typing.
    const w = world({ states: [state("a"), state("b")], defaultStateId: "a" });
    const r = rig(w);
    await waitFor(() => !r.runtime.idle, "the first clip");
    const generation = r.last().generation;

    r.runtime.setWorld({ ...w, states: [{ ...w.states[0]!, name: "renamed" }, w.states[1]!] });

    expect(r.last().generation).toBe(generation);
    expect(r.runtime.idle).toBe(false);
  });

  it("restarts when the current State's clip actually changes", async () => {
    const w = world({ states: [state("a")], defaultStateId: "a" });
    const r = rig(w);
    await waitFor(() => !r.runtime.idle, "the first clip");
    const generation = r.last().generation;

    r.runtime.setWorld({ ...w, states: [{ ...w.states[0]!, clips: [solo("other")] }] });

    expect(r.last().generation).not.toBe(generation);
    expect(r.last().clip?.path).toBe("clips/other.mp4");
  });

  it("offers a transition with no conditions and no exit time at clip end (R10)", async () => {
    // Nothing sets a Parameter here — there are none. Offering a non-waiting
    // transition only on a Parameter change left this one unable to fire.
    const w = world({
      states: [state("a"), state("b")],
      transitions: [transition({ id: "t", from: "a", to: "b", hasExitTime: false })],
    });
    const r = rig(w);

    await stepThrough(r);
    await waitFor(() => r.last().stateId === "b", "the machine to move on at clip end");
  });

  it("reaches a transition whose exit time is 0 rather than stranding it", async () => {
    const w = world({
      states: [state("a"), state("b")],
      transitions: [transition({ id: "t", from: "a", to: "b", hasExitTime: true, exitTime: 0 })],
    });
    const r = rig(w);

    await stepThrough(r);
    await waitFor(() => r.last().stateId === "b", "the 0 exit time to be offered");
  });

  it("paces a sub-second clip at the floor, not at the reported millisecond", async () => {
    // A duration of 1ms makes the machine enter, broadcast and re-issue a
    // thousand times a second — and the number is persisted, so a restart walks
    // back into it.
    //
    // Asserted on the delay actually scheduled rather than on how many
    // broadcasts arrive in a wall-clock window: under load the buggy code can
    // be starved into looking well-behaved, which would let the regression back
    // in green.
    const delays: number[] = [];
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    try {
      const w = world({ states: [state("a", "a", 1)], defaultStateId: "a" });
      const r = rig(w);
      await waitFor(() => !r.runtime.idle, "the clip");
      for (const call of scheduled.mock.calls) delays.push(Number(call[1]));
      r.runtime.stop();
    } finally {
      scheduled.mockRestore();
    }

    expect(Math.max(...delays)).toBe(MIN_CLIP_MS);
  });

  it("ignores a clip-end report aimed at a mid-clip wake point", async () => {
    // Several waits run under one generation, so the generation alone does not
    // say which wait a report is about. Accepting it against the mid-clip one
    // cuts the clip short.
    const w = world({
      states: [state("a"), state("b")],
      parameters: [bool("go")],
      transitions: [
        transition({ id: "mid", from: "a", to: "b", hasExitTime: true, exitTime: 0.5, conditions: [{ parameter: "go", op: "is", value: true }] }),
      ],
    });
    const r = rig(w);
    await waitFor(() => !r.runtime.idle, "the clip");
    const live = r.last();

    expect(r.runtime.reportClipEnd(live.worldId, live.stateId!, live.generation)).toBe(false);
  });

  it("re-seats a live value when its Parameter is re-declared under another type", async () => {
    const w = world({ states: [state("a")], parameters: [bool("speed")] });
    const r = rig(w);
    r.runtime.setParameter("speed", true);

    r.runtime.setWorld({ ...w, parameters: [float("speed", 0)] });

    expect(r.runtime.parameters().speed).toBe(0);
  });
});

describe("a transition abandoned while its clip was being checked", () => {
  it("stays put when its conditions stop holding across the usability check", async () => {
    // `usable()` touches the filesystem. A Parameter set while it is in flight
    // can make the transition untrue, and taking it anyway acts on a world that
    // no longer exists. The generation guard does not cover this: nothing else
    // fired, so the generation is still the one this transition claimed.
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const w = world({
      states: [state("a"), state("b")],
      parameters: [bool("go")],
      transitions: [
        transition({
          id: "t",
          from: "a",
          to: "b",
          hasExitTime: false,
          conditions: [{ parameter: "go", op: "is", value: true }],
        }),
      ],
    });

    const r = rig(w, {
      clipUsable: async (clip: ClipRef) => {
        if (clip.path === "clips/b.mp4") await held;
        return true;
      },
    });

    r.runtime.setParameter("go", true);
    await waitFor(() => release !== null, "the check to be in flight");
    // Un-satisfy it while the check is suspended.
    r.runtime.setParameter("go", false);
    release!();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(r.last().stateId).toBe("a");
  });
});

describe("what re-seating without restarting must still notice", () => {
  it("faults rather than entering a State deleted while the clip was checked", async () => {
    // The re-seat no longer bumps the generation, so `take`'s generation guard
    // cannot see an edit that removed the destination mid-check.
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const w = world({
      states: [state("a"), state("b")],
      parameters: [bool("go")],
      transitions: [
        transition({ id: "t", from: "a", to: "b", hasExitTime: false, conditions: [{ parameter: "go", op: "is", value: true }] }),
      ],
    });
    const r = rig(w, {
      clipUsable: async (clip: ClipRef) => {
        if (clip.path === "clips/b.mp4") await held;
        return true;
      },
    });

    r.runtime.setParameter("go", true);
    await waitFor(() => release !== null, "the check to be in flight");
    r.runtime.setWorld({ ...w, states: [w.states[0]!] });
    release!();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(r.last().stateId).not.toBe("b");
    expect(r.last().fault).toMatch(/no longer has/);
  });

  it("re-enters when an exit time is edited under the clip in flight", async () => {
    // Wake points are read once per turn of the clip. Re-seating without
    // restarting would leave the new exit time unhonoured until the clip
    // looped — up to an hour away.
    const w = world({
      states: [state("a"), state("b")],
      transitions: [transition({ id: "t", from: "a", to: "b", hasExitTime: true, exitTime: 0.9 })],
    });
    const r = rig(w);
    await waitFor(() => !r.runtime.idle, "the clip");
    const generation = r.last().generation;

    r.runtime.setWorld({
      ...w,
      transitions: [{ ...w.transitions[0]!, exitTime: 0.1 }],
    });

    expect(r.last().generation).not.toBe(generation);
  });

  it("clears a fault once a clip is playing again", async () => {
    const w = world({
      states: [state("a"), state("b")],
      parameters: [bool("go")],
      transitions: [
        transition({ id: "t", from: "a", to: "b", hasExitTime: false, conditions: [{ parameter: "go", op: "is", value: true }] }),
      ],
    });
    const r = rig(w, { clipUsable: async (clip: ClipRef) => clip.path !== "clips/b.mp4" });

    r.runtime.setParameter("go", true);
    await waitFor(() => !!r.last().fault, "the fault");

    // The clip is restored and the World is touched.
    r.runtime.setWorld({ ...w, states: [w.states[0]!, { ...w.states[1]!, clips: [solo("b-fixed")] }] });
    await waitFor(() => r.last().fault === null, "the fault to clear once it plays again");
  });
});

describe("a State draws from its clips", () => {
  it("plays a different member on each loop", async () => {
    const w = world({ states: [stateOf("a", ["a1", "a2", "a3"])], defaultStateId: "a" });
    const r = rig(w);

    const seen: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      await waitFor(() => !r.runtime.idle, "a clip");
      seen.push(r.last().clip!.path);
      await stepThrough(r);
    }

    // Never twice running. Which member is drawn is random, so the assertion is
    // about the rule rather than the sequence.
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).not.toBe(seen[i - 1]);
  });

  it("loops a single-member set without deadlocking on the no-repeat rule", async () => {
    const w = world({ states: [state("a")], defaultStateId: "a" });
    const r = rig(w);

    await waitFor(() => !r.runtime.idle, "a clip");
    expect(r.last().clip?.path).toBe("clips/a.mp4");
    await stepThrough(r);
    await waitFor(() => r.last().clip?.path === "clips/a.mp4", "the same clip again");
  });

  it("skips a member it cannot play and keeps a usable sibling", async () => {
    const w = world({ states: [stateOf("a", ["good", "broken"])], defaultStateId: "a" });
    const r = rig(w, { clipUsable: async (c: ClipRef) => c.path !== "clips/broken.mp4" });

    for (let i = 0; i < 3; i += 1) {
      await waitFor(() => !r.runtime.idle, "a clip");
      expect(r.last().clip?.path).toBe("clips/good.mp4");
      expect(r.last().fault).toBeNull();
      await stepThrough(r);
    }
  });

  it("faults only when no member can be played", async () => {
    const w = world({ states: [stateOf("a", ["one", "two"])], defaultStateId: "a" });
    const r = rig(w, { clipUsable: async () => false });

    await waitFor(() => !!r.last().fault, "the fault");
    expect(r.last().clip).toBeNull();
  });

  it("holds silently with an empty set, as a State with no clip always did", async () => {
    const w = world({ states: [stateOf("a", [])], defaultStateId: "a" });
    const r = rig(w);

    await waitFor(() => r.seen.length > 0, "the broadcast");
    expect(r.last().clip).toBeNull();
    expect(r.last().fault).toBeNull();
  });

  it("does not replay the member that last played there after leaving and returning", async () => {
    const w = world({
      states: [stateOf("a", ["a1", "a2"]), state("b")],
      parameters: [bool("go")],
      transitions: [
        transition({ id: "out", from: "a", to: "b", hasExitTime: false, conditions: [{ parameter: "go", op: "is", value: true }] }),
        transition({ id: "back", from: "b", to: "a", hasExitTime: false, conditions: [{ parameter: "go", op: "is", value: false }] }),
      ],
    });
    const r = rig(w);
    await waitFor(() => !r.runtime.idle, "a clip");
    const before = r.last().clip!.path;

    r.runtime.setParameter("go", true);
    await waitFor(() => r.last().stateId === "b", "the trip out");
    r.runtime.setParameter("go", false);
    await waitFor(() => r.last().stateId === "a", "the trip back");

    expect(r.last().clip!.path).not.toBe(before);
  });

  it("times an exit time against whichever member is playing", async () => {
    // Members have different lengths, so 0.5 is a different millisecond each
    // loop. The rule is the fraction, not a fixed time.
    const w = world({
      states: [
        { id: "a", name: "a", clips: [solo("short", 1000), solo("long", 8000)], x: 0, y: 0 },
        state("b"),
      ],
      defaultStateId: "a",
      transitions: [transition({ id: "t", from: "a", to: "b", hasExitTime: true, exitTime: 0.5 })],
    });
    const r = rig(w);

    await waitFor(() => !r.runtime.idle, "a clip");
    const playing = r.last().clip!;
    expect([1000, 8000]).toContain(playing.durationMs);
  });
});

describe("a transition that plays a bridge", () => {
  const bridged = (over: Partial<Transition> = {}) =>
    world({
      states: [state("a"), state("b")],
      parameters: [bool("go"), trigger("fire")],
      transitions: [
        transition({
          id: "t",
          from: "a",
          to: "b",
          hasExitTime: false,
          clips: [solo("walk", 4000)],
          conditions: [{ parameter: "go", op: "is", value: true }],
          ...over,
        }),
      ],
    });

  /** Start the bridge and settle, without letting its wait resolve. */
  async function crossing(r: Rig): Promise<void> {
    r.runtime.setParameter("go", true);
    await waitFor(() => r.last().clip?.path === "clips/walk.mp4", "the bridge to start");
  }

  it("plays the transition's clip before the destination State begins", async () => {
    const r = rig(bridged());

    await crossing(r);
    expect(r.last().stateId).not.toBe("b");

    await stepThrough(r);
    await waitFor(() => r.last().stateId === "b", "the landing");
    expect(r.last().clip?.path).toBe("clips/b.mp4");
  });

  it("is taken instantly when it holds no clips, exactly as before", async () => {
    const r = rig(bridged({ clips: [] }));

    r.runtime.setParameter("go", true);
    await waitFor(() => r.last().stateId === "b", "the instant cut");
    expect(r.seen.some((l) => l.clip?.path === "clips/walk.mp4")).toBe(false);
  });

  it("says which transition it is crossing while it plays", async () => {
    const r = rig(bridged());
    await crossing(r);
    expect(r.last().transitionId).toBe("t");

    await stepThrough(r);
    await waitFor(() => r.last().stateId === "b", "the landing");
    expect(r.last().transitionId).toBeNull();
  });

  // The invariant everything else rests on: nothing is evaluated while a bridge
  // is in flight. Without it a mid-bridge report or an Any State transition
  // resolves the wrong wait and fires early.
  it("evaluates nothing while it is in flight", async () => {
    const w = bridged();
    const r = rig({
      ...w,
      transitions: [
        ...w.transitions,
        transition({ id: "any", fromAny: true, to: "a", hasExitTime: false, conditions: [{ parameter: "fire", op: "is", value: true }] }),
      ],
    });

    await crossing(r);
    r.runtime.setParameter("fire", true);
    await new Promise((resolve) => setImmediate(resolve));

    // Still crossing: the Any State transition did not cut in.
    expect(r.last().clip?.path).toBe("clips/walk.mp4");
    expect(r.last().transitionId).toBe("t");
  });

  it("records a Parameter set mid-bridge and honours it on landing", async () => {
    const w = bridged();
    const r = rig({
      ...w,
      transitions: [
        ...w.transitions,
        transition({ id: "back", from: "b", to: "a", hasExitTime: false, conditions: [{ parameter: "go", op: "is", value: false }] }),
      ],
    });

    await crossing(r);
    r.runtime.setParameter("go", false);
    expect(r.runtime.parameters().go).toBe(false);
    expect(r.last().clip?.path).toBe("clips/walk.mp4");

    await stepThrough(r);
    await waitFor(() => r.last().stateId === "a", "the return once it lands and re-evaluates");
  });

  it("keeps a Trigger armed until it lands", async () => {
    const r = rig(bridged({ conditions: [{ parameter: "fire", op: "is", value: true }] }));

    r.runtime.setParameter("fire", true);
    await waitFor(() => r.last().clip?.path === "clips/walk.mp4", "the bridge");
    expect(r.runtime.parameters().fire).toBe(true);

    await stepThrough(r);
    await waitFor(() => r.last().stateId === "b", "the landing");
    expect(r.runtime.parameters().fire).toBe(false);
  });

  it("leaves a Trigger armed when the bridge faults, so the move can be driven again", async () => {
    const r = rig(bridged({ conditions: [{ parameter: "fire", op: "is", value: true }] }));

    r.runtime.setParameter("fire", true);
    await waitFor(() => r.last().clip?.path === "clips/walk.mp4", "the bridge");
    // The destination goes while the bridge is crossing.
    r.runtime.setWorld({ ...bridged(), states: [state("a")] });
    await stepThrough(r);
    await waitFor(() => !!r.last().fault, "the fault on landing");

    expect(r.runtime.parameters().fire).toBe(true);
  });

  it("does not restart the bridge for an unrelated edit", async () => {
    const w = bridged();
    const r = rig(w);
    await crossing(r);
    const generation = r.last().generation;

    r.runtime.setWorld({ ...w, states: [{ ...w.states[0]!, name: "renamed" }, w.states[1]!] });

    expect(r.last().generation).toBe(generation);
    expect(r.last().clip?.path).toBe("clips/walk.mp4");
  });

  it("faults on landing when the destination has gone, not before", async () => {
    const w = bridged();
    const r = rig(w);
    await crossing(r);

    r.runtime.setWorld({ ...w, states: [state("a")] });
    expect(r.last().fault).toBeNull();
    expect(r.last().clip?.path).toBe("clips/walk.mp4");

    await stepThrough(r);
    await waitFor(() => !!r.last().fault, "the fault once it tries to land");
  });

  it("faults without playing when no member of its set can be played", async () => {
    const r = rig(bridged(), { clipUsable: async (c: ClipRef) => c.path !== "clips/walk.mp4" });

    r.runtime.setParameter("go", true);
    await waitFor(() => !!r.last().fault, "the fault");
    expect(r.seen.some((l) => l.clip?.path === "clips/walk.mp4")).toBe(false);
  });

  it("draws a different bridge clip each crossing", async () => {
    const w = world({
      states: [state("a"), state("b")],
      parameters: [bool("go")],
      transitions: [
        transition({ id: "out", from: "a", to: "b", hasExitTime: false, clips: [solo("w1"), solo("w2")], conditions: [{ parameter: "go", op: "is", value: true }] }),
        transition({ id: "back", from: "b", to: "a", hasExitTime: false, conditions: [{ parameter: "go", op: "is", value: false }] }),
      ],
    });
    const r = rig(w);

    const crossings: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      r.runtime.setParameter("go", true);
      await waitFor(() => r.last().transitionId === "out", "a crossing");
      crossings.push(r.last().clip!.path);
      await stepThrough(r);
      await waitFor(() => r.last().stateId === "b", "the landing");
      r.runtime.setParameter("go", false);
      await waitFor(() => r.last().stateId === "a", "the return");
    }

    expect(crossings[0]).not.toBe(crossings[1]);
  });
});

describe("what the review of the bridge found", () => {
  const walk = (over: Partial<Transition> = {}) =>
    world({
      states: [state("a"), state("b")],
      parameters: [bool("go"), trigger("fire")],
      transitions: [
        transition({
          id: "t",
          from: "a",
          to: "b",
          hasExitTime: false,
          clips: [solo("walk", 4000)],
          conditions: [{ parameter: "go", op: "is", value: true }],
          ...over,
        }),
      ],
    });

  it("refuses a clip-end report while a bridge is crossing", async () => {
    // The triple a client is told during a crossing is the source State and the
    // claimed generation, which is exactly what reportClipEnd accepts. Without
    // this, a client echoing its own broadcast lands the bridge instantly and
    // "uninterruptible" is a claim rather than a property.
    const r = rig(walk());
    r.runtime.setParameter("go", true);
    await waitFor(() => r.last().transitionId === "t", "the crossing");
    const live = r.last();

    expect(r.runtime.reportClipEnd(live.worldId, live.stateId!, live.generation)).toBe(false);
    expect(r.last().transitionId).toBe("t");
  });

  it("honours a Parameter set mid-bridge the moment it lands", async () => {
    const w = walk();
    const r = rig({
      ...w,
      states: [state("a"), state("b", "b", 60_000)],
      transitions: [
        ...w.transitions,
        transition({
          id: "back",
          from: "b",
          to: "a",
          hasExitTime: false,
          conditions: [{ parameter: "go", op: "is", value: false }],
        }),
      ],
    });

    r.runtime.setParameter("go", true);
    await waitFor(() => r.last().transitionId === "t", "the crossing");
    r.runtime.setParameter("go", false);
    await stepThrough(r);

    // b holds a minute of clip. Without an evaluation on arrival this waits it out.
    await waitFor(() => r.last().stateId === "a", "the return on arrival", 3000);
  });

  it("caps how long a crossing can hold the machine", async () => {
    const delays: number[] = [];
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    try {
      const r = rig(walk({ clips: [solo("walk", 60 * 60 * 1000)] }));
      r.runtime.setParameter("go", true);
      await waitFor(() => r.last().transitionId === "t", "the crossing");
      for (const call of scheduled.mock.calls) delays.push(Number(call[1]));
      r.runtime.stop();
    } finally {
      scheduled.mockRestore();
    }

    expect(Math.max(...delays)).toBe(MAX_BRIDGE_MS);
  });

  it("keeps crossing when the bridge clip's measured length arrives", async () => {
    // An imported clip has no duration until a browser measures it, so the
    // first crossing is paced by the default and the correction lands mid-walk.
    // Superseding on it put the character back where the walk started; the wait
    // is re-timed instead, and the walk finishes.
    const w = walk({ clips: [{ clips: [{ path: "clips/walk.mp4", durationMs: 0 }] }] });
    const r = rig(w);
    r.runtime.setParameter("go", true);
    await waitFor(() => r.last().transitionId === "t", "the crossing");
    const seenBefore = r.seen.length;

    r.runtime.setWorld({
      ...w,
      transitions: [{ ...w.transitions[0]!, clips: [{ clips: [{ path: "clips/walk.mp4", durationMs: 9000 }] }] }],
    });

    expect(r.last().transitionId).toBe("t");
    // Still crossing after the correction has had time to propagate: the wait
    // was re-timed, not resolved. Resolving it ended the walk on the spot.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(r.last().transitionId).toBe("t");

    await stepThrough(r);
    await waitFor(() => r.last().stateId === "b", "the landing");
    // Never back at the source: an abandoned crossing shows up as a return to a.
    expect(r.seen.slice(seenBefore).some((l) => l.transitionId === null && l.stateId === "a")).toBe(false);
  });

  it("faults when nothing at the far end can be played by the time it lands", async () => {
    let broken = false;
    const r = rig(walk(), { clipUsable: async (c: ClipRef) => !(broken && c.path === "clips/b.mp4") });

    r.runtime.setParameter("go", true);
    await waitFor(() => r.last().transitionId === "t", "the crossing");
    broken = true;
    await stepThrough(r);

    await waitFor(() => !!r.last().fault, "a fault rather than a silent idle");
    expect(r.last().clip).toBeNull();
  });

  it("goes to the default State when the source is deleted mid-crossing", async () => {
    const w = walk();
    const r = rig(w);
    r.runtime.setParameter("go", true);
    await waitFor(() => r.last().transitionId === "t", "the crossing");

    r.runtime.setWorld({ ...w, states: [state("b")], transitions: [], defaultStateId: "b" });

    expect(r.last().stateId).toBe("b");
  });

  it("supersedes the crossing when its own transition is edited", async () => {
    const w = walk();
    const r = rig(w);
    r.runtime.setParameter("go", true);
    await waitFor(() => r.last().transitionId === "t", "the crossing");
    const generation = r.last().generation;

    r.runtime.setWorld({ ...w, transitions: [{ ...w.transitions[0]!, to: "a" }] });

    expect(r.last().generation).not.toBe(generation);
    expect(r.last().transitionId).toBeNull();
  });

  it("does not remember a member that was drawn but never played", async () => {
    const w = world({ states: [stateOf("a", ["good", "broken"])], defaultStateId: "a" });
    const r = rig(w, { clipUsable: async (c: ClipRef) => c.path !== "clips/broken.mp4" });

    for (let i = 0; i < 3; i += 1) {
      await waitFor(() => !r.runtime.idle, "a clip");
      expect(r.last().clip?.path).toBe("clips/good.mp4");
      await stepThrough(r);
    }
  });

  it("faults on a single missing clip rather than looping a black frame", async () => {
    const r = rig(world({ states: [state("a")], defaultStateId: "a" }), { clipUsable: async () => false });
    await waitFor(() => !!r.last().fault, "the fault");
  });

  it("does not churn a generation renaming a State that holds no clips", async () => {
    const w = world({ states: [stateOf("a", [])], defaultStateId: "a" });
    const r = rig(w);
    await waitFor(() => r.seen.length > 0, "the first broadcast");
    const generation = r.last().generation;

    r.runtime.setWorld({ ...w, states: [{ ...w.states[0]!, name: "renamed" }] });

    expect(r.last().generation).toBe(generation);
  });

  it("draws the member an injected random source chooses", async () => {
    const picks = [0, 0.99];
    let n = 0;
    const w = world({ states: [stateOf("a", ["one", "two", "three"])], defaultStateId: "a" });
    const r = rig(w, { random: () => picks[n++ % picks.length]! });

    await waitFor(() => !r.runtime.idle, "a clip");
    expect(r.last().clip?.path).toBe("clips/one.mp4");
    await stepThrough(r);
    // "one" is excluded as just played, so 0.99 takes the last of what remains.
    await waitFor(() => r.last().clip?.path === "clips/three.mp4", "the far end of the pool");
  });
});

describe("a drive that stops answering", () => {
  /** A check that never returns, which is what a stalled mount looks like. */
  const stalled = () => () => new Promise<boolean>(() => {});

  it("keeps playing rather than holding for a check that never answers", async () => {
    // Before the deadline this held the machine with no timer, no fault and
    // nothing to say why — indistinguishable from a State holding silently.
    const w = world({ states: [state("a")], defaultStateId: "a" });
    const r = rig(w, { clipUsable: stalled() });

    await waitFor(() => !r.runtime.idle, "the clip to be playing anyway", 8000);
    expect(r.last().clip?.path).toBe("clips/a.mp4");
    expect(r.last().fault).toBeNull();
  });

  it("does not fault a State because its disk is slow", async () => {
    const w = world({ states: [stateOf("a", ["one", "two"])], defaultStateId: "a" });
    const r = rig(w, { clipUsable: stalled() });

    await waitFor(() => !r.runtime.idle, "the clip", 8000);
    expect(r.last().fault).toBeNull();
  });

  it("still crosses a bridge when the check does not answer", async () => {
    const w = world({
      states: [state("a"), state("b")],
      parameters: [bool("go")],
      transitions: [
        transition({
          id: "t",
          from: "a",
          to: "b",
          hasExitTime: false,
          clips: [solo("walk", 4000)],
          conditions: [{ parameter: "go", op: "is", value: true }],
        }),
      ],
    });
    const r = rig(w, { clipUsable: stalled() });
    await waitFor(() => !r.runtime.idle, "the source clip", 8000);

    r.runtime.setParameter("go", true);

    await waitFor(() => r.last().transitionId === "t", "the crossing", 8000);
    await stepThrough(r);
    await waitFor(() => r.last().stateId === "b", "the landing", 8000);
  });

  it("takes a check that rejects as an answer rather than a crash", async () => {
    const w = world({ states: [state("a")], defaultStateId: "a" });
    const r = rig(w, { clipUsable: () => Promise.reject(new Error("EIO")) });

    await waitFor(() => !r.runtime.idle, "the clip", 8000);
    expect(r.last().fault).toBeNull();
  });
});

describe("a run of several clips", () => {
  it("plays a State's run in order, then draws again", async () => {
    const w = world({ defaultStateId: "a", states: [stateRun("a", ["one", "two", "three"])] });
    const r = rig(w);

    await waitFor(() => !r.runtime.idle, "the first member");
    expect(r.last().clip?.path).toBe("clips/one.mp4");

    await stepThrough(r);
    expect(r.last().clip?.path).toBe("clips/two.mp4");

    await stepThrough(r);
    expect(r.last().clip?.path).toBe("clips/three.mp4");

    // The run is over, so the State draws — and with one run in the set it is
    // the same one, from the top.
    await stepThrough(r);
    expect(r.last().clip?.path).toBe("clips/one.mp4");
  });

  it("issues a new generation for each member, so a report names one of them", async () => {
    const r = rig(world({ defaultStateId: "a", states: [stateRun("a", ["one", "two"])] }));

    await waitFor(() => !r.runtime.idle, "the first member");
    const first = r.last().generation;
    await stepThrough(r);
    expect(r.last().generation).not.toBe(first);

    // The stale generation is the first member's, and that member has ended.
    expect(r.runtime.reportClipEnd("lounge", "a", first)).toBe(false);
  });

  it("offers an exit time once per member, not once per run", async () => {
    // Three members and an exit time of 0.5: the transition is offered at the
    // half-way point of whichever clip is playing, so it fires during the
    // first member rather than waiting for the gesture to finish.
    const w = world({
      defaultStateId: "a",
      states: [stateRun("a", ["one", "two", "three"]), state("b")],
      parameters: [bool("go", true)],
      transitions: [
        transition({
          id: "t",
          from: "a",
          to: "b",
          hasExitTime: true,
          exitTime: 0.5,
          conditions: [{ parameter: "go", op: "is", value: true }],
        }),
      ],
    });
    const r = rig(w);

    await waitFor(() => !r.runtime.idle, "the first member");
    r.runtime.step();
    await waitFor(() => r.last().stateId === "b", "the transition at the first half-way point");
  });

  it("drops a run whose member cannot be played, and keeps its sibling", async () => {
    const w = world({
      defaultStateId: "a",
      states: [{ ...stateOf("a", ["good"]), clips: [run(["broken", "second"]), solo("good")] }],
    });
    const r = rig(w, { clipUsable: async (c) => c.path !== "clips/broken.mp4" });

    await waitFor(() => !r.runtime.idle, "a clip");
    // Never the surviving half of the broken run: a gesture missing its first
    // beat is not the gesture, so the whole run leaves the draw.
    for (let i = 0; i < 4; i += 1) {
      expect(r.last().clip?.path).toBe("clips/good.mp4");
      await stepThrough(r);
    }
  });

  it("faults when every run holds something broken", async () => {
    const w = world({
      defaultStateId: "a",
      states: [{ ...stateOf("a", ["x"]), clips: [run(["a1", "a2"]), run(["b1", "b2"])] }],
    });
    const r = rig(w, { clipUsable: async (c) => c.path === "clips/a2.mp4" });

    await waitFor(() => !!r.last().fault, "the fault");
    expect(r.last().fault).toMatch(/could be played/);
  });

  it("draws a different run rather than repeating the one just played", async () => {
    const w = world({
      defaultStateId: "a",
      states: [{ ...stateOf("a", ["x"]), clips: [run(["p", "q"]), run(["r", "s"])] }],
    });
    // Always asks for the first of whatever pool it is given, so a repeat would
    // be certain if the exclusion keyed on anything but the whole run.
    const r = rig(w, { random: () => 0 });

    const heads: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      await waitFor(() => !r.runtime.idle, "a member");
      heads.push(r.last().clip!.path);
      await stepThrough(r, 2);
    }
    expect(heads).toEqual(["clips/p.mp4", "clips/r.mp4", "clips/p.mp4", "clips/r.mp4"]);
  });
});

describe("a State whose run plays whole", () => {
  const atomicWorld = (over: Partial<Transition> = {}) =>
    world({
      defaultStateId: "a",
      states: [stateRun("a", ["one", "two"], 4000, true), state("b")],
      parameters: [bool("go")],
      transitions: [
        transition({
          id: "t",
          from: "a",
          to: "b",
          hasExitTime: false,
          conditions: [{ parameter: "go", op: "is", value: true }],
          ...over,
        }),
      ],
    });

  it("does not act on a Parameter until the run ends", async () => {
    const r = rig(atomicWorld());
    await waitFor(() => !r.runtime.idle, "the first member");

    r.runtime.setParameter("go", true);
    await new Promise((resolve) => setImmediate(resolve));
    // Recorded and broadcast — the author moved a control and must see it —
    // but not acted on.
    expect(r.last().parameters.go).toBe(true);
    expect(r.last().stateId).toBe("a");
    expect(r.last().clip?.path).toBe("clips/one.mp4");

    await stepThrough(r);
    expect(r.last().clip?.path).toBe("clips/two.mp4");

    await stepThrough(r);
    await waitFor(() => r.last().stateId === "b", "the transition once the run landed");
  });

  it("holds an Any State transition until the run ends too", async () => {
    const w = atomicWorld();
    w.transitions = [
      transition({
        id: "any",
        fromAny: true,
        to: "b",
        hasExitTime: false,
        conditions: [{ parameter: "go", op: "is", value: true }],
      }),
    ];
    const r = rig(w);
    await waitFor(() => !r.runtime.idle, "the first member");

    r.runtime.setParameter("go", true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(r.last().stateId).toBe("a");

    await stepThrough(r, 2);
    await waitFor(() => r.last().stateId === "b", "Any State once the run landed");
  });

  it("wakes for no exit time part way through", async () => {
    const r = rig(atomicWorld({ hasExitTime: true, exitTime: 0.5 }));
    await waitFor(() => !r.runtime.idle, "the first member");
    r.runtime.setParameter("go", true);

    // The wait in flight is the whole member, not a half-way wake: resolving it
    // advances to the second member rather than taking the transition.
    r.runtime.step();
    await new Promise((resolve) => setImmediate(resolve));
    expect(r.last().stateId).toBe("a");
    expect(r.last().clip?.path).toBe("clips/two.mp4");
  });

  it("refuses a watching client's clip-end report for the whole run", async () => {
    const r = rig(atomicWorld());
    await waitFor(() => !r.runtime.idle, "the first member");

    expect(r.runtime.reportClipEnd("lounge", "a", r.last().generation)).toBe(false);
  });

  it("leaves an interruptible State reporting and cutting as it always did", async () => {
    // The same World with the switch off. Without this the atomic tests could
    // pass because the machine had stopped honouring reports at all.
    const w = atomicWorld();
    w.states = [stateRun("a", ["one", "two"], 4000, false), state("b")];
    const r = rig(w);
    await waitFor(() => !r.runtime.idle, "the first member");

    expect(r.runtime.reportClipEnd("lounge", "a", r.last().generation)).toBe(true);
    r.runtime.setParameter("go", true);
    await waitFor(() => r.last().stateId === "b", "the transition to cut in");
  });
});

describe("a bridge of several clips", () => {
  const crossing = (names: string[], durationMs = 4000) =>
    world({
      defaultStateId: "a",
      states: [state("a"), state("b")],
      parameters: [bool("go")],
      transitions: [
        transition({
          id: "t",
          from: "a",
          to: "b",
          hasExitTime: false,
          clips: [run(names, durationMs)],
          conditions: [{ parameter: "go", op: "is", value: true }],
        }),
      ],
    });

  it("plays every member before landing", async () => {
    const r = rig(crossing(["stand", "walk"]));
    r.runtime.setParameter("go", true);

    await waitFor(() => r.last().clip?.path === "clips/stand.mp4", "the first bridge clip");
    expect(r.last().transitionId).toBe("t");

    await stepThrough(r);
    expect(r.last().clip?.path).toBe("clips/walk.mp4");
    // Still in transit between the two, which is the whole point.
    expect(r.last().transitionId).toBe("t");

    await stepThrough(r);
    await waitFor(() => r.last().stateId === "b" && r.last().transitionId === null, "the landing");
  });

  it("refuses a clip-end report between two members", async () => {
    const r = rig(crossing(["stand", "walk"]));
    r.runtime.setParameter("go", true);
    await waitFor(() => r.last().clip?.path === "clips/stand.mp4", "the first bridge clip");

    expect(r.runtime.reportClipEnd("lounge", "a", r.last().generation)).toBe(false);
  });

  it("bounds the whole crossing rather than each of its clips", async () => {
    // The ceiling exists because nothing is evaluated while a bridge runs, and
    // that argument is about the total: clamping each member instead would let
    // three of them freeze the World for three ceilings.
    const delays: number[] = [];
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    try {
      const r = rig(crossing(["one", "two", "three"], MAX_BRIDGE_MS));
      r.runtime.setParameter("go", true);
      await waitFor(() => r.last().transitionId === "t", "the crossing");
      await stepThrough(r, 2);
      for (const call of scheduled.mock.calls) {
        const ms = call[1];
        // Only the clip waits. `waitFor` polls on a few milliseconds of its
        // own, and counting those would measure the test rather than the cap.
        if (typeof ms === "number" && ms >= MIN_CLIP_MS) delays.push(ms);
      }
    } finally {
      scheduled.mockRestore();
    }
    expect(delays.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(MAX_BRIDGE_MS);
  });
});
