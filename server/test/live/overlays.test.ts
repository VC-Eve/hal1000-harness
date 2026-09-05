import { describe, it, expect } from "vitest";
import {
  DEFAULT_OVERLAYS,
  MAX_OVERLAYS,
  TEXT_MAX,
  cleanOverlays,
  cleanText,
  hexColor,
  overlayEntries,
  resolveSlot,
  slotsOf,
  usableSize,
  type OverlaySlot,
} from "../../../shared/src/overlays.js";
import type { TransportState, World } from "../../../shared/src/types.js";
import { WORLD_VERSION } from "../../../shared/src/worlds.js";

const world = (over: Partial<World> = {}): World => ({
  version: WORLD_VERSION,
  id: "night-drive",
  name: "Night Drive",
  defaultStateId: null,
  states: [],
  transitions: [],
  parameters: [],
  ...over,
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

const slot = (over: Partial<OverlaySlot> = {}): OverlaySlot => ({
  position: "bottom-left",
  source: "text",
  text: "hello",
  font: "Segoe UI",
  size: 4,
  color: "#ffffff",
  ...over,
});

describe("slotsOf", () => {
  it("gives the three defaults to a World with no overlays key", () => {
    expect(slotsOf(world())).toBe(DEFAULT_OVERLAYS);
    expect(DEFAULT_OVERLAYS.map((s) => [s.position, s.source])).toEqual([
      ["top-center", "title"],
      ["bottom-left", "playlist-header"],
      ["bottom-left", "track-description"],
    ]);
  });

  it("gives nothing for an explicit empty list, and nothing for no World", () => {
    expect(slotsOf(world({ overlays: [] }))).toEqual([]);
    expect(slotsOf(null)).toEqual([]);
  });

  it("gives a stored list unchanged", () => {
    const stored = [slot()];
    expect(slotsOf(world({ overlays: stored }))).toBe(stored);
  });
});

describe("resolveSlot", () => {
  it("answers each source from where its words live", () => {
    const w = world({ title: " Night Drive " });
    const t = transport();
    expect(resolveSlot(slot({ source: "title" }), w, t)).toBe("Night Drive");
    expect(resolveSlot(slot({ source: "playlist-header" }), w, t)).toBe("Late Set");
    expect(resolveSlot(slot({ source: "track-description" }), w, t)).toBe("A slow one");
    expect(resolveSlot(slot({ source: "text", text: " fixed " }), w, t)).toBe("fixed");
  });

  it("is null for empty, whitespace and absent words", () => {
    const t = transport({ header: null, description: null });
    expect(resolveSlot(slot({ source: "title" }), world(), t)).toBeNull();
    expect(resolveSlot(slot({ source: "title" }), world({ title: "   " }), t)).toBeNull();
    expect(resolveSlot(slot({ source: "playlist-header" }), world(), t)).toBeNull();
    expect(resolveSlot(slot({ source: "track-description" }), world(), t)).toBeNull();
    expect(resolveSlot(slot({ source: "text", text: "" }), world(), t)).toBeNull();
    expect(resolveSlot(slot({ source: "text", text: undefined }), world(), t)).toBeNull();
  });

  it("is null for the playlist sources while nothing is received or held", () => {
    expect(resolveSlot(slot({ source: "playlist-header" }), world(), null)).toBeNull();
    expect(resolveSlot(slot({ source: "track-description" }), null, undefined)).toBeNull();
    const held = transport({ index: -1, path: null, name: null, description: null });
    expect(resolveSlot(slot({ source: "playlist-header" }), world(), held)).toBe("Late Set");
    expect(resolveSlot(slot({ source: "track-description" }), world(), held)).toBeNull();
  });

  it("is null for a stored slot that is not usable, and leaves the others alone", () => {
    const bad = slot({ size: 30 });
    const good = slot({ size: 25 });
    expect(resolveSlot(bad, world(), transport())).toBeNull();
    expect(resolveSlot(good, world(), transport())).toBe("hello");
    expect(resolveSlot({ ...slot(), position: "nowhere" as never }, world(), transport())).toBeNull();
  });
});

describe("cleanOverlays", () => {
  it("accepts the band's edges and refuses everything outside it", () => {
    expect(cleanOverlays([slot({ size: 1 }), slot({ size: 25 })])?.map((s) => s.size)).toEqual([1, 25]);
    for (const size of [0, 26, NaN, Infinity, "4" as never]) {
      expect(cleanOverlays([slot({ size })])).toBeNull();
    }
  });

  it("refuses a position or source outside the sets", () => {
    expect(cleanOverlays([slot({ position: "centre" as never })])).toBeNull();
    expect(cleanOverlays([slot({ source: "clock" as never })])).toBeNull();
  });

  it("refuses a list longer than MAX_OVERLAYS, and a non-array", () => {
    expect(cleanOverlays(Array.from({ length: MAX_OVERLAYS }, () => slot()))).toHaveLength(MAX_OVERLAYS);
    expect(cleanOverlays(Array.from({ length: MAX_OVERLAYS + 1 }, () => slot()))).toBeNull();
    expect(cleanOverlays("yes")).toBeNull();
    expect(cleanOverlays([])).toEqual([]);
  });

  it("keeps text on a text slot and drops it elsewhere", () => {
    expect(cleanOverlays([slot({ source: "text", text: " hi " })])?.[0]?.text).toBe("hi");
    expect(cleanOverlays([slot({ source: "title", text: "stray" })])?.[0]).not.toHaveProperty("text");
  });

  it("stores colours as typed, canonicalised and never normalised", () => {
    expect(cleanOverlays([slot({ color: "#000000" })])?.[0]?.color).toBe("#000000");
    expect(cleanOverlays([slot({ color: "#e0301e" })])?.[0]?.color).toBe("#e0301e");
    expect(cleanOverlays([slot({ color: "#FFF" })])?.[0]?.color).toBe("#ffffff");
    expect(cleanOverlays([slot({ color: "red" })])).toBeNull();
    expect(hexColor("abc")).toBe("#aabbcc");
    expect(hexColor(12)).toBeNull();
  });

  it("falls back to the page font for a blank family and bounds a long one", () => {
    expect(cleanOverlays([slot({ font: "  " })])?.[0]?.font).toBe("Segoe UI");
    expect(cleanOverlays([slot({ font: "x".repeat(100) })])?.[0]?.font).toHaveLength(60);
  });
});

describe("overlayEntries", () => {
  it("is undefined for absent, empty for a non-array, and keeps a list whole", () => {
    expect(overlayEntries(undefined)).toBeUndefined();
    expect(overlayEntries("yes")).toEqual([]);
    const five = [slot(), slot(), slot({ size: 30 }), slot(), slot()];
    const kept = overlayEntries(five)!;
    expect(kept).toHaveLength(5);
    expect(kept.map((s) => resolveSlot(s, world(), transport()))).toEqual([
      "hello",
      "hello",
      null,
      "hello",
      "hello",
    ]);
  });

  it("drops entries that are not objects", () => {
    expect(overlayEntries([slot(), null, 3, "x", [slot()]])).toHaveLength(1);
  });
});

describe("cleanText and usableSize", () => {
  it("keeps TEXT_MAX, cuts TEXT_MAX + 1, and clears whitespace", () => {
    expect(cleanText("x".repeat(TEXT_MAX))).toHaveLength(TEXT_MAX);
    expect(cleanText("x".repeat(TEXT_MAX + 1))).toHaveLength(TEXT_MAX);
    expect(cleanText("   ")).toBeUndefined();
    expect(cleanText(4)).toBeUndefined();
  });

  it("accepts a size in the band and refuses the rest", () => {
    expect(usableSize(3.5)).toBe(3.5);
    expect(usableSize(0.5)).toBeNull();
    expect(usableSize(NaN)).toBeNull();
    expect(usableSize("3")).toBeNull();
  });
});
