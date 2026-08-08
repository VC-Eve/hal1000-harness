// Collapsing the timeline into rows (U6, R13).
//
// Tested directly as well as through the pane. The failure that matters here is
// a collapse that swallows the one event anybody cares about, and a rendered
// assertion proves it for one arrangement while this proves it for the shapes
// that are awkward to mount.

import { describe, expect, it } from "vitest";
import { faceLabel, spanLabel, timelineRows } from "../src/vision-rows";
import type { VisionEvent } from "../../shared/src/types";

const nobody = (at: string): VisionEvent => ({ kind: "check", at, faces: [] });
const somebody = (at: string): VisionEvent => ({
  kind: "check",
  at,
  faces: [{ embedded: true, personId: "p1", name: "Creator", confidence: 0.71, band: "stated", weight: 0.4 }],
});
const said = (at: string): VisionEvent => ({ kind: "caption", at, caption: "a person at a desk" });

const stamp = (second: number) => `2026-08-08T10:00:${String(second).padStart(2, "0")}.000Z`;

describe("timelineRows", () => {
  it("leaves a lone check alone", () => {
    expect(timelineRows([somebody(stamp(0))])).toEqual([
      { kind: "check", at: stamp(0), faces: [expect.objectContaining({ name: "Creator" })] },
    ]);
  });

  it("collapses consecutive nobody-found checks and keeps the count and the span", () => {
    const rows = timelineRows([nobody(stamp(0)), nobody(stamp(3)), nobody(stamp(6))]);
    expect(rows).toEqual([{ kind: "absence", at: stamp(0), until: stamp(6), count: 3 }]);
  });

  it("collapses a run of one without pretending it is a span", () => {
    const rows = timelineRows([nobody(stamp(0))]);
    expect(rows[0]).toMatchObject({ count: 1, at: stamp(0), until: stamp(0) });
    expect(spanLabel(stamp(0), stamp(0))).toBe("");
  });

  it("breaks a run where somebody was seen", () => {
    const rows = timelineRows([nobody(stamp(0)), somebody(stamp(3)), nobody(stamp(6)), nobody(stamp(9))]);
    expect(rows.map((r) => r.kind)).toEqual(["absence", "check", "absence"]);
    expect(rows[2]).toMatchObject({ count: 2 });
  });

  it("breaks a run at a caption too", () => {
    // Otherwise a caption would have to be either dropped or rendered out of
    // order, and both would make the record disagree with itself about when
    // things happened.
    const rows = timelineRows([nobody(stamp(0)), said(stamp(3)), nobody(stamp(6))]);
    expect(rows.map((r) => r.kind)).toEqual(["absence", "caption", "absence"]);
  });

  it("does not mutate the events it was given", () => {
    // Rows are built by extending the last row in place; doing that to the
    // caller's event objects would corrupt the store.
    const events = [nobody(stamp(0)), nobody(stamp(3))];
    timelineRows(events);
    expect(events[0]).toEqual({ kind: "check", at: stamp(0), faces: [] });
  });

  it("renders nothing from nothing", () => {
    expect(timelineRows([])).toEqual([]);
  });
});

describe("spanLabel", () => {
  it("counts seconds, then minutes, then hours", () => {
    expect(spanLabel(stamp(0), stamp(12))).toBe("over 12s");
    expect(spanLabel("2026-08-08T10:00:00.000Z", "2026-08-08T10:05:00.000Z")).toBe("over 5m");
    expect(spanLabel("2026-08-08T10:00:00.000Z", "2026-08-08T13:00:00.000Z")).toBe("over 3h");
  });

  it("says nothing for a sub-second or malformed span", () => {
    // Acceptance-phrased, so a NaN from an unparseable stamp reads as no span
    // rather than as "over NaNs".
    expect(spanLabel(stamp(0), stamp(0))).toBe("");
    expect(spanLabel("not a date", stamp(5))).toBe("");
  });
});

describe("faceLabel", () => {
  it("names a match with its confidence", () => {
    expect(faceLabel({ embedded: true, name: "Creator", confidence: 0.71 })).toBe("Creator 71%");
  });

  it("distinguishes unrecognised from undescribable", () => {
    // Two different facts. A face the recogniser could find but not embed is
    // not the gallery's failure to know someone.
    expect(faceLabel({ embedded: true })).toBe("an unrecognised face");
    expect(faceLabel({ embedded: false })).toBe("a face it could not describe");
  });
});
