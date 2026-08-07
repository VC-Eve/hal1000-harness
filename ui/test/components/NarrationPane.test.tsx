import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import type { NarrationEntry, Readiness } from "../../../shared/src/types";
import { NarrationPane } from "../../src/components/NarrationPane";
import { harness, mount, testState } from "./harness";

const READY: Readiness = { ollama: "ok", models: "ok", claudeLogs: "ok", captioner: "disabled" };

const entry = (over: Partial<NarrationEntry> = {}): NarrationEntry => ({
  id: Math.random().toString(36).slice(2),
  at: "2026-08-07T10:15:30.000Z",
  kind: "narration",
  text: "The agent proceeds.",
  adapterId: "claude-code",
  ...over,
});

function renderPane(over: Parameters<typeof testState>[0] = {}) {
  const h = harness();
  mount(
    <NarrationPane
      state={testState({ readiness: READY, ...over })}
      send={h.send}
      dispatch={() => {}}
      intensity="medium"
      onOpenSettings={() => {}}
      collapseDisabled={false}
      onCollapse={() => {}}
    />,
  );
  return h;
}

// Several sessions narrate into one feed and they all carry the same adapter
// colour, so which session an observation is about, and which one the reader
// chose, have to be legible some other way.
describe("NarrationPane — concurrent sessions", () => {
  it("labels each entry with the session it is about", () => {
    renderPane({
      watchedSessionId: "sess-aaaa1111",
      narration: [
        entry({ text: "in the selected one", sessionId: "sess-aaaa1111", sessionLabel: "Claude Code [sess-aaa]" }),
        entry({ text: "in another one", sessionId: "sess-bbbb2222", sessionLabel: "Claude Code [sess-bbb]" }),
      ],
    });

    expect(screen.getByText("Claude Code [sess-aaa]")).toBeInTheDocument();
    expect(screen.getByText("Claude Code [sess-bbb]")).toBeInTheDocument();
  });

  it("marks the selected session's entries apart from the rest", () => {
    renderPane({
      watchedSessionId: "sess-aaaa1111",
      narration: [
        entry({ text: "in the selected one", sessionId: "sess-aaaa1111", sessionLabel: "Claude Code [sess-aaa]" }),
        entry({ text: "in another one", sessionId: "sess-bbbb2222", sessionLabel: "Claude Code [sess-bbb]" }),
      ],
    });

    expect(screen.getByText("in the selected one").closest(".feed-entry")).toHaveClass("session-selected");
    expect(screen.getByText("in another one").closest(".feed-entry")).toHaveClass("session-other");
  });

  // The highlight describes the current selection, not the one in force when
  // the entry was made — so changing it must re-emphasise the history too.
  it("moves the highlight when the selection changes", () => {
    renderPane({
      watchedSessionId: "sess-bbbb2222",
      narration: [
        entry({ text: "in the first one", sessionId: "sess-aaaa1111", sessionLabel: "Claude Code [sess-aaa]" }),
        entry({ text: "in the second one", sessionId: "sess-bbbb2222", sessionLabel: "Claude Code [sess-bbb]" }),
      ],
    });

    expect(screen.getByText("in the first one").closest(".feed-entry")).toHaveClass("session-other");
    expect(screen.getByText("in the second one").closest(".feed-entry")).toHaveClass("session-selected");
  });

  // Monitors and Vision are separate roles, not sessions: neither the label nor
  // the selection treatment applies to them.
  it("leaves monitor and vision entries out of the session treatment", () => {
    renderPane({
      watchedSessionId: "sess-aaaa1111",
      narration: [entry({ text: "from a monitor", adapterId: null, monitorId: "m1" }), entry({ text: "from vision", adapterId: null, fromVision: true })],
    });

    const monitor = screen.getByText("from a monitor").closest(".feed-entry")!;
    const vision = screen.getByText("from vision").closest(".feed-entry")!;
    for (const el of [monitor, vision]) {
      expect(el).not.toHaveClass("session-selected");
      expect(el).not.toHaveClass("session-other");
    }
  });

  it("shows how many sessions are being followed once there is more than one", () => {
    renderPane({ watchedSessionId: "sess-a", followedSessionIds: ["sess-a", "sess-b", "sess-c"] });
    expect(screen.getByTestId("followed-count")).toHaveTextContent("following 3");
  });

  // At one, the count would only restate the selection.
  it("omits the count when only one session is followed", () => {
    renderPane({ watchedSessionId: "sess-a", followedSessionIds: ["sess-a"] });
    expect(screen.queryByTestId("followed-count")).toBeNull();
  });

  // Observation continues with nothing selected, so a condition worth
  // reporting is just as true then.
  it("reports a stalled narrator even with no session selected", () => {
    renderPane({ watchedSessionId: null, narrationStatus: "provider-unavailable", narration: [entry()] });
    expect(document.querySelector(".banner.error")).not.toBeNull();
  });
});
