import { describe, expect, it } from "vitest";
import {
  MIX_MAX,
  SPEED_MAX,
  SPEED_MIN,
  cleanId,
  cleanLabel,
  cleanMix,
  cleanPreset,
  idFromLabel,
  shares,
  unknownVoices,
  usableSpeed,
  usableWeight,
} from "../../../shared/src/voices.js";

const preset = (over: Record<string, unknown> = {}) => ({
  id: "hal",
  label: "HAL 9000",
  mix: [{ voice: "am_michael", weight: 0.6 }],
  speed: 0.95,
  ...over,
});

describe("usableSpeed", () => {
  it("accepts the band and refuses outside it", () => {
    expect(usableSpeed(SPEED_MIN)).toBe(SPEED_MIN);
    expect(usableSpeed(SPEED_MAX)).toBe(SPEED_MAX);
    expect(usableSpeed(1)).toBe(1);
    expect(usableSpeed(SPEED_MIN - 0.01)).toBeNull();
    expect(usableSpeed(SPEED_MAX + 0.01)).toBeNull();
  });

  // The negation-once shape exists for exactly this: a guard written as
  // `value < MIN || value > MAX` returns false for NaN and lets it through.
  it("fails closed on NaN and Infinity", () => {
    expect(usableSpeed(Number.NaN)).toBeNull();
    expect(usableSpeed(Number.POSITIVE_INFINITY)).toBeNull();
    expect(usableSpeed("1" as unknown)).toBeNull();
  });
});

describe("usableWeight", () => {
  it("allows zero and refuses negatives", () => {
    // Zero is a voice turned down to nothing but not yet removed, which is a
    // normal state mid-design. Negative would subtract a voice from a blend.
    expect(usableWeight(0)).toBe(0);
    expect(usableWeight(2.5)).toBe(2.5);
    expect(usableWeight(-0.1)).toBeNull();
    expect(usableWeight(Number.NaN)).toBeNull();
  });
});

describe("cleanMix", () => {
  it("keeps author order and author weights", () => {
    const mix = cleanMix([
      { voice: "bm_george", weight: 3 },
      { voice: "am_michael", weight: 1 },
    ]);
    expect(mix).toEqual([
      { voice: "bm_george", weight: 3 },
      { voice: "am_michael", weight: 1 },
    ]);
  });

  it("refuses an empty mix, an over-long one, and a duplicate voice", () => {
    expect(cleanMix([])).toBeNull();
    expect(cleanMix(Array.from({ length: MIX_MAX + 1 }, (_, i) => ({ voice: `v${i}`, weight: 1 })))).toBeNull();
    expect(
      cleanMix([
        { voice: "am_michael", weight: 1 },
        { voice: "am_michael", weight: 2 },
      ]),
    ).toBeNull();
  });

  it("refuses a mix whose weights are all zero", () => {
    // Refused here rather than at render time: `shares` cannot answer for it,
    // and a preset that cannot be rendered should not reach the store.
    expect(cleanMix([{ voice: "am_michael", weight: 0 }])).toBeNull();
    expect(
      cleanMix([
        { voice: "am_michael", weight: 0 },
        { voice: "bm_george", weight: 0 },
      ]),
    ).toBeNull();
  });

  it("allows one voice at zero beside a voice that sounds", () => {
    expect(
      cleanMix([
        { voice: "am_michael", weight: 0 },
        { voice: "bm_george", weight: 1 },
      ]),
    ).toHaveLength(2);
  });

  it("refuses malformed entries rather than repairing them", () => {
    expect(cleanMix([{ voice: "am_michael" }])).toBeNull();
    expect(cleanMix([{ weight: 1 }])).toBeNull();
    expect(cleanMix([{ voice: "", weight: 1 }])).toBeNull();
    expect(cleanMix("am_michael" as unknown)).toBeNull();
  });
});

