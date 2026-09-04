import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { TransportState, World } from "../../../shared/src/types";
import { WORLD_VERSION } from "../../../shared/src/worlds";
import { AudioPlayer, trackUrl } from "../../src/components/AudioPlayer";
import { harness, mount, testState } from "./harness";

/**
 * jsdom implements no media pipeline: `play`, `pause` and `load` are not
 * functions there and `currentTime` is not a property that keeps what it is
 * given. So the element is faked, and the fakes record — what this component
 * has to get right is *whether* it sounded and *when*, which is a count and an
 * order rather than anything audible.
 */
const played: HTMLMediaElement[] = [];
const paused: HTMLMediaElement[] = [];

beforeAll(() => {
  Object.defineProperty(HTMLMediaElement.prototype, "load", { configurable: true, value: () => {} });
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value(this: HTMLMediaElement) {
      played.push(this);
      return Promise.resolve();
    },
  });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", {
    configurable: true,
    value(this: HTMLMediaElement) {
      paused.push(this);
    },
  });
  // A settable one, so a resume can be asserted rather than assumed.
  Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
    configurable: true,
    writable: true,
    value: 0,
  });
});

beforeEach(() => {
  played.length = 0;
  paused.length = 0;
});

const transport = (over: Partial<TransportState> = {}): TransportState => ({
  playlistId: "warmup",
  index: 0,
  path: "tracks/a.flac",
  name: "a.flac",
  playing: false,
  positionMs: 0,
  durationMs: 300_000,
  volume: 1,
  tracks: 3,
  bpm: null,
  audible: false,
  generation: 1,
  ...over,
});

const element = () => screen.getByTestId("audio-element") as HTMLAudioElement;

describe("the gesture gate", () => {
  it("covers AE4: offers the control, sounds nothing, and starts on the gesture", async () => {
    const h = harness();
    const armed = transport();
    const { rerender } = mount(
      <AudioPlayer state={testState({ audioTransport: armed, audioAuthority: true })} send={h.send} />,
    );

    // The loudspeaker announced itself, which is what tells the server to arm
    // the playlist rather than start it.
    await waitFor(() => expect(h.sent).toContainEqual({ type: "audio-transport", command: "attend" }));
    expect(h.sent).not.toContainEqual({ type: "audio-transport", command: "enable-sound" });
    // Nothing sounded, and the control to fix that is on screen.
    expect(played).toHaveLength(0);
    expect(screen.getByTestId("audio-enable")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("audio-enable"));
    expect(h.sent).toContainEqual({ type: "audio-transport", command: "enable-sound" });
    // Still silent: the gesture asks the server, and the server is what says a
    // track is now playing. A client that started on its own click would be
    // sounding a transport nobody else knows about.
    expect(played).toHaveLength(0);

    rerender(
      <AudioPlayer
        state={testState({
          audioTransport: transport({ playing: true, audible: true }),
          audioAuthority: true,
        })}
        send={h.send}
      />,
    );
    await waitFor(() => expect(played).toHaveLength(1));
    expect(element().getAttribute("src")).toBe(trackUrl("tracks/a.flac"));
    // The control has done its job and stops being offered.
    expect(screen.queryByTestId("audio-enable")).toBeNull();
  });

  it("resumes where the server is rather than at the start of the track", async () => {
    const h = harness();
    mount(
      <AudioPlayer
        state={testState({
          audioTransport: transport({ playing: true, audible: true, positionMs: 42_000 }),
          audioAuthority: true,
        })}
        send={h.send}
      />,
    );
    fireEvent.click(screen.getByTestId("audio-enable"));
    fireEvent.loadedMetadata(element());
    expect(element().currentTime).toBe(42);
  });

  it("plays the same track again when the server says it started again", async () => {
    // A playlist of one wraps onto its own track: same path, same source. The
    // element is finished and holds the right bytes, so only the generation says
    // to play it again — without it the pane sits silent while the clock runs,
    // which is what "no looping" was.
    const h = harness();
    const view = mount(
      <AudioPlayer
        state={testState({
          audioTransport: transport({ playing: true, audible: true, generation: 7 }),
          audioAuthority: true,
        })}
        send={h.send}
      />,
    );
    fireEvent.click(screen.getByTestId("audio-enable"));
    const src = element().getAttribute("src");
    element().currentTime = 3.5;
    const before = played.length;

    view.rerender(
      <AudioPlayer
        state={testState({
          audioTransport: transport({ playing: true, audible: true, generation: 8 }),
          audioAuthority: true,
        })}
        send={h.send}
      />,
    );

    // Rewound and played, and *not* reassigned: setting `src` again would
    // refetch a file the browser already has and gap the loop.
    expect(element().getAttribute("src")).toBe(src);
    expect(element().currentTime).toBe(0);
    expect(played.length).toBeGreaterThan(before);
  });

  it("does not restart the track on a rerender that changed nothing", async () => {
    const h = harness();
    const held = transport({ playing: true, audible: true, generation: 7 });
    const view = mount(
      <AudioPlayer state={testState({ audioTransport: held, audioAuthority: true })} send={h.send} />,
    );
    fireEvent.click(screen.getByTestId("audio-enable"));
    element().currentTime = 3.5;
    const before = played.length;

    view.rerender(
      <AudioPlayer
        state={testState({ audioTransport: { ...held, positionMs: 4_000 }, audioAuthority: true })}
        send={h.send}
      />,
    );

    expect(element().currentTime).toBe(3.5);
    expect(played.length).toBe(before);
  });
});

