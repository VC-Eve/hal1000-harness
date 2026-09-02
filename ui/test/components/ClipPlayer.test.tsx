import { describe, it, expect, beforeAll } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { ClipPlayer, clipUrl } from "../../src/components/ClipPlayer";
import { harness, mount, testLive, testState, testWorld } from "./harness";

/**
 * jsdom implements no media pipeline: `load` and `play` are not functions and
 * `canplay` never fires on its own. So the element is faked — and the fake
 * emits `canplay` asynchronously, because a synchronous one would hide exactly
 * the ordering this component exists to get right.
 */
beforeAll(() => {
  Object.defineProperty(HTMLMediaElement.prototype, "load", {
    configurable: true,
    value(this: HTMLMediaElement) {
      setTimeout(() => this.dispatchEvent(new Event("canplay")), 0);
    },
  });
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: () => Promise.resolve(),
  });
});

const sources = () =>
  [0, 1].map((i) => (screen.getByTestId(`clip-video-${i}`) as HTMLVideoElement).getAttribute("src"));

const front = () => [0, 1].find((i) => screen.getByTestId(`clip-video-${i}`).className.includes("front"));

const url = (path: string) => `/api/live/clip?world=lounge&clip=${encodeURIComponent(path)}`;

/**
 * Wait until the visible element is the one holding this clip.
 *
 * Polled rather than slept through: the swap happens when the incoming element
 * says it can play, and how long that takes is not something a fixed delay can
 * know.
 */
async function showing(path: string): Promise<number> {
  await waitFor(() => {
    const index = front();
    expect(index).not.toBeUndefined();
    expect(sources()[index!]).toBe(url(path));
  });
  return front()!;
}

describe("what is on screen", () => {
  it("requests the current State's clip from the clip route, with the World named", async () => {
    const world = testWorld();
    mount(<ClipPlayer state={testState({ world, worldLive: testLive() })} send={harness().send} />);
    await showing("clips/couch-idle.mp4");

    expect(sources()).toContain("/api/live/clip?world=lounge&clip=clips%2Fcouch-idle.mp4");
    expect(clipUrl("lounge", { path: "clips/a b.mp4", durationMs: 0 })).toBe(
      "/api/live/clip?world=lounge&clip=clips%2Fa%20b.mp4",
    );
  });

  it("swaps the visible element on a State change rather than reassigning one source", async () => {
    const world = testWorld();
    const { rerender } = mount(<ClipPlayer state={testState({ world, worldLive: testLive() })} send={harness().send} />);
    const first = await showing("clips/couch-idle.mp4");

    rerender(
      <ClipPlayer
        state={testState({
          world,
          worldLive: testLive({ stateId: "s-booth", generation: 8, clip: { path: "clips/booth-idle.mp4", durationMs: 4000 } }),
        })}
        send={harness().send}
      />,
    );
    await showing("clips/booth-idle.mp4");

    expect(front()).not.toBe(first);
    // Both clips are held, one per element — which is what makes the join free
    // of a reload.
    expect(sources().filter(Boolean).sort()).toEqual([
      "/api/live/clip?world=lounge&clip=clips%2Fbooth-idle.mp4",
      "/api/live/clip?world=lounge&clip=clips%2Fcouch-idle.mp4",
    ]);
  });

  it("plays a Cut's exit clip and then its entry clip, in order", async () => {
    const world = testWorld();
    const { rerender } = mount(<ClipPlayer state={testState({ world, worldLive: testLive() })} send={harness().send} />);
    await showing("clips/couch-idle.mp4");

    const seen: (string | null)[] = [];
    rerender(
      <ClipPlayer
        state={testState({
          world,
          worldLive: testLive({ phase: "playing", generation: 8, clip: { path: "clips/exit.mp4", durationMs: 1000 } }),
        })}
        send={harness().send}
      />,
    );
    seen.push(sources()[await showing("clips/exit.mp4")]);

    rerender(
      <ClipPlayer
        state={testState({
          world,
          worldLive: testLive({ phase: "cutting", generation: 9, clip: { path: "clips/entry.mp4", durationMs: 1000 } }),
        })}
        send={harness().send}
      />,
    );
    seen.push(sources()[await showing("clips/entry.mp4")]);

    expect(seen).toEqual([
      "/api/live/clip?world=lounge&clip=clips%2Fexit.mp4",
      "/api/live/clip?world=lounge&clip=clips%2Fentry.mp4",
    ]);
  });

  it("loops one clip with no error when the World has no edges", async () => {
    // Covers AE4.
    const world = testWorld({ edges: [], states: [testWorld().states[0]!] });
    mount(<ClipPlayer state={testState({ world, worldLive: testLive() })} send={harness().send} />);
    await showing("clips/couch-idle.mp4");

    expect(screen.queryByTestId("clip-fault")).not.toBeInTheDocument();
    expect(sources()).toContain("/api/live/clip?world=lounge&clip=clips%2Fcouch-idle.mp4");
  });
});

describe("reporting clip end", () => {
  it("reports once per clip, not once per rerender", async () => {
    const h = harness();
    const world = testWorld();
    const view = <ClipPlayer state={testState({ world, worldLive: testLive() })} send={h.send} />;
    const { rerender } = mount(view);
    await showing("clips/couch-idle.mp4");

    fireEvent.ended(screen.getByTestId(`clip-video-${front()}`));
    rerender(view);
    rerender(view);
    fireEvent.ended(screen.getByTestId(`clip-video-${front()}`));

    expect(h.countOf("report-clip-end")).toBe(1);
    expect(h.sent[0]).toEqual({ type: "report-clip-end", worldId: "lounge", stateId: "s-couch", generation: 7 });
  });

  it("reports the new generation after the clip changes", async () => {
    const h = harness();
    const world = testWorld();
    const { rerender } = mount(<ClipPlayer state={testState({ world, worldLive: testLive() })} send={h.send} />);
    await showing("clips/couch-idle.mp4");
    fireEvent.ended(screen.getByTestId(`clip-video-${front()}`));

    rerender(
      <ClipPlayer
        state={testState({
          world,
          worldLive: testLive({ stateId: "s-booth", generation: 8, clip: { path: "clips/booth-idle.mp4", durationMs: 4000 } }),
        })}
        send={h.send}
      />,
    );
    await showing("clips/booth-idle.mp4");
    fireEvent.ended(screen.getByTestId(`clip-video-${front()}`));

    expect(h.countOf("report-clip-end")).toBe(2);
    expect(h.sent[1]).toMatchObject({ stateId: "s-booth", generation: 8 });
  });
});

describe("faults", () => {
  it("surfaces a clip that will not load rather than leaving the previous one looping", async () => {
    const world = testWorld();
    mount(<ClipPlayer state={testState({ world, worldLive: testLive() })} send={harness().send} />);
    await showing("clips/couch-idle.mp4");

    fireEvent.error(screen.getByTestId(`clip-video-${front()}`));
    expect(screen.getByTestId("clip-fault")).toHaveTextContent("clips/couch-idle.mp4");
  });

  it("shows the runtime's own fault", () => {
    const world = testWorld();
    mount(
      <ClipPlayer
        state={testState({ world, worldLive: testLive({ fault: "That edge's clip could not be played." }) })}
        send={harness().send}
      />,
    );
    expect(screen.getByTestId("live-fault")).toHaveTextContent("could not be played");
  });

  it("says nothing is assigned when the State has no clip", () => {
    const world = testWorld();
    mount(<ClipPlayer state={testState({ world, worldLive: testLive({ clip: null }) })} send={harness().send} />);
    expect(screen.getByTestId("clip-empty")).toBeInTheDocument();
  });
});