describe("shares", () => {
  it("normalises at use and leaves the stored weights alone", () => {
    const mix = [
      { voice: "am_michael", weight: 1 },
      { voice: "bm_george", weight: 1 },
    ];
    expect(shares(mix)).toEqual([
      { voice: "am_michael", share: 0.5 },
      { voice: "bm_george", share: 0.5 },
    ]);
    // The point of normalising at use: the author's numbers are untouched.
    expect(mix[0]!.weight).toBe(1);
  });

  it("gives the same answer for a ratio however it is written", () => {
    const a = shares([
      { voice: "am_michael", weight: 0.6 },
      { voice: "bm_george", weight: 0.4 },
    ]);
    const b = shares([
      { voice: "am_michael", weight: 6 },
      { voice: "bm_george", weight: 4 },
    ]);
    expect(a).toEqual(b);
  });

  it("moves every share when a voice is added, which is why the editor shows them", () => {
    const two = shares([
      { voice: "a", weight: 1 },
      { voice: "b", weight: 1 },
    ]);
    const three = shares([
      { voice: "a", weight: 1 },
      { voice: "b", weight: 1 },
      { voice: "c", weight: 1 },
    ]);
    expect(two?.map((s) => s.share)).toEqual([0.5, 0.5]);
    expect(three?.every((s) => Math.abs(s.share - 1 / 3) < 1e-12)).toBe(true);
  });

  it("refuses what it cannot normalise", () => {
    expect(shares([])).toBeNull();
    expect(shares([{ voice: "a", weight: 0 }])).toBeNull();
    expect(shares([{ voice: "a", weight: Number.NaN }])).toBeNull();
  });
});

describe("unknownVoices", () => {
  it("names what was wrong rather than answering yes or no", () => {
    const mix = [
      { voice: "am_michael", weight: 1 },
      { voice: "am_nobody", weight: 1 },
      { voice: "af_ghost", weight: 1 },
    ];
    expect(unknownVoices(mix, ["am_michael", "bm_george"])).toEqual(["am_nobody", "af_ghost"]);
  });

  it("is empty for a mix the pack carries", () => {
    expect(unknownVoices([{ voice: "am_michael", weight: 1 }], ["am_michael"])).toEqual([]);
  });
});

describe("ids and labels", () => {
  it("derives an id from a label", () => {
    expect(idFromLabel("HAL 9000")).toBe("hal-9000");
    expect(idFromLabel("  Mission Control  ")).toBe("mission-control");
    expect(idFromLabel("Bowman's Voice")).toBe("bowman-s-voice");
  });

  it("refuses a label with nothing usable in it", () => {
    expect(idFromLabel("!!!")).toBeUndefined();
    expect(idFromLabel("   ")).toBeUndefined();
    expect(cleanLabel("   ")).toBeUndefined();
    expect(cleanId("Has Spaces")).toBeUndefined();
    expect(cleanId("-leading")).toBeUndefined();
  });

  it("bounds a long label rather than refusing it", () => {
    expect(cleanLabel("x".repeat(500))).toHaveLength(60);
  });
});

describe("cleanPreset", () => {
  it("accepts the canonical form", () => {
    expect(cleanPreset(preset())).toEqual({
      id: "hal",
      label: "HAL 9000",
      mix: [{ voice: "am_michael", weight: 0.6 }],
      speed: 0.95,
    });
  });

  it("refuses when any one field is unusable", () => {
    expect(cleanPreset(preset({ id: "Not An Id" }))).toBeNull();
    expect(cleanPreset(preset({ label: "" }))).toBeNull();
    expect(cleanPreset(preset({ mix: [] }))).toBeNull();
    expect(cleanPreset(preset({ speed: 9 }))).toBeNull();
    expect(cleanPreset(preset({ speed: Number.NaN }))).toBeNull();
  });

  it("refuses a non-object", () => {
    expect(cleanPreset(null)).toBeNull();
    expect(cleanPreset([preset()])).toBeNull();
    expect(cleanPreset("hal")).toBeNull();
  });
});