describe("one click to start", () => {
  /** A World naming a set, which is the ordinary state of the pane. */
  const world = (playlistId: string | null = "warmup"): World => ({
    version: WORLD_VERSION,
    id: "booth",
    name: "Booth",
    defaultStateId: null,
    states: [],
    transitions: [],
    parameters: [],
    playlistId,
  });

  it("enables sound and starts this World's playlist in the one gesture", async () => {
    const h = harness();
    // A fresh page against a transport holding nothing, which is where every
    // session begins: the gesture used to lift the gate and stop there, leaving
    // the person to find a second control before anything made a sound.
    mount(
      <AudioPlayer
        state={testState({ audioTransport: null, audioAuthority: true, world: world() })}
        send={h.send}
      />,
    );
    await waitFor(() => expect(h.countOf("audio-transport")).toBeGreaterThan(0));

    fireEvent.click(screen.getByTestId("audio-enable"));
    expect(h.sent).toContainEqual({ type: "audio-transport", command: "enable-sound" });
    expect(h.sent).toContainEqual({
      type: "audio-transport",
      command: "start-world-playlist",
      worldId: "booth",
    });
    // In that order: the transport is cleared to sound before the first track
    // begins, so it starts rather than arming and waiting for a second click.
    const commands = h.sent.filter((m) => m.type === "audio-transport").map((m) => m.command);
    expect(commands.indexOf("enable-sound")).toBeLessThan(commands.indexOf("start-world-playlist"));
  });

  it("interrupts nothing when a track is already held", () => {
    const h = harness();
    mount(
      <AudioPlayer
        state={testState({
          audioTransport: transport({ playing: true, index: 1 }),
          audioAuthority: true,
          world: world(),
        })}
        send={h.send}
      />,
    );

    fireEvent.click(screen.getByTestId("audio-enable"));
    expect(h.sent).toContainEqual({ type: "audio-transport", command: "enable-sound" });
    // `start-world-playlist` is the one command the arming gate does not apply
    // to, so sending it here would restart a set mid-track — from a click that
    // was about letting this browser make a sound.
    expect(h.sent.some((m) => m.type === "audio-transport" && m.command === "start-world-playlist")).toBe(
      false,
    );
  });

  it("asks for nothing from a World that names no playlist", () => {
    const h = harness();
    mount(
      <AudioPlayer
        state={testState({ audioTransport: null, audioAuthority: true, world: world(null) })}
        send={h.send}
      />,
    );
    fireEvent.click(screen.getByTestId("audio-enable"));
    // The announcement and the gesture, and nothing else: the command would come
    // back refused, on every client's pane.
    expect(h.sent.filter((m) => m.type === "audio-transport").map((m) => m.command)).toEqual([
      "attend",
      "enable-sound",
    ]);
  });
});

