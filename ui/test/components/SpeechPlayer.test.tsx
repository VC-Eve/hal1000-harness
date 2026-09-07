import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { SpeechPlayer } from "../../src/components/SpeechPlayer";
import { AudioPlayer } from "../../src/components/AudioPlayer";
import type { Utterance } from "../../../shared/src/types";
import { harness, testState, testSettings } from "./harness";

/**
 * jsdom implements no media: `play()` is undefined and `volume` throws outside
 * 0–1. Both are stubbed to the shapes the components actually depend on, so what
 * is asserted here is the component's decisions — which URL, which report, what
 * level — rather than anything about playback, which only a browser can show.
 */
let played: string[] = [];
let refuse = false;

beforeEach(() => {
  played = [];
  refuse = false;
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: function play(this: HTMLAudioElement) {
      if (refuse) return Promise.reject(new DOMException("blocked", "NotAllowedError"));
      played.push(this.getAttribute("src") ?? "");
      return Promise.resolve();
    },
  });
});

const utterance = (over: Partial<Utterance> = {}): Utterance => ({
  generation: 4,
  text: "I am afraid, Dave. This mission is too important.",
  voiceId: "hal",
  sentences: [
    { text: "I am afraid, Dave.", durationMs: 1500 },
    { text: "This mission is too important.", durationMs: 2000 },
  ],
  current: -1,
  ...over,
});

const flush = () => new Promise((done) => setTimeout(done, 0));

describe("SpeechPlayer", () => {
  it("sounds only on the client holding the grant", async () => {
    const h = harness();
    render(
      <SpeechPlayer
        state={testState({ speech: utterance(), audioAuthority: false })}
        send={h.send}
        gestured
      />,
    );
    await flush();
    expect(played).toEqual([]);
    expect(h.countOf("report-speech-sentence")).toBe(0);
  });

  it("does not sound on a page that has had no gesture", async () => {
    // The browser would refuse anyway; not trying is what keeps the refusal out
    // of the console and the state honest.
    const h = harness();
    render(
      <SpeechPlayer
        state={testState({ speech: utterance(), audioAuthority: true })}
        send={h.send}
        gestured={false}
      />,
    );
    await flush();
    expect(played).toEqual([]);
  });

  it("plays the first sentence and reports it", async () => {
    const h = harness();
    render(
      <SpeechPlayer
        state={testState({ speech: utterance(), audioAuthority: true })}
        send={h.send}
        gestured
      />,
    );
    await flush();
    expect(played).toHaveLength(1);
    expect(played[0]).toContain("generation=4");
    expect(played[0]).toContain("sentence=0");
    // The subtitle follows this report rather than a server timer, so the words
    // on screen and the words being said cannot drift apart.
    expect(h.sent).toContainEqual({
      type: "report-speech-sentence",
      generation: 4,
      index: 0,
    });
  });

  it("reports a blocked play instead of leaving subtitles under silence", async () => {
    refuse = true;
    const h = harness();
    render(
      <SpeechPlayer
        state={testState({ speech: utterance(), audioAuthority: true })}
        send={h.send}
        gestured
      />,
    );
    await flush();
    expect(h.countOf("report-speech-sentence")).toBe(0);
    expect(screen.getByRole("status")).toHaveTextContent(/not been allowed to make a sound/i);
  });

  it("stops when the utterance is cleared", async () => {
    const h = harness();
    const { rerender } = render(
      <SpeechPlayer
        state={testState({ speech: utterance(), audioAuthority: true })}
        send={h.send}
        gestured
      />,
    );
    await flush();
    rerender(
      <SpeechPlayer state={testState({ speech: null, audioAuthority: true })} send={h.send} gestured />,
    );
    await flush();
    const element = screen.getByTestId("speech-player") as HTMLAudioElement;
    expect(element.getAttribute("src")).toBeNull();
  });

  it("does not replay the first sentence when it outruns the renderer", async () => {
    // Kokoro renders at about real time, so a short first sentence finishes
    // before the second has been synthesised. The client then reports past the
    // last *rendered* sentence and waits. When the second arrives it must resume
    // at sentence 1 — forgetting the position here replayed sentence 0, which is
    // "I'm a robot, get fucked. I'm a robot, get fucked. I don't even care."
    const h = harness();
    const one = utterance({ sentences: [{ text: "I am a robot.", durationMs: 900 }] });
    const { rerender } = render(
      <SpeechPlayer state={testState({ speech: one, audioAuthority: true })} send={h.send} gestured />,
    );
    await flush();
    expect(played).toHaveLength(1);
    expect(played[0]).toContain("sentence=0");

    // Sentence 0 ends while sentence 1 is still being rendered.
    fireEvent.ended(screen.getByTestId("speech-player"));
    await flush();
    expect(played).toHaveLength(1); // nothing new to play yet

    // Sentence 1 lands.
    const two = utterance({
      sentences: [
        { text: "I am a robot.", durationMs: 900 },
        { text: "I do not even care.", durationMs: 1100 },
      ],
    });
    rerender(
      <SpeechPlayer state={testState({ speech: two, audioAuthority: true })} send={h.send} gestured />,
    );
    await flush();

    expect(played).toHaveLength(2);
    expect(played[1]).toContain("sentence=1");
    expect(played.filter((src) => src.includes("sentence=0"))).toHaveLength(1);
  });

  it("starts the replacement when a new generation supersedes the old", async () => {
    const h = harness();
    const { rerender } = render(
      <SpeechPlayer
        state={testState({ speech: utterance(), audioAuthority: true })}
        send={h.send}
        gestured
      />,
    );
    await flush();
    rerender(
      <SpeechPlayer
        state={testState({ speech: utterance({ generation: 5 }), audioAuthority: true })}
        send={h.send}
        gestured
      />,
    );
    await flush();
    expect(played).toHaveLength(2);
    expect(played[1]).toContain("generation=5");
    expect(played[1]).toContain("sentence=0");
  });
});

