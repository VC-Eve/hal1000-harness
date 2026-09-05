import { describe, it, expect, afterEach, vi } from "vitest";
import { screen } from "@testing-library/react";
import { mount } from "./harness";

/**
 * Where the broadcast branch sits relative to the boundary that already exists.
 *
 * Its own file because the assertion needs `BroadcastStage` replaced by
 * something that throws, and a module mock has to be hoisted above the import
 * of `App` — which the routing suite in `LivePane.test.tsx` cannot do without
 * imposing the mock on every other case in it. Vitest isolates test files, so
 * this mounts `App` without racing that suite's history cleanup.
 *
 * The property under test is the fourth leak in the origin's table. `App` wraps
 * its route switch in `<ErrorBoundary label="The main view">`, whose fallback
 * renders the throw's own message — a clip path, in the case that matters — and
 * the words "This is a fault in HAL". On `/live` that is right and useful. On a
 * projector it is the thing this whole surface exists to prevent, so the
 * broadcast branch has to return above the boundary rather than inside it.
 */
vi.mock("../../src/components/BroadcastStage", () => ({
  BroadcastStage: () => {
    throw new Error("clips/couch-idle.mp4 is missing");
  },
}));

const { App } = await import("../../src/App");

afterEach(() => {
  window.history.pushState({}, "", "/");
});

describe("a throw on the broadcast route", () => {
  it("is not caught and turned into text", () => {
    window.history.pushState({}, "", "/broadcast");

    // The throw escaping to the caller is the property: nothing intercepted it
    // and rendered its message. React unmounts the tree, leaving the black the
    // root element already carries.
    expect(() => mount(<App />)).toThrow(/couch-idle/);
    expect(screen.queryByTestId("render-error")).toBeNull();
  });
});