describe("the end of a track", () => {
  it("reports what the element finished, once", async () => {
    const h = harness();
    mount(
      <AudioPlayer
        state={testState({
          audioTransport: transport({ playing: true, audible: true }),
          audioAuthority: true,
        })}
        send={h.send}
      />,
    );
    fireEvent.click(screen.getByTestId("audio-enable"));
    await waitFor(() => expect(played).toHaveLength(1));

    fireEvent.ended(element());
    fireEvent.ended(element());
    expect(h.sent.filter((m) => m.type === "report-track-end")).toEqual([
      { type: "report-track-end", playlistId: "warmup", path: "tracks/a.flac" },
    ]);
  });

  it("says nothing before the gesture or from a client that lost the grant", async () => {
    const h = harness();
    const state = (authority: boolean) =>
      testState({ audioTransport: transport({ playing: true, audible: true }), audioAuthority: authority });
    const { rerender } = mount(<AudioPlayer state={state(true)} send={h.send} />);

    // No gesture yet: this element has sounded nothing, so it has finished
    // nothing either.
    fireEvent.ended(element());
    expect(h.countOf("report-track-end")).toBe(0);

    fireEvent.click(screen.getByTestId("audio-enable"));
    rerender(<AudioPlayer state={state(false)} send={h.send} />);
    // The superseded owner's element keeps running for a beat and keeps firing.
    // Advancing a playlist somebody else is sounding is what that costs.
    fireEvent.ended(element());
    expect(h.countOf("report-track-end")).toBe(0);
  });
});

describe("a client that is not the authority", () => {
  it("renders the transport read-only, sounds nothing and sends nothing", async () => {
    const h = harness();
    mount(
      <AudioPlayer
        state={testState({
          audioTransport: transport({ playing: true, audible: true }),
          audioAuthority: false,
        })}
        send={h.send}
      />,
    );

    expect(screen.getByTestId("audio-readonly")).toBeInTheDocument();
    expect(screen.queryByTestId("audio-enable")).toBeNull();
    for (const control of ["audio-previous", "audio-play", "audio-next"]) {
      expect(screen.getByTestId(control)).toBeDisabled();
    }
    fireEvent.click(screen.getByTestId("audio-play"));
    // Nothing at all: not the command, not the announcement, not a sound. The
    // transport says a track is playing and this client still holds its peace.
    expect(h.sent).toEqual([]);
    expect(played).toHaveLength(0);
    // It does not even fetch the bytes: a read-only tab streaming a 40MB FLAC
    // it is never going to sound is a download nobody asked for.
    expect(element().getAttribute("src")).toBeNull();
    // It still shows what is playing, because read-only is a display and not a
    // blank.
    expect(screen.getByTestId("audio-track")).toHaveTextContent("a.flac");
  });

  it("stops sounding the moment the grant moves away", async () => {
    const h = harness();
    const state = (authority: boolean) =>
      testState({ audioTransport: transport({ playing: true, audible: true }), audioAuthority: authority });
    const { rerender } = mount(<AudioPlayer state={state(true)} send={h.send} />);
    fireEvent.click(screen.getByTestId("audio-enable"));
    await waitFor(() => expect(played).toHaveLength(1));

    rerender(<AudioPlayer state={state(false)} send={h.send} />);
    // The superseded owner stops first and asks questions later: the element is
    // paused and nothing was sounded a second time.
    await waitFor(() => expect(paused.length).toBeGreaterThan(0));
    expect(played).toHaveLength(1);
  });

  it("offers a way to take the grant, and counts that press as the gesture", async () => {
    const h = harness();
    const state = (authority: boolean) =>
      testState({ audioTransport: transport({ playing: true, audible: true }), audioAuthority: authority });
    const { rerender } = mount(<AudioPlayer state={state(false)} send={h.send} />);

    // The recourse a read-only pane had none of: without this, a tab left open
    // in another window holds the loudspeaker until somebody finds and closes
    // it, and every other pane is a dead control with no explanation.
    fireEvent.click(screen.getByTestId("audio-take"));
    expect(h.sent).toEqual([{ type: "take-audio-authority" }]);
    // Still not the authority until the server says so, and still silent.
    expect(played).toHaveLength(0);

    rerender(<AudioPlayer state={state(true)} send={h.send} />);
    // The press was a real click on this page, so the browser's activation is
    // already spent on it: the sound resumes here without a second control and
    // a second click, which is the shape "start the sound" already refuses to
    // repeat.
    await waitFor(() => expect(played).toHaveLength(1));
    expect(h.sent).toContainEqual({ type: "audio-transport", command: "attend" });
    expect(h.sent).toContainEqual({ type: "audio-transport", command: "enable-sound" });
    expect(screen.queryByTestId("audio-enable")).toBeNull();
    // And the pane that holds the grant is not offered a way to take it.
    expect(screen.queryByTestId("audio-take")).toBeNull();
  });
});

