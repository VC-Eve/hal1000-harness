import { describe, it, expect } from "vitest";
import { lensState } from "../src/lens";
import type { NarrationStatus } from "../../shared/src/types";

// The whole `NarrationStatus` union, spelled out so adding a value to the
// shared contract without deciding what the lens does about it fails here as
// well as at the typecheck.
const ALL_STATUSES: NarrationStatus[] = [
  "idle",
  "narrating",
  "catching-up",
  "paused-missing-model",
  "provider-unavailable",
];

describe("lensState", () => {
  it("shows the composing lens while HAL narrates (R1)", () => {
    expect(lensState("narrating")).toBe("composing");
  });

  it("distinguishes a backlog from ordinary composition (R4)", () => {
    expect(lensState("catching-up")).toBe("backlog");
    expect(lensState("catching-up")).not.toBe(lensState("narrating"));
  });

  it("stays absent when HAL is paused or the provider is unreachable (AE2, R3)", () => {
    // A paused narrator must never look busy: the lens is a claim about what
    // HAL is doing, and here he is doing nothing.
    expect(lensState("paused-missing-model")).toBe("absent");
    expect(lensState("provider-unavailable")).toBe("absent");
  });

  it("yields to the finished text when idle (R2)", () => {
    expect(lensState("idle")).toBe("absent");
  });

  it("maps every status in the union to a known state", () => {
    for (const status of ALL_STATUSES) {
      expect(["composing", "backlog", "absent"]).toContain(lensState(status));
    }
  });

  it("treats an unknown status as absent rather than as composing", () => {
    // Defence in depth for a status arriving from a newer server than this
    // client: erring towards absent under-reports, erring towards composing
    // would have the interface claim work that is not happening.
    expect(lensState("some-future-status" as NarrationStatus)).toBe("absent");
  });

  it("is pure — the same status always yields the same state", () => {
    for (const status of ALL_STATUSES) {
      expect(lensState(status)).toBe(lensState(status));
    }
  });
});
