import { describe, it, expect, beforeAll, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { BroadcastStage } from "../../src/components/BroadcastStage";
import { harness, mount, testLive, testState, testWorld } from "./harness";

// jsdom implements no media pipeline. Same fake as the other clip suites.
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

const front = () => [0, 1].find((i) => screen.getByTestId(`broadcast-video-${i}`).className.includes("front"));

const showing = async (): Promise<number> => {
  await waitFor(() => expect(front()).not.toBeUndefined());
  return front()!;
};

/**
 * Every text node under the stage, with whitespace-only nodes dropped.
 *
 * A walk rather than a `textContent` check, because `textContent` on an empty
 * tree and on a tree of empty elements both answer "" and only one of those is
 * the property being asserted.
 */
function textNodes(root: HTMLElement): string[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const found: string[] = [];
  let node = walker.nextNode();
  while (node) {
    const text = (node.textContent ?? "").trim();
    if (text.length > 0) found.push(text);
    node = walker.nextNode();
  }
  return found;
}

/** Attributes that carry prose to a reader or a screen reader. */
const PROSE_ATTRIBUTES = ["title", "alt", "aria-label", "placeholder", "aria-description"];

function prose(root: HTMLElement): string[] {
  const found: string[] = [];
  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const name of PROSE_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value !== null && value.trim().length > 0) found.push(`${name}="${value}"`);
    }
  }
  return found;
}

describe("what the audience can see", () => {
  it("renders the two elements and no text, with a clip playing", async () => {
    const world = testWorld();
    mount(<BroadcastStage state={testState({ world, worldLive: testLive() })} send={harness().send} />);
    await showing();

    expect(screen.getByTestId("broadcast-video-0")).toBeInTheDocument();
    expect(screen.getByTestId("broadcast-video-1")).toBeInTheDocument();
    expect(textNodes(screen.getByTestId("broadcast-stage"))).toEqual([]);
  });

  it("renders no text with no World open", () => {
    mount(<BroadcastStage state={testState()} send={harness().send} />);

    // `/live` says "Nothing is assigned to play here yet." here. This surface
    // has no renderer that could.
    expect(textNodes(screen.getByTestId("broadcast-stage"))).toEqual([]);
  });

  it("renders no text with a World open but nothing assigned", () => {
    const world = testWorld();
    mount(
      <BroadcastStage state={testState({ world, worldLive: testLive({ clip: null }) })} send={harness().send} />,
    );

    expect(textNodes(screen.getByTestId("broadcast-stage"))).toEqual([]);
  });

  it("renders no text when a clip will not load", async () => {
    // The leak this whole surface exists to prevent: /live renders the failing
    // clip's path here, which is a file path on a projector.
    const world = testWorld();
    mount(<BroadcastStage state={testState({ world, worldLive: testLive() })} send={harness().send} />);
    const index = await showing();

    fireEvent.error(screen.getByTestId(`broadcast-video-${index}`));

    const stage = screen.getByTestId("broadcast-stage");
    expect(textNodes(stage)).toEqual([]);
    expect(stage.textContent).not.toMatch(/couch-idle/);
  });

  it("renders no text when the server reports a fault", async () => {
    const world = testWorld();
    mount(
      <BroadcastStage
        state={testState({ world, worldLive: testLive({ fault: "That State holds no clip that will play." }) })}
        send={harness().send}
      />,
    );
    await showing();

    const stage = screen.getByTestId("broadcast-stage");
    expect(textNodes(stage)).toEqual([]);
    expect(stage.textContent).not.toMatch(/State/);
  });

  it("carries no attribute that reads as prose", async () => {
    // A text-node walk would miss these, and a title or aria-label is on screen
    // or in a screen reader all the same.
    const world = testWorld();
    mount(<BroadcastStage state={testState({ world, worldLive: testLive() })} send={harness().send} />);
    await showing();

    expect(prose(screen.getByTestId("broadcast-stage"))).toEqual([]);
  });
});