describe("the element going away", () => {
  it("tells the server the loudspeaker has gone", async () => {
    const h = harness();
    const { unmount } = mount(
      <AudioPlayer
        state={testState({ audioTransport: transport({ playing: true }), audioAuthority: true })}
        send={h.send}
      />,
    );
    await waitFor(() => expect(h.sent).toContainEqual({ type: "audio-transport", command: "attend" }));

    unmount();
    // The socket is still open, so nothing else says this happened: `leave` sees
    // a disconnect and this is not one. Untold, the server went on reporting
    // `audible` for a room in silence and went on waiting out its end-of-track
    // grace for an `ended` no element would send.
    expect(h.sent).toContainEqual({ type: "audio-transport", command: "unattend" });
  });

  it("says nothing on the way out if it never announced itself", () => {
    // A read-only tab holds no grant, so it has nothing to hand back — and
    // asking would take an authority nobody was holding just to give it back.
    const h = harness();
    const { unmount } = mount(
      <AudioPlayer state={testState({ audioTransport: transport(), audioAuthority: false })} send={h.send} />,
    );
    unmount();
    expect(h.countOf("audio-transport")).toBe(0);
  });

  it("does not sound again on a remount that has not been clicked", async () => {
    const h = harness();
    const playing = transport({ playing: true, audible: true });
    const { unmount } = mount(
      <AudioPlayer state={testState({ audioTransport: playing, audioAuthority: true })} send={h.send} />,
    );
    fireEvent.click(screen.getByTestId("audio-enable"));
    await waitFor(() => expect(played).toHaveLength(1));

    unmount();
    played.length = 0;
    mount(<AudioPlayer state={testState({ audioTransport: playing, audioAuthority: true })} send={h.send} />);

    // The browser's activation gate is per element: the new one has never been
    // clicked, so it offers the control again rather than calling `play` and
    // reporting a blocked autoplay to everybody's pane.
    expect(played).toHaveLength(0);
    expect(screen.getByTestId("audio-enable")).toBeInTheDocument();
  });
});

describe("playing and audible", () => {
  it("says when the clock is running and nothing is sounding it", () => {
    const h = harness();
    const { rerender } = mount(
      <AudioPlayer
        state={testState({
          audioTransport: transport({ playing: true, audible: false }),
          audioAuthority: true,
        })}
        send={h.send}
      />,
    );
    // The World is running unattended — which it must be able to do (origin
    // R25) — and saying only "playing" there is a stale reading served
    // confidently about a silent room.
    expect(screen.getByTestId("audio-unattended")).toBeInTheDocument();
    expect(screen.queryByTestId("audio-audible")).toBeNull();

    rerender(
      <AudioPlayer
        state={testState({
          audioTransport: transport({ playing: true, audible: true }),
          audioAuthority: true,
        })}
        send={h.send}
      />,
    );
    expect(screen.getByTestId("audio-audible")).toBeInTheDocument();
    expect(screen.queryByTestId("audio-unattended")).toBeNull();

    // And neither with nothing playing: there is no sound to be missing.
    rerender(
      <AudioPlayer
        state={testState({ audioTransport: transport({ playing: false }), audioAuthority: true })}
        send={h.send}
      />,
    );
    expect(screen.queryByTestId("audio-audible")).toBeNull();
    expect(screen.queryByTestId("audio-unattended")).toBeNull();
  });
});

