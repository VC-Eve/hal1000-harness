import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { createRef, type RefObject } from "react";
import { OverlayLayer } from "../../src/components/OverlayLayer";
import { DEFAULT_OVERLAYS, type OverlaySlot } from "../../../shared/src/overlays";
import type { TransportState } from "../../../shared/src/types";
import { mount, testState, testWorld } from "./harness";

// jsdom defines no ResizeObserver. A stub that hands its callback back lets a
// test feed the layer a container size, which is the one thing the fitted-rect
// arithmetic needs and the one thing this DOM cannot lay out.
type Observed = (entries: { contentRect: { width: number; height: number } }[]) => void;
let observers: Observed[];

beforeEach(() => {
  observers = [];
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(private readonly cb: Observed) {
      observers.push(cb);
    }
    observe() {}
    disconnect() {}
  };
});

afterEach(() => {
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

const transport = (over: Partial<TransportState> = {}): TransportState => ({
  playlistId: "late-set",
  generation: 1,
  index: 0,
  path: "tracks/one.mp3",
  name: "one",
  header: "Late Set",
  description: "A slow one",
  playing: true,
  positionMs: 0,
  durationMs: 1000,
  volume: 1,
  tracks: 3,
  shuffle: false,
  bpm: null,
  audible: true,
  ...over,
});

/** Two elements the layer can read a size from, the way a stage's refs are. */
function elements(): [RefObject<HTMLVideoElement>, RefObject<HTMLVideoElement>] {
  const a = createRef<HTMLVideoElement>() as { current: HTMLVideoElement | null };
  const b = createRef<HTMLVideoElement>() as { current: HTMLVideoElement | null };
  a.current = document.createElement("video");
  b.current = document.createElement("video");
  return [a, b] as [RefObject<HTMLVideoElement>, RefObject<HTMLVideoElement>];
}

function size(element: HTMLVideoElement, width: number, height: number): void {
  Object.defineProperty(element, "videoWidth", { configurable: true, value: width });
  Object.defineProperty(element, "videoHeight", { configurable: true, value: height });
}

const resize = (width: number, height: number) =>
  act(() => {
    for (const cb of observers) cb([{ contentRect: { width, height } }]);
  });

const picture = () => screen.getByTestId("overlay-picture") as HTMLDivElement;
const slots = () => Array.from(document.querySelectorAll("[data-overlay-slot]")) as HTMLElement[];

const slot = (over: Partial<OverlaySlot> = {}): OverlaySlot => ({
  position: "bottom-left",
  source: "text",
  text: "fixed",
  font: "Georgia",
  size: 4,
  color: "#ff0000",
  ...over,
});

describe("what the layer says", () => {
  it("draws the three defaults from the World's title and the transport's words", () => {
    const world = testWorld({ title: "Night Drive" });
    mount(
      <OverlayLayer
        state={testState({ world, audioTransport: transport() })}
        videos={elements()}
        front={0}
        blank={false}
      />,
    );

    expect(slots().map((s) => s.textContent)).toEqual(["Night Drive", "Late Set", "A slow one"]);
    expect(screen.getByTestId("overlay-cell-top-center").textContent).toBe("Night Drive");
    expect(screen.getByTestId("overlay-cell-bottom-left").textContent).toBe("Late SetA slow one");
  });

  it("renders no element at all for a slot with nothing to say", () => {
    // R14 by construction, and what keeps the broadcast allowlist exact.
    const world = testWorld();
    mount(
      <OverlayLayer
        state={testState({ world, audioTransport: transport({ description: null }) })}
        videos={elements()}
        front={0}
        blank={false}
      />,
    );

    expect(slots().map((s) => s.textContent)).toEqual(["Late Set"]);
    expect(screen.getByTestId("overlay-cell-top-center").childElementCount).toBe(0);
  });

  it("draws nothing with no World, and only the title with no transport", () => {
    const { rerender } = mount(
      <OverlayLayer state={testState({ world: null })} videos={elements()} front={0} blank />,
    );
    expect(slots()).toEqual([]);

    rerender(
      <OverlayLayer
        state={testState({ world: testWorld({ title: "Night Drive" }), audioTransport: null })}
        videos={elements()}
        front={0}
        blank
      />,
    );
    expect(slots().map((s) => s.textContent)).toEqual(["Night Drive"]);
  });

  it("stacks two slots in one cell in list order", () => {
    const world = testWorld({ overlays: [slot({ text: "first" }), slot({ source: "track-description" })] });
    mount(
      <OverlayLayer
        state={testState({ world, audioTransport: transport() })}
        videos={elements()}
        front={0}
        blank={false}
      />,
    );

    const cell = screen.getByTestId("overlay-cell-bottom-left");
    expect(Array.from(cell.children).map((c) => c.textContent)).toEqual(["first", "A slow one"]);
    expect(Array.from(cell.children).map((c) => c.getAttribute("data-overlay-slot"))).toEqual(["0", "1"]);
  });

  it("carries no attribute that reads as prose", () => {
    const world = testWorld({ title: "Night Drive" });
    mount(
      <OverlayLayer
        state={testState({ world, audioTransport: transport() })}
        videos={elements()}
        front={0}
        blank={false}
      />,
    );
    const layer = screen.getByTestId("overlay-layer");
    for (const element of [layer, ...Array.from(layer.querySelectorAll("*"))]) {
      for (const name of ["title", "alt", "aria-label", "placeholder", "aria-description"]) {
        expect(element.getAttribute(name)).toBeNull();
      }
    }
  });
});

describe("how the layer looks", () => {
  it("styles a slot from its own font, size in picture height, and colour", () => {
    const world = testWorld({ overlays: [slot()] });
    mount(<OverlayLayer state={testState({ world })} videos={elements()} front={0} blank={false} />);

    const [one] = slots();
    expect(one!.style.fontFamily).toBe("Georgia");
    expect(one!.style.fontSize).toBe("4cqh");
    expect(one!.style.color).toBe("rgb(255, 0, 0)");
    expect(DEFAULT_OVERLAYS[0]!.size).toBeGreaterThan(0);
  });

  it("places the picture on the contained rect of the front element", () => {
    const videos = elements();
    size(videos[0].current!, 1920, 1080);
    mount(<OverlayLayer state={testState({ world: testWorld() })} videos={videos} front={0} blank={false} />);

    resize(800, 600);

    // 16:9 in 4:3 — letterboxed top and bottom (see ui/test/overlay.test.ts).
    expect(picture().style.left).toBe("0px");
    expect(picture().style.top).toBe("75px");
    expect(picture().style.width).toBe("800px");
    expect(picture().style.height).toBe("450px");
  });

  it("re-reads the picture's size on a swap, not only on metadata", () => {
    // `loadedmetadata` fires on the back element while it preloads; the swap on
    // `canplay` fires nothing. A layer keyed on metadata alone would keep the
    // previous clip's aspect and put bottom-left text in the bar.
    const videos = elements();
    size(videos[0].current!, 1920, 1080);
    size(videos[1].current!, 640, 480);
    const view = (front: number) => (
      <OverlayLayer state={testState({ world: testWorld() })} videos={videos} front={front} blank={false} />
    );
    const { rerender } = mount(view(0));
    resize(800, 600);
    expect(picture().style.height).toBe("450px");

    rerender(view(1));

    // 4:3 in 4:3 — fills.
    expect(picture().style.top).toBe("0px");
    expect(picture().style.height).toBe("600px");
  });

  it("re-reads on metadata from either element, so the first clip is sized before its swap", () => {
    const videos = elements();
    mount(<OverlayLayer state={testState({ world: testWorld() })} videos={videos} front={0} blank={false} />);
    resize(800, 600);
    expect(picture().style.height).toBe("600px");

    size(videos[0].current!, 1920, 1080);
    act(() => {
      fireEvent.loadedMetadata(videos[0].current!);
    });
    expect(picture().style.height).toBe("450px");
  });

  it("is the whole box while nothing is assigned", () => {
    const videos = elements();
    size(videos[0].current!, 1920, 1080);
    mount(<OverlayLayer state={testState({ world: testWorld() })} videos={videos} front={0} blank />);
    resize(800, 600);

    expect(picture().style.top).toBe("0px");
    expect(picture().style.height).toBe("600px");
  });

  it("mounts and measures once with no ResizeObserver at all", () => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    const world = testWorld({ title: "Night Drive" });
    mount(<OverlayLayer state={testState({ world })} videos={elements()} front={0} blank />);

    expect(slots().map((s) => s.textContent)).toEqual(["Night Drive"]);
    expect(picture().style.width).toBe("0px");
  });
});