describe("what the browser would offer that we do not", () => {
  it("prevents the native context menu", async () => {
    // "Copy video address" resolves to the clip route, which carries the World
    // id and the clip path in its query string.
    const world = testWorld();
    mount(<BroadcastStage state={testState({ world, worldLive: testLive() })} send={harness().send} />);
    await showing();

    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    screen.getByTestId("broadcast-stage").dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("disables Picture-in-Picture and the download and remote-playback controls", async () => {
    const world = testWorld();
    mount(<BroadcastStage state={testState({ world, worldLive: testLive() })} send={harness().send} />);
    await showing();

    for (const index of [0, 1]) {
      const element = screen.getByTestId(`broadcast-video-${index}`);
      expect(element).toHaveAttribute("disablePictureInPicture");
      expect(element.getAttribute("controlsList")).toContain("nodownload");
      expect(element.getAttribute("controlsList")).toContain("noremoteplayback");
    }
  });

  it("offers no media controls of its own", async () => {
    const world = testWorld();
    mount(<BroadcastStage state={testState({ world, worldLive: testLive() })} send={harness().send} />);
    await showing();

    for (const index of [0, 1]) {
      expect(screen.getByTestId(`broadcast-video-${index}`)).not.toHaveAttribute("controls");
    }
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("holding the frame, then fading", () => {
  it("does not start the fade when the back element fails while the front is still playing", async () => {
    // The defect this test exists for: the error is raised by the element that
    // is preloading, and the visible one carries on playing correctly —
    // possibly for seconds. Fading on the fault would dip a good picture.
    vi.useFakeTimers();
    try {
      const world = testWorld();
      mount(<BroadcastStage state={testState({ world, worldLive: testLive() })} send={harness().send} />);
      await vi.advanceTimersByTimeAsync(5);
      const showingIndex = front()!;
      const back = showingIndex === 0 ? 1 : 0;

      fireEvent.error(screen.getByTestId(`broadcast-video-${back}`));
      await vi.advanceTimersByTimeAsync(10_000);

      expect(screen.getByTestId("broadcast-stage").className).not.toContain("faded");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fades once the front element ends with nothing to swap in", async () => {
    vi.useFakeTimers();
    try {
      const world = testWorld();
      mount(<BroadcastStage state={testState({ world, worldLive: testLive() })} send={harness().send} />);
      await vi.advanceTimersByTimeAsync(5);
      const showingIndex = front()!;
      const back = showingIndex === 0 ? 1 : 0;

      fireEvent.error(screen.getByTestId(`broadcast-video-${back}`));
      // The held frame: the visible clip finishes and there is no next one.
      fireEvent.ended(screen.getByTestId(`broadcast-video-${showingIndex}`));

      // Still holding, not yet faded.
      expect(screen.getByTestId("broadcast-stage").className).not.toContain("faded");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });

      expect(screen.getByTestId("broadcast-stage").className).toContain("faded");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels an armed fade when the next clip arrives", async () => {
    vi.useFakeTimers();
    try {
      const world = testWorld();
      const view = (live: ReturnType<typeof testLive>) => (
        <BroadcastStage state={testState({ world, worldLive: live })} send={harness().send} />
      );
      const { rerender } = mount(view(testLive()));
      await vi.advanceTimersByTimeAsync(5);
      const showingIndex = front()!;
      const back = showingIndex === 0 ? 1 : 0;

      fireEvent.error(screen.getByTestId(`broadcast-video-${back}`));
      fireEvent.ended(screen.getByTestId(`broadcast-video-${showingIndex}`));

      // Recovery arrives before the fade completes.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
        rerender(
          view(
            testLive({
              stateId: "s-booth",
              clip: { path: "clips/booth-idle.mp4", durationMs: 4000 },
              generation: 8,
            }),
          ),
        );
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(screen.getByTestId("broadcast-stage").className).not.toContain("faded");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("fullscreen, with nothing to click", () => {
  /** Stand in for a media-less jsdom, which implements none of the fullscreen API. */
  function fullscreenApi() {
    const request = vi.fn(() => Promise.resolve());
    const exit = vi.fn(() => Promise.resolve());
    Object.defineProperty(Element.prototype, "requestFullscreen", { configurable: true, value: request });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
    Object.defineProperty(document, "fullscreenElement", { configurable: true, writable: true, value: null });
    return { request, exit };
  }

  it("goes fullscreen on the container, not on a video element", async () => {
    const { request } = fullscreenApi();
    const world = testWorld();
    mount(<BroadcastStage state={testState({ world, worldLive: testLive() })} send={harness().send} />);
    await showing();

    const stage = screen.getByTestId("broadcast-stage");
    fireEvent.doubleClick(stage);

    expect(request).toHaveBeenCalledTimes(1);
    // The element it was called on is the one that holds both videos — the
    // engine swaps between them, so fullscreening the visible one would strand
    // it at the next swap.
    expect(request.mock.instances[0]).toBe(stage);
  });

  it("leaves fullscreen on a second double-click", async () => {
    const { exit } = fullscreenApi();
    const world = testWorld();
    mount(<BroadcastStage state={testState({ world, worldLive: testLive() })} send={harness().send} />);
    await showing();

    const stage = screen.getByTestId("broadcast-stage");
    Object.defineProperty(document, "fullscreenElement", { configurable: true, writable: true, value: stage });
    fireEvent.doubleClick(stage);

    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("does nothing on a single click", async () => {
    const { request, exit } = fullscreenApi();
    const world = testWorld();
    mount(<BroadcastStage state={testState({ world, worldLive: testLive() })} send={harness().send} />);
    await showing();

    // A stray click during a show must not change what the room is looking at.
    fireEvent.click(screen.getByTestId("broadcast-stage"));

    expect(request).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("survives a browser that refuses", async () => {
    const world = testWorld();
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value: () => Promise.reject(new Error("denied")),
    });
    Object.defineProperty(document, "fullscreenElement", { configurable: true, writable: true, value: null });
    mount(<BroadcastStage state={testState({ world, worldLive: testLive() })} send={harness().send} />);
    await showing();

    fireEvent.doubleClick(screen.getByTestId("broadcast-stage"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A refusal is an answer. The picture is still there and nothing was said
    // about it.
    expect(screen.getByTestId("broadcast-stage")).toBeInTheDocument();
    expect(textNodes(screen.getByTestId("broadcast-stage"))).toEqual([]);
  });

  it("adds no control and no text in either state", async () => {
    fullscreenApi();
    const world = testWorld();
    mount(<BroadcastStage state={testState({ world, worldLive: testLive() })} send={harness().send} />);
    await showing();
    const stage = screen.getByTestId("broadcast-stage");

    expect(screen.queryByRole("button")).toBeNull();
    fireEvent.doubleClick(stage);
    Object.defineProperty(document, "fullscreenElement", { configurable: true, writable: true, value: stage });
    fireEvent(document, new Event("fullscreenchange"));

    expect(screen.queryByRole("button")).toBeNull();
    expect(textNodes(stage)).toEqual([]);
    expect(prose(stage)).toEqual([]);
  });
});
