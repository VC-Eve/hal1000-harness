import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "@testing-library/react";
import type { ClientMessage } from "../../../shared/src/types";
import { mount } from "./harness";

/**
 * The client half of the observer role.
 *
 * This was the last untested line in the feature and the one everything else
 * rests on: the server's refusals are thorough and each was proved by removing
 * it, but they only ever fire for a socket that said `observe`, and nothing
 * asserted that anything ever says it. The line could have been deleted and the
 * whole suite would have stayed green while `/broadcast` quietly took the audio
 * grant on every boot.
 *
 * Its own file because `WsClient` has to be replaced wholesale, and hoisting
 * that mock into the routing suite would impose it on every other case there.
 */
const sent: ClientMessage[] = [];
let announce: ((state: "connecting" | "open" | "lost") => void) | null = null;

vi.mock("../../src/ws-client", () => ({
  WsClient: class {
    constructor(
      _onMessage: (msg: unknown) => void,
      onState: (state: "connecting" | "open" | "lost") => void,
    ) {
      announce = onState;
    }
    connect(): void {}
    close(): void {}
    send(msg: ClientMessage): void {
      sent.push(msg);
    }
  },
}));

const { App } = await import("../../src/App");

const observes = () => sent.filter((m) => m.type === "observe").length;

afterEach(() => {
  sent.length = 0;
  announce = null;
  window.history.pushState({}, "", "/");
  document.documentElement.classList.remove("broadcast");
});

describe("declaring the socket an observer", () => {
  it("declares once the socket is open on /broadcast", async () => {
    window.history.pushState({}, "", "/broadcast");
    mount(<App />);

    expect(observes()).toBe(0);
    await act(async () => announce!("open"));

    expect(observes()).toBe(1);
  });

  it("declares again after a reconnect", async () => {
    // The case the declaration exists for. This client auto-reconnects, and the
    // server restarts are routine here — `npm run start` never auto-reloads. A
    // declaration sent once at mount lapses on the first blip, and the broadcast
    // window is then an ordinary candidate for the audio grant at exactly the
    // moment nobody is watching for it.
    window.history.pushState({}, "", "/broadcast");
    mount(<App />);
    await act(async () => announce!("open"));

    await act(async () => announce!("lost"));
    await act(async () => announce!("open"));

    expect(observes()).toBe(2);
  });

  it("says nothing on the operator routes", async () => {
    window.history.pushState({}, "", "/live");
    mount(<App />);
    await act(async () => announce!("open"));

    expect(observes()).toBe(0);
  });

  it("declares when navigation reaches the broadcast route on an open socket", async () => {
    // Keyed on the route rather than on the moment the socket opened. Nothing
    // navigates here in-document today, but a declaration bound to a moment
    // rather than to the page would be silently wrong the day something does.
    window.history.pushState({}, "", "/");
    mount(<App />);
    await act(async () => announce!("open"));
    expect(observes()).toBe(0);

    await act(async () => {
      window.history.pushState({}, "", "/broadcast");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(observes()).toBe(1);
  });

  it("keeps the root element's black in step with the route", async () => {
    window.history.pushState({}, "", "/broadcast");
    mount(<App />);
    expect(document.documentElement.classList.contains("broadcast")).toBe(true);

    await act(async () => {
      window.history.pushState({}, "", "/live");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(document.documentElement.classList.contains("broadcast")).toBe(false);
  });
});
