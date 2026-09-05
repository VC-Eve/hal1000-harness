import { describe, it, expect, beforeAll } from "vitest";
import { StrictMode } from "react";
import { screen, waitFor } from "@testing-library/react";
import { ClipPlayer } from "../../src/components/ClipPlayer";
import { harness, mount, testLive, testState, testWorld } from "./harness";

/**
 * The clip engine mounted the way production mounts it.
 *
 * `ui/src/main.tsx` renders inside `React.StrictMode`; `harness.mount` is a
 * bare `render`. So every other case in the suite exercises a single mount
 * effect, and the double-invoked one — cleanup and re-run before paint — is a
 * path no test reaches. This file is that path, and nothing more.
 *
 * **What this does not prove, and why the file is small.** The plan this was
 * written under claimed the reporting guards were StrictMode-sensitive and
 * therefore uncovered, on the strength of the component's own comment about
 * "StrictMode double-invoking a mount effect". That was checked and is wrong:
 * both reports are raised from event handlers (`onEnded`, `onLoadedMetadata`),
 * and StrictMode double-invokes effects, not handlers. Removing both guards
 * fails two cases in `ClipPlayer.test.tsx` and none here — the dedupe is
 * already characterized where it always was, and a duplicate assertion here
 * would have been coverage-shaped decoration that cannot fail.
 *
 * What is left is a genuine gap rather than a defect: the double-invoked effect
 * assigns `loaded`, re-enters the `held` branch, and re-registers the `canplay`
 * listener a second time, and no test says the swap survives that. It survives
 * today. This is here so that an extraction which moves `held` or `loaded` off
 * refs — where the second invocation would see state the first one set, or
 * would not — is caught by something.
 */

// jsdom implements no media pipeline. Same fake as `ClipPlayer.test.tsx`, and
// asynchronous for the same reason: a synchronous `canplay` would hide the
// ordering the swap depends on.
beforeAll(() => {
  Object.defineProperty(HTMLMediaElement.prototype, "load", {
    configurable: true,
    value(this: HTMLMediaElement) {
      setTimeout(() => this.dispatchEvent(new Event("canplay")), 0);
    },
  });
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: () => Promise.resolve(),
  });
});

const sources = () =>
  [0, 1].map((i) => (screen.getByTestId(`clip-video-${i}`) as HTMLVideoElement).getAttribute("src"));

const front = () => [0, 1].find((i) => screen.getByTestId(`clip-video-${i}`).className.includes("front"));

const url = (path: string) => `/api/live/clip?world=lounge&clip=${encodeURIComponent(path)}`;

async function showing(path: string): Promise<number> {
  await waitFor(() => {
    const index = front();
    expect(index).not.toBeUndefined();
    expect(sources()[index!]).toBe(url(path));
  });
  return front()!;
}

describe("the clip engine under StrictMode", () => {
  it("still shows the element holding the current clip after a double-invoked mount effect", async () => {
    const h = harness();
    const world = testWorld();
    mount(
      <StrictMode>
        <ClipPlayer state={testState({ world, worldLive: testLive() })} send={h.send} />
      </StrictMode>,
    );

    const index = await showing("clips/couch-idle.mp4");

    // The other element is the spare, and must not also be showing.
    expect(screen.getByTestId(`clip-video-${index === 0 ? 1 : 0}`).className).not.toContain("front");
  });

  it("assigns the source once across both invocations", async () => {
    // The second invocation finds `held` already carrying this source and takes
    // the `currentTime = 0` branch instead of loading again. If an extraction
    // moved `held` somewhere the second invocation cannot see, the element
    // reloads mid-mount — which on a real pipeline is a visible restart.
    const h = harness();
    const world = testWorld();
    let loads = 0;
    const realLoad = HTMLMediaElement.prototype.load;
    Object.defineProperty(HTMLMediaElement.prototype, "load", {
      configurable: true,
      value(this: HTMLMediaElement) {
        loads += 1;
        setTimeout(() => this.dispatchEvent(new Event("canplay")), 0);
      },
    });

    mount(
      <StrictMode>
        <ClipPlayer state={testState({ world, worldLive: testLive() })} send={h.send} />
      </StrictMode>,
    );
    await showing("clips/couch-idle.mp4");

    Object.defineProperty(HTMLMediaElement.prototype, "load", { configurable: true, value: realLoad });
    expect(loads).toBe(1);
  });
});