describe("the duck", () => {
  const level = (speech: Utterance | null, over: Parameters<typeof testSettings>[0] = {}) => {
    const h = harness();
    // Each call gets its own container and is torn down after: the helper is
    // called twice in one test, and a shared document would find two elements.
    const view = render(
      <AudioPlayer
        state={testState({
          speech,
          audioAuthority: true,
          settings: testSettings(over),
          audioTransport: {
            playlistId: "p",
            generation: 1,
            index: 0,
            playing: true,
            positionMs: 0,
            volume: 0.8,
            audible: true,
          } as never,
        })}
        send={h.send}
      />,
    );
    const element = view.getByTestId("audio-element") as HTMLAudioElement;
    const volume = element.volume;
    view.unmount();
    return volume;
  };

  it("multiplies the transport's volume rather than replacing it", () => {
    // Writing the transport's own number would survive the line, and it is
    // server-owned and shared — every other tab would go quiet too.
    const loud = level(null);
    const ducked = level(utterance());
    expect(loud).toBeCloseTo(0.8, 5);
    expect(ducked).toBeCloseTo(0.8 * 10 ** (-12 / 20), 5);
  });

  it("leaves the music alone at a depth of zero", () => {
    expect(level(utterance(), { speechDuckDb: 0 })).toBeCloseTo(0.8, 5);
  });

  it("falls back to the default rather than muting on a value it cannot read", () => {
    // A guard written the other way round would silence the music on a NaN.
    const bad = level(utterance(), { speechDuckDb: Number.NaN as never });
    expect(bad).toBeCloseTo(0.8 * 10 ** (-12 / 20), 5);
    expect(bad).toBeGreaterThan(0);
  });

  it("does not duck on a client that is not sounding", () => {
    const h = harness();
    const view = render(
      <AudioPlayer
        state={testState({
          speech: utterance(),
          audioAuthority: false,
          audioTransport: { volume: 0.8, playing: true } as never,
        })}
        send={h.send}
      />,
    );
    expect((view.getByTestId("audio-element") as HTMLAudioElement).volume).toBeCloseTo(0.8, 5);
  });
});
