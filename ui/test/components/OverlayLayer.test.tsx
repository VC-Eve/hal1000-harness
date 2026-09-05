import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { createRef, type RefObject } from "react";
import { OverlayLayer } from "../../src/components/OverlayLayer";
import { DEFAULT_OVERLAYS, type ImageSlot, type OverlaySlot } from "../../../shared/src/overlays";
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

  it("draws a stored colour in canonical form, so a hand-edited one is still a CSS colour", () => {
    const world = testWorld({ overlays: [slot({ color: "F00" as string })] });
    mount(<OverlayLayer state={testState({ world })} videos={elements()} front={0} blank={false} />);
    expect(slots()[0]!.style.color).toBe("rgb(255, 0, 0)");
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

describe("pictures over the picture", () => {
  const image = (over: Partial<ImageSlot> = {}): ImageSlot => ({
    kind: "image",
    position: "bottom-left",
    image: "band.png",
    size: 8,
    ...over,
  });

  const images = () => Array.from(document.querySelectorAll("[data-overlay-image]")) as HTMLImageElement[];

  it("draws a picture behind the words even when it is listed last", () => {
    // The fixture lists the image *after* the caption on purpose. Listed first
    // it would pass whether or not the two-grid split works, because document
    // order would happen to be right — and this is precisely the shape
    // docs/solutions/tests-that-lock-in-the-bug.md warns about.
    const world = testWorld({
      overlays: [slot({ position: "bottom-left", text: "caption" }), image()],
    });
    mount(
      <OverlayLayer
        state={testState({ world, audioTransport: transport() })}
        videos={elements()}
        front={0}
        blank={false}
      />,
    );

    const layers = Array.from(picture().children) as HTMLElement[];
    expect(layers.map((l) => l.dataset.testid ?? l.getAttribute("data-testid"))).toEqual([
      "overlay-images",
      "overlay-text",
    ]);
    // The caption is in the second layer, the band in the first — so the band
    // is behind it whatever the list said.
    expect(screen.getByTestId("overlay-images").contains(images()[0]!)).toBe(true);
    expect(screen.getByTestId("overlay-text").textContent).toContain("caption");
    expect(screen.getByTestId("overlay-images").textContent).toBe("");
  });

  it("layers two pictures at one position in list order", () => {
    const world = testWorld({
      overlays: [image({ image: "under.png" }), image({ image: "over.png" })],
    });
    mount(
      <OverlayLayer
        state={testState({ world, audioTransport: transport() })}
        videos={elements()}
        front={0}
        blank={false}
      />,
    );

    // Read off the images themselves rather than by position in the whole
    // tree: an index-based query couples this to every unrelated element the
    // component might grow.
    expect(images().map((i) => new URL(i.src, "http://x").searchParams.get("image"))).toEqual([
      "under.png",
      "over.png",
    ]);
  });

  it("sizes a picture in cqh and fades it on a nought-to-one scale", () => {
    const world = testWorld({ overlays: [image({ size: 8, opacity: 50 }), image({ image: "solid.png" })] });
    mount(
      <OverlayLayer
        state={testState({ world, audioTransport: transport() })}
        videos={elements()}
        front={0}
        blank={false}
      />,
    );

    // jsdom lays nothing out, so the expression is the whole of what can be
    // asserted here — and asserting it stops a refactor switching units
    // silently. The ratio itself is scripts/overlays-check.mjs's job.
    expect(images()[0]!.style.height).toBe("8cqh");
    // Stored as a percentage; the CSS property takes 0-1. Passing 50 straight
    // through clamps to fully opaque while an assertion on the stored value
    // still passes.
    expect(images()[0]!.style.opacity).toBe("0.5");
    expect(images()[1]!.style.opacity).toBe("");
  });

  it("removes a picture whose file will not load, and leaves the words where they were", () => {
    const world = testWorld({
      title: "Night Drive",
      overlays: [image({ position: "top-right" }), slot({ position: "top-center", source: "title" })],
    });
    mount(
      <OverlayLayer
        state={testState({ world, audioTransport: transport() })}
        videos={elements()}
        front={0}
        blank={false}
      />,
    );

    expect(images()).toHaveLength(1);
    act(() => {
      fireEvent.error(images()[0]!);
    });

    // Asserted as the element's absence, not as "no text nodes": a correct
    // build has no text here either way, so a text assertion would pass
    // whether or not this works. A broken <img> paints a platform glyph, which
    // is the leak the broadcast rule exists to stop.
    expect(images()).toHaveLength(0);
    expect(slots().map((s) => s.textContent)).toEqual(["Night Drive"]);
  });

  it("draws a picture from the World message alone, as an observer receives it", () => {
    // R29. An observer is given the World and nothing the operator's window
    // additionally loads — no playlist index, no library listing — and the
    // bytes come from the route rather than being pushed. The architectural
    // argument is easy to believe and cheap to check, so it is checked.
    const world = testWorld({ id: "night-drive", overlays: [image({ image: "logo.png" })] });
    mount(
      <OverlayLayer state={testState({ world })} videos={elements()} front={0} blank={false} />,
    );

    const src = new URL(images()[0]!.src, "http://x");
    expect(src.pathname).toBe("/api/live/image");
    expect(src.searchParams.get("world")).toBe("night-drive");
    expect(src.searchParams.get("image")).toBe("logo.png");
    // Never a filename in the alt: on a projector an attribute that reads as
    // prose is text too.
    expect(images()[0]!.alt).toBe("");
  });

  it("draws nothing for a picture slot the guard refuses", () => {
    const world = testWorld({
      overlays: [image({ size: 30 }), image({ image: "  " }), image({ opacity: NaN })],
    });
    mount(
      <OverlayLayer
        state={testState({ world, audioTransport: transport() })}
        videos={elements()}
        front={0}
        blank={false}
      />,
    );

    expect(images()).toHaveLength(0);
  });
});