describe("faults", () => {
  it("shows a blocked-sound failure apart from the transport's own fault", () => {
    const h = harness();
    const { rerender } = mount(
      <AudioPlayer
        state={testState({
          audioTransport: transport({ soundError: "The browser blocked it." }),
          audioAuthority: true,
        })}
        send={h.send}
      />,
    );
    expect(screen.getByTestId("audio-sound-fault")).toHaveTextContent("blocked");
    expect(screen.queryByTestId("audio-track-fault")).toBeNull();

    rerender(
      <AudioPlayer
        state={testState({
          audioTransport: transport({ error: "No track in that playlist could be played." }),
          audioAuthority: true,
        })}
        send={h.send}
      />,
    );
    // Two faults, two places. A pane that merged them would tell an author to go
    // and look at their playlist because this browser has no decoder for FLAC.
    expect(screen.getByTestId("audio-track-fault")).toHaveTextContent("could be played");
    expect(screen.queryByTestId("audio-sound-fault")).toBeNull();
  });

  it("reports bytes it could not play as this client's failure", async () => {
    const h = harness();
    mount(
      <AudioPlayer
        state={testState({ audioTransport: transport({ playing: true }), audioAuthority: true })}
        send={h.send}
      />,
    );
    fireEvent.error(element());
    expect(h.countOf("report-audio-failure")).toBe(1);
  });
});

describe("what it tells the server", () => {
  it("reports a length the store does not know, once", () => {
    const h = harness();
    mount(
      <AudioPlayer
        state={testState({
          audioTransport: transport({ playing: true, durationMs: 0 }),
          audioAuthority: true,
        })}
        send={h.send}
      />,
    );
    const audio = element();
    Object.defineProperty(audio, "duration", { configurable: true, value: 240 });

    fireEvent.loadedMetadata(audio);
    fireEvent.loadedMetadata(audio);
    expect(h.sent.filter((m) => m.type === "report-track-duration")).toEqual([
      { type: "report-track-duration", playlistId: "warmup", path: "tracks/a.flac", durationMs: 240_000 },
    ]);
  });

  it("says nothing about a length the store already has right", () => {
    const h = harness();
    mount(
      <AudioPlayer
        state={testState({
          audioTransport: transport({ playing: true, durationMs: 240_050 }),
          audioAuthority: true,
        })}
        send={h.send}
      />,
    );
    const audio = element();
    Object.defineProperty(audio, "duration", { configurable: true, value: 240 });
    fireEvent.loadedMetadata(audio);
    expect(h.countOf("report-track-duration")).toBe(0);
  });

  it("survives an unstable send without an unbounded request loop", async () => {
    const h = harness();
    // A fresh function on every render, which is what an app that built `send`
    // inline would hand it. An effect depending on it would announce the
    // loudspeaker on every render, and every announcement produces a broadcast
    // that renders again.
    const unstable = (state: ReturnType<typeof testState>) => (
      <AudioPlayer state={state} send={(msg) => h.send(msg)} />
    );
    const { rerender } = mount(
      unstable(testState({ audioTransport: transport(), audioAuthority: true })),
    );
    fireEvent.click(screen.getByTestId("audio-enable"));
    for (let i = 1; i <= 6; i += 1) {
      rerender(
        unstable(
          testState({
            audioTransport: transport({ playing: true, audible: true, positionMs: i * 1_000 }),
            audioAuthority: true,
          }),
        ),
      );
    }
    await waitFor(() => expect(h.countOf("audio-transport")).toBeGreaterThan(0));
    // One announcement and one gesture, however many times the transport ticked.
    expect(h.countOf("audio-transport")).toBe(2);
    // And one `play`, not seven: an effect keyed on the whole transport would
    // reassign the source and restart the track on every tick of the position.
    expect(played).toHaveLength(1);
  });
});

describe("the byte URL", () => {
  it("names the track in a query parameter, never as a path segment", () => {
    expect(trackUrl("tracks/a b.flac")).toBe("/api/live/audio?track=tracks%2Fa%20b.flac");
  });
});
