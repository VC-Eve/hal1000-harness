import { describe, it, expect } from "vitest";
import {
  DEFAULT_OVERLAYS,
  MAX_OVERLAYS,
  TEXT_MAX,
  cleanOverlays,
  cleanSlot,
  cleanText,
  hexColor,
  isImageSlot,
  isTextSlot,
  overlayEntries,
  resolveSlot,
  slotsOf,
  usableSize,
  usableFade,
  isCondition,
  MAX_OVERLAY_FADE_MS,
  MAX_SLOT_STATES,
  MAX_SLOT_CONDITIONS,
  type OverlaySlot,
  type ImageSlot,
  type TextSlot,
} from "../../../shared/src/overlays.js";
import type { TransportState, World } from "../../../shared/src/types.js";
import { WORLD_VERSION, BOOLEAN_OPS, NUMERIC_OPS, CONDITION_OPS } from "../../../shared/src/worlds.js";

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

const slot = (over: Partial<TextSlot> = {}): TextSlot => ({
  position: "bottom-left",
  source: "text",
  text: "hello",
  font: "Segoe UI",
  size: 4,
  color: "#ffffff",
  ...over,
});

/**
 * The first cleaned slot, as the text slot these cases build.
 *
 * `cleanOverlays` answers a union, so reading `.font` off it is a type error
 * rather than a cast — and narrowing here asserts the kind survived the round
 * trip, which is the thing worth checking anyway: a text slot that came back as
 * anything else would fail the guard rather than the assertion.
 */
