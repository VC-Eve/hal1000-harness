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
          worldLive: testLive({ generation: 8, clip: { path: "clips/exit.mp4", durationMs: 1000 } }),
        })}
        send={harness().send}
      />,
    );
    seen.push(sources()[await showing("clips/exit.mp4")]);

    rerender(
      <ClipPlayer
        state={testState({
          world,
          worldLive: testLive({ generation: 9, clip: { path: "clips/entry.mp4", durationMs: 1000 } }),
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

  it("loops one clip with no error when the World has no transitions", async () => {
    // Covers AE4.
    const world = testWorld({ transitions: [], states: [testWorld().states[0]!] });
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

describe("which clip actually ended", () => {
  it("reports the clip the demoted element was playing, not the one now on screen", async () => {
    // The defect this component shipped with. The server's timer normally fires
    // slightly before the browser finishes, so the outgoing element's `ended`
    // arrives AFTER the next broadcast. Reported against the current render it
    // named the new clip, which the runtime accepted — truncating the clip that
    // had just started, on every ordinary loop.
    const h = harness();
    const world = testWorld();
    const { rerender } = mount(<ClipPlayer state={testState({ world, worldLive: testLive() })} send={h.send} />);
    const first = await showing("clips/couch-idle.mp4");

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

    // The element that just lost the front is the one whose clip ends.
    fireEvent.ended(screen.getByTestId(`clip-video-${first}`));

    expect(h.sent.filter((m) => m.type === "report-clip-end")).toEqual([
      { type: "report-clip-end", worldId: "lounge", stateId: "s-couch", generation: 7 },
    ]);
  });

  it("pauses the element it demotes, so a hidden clip stops producing events", async () => {
    const world = testWorld();
    const { rerender } = mount(<ClipPlayer state={testState({ world, worldLive: testLive() })} send={harness().send} />);
    const first = await showing("clips/couch-idle.mp4");
    const outgoing = screen.getByTestId(`clip-video-${first}`) as HTMLVideoElement;
    let paused = false;
    outgoing.pause = () => {
      paused = true;
    };

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

    expect(paused).toBe(true);
  });
});

describe("measuring a clip", () => {
  it("reports the real duration when the manifest's is wrong", async () => {
    // Nothing can measure a clip at assignment time — the route serves only
    // clips the manifest already references, so a probe then is a 404 and the
    // recorded duration is zero. First play is the first chance.
    const h = harness();
    const world = testWorld();
    mount(
      <ClipPlayer
        state={testState({ world, worldLive: testLive({ clip: { path: "clips/couch-idle.mp4", durationMs: 0 } }) })}
        send={h.send}
      />,
    );
    const index = await showing("clips/couch-idle.mp4");
    const element = screen.getByTestId(`clip-video-${index}`) as HTMLVideoElement;
    Object.defineProperty(element, "duration", { configurable: true, value: 4.25 });
    fireEvent.loadedMetadata(element);

    expect(h.sent).toContainEqual({
      type: "report-clip-duration",
      worldId: "lounge",
      path: "clips/couch-idle.mp4",
      durationMs: 4250,
    });
  });

  it("says nothing when the recorded duration is already right", async () => {
    const h = harness();
    const world = testWorld();
    mount(<ClipPlayer state={testState({ world, worldLive: testLive() })} send={h.send} />);
    const index = await showing("clips/couch-idle.mp4");
    const element = screen.getByTestId(`clip-video-${index}`) as HTMLVideoElement;
    Object.defineProperty(element, "duration", { configurable: true, value: 4.0 });
    fireEvent.loadedMetadata(element);

    expect(h.countOf("report-clip-duration")).toBe(0);
  });

  it("reports once per measurement, not once per rerender", async () => {
    const h = harness();
    const world = testWorld();
    const view = (
      <ClipPlayer
        state={testState({ world, worldLive: testLive({ clip: { path: "clips/couch-idle.mp4", durationMs: 0 } }) })}
        send={h.send}
      />
    );
    const { rerender } = mount(view);
    const index = await showing("clips/couch-idle.mp4");
    const element = screen.getByTestId(`clip-video-${index}`) as HTMLVideoElement;
    Object.defineProperty(element, "duration", { configurable: true, value: 4.25 });

    fireEvent.loadedMetadata(element);
    rerender(view);
    fireEvent.loadedMetadata(element);

    expect(h.countOf("report-clip-duration")).toBe(1);
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

describe("playing a bridge", () => {
  // The player has no idea bridges exist: it swaps on the State, the generation
  // and the clip path together, and a crossing changes the generation on both
  // edges. That is why this works — and why it needs pinning, because nothing
  // in the component says so and a change to when the generation moves would
  // break it silently.
  const crossing = (over: Parameters<typeof testLive>[0] = {}) =>
    testLive({
      stateId: "s-couch",
      transitionId: "t1",
      generation: 8,
      clip: { path: "clips/walk.mp4", durationMs: 4000 },
      ...over,
    });

  it("swaps to the bridge clip while the State it left is unchanged", async () => {
    const world = testWorld();
    const { rerender } = mount(
      <ClipPlayer state={testState({ world, worldLive: testLive() })} send={harness().send} />,
    );
    await showing("clips/couch-idle.mp4");

    rerender(<ClipPlayer state={testState({ world, worldLive: crossing() })} send={harness().send} />);

    await showing("clips/walk.mp4");
  });

  it("swaps again on landing, though the source State never changed", async () => {
    // stateId stays "s-couch" for the whole crossing and only moves at the
    // landing, so the generation is what carries both swaps.
    const world = testWorld();
    const { rerender } = mount(
      <ClipPlayer state={testState({ world, worldLive: crossing() })} send={harness().send} />,
    );
    await showing("clips/walk.mp4");

    rerender(
      <ClipPlayer
        state={testState({
          world,
          worldLive: testLive({ stateId: "s-booth", transitionId: null, generation: 9, clip: { path: "clips/booth-idle.mp4", durationMs: 4000 } }),
        })}
        send={harness().send}
      />,
    );

    await showing("clips/booth-idle.mp4");
  });

  it("reports the end of a bridge against the State the server still names", async () => {
    // The server keeps `stateId` on the source for the crossing, and matches a
    // report against exactly that. A report naming anything else is discarded.
    const h = harness();
    const live = crossing();
    mount(<ClipPlayer state={testState({ world: testWorld(), worldLive: live })} send={h.send} />);
    const index = await showing("clips/walk.mp4");

    fireEvent.ended(screen.getByTestId(`clip-video-${index}`));

    expect(h.sent.at(-1)).toMatchObject({
      type: "report-clip-end",
      stateId: "s-couch",
      generation: 8,
    });
  });
});

describe("fullscreening the video", () => {
  /**
   * jsdom implements no Fullscreen API. The fake tracks a current element and
   * fires `fullscreenchange` like a browser does, so the component is tested
   * against the thing it actually reads rather than against its own click.
   */
  function fakeFullscreen(opts: { enabled?: boolean; refuse?: boolean } = {}) {
    let current: Element | null = null;
    Object.defineProperty(document, "fullscreenEnabled", {
      configurable: true,
      get: () => opts.enabled !== false,
    });
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => current });
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value(this: Element) {
        if (opts.refuse) return Promise.reject(new Error("denied"));
        current = this;
        document.dispatchEvent(new Event("fullscreenchange"));
        return Promise.resolve();
      },
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: () => {
        current = null;
        document.dispatchEvent(new Event("fullscreenchange"));
        return Promise.resolve();
      },
    });
    return { escape: () => (document as unknown as { exitFullscreen(): Promise<void> }).exitFullscreen() };
  }

  const playing = () => testState({ world: testWorld(), worldLive: testLive() });

  it("takes the stage fullscreen, not one of the two video elements", async () => {
    // The player swaps between two elements; fullscreening one would lose the
    // next clip at the swap.
    fakeFullscreen();
    mount(<ClipPlayer state={playing()} send={harness().send} />);

    fireEvent.click(screen.getByTestId("clip-fullscreen"));

    await waitFor(() => expect(document.fullscreenElement).toBe(screen.getByTestId("clip-player")));
  });

  it("offers the way back once it is fullscreen", async () => {
    fakeFullscreen();
    mount(<ClipPlayer state={playing()} send={harness().send} />);
    expect(screen.getByLabelText("fullscreen")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("clip-fullscreen"));

    await waitFor(() => expect(screen.getByLabelText("exit fullscreen")).toBeInTheDocument());
  });

  it("follows the browser out when Escape leaves fullscreen", async () => {
    // Escape does not tell the page. A flag the button owned would drift out of
    // step with what is actually on screen.
    const fs = fakeFullscreen();
    mount(<ClipPlayer state={playing()} send={harness().send} />);
    fireEvent.click(screen.getByTestId("clip-fullscreen"));
    await waitFor(() => expect(screen.getByLabelText("exit fullscreen")).toBeInTheDocument());

    await fs.escape();

    await waitFor(() => expect(screen.getByLabelText("fullscreen")).toBeInTheDocument());
  });

  it("leaves fullscreen when pressed again", async () => {
    fakeFullscreen();
    mount(<ClipPlayer state={playing()} send={harness().send} />);
    fireEvent.click(screen.getByTestId("clip-fullscreen"));
    await waitFor(() => expect(document.fullscreenElement).not.toBeNull());

    fireEvent.click(screen.getByTestId("clip-fullscreen"));

    await waitFor(() => expect(document.fullscreenElement).toBeNull());
  });

  it("keeps playing when the browser refuses", async () => {
    fakeFullscreen({ refuse: true });
    mount(<ClipPlayer state={playing()} send={harness().send} />);

    fireEvent.click(screen.getByTestId("clip-fullscreen"));

    await waitFor(() => expect(screen.getByLabelText("fullscreen")).toBeInTheDocument());
    expect(screen.getByTestId("clip-player")).toBeInTheDocument();
  });

  it("shows no control at all where the browser does not offer fullscreen", () => {
    // An inert button costs more than an absent one.
    fakeFullscreen({ enabled: false });
    mount(<ClipPlayer state={playing()} send={harness().send} />);

    expect(screen.queryByTestId("clip-fullscreen")).not.toBeInTheDocument();
  });
});

describe("the overlay on the operator's player", () => {
  it("mounts the same layer the broadcast surface does, inside the stage", async () => {
    const world = testWorld({ title: "Night Drive" });
    mount(<ClipPlayer state={testState({ world, worldLive: testLive() })} send={harness().send} />);
    await showing("clips/couch-idle.mp4");

    const player = screen.getByTestId("clip-player");
    const layer = screen.getByTestId("overlay-layer");
    expect(player.contains(layer)).toBe(true);
    expect(layer.textContent).toBe("Night Drive");
  });
});