const firstText = (list: OverlaySlot[] | null): TextSlot | undefined => {
  const first = list?.[0];
  return first !== undefined && isTextSlot(first) ? first : undefined;
};

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
    expect(firstText(cleanOverlays([slot({ source: "text", text: " hi " })]))?.text).toBe("hi");
    expect(cleanOverlays([slot({ source: "title", text: "stray" })])?.[0]).not.toHaveProperty("text");
  });

  it("stores colours as typed, canonicalised and never normalised", () => {
    expect(firstText(cleanOverlays([slot({ color: "#000000" })]))?.color).toBe("#000000");
    expect(firstText(cleanOverlays([slot({ color: "#e0301e" })]))?.color).toBe("#e0301e");
    expect(firstText(cleanOverlays([slot({ color: "#FFF" })]))?.color).toBe("#ffffff");
    expect(cleanOverlays([slot({ color: "red" })])).toBeNull();
    expect(hexColor("abc")).toBe("#aabbcc");
    expect(hexColor(12)).toBeNull();
  });

  it("falls back to the page font for a blank family and bounds a long one", () => {
    expect(firstText(cleanOverlays([slot({ font: "  " })]))?.font).toBe("Segoe UI");
    expect(firstText(cleanOverlays([slot({ font: "x".repeat(100) })]))?.font).toHaveLength(60);
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


describe("a list of two kinds", () => {
  const image = (over: Partial<ImageSlot> = {}): ImageSlot => ({
    kind: "image",
    position: "top-right",
    image: "logo.png",
    size: 6,
    ...over,
  });

  it("reads a slot with no kind as text, and keeps its canonical form kindless", () => {
    // The whole of backward compatibility. A stored `kind: "text"` is accepted
    // and dropped, so no manifest gains a key on its owner's next edit.
    const cleaned = cleanOverlays([slot(), { ...slot(), kind: "text" }])!;
    expect(cleaned).toHaveLength(2);
    expect(cleaned.every(isTextSlot)).toBe(true);
    expect(cleaned[0]).not.toHaveProperty("kind");
    expect(cleaned[1]).not.toHaveProperty("kind");
  });

  it("refuses an unknown kind rather than reading it as text", () => {
    // Drawing a caption because a word was misspelled is worse than drawing
    // nothing, and `kind: undefined` is the only absence that means text.
    expect(cleanOverlays([{ ...slot(), kind: "video" }])).toBeNull();
    expect(cleanOverlays([{ ...slot(), kind: 3 }])).toBeNull();
  });

  it("keeps a picture slot's own fields and drops a caption's", () => {
    const cleaned = cleanSlot({ ...image(), font: "Georgia", color: "#ff0000", source: "title", text: "x" })!;
    expect(cleaned).toMatchObject({ kind: "image", image: "logo.png", size: 6 });
    expect(cleaned).not.toHaveProperty("font");
    expect(cleaned).not.toHaveProperty("color");
    expect(cleaned).not.toHaveProperty("source");
    expect(cleaned).not.toHaveProperty("text");
  });

  it("accepts a picture slot with no picture, and draws nothing for it", () => {
    // The rule a caption with no words already keeps: valid, and takes no
    // space. Refusing it instead had the editor's write filter drop the row it
    // had just added.
    const cleaned = cleanSlot(image({ image: undefined }))!;
    expect(cleaned).not.toBeNull();
    expect(cleaned).not.toHaveProperty("image");
    expect(cleanSlot(image({ image: "   " }))).not.toBeNull();
    expect(resolveSlot(cleaned, world(), transport())).toBeNull();
  });

  it("takes opacity absent, refuses it unusable, and never confuses the two", () => {
    // `NaN ?? 100` is `NaN`, so absent and unusable must be different answers
    // rather than one fallback. Written as one negation around the acceptance,
    // the way `usableSize` is.
    expect(cleanSlot(image())).not.toHaveProperty("opacity");
    expect(cleanSlot(image({ opacity: 0 }))).toMatchObject({ opacity: 0 });
    expect(cleanSlot(image({ opacity: 100 }))).toMatchObject({ opacity: 100 });
    for (const bad of [NaN, Infinity, -1, 101, "50" as never, null as never]) {
      expect(cleanSlot(image({ opacity: bad }))).toBeNull();
    }
  });

  it("holds both kinds under one bound and one position set", () => {
    // Every one of these invariants held partly because every member was text.
    // Adding a variant is how a safeguard that worked by accident is found, so
    // each is asserted against a member with no font, no source and no words.
    const mixed = [image(), slot(), image({ position: "bottom-center" })];
    expect(cleanOverlays(mixed)).toHaveLength(3);
    expect(cleanOverlays(Array.from({ length: MAX_OVERLAYS }, () => image()))).toHaveLength(MAX_OVERLAYS);
    expect(cleanOverlays(Array.from({ length: MAX_OVERLAYS + 1 }, () => image()))).toBeNull();
    expect(cleanOverlays([image({ position: "centre" as never })])).toBeNull();
    expect(cleanOverlays([image({ size: 0 })])).toBeNull();
    expect(cleanOverlays([image({ size: 26 })])).toBeNull();
    expect(cleanOverlays([image({ size: NaN })])).toBeNull();
    // Resolving a slot means "the words it draws", and a picture draws none.
    expect(resolveSlot(image(), world({ title: "Night Drive" }), transport())).toBeNull();
    expect(isImageSlot(image())).toBe(true);
    expect(isTextSlot(image())).toBe(false);
    expect(isTextSlot(slot())).toBe(true);
  });

  it("keeps a mixed list whole through the lenient guard", () => {
    // One unusable picture must not cost the list its captions — the reason
    // the load is lenient and the write is strict.
    const kept = overlayEntries([image({ size: 300 }), slot(), image()])!;
    expect(kept).toHaveLength(3);
    expect(kept.map((s) => cleanSlot(s) !== null)).toEqual([false, true, true]);
  });
});

describe("when a slot is drawn", () => {
  const image = (over: Partial<ImageSlot> = {}): ImageSlot => ({
    kind: "image",
    position: "top-right",
    image: "logo.png",
    size: 6,
    ...over,
  });
  const clause = { parameter: "energy", op: "gt", value: 0.7 } as const;

  it("leaves all three absent on a slot that says nothing, on both kinds", () => {
    // The whole of backward compatibility for this feature: every slot on disk
    // today takes this path, and none of them gains a key on its next save.
    for (const cleaned of [cleanSlot(slot())!, cleanSlot(image())!]) {
      expect(cleaned).not.toHaveProperty("states");
      expect(cleaned).not.toHaveProperty("conditions");
      expect(cleaned).not.toHaveProperty("fadeMs");
    }
  });

  it("keeps States, clauses and a fade on both kinds, in order", () => {
    const second = { parameter: "audio.playing", op: "is", value: true } as const;
    for (const kind of [slot(), image()]) {
      const cleaned = cleanSlot({ ...kind, states: ["s2", "s1"], conditions: [clause, second], fadeMs: 400 })!;
      expect(cleaned.states).toEqual(["s2", "s1"]);
      expect(cleaned.conditions).toEqual([clause, second]);
      expect(cleaned.fadeMs).toBe(400);
    }
  });

  it("drops an empty list and a zero fade rather than storing them", () => {
    // Absent is the canonical form for "always drawn", so an operator clearing
    // the last clause leaves the slot shaped like one that never had any.
    const cleaned = cleanSlot({ ...slot(), states: [], conditions: [], fadeMs: 0 })!;
    expect(cleaned).not.toHaveProperty("states");
    expect(cleaned).not.toHaveProperty("conditions");
    expect(cleaned).not.toHaveProperty("fadeMs");
  });

  it("drops a repeated State but keeps the first mention's place", () => {
    expect(cleanSlot({ ...slot(), states: ["a", "b", "a"] })!.states).toEqual(["a", "b"]);
  });

  it("refuses a malformed clause rather than dropping it, on both kinds", () => {
    // Refused, not dropped: a slot drawn on a schedule nobody wrote is worse
    // than a slot the editor marks broken. The same rule an unknown `kind` and
    // an unknown `backing` already follow.
    const bad: unknown[] = [
      3,
      {},
      "energy gt 0.7",
      [null],
      [{ op: "gt", value: 1 }],
      [{ parameter: 7, op: "gt", value: 1 }],
      [{ parameter: "", op: "gt", value: 1 }],
      [{ parameter: "energy", op: "matches", value: 1 }],
      [{ parameter: "energy", op: "gt", value: "1" }],
      [{ parameter: "energy", op: "gt", value: Number.NaN }],
      [{ parameter: "energy", op: "gt", value: Number.POSITIVE_INFINITY }],
    ];
    for (const conditions of bad) {
      expect(cleanSlot({ ...slot(), conditions })).toBeNull();
      expect(cleanSlot({ ...image(), conditions })).toBeNull();
    }
  });

  it("refuses a malformed States list rather than dropping it", () => {
    for (const states of [3, "s1", {}, [null], [7], [""], ["   "], ["x".repeat(65)]] as unknown[]) {
      expect(cleanSlot({ ...slot(), states })).toBeNull();
      expect(cleanSlot({ ...image(), states })).toBeNull();
    }
    expect(cleanSlot({ ...slot(), states: ["x".repeat(64)] })!.states).toHaveLength(1);
  });

  it("refuses a fade outside the band, and never reads NaN as no fade", () => {
    // `usableOpacity`'s rule: absent and unusable are different answers, and
    // collapsing them would let a hand edit arrive as "no fade requested".
    for (const fadeMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, MAX_OVERLAY_FADE_MS + 1, "400"] as unknown[]) {
      expect(cleanSlot({ ...slot(), fadeMs })).toBeNull();
    }
    expect(cleanSlot({ ...slot(), fadeMs: MAX_OVERLAY_FADE_MS })!.fadeMs).toBe(MAX_OVERLAY_FADE_MS);
  });

  it("refuses the whole list through the strict guard, and keeps it through the lenient one", () => {
    // The pairing the editor's write filter depends on: a hand-edited manifest
    // still loads and still shows the operator a row to fix.
    expect(cleanOverlays([slot(), { ...slot(), conditions: 3 }])).toBeNull();
    const kept = overlayEntries([{ ...slot(), conditions: 3 }, slot()])!;
    expect(kept).toHaveLength(2);
    expect(kept.map((s) => cleanSlot(s) !== null)).toEqual([false, true]);
  });

  it("accepts every operator the machine chooses between, and nothing else", () => {
    // Registered once in `worlds.ts`; an operator added there is refused here
    // until it is added there too, rather than being quietly admitted.
    for (const op of [...BOOLEAN_OPS, ...NUMERIC_OPS]) {
      const value = BOOLEAN_OPS.includes(op) ? true : 1;
      expect(isCondition({ parameter: "p", op, value })).toBe(true);
    }
    expect(isCondition({ parameter: "p", op: "contains", value: 1 })).toBe(false);
  });
});

describe("what a hand-edited when can and cannot be", () => {
  const clause = { parameter: "energy", op: "gt", value: 0.7 } as const;

  it("refuses more States or clauses than a slot may hold", () => {
    // Every other list-shaped input in this file has a count cap, and these two
    // were the exception. The guard runs on every load, on every report and on
    // every render of both surfaces, so an unbounded list in a portable
    // manifest is unbounded work behind every ordinary edit.
    const ids = Array.from({ length: MAX_SLOT_STATES }, (_, i) => `s${i}`);
    expect(cleanSlot({ ...slot(), states: ids })!.states).toHaveLength(MAX_SLOT_STATES);
    expect(cleanSlot({ ...slot(), states: [...ids, "one-too-many"] })).toBeNull();

    const many = Array.from({ length: MAX_SLOT_CONDITIONS }, () => clause);
    expect(cleanSlot({ ...slot(), conditions: many })!.conditions).toHaveLength(MAX_SLOT_CONDITIONS);
    expect(cleanSlot({ ...slot(), conditions: [...many, clause] })).toBeNull();
  });

  it("reads the operator set from its one registration point", () => {
    for (const op of CONDITION_OPS) {
      const value = op === "is" || op === "isNot" ? true : 1;
      expect(isCondition({ parameter: "p", op, value })).toBe(true);
    }
    expect(CONDITION_OPS).toHaveLength(6);
  });
});
