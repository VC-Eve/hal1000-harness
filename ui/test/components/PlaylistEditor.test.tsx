import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import type {
  AudioListing,
  Playlist,
  PlaylistTrack,
  TransportState,
  World,
} from "../../../shared/src/types";
import { unreachableIndexConditions } from "../../../shared/src/world-graph";
import { AudioPlayer } from "../../src/components/AudioPlayer";
import { AudioBrowser } from "../../src/components/AudioBrowser";
import { PlaylistEditor } from "../../src/components/PlaylistEditor";
import { harness, mount, testState, testWorld } from "./harness";
import { TEXT_MAX } from "../../../shared/src/overlays";

/**
 * The playlist surfaces: building a list, editing what a track is worth to the
 * machine, and driving the transport.
 *
 * jsdom implements no media pipeline, so the element is faked exactly as
 * `AudioPlayer.test.tsx` establishes — the transport assertions here are about
 * what is *sent* and what is *disabled*, which is a count and a flag rather
 * than anything audible.
 */
beforeAll(() => {
  Object.defineProperty(HTMLMediaElement.prototype, "load", { configurable: true, value: () => {} });
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: () => Promise.resolve(),
  });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value: () => {} });
});

const track = (over: Partial<PlaylistTrack> = {}): PlaylistTrack => ({
  path: "tracks/a.flac",
  name: "a.flac",
  durationMs: 300_000,
  ...over,
});

const playlist = (over: Partial<Playlist> = {}): Playlist => ({
  id: "warmup",
  name: "Warmup",
  tracks: [
    track({ path: "tracks/1.flac", name: "1.flac", bpm: 174, bpmSource: "measured" }),
    track({ path: "tracks/2.flac", name: "2.flac" }),
    track({ path: "tracks/3.flac", name: "3.flac" }),
    track({ path: "tracks/4.flac", name: "4.flac" }),
  ],
  ...over,
});

const audioListing = (over: Partial<AudioListing> = {}): AudioListing => ({
  folder: "/music",
  parent: "/",
  folders: [{ name: "dnb", path: "/music/dnb" }],
  tracks: [
    { name: "one.flac", path: "/music/one.flac", sizeBytes: 4096 },
    { name: "two.flac", path: "/music/two.flac", sizeBytes: 8192 },
    { name: "three.mp3", path: "/music/three.mp3", sizeBytes: 2048 },
  ],
  matched: 3,
  ...over,
});

const transport = (over: Partial<TransportState> = {}): TransportState => ({
  playlistId: "warmup",
  index: 0,
  path: "tracks/1.flac",
  name: "1.flac",
  playing: false,
  positionMs: 0,
  durationMs: 300_000,
  volume: 1,
  tracks: 4,
  header: null,
  description: null,
  bpm: null,
  audible: false,
  shuffle: false,
  ...over,
});

/**
 * A World that exits on a playlist position.
 *
 * The condition is the point of the fixture: `audio.track` is one-based, so a
 * playlist shrunk below the position it names can never satisfy it again.
 */
const worldOnTrack = (id: string, name: string, value: number): World =>
  testWorld({
    id,
    name,
    playlistId: "warmup",
    transitions: [
      {
        id: "t1",
        from: "s-couch",
        to: "s-booth",
        clips: [],
        conditions: [{ parameter: "audio.track", op: "eq", value }],
        hasExitTime: false,
        exitTime: 0,
        order: 0,
      },
    ],
  });

describe("the track that is sounding, and starting another", () => {
  /** The editor showing the playlist the transport is holding, from the authority. */
  function sounding(over: Partial<Parameters<typeof testState>[0]> = {}) {
    const h = harness();
    mount(
      <PlaylistEditor
        state={testState({
          playlist: playlist(),
          world: testWorld(),
          audioTransport: transport({ path: "tracks/2.flac", name: "2.flac", index: 1, playing: true }),
          audioAuthority: true,
          ...over,
        })}
        send={h.send}
        onClose={() => {}}
      />,
    );
    return h;
  }

  const marked = () =>
    ["1.flac", "2.flac", "3.flac", "4.flac"].filter((name) =>
      screen.getByTestId(`entry-${name}`).className.includes("track-playing"),
    );

  it("marks the track the transport is holding, and only that one", () => {
    sounding();
    expect(marked()).toEqual(["2.flac"]);
  });

  it("marks nothing when the transport is holding another playlist", () => {
    // A playlist belongs to no World and this editor opens any of them, so the
    // tracks in front of the operator are very often not the ones sounding.
    sounding({ audioTransport: transport({ playlistId: "closing", path: "tracks/2.flac" }) });
    expect(marked()).toEqual([]);
  });

  it("marks nothing when the transport is holding nothing at all", () => {
    sounding({ audioTransport: transport({ playlistId: null, path: null, name: null, index: -1 }) });
    expect(marked()).toEqual([]);
  });

  it("matches the row by path rather than by position", () => {
    // The index a row is drawn at and the index the transport is holding are two
    // counts of two arrays that an edit in another tab can separate — and under
    // shuffle the transport's next track is not this row's neighbour either.
    sounding({ audioTransport: transport({ path: "tracks/3.flac", name: "3.flac", index: 0 }) });
    expect(marked()).toEqual(["3.flac"]);
  });

  it("starts the track that was clicked, naming it by path", () => {
    const h = sounding();
    fireEvent.click(screen.getByTestId("play-4.flac"));
    expect(h.sent.filter((m) => m.type === "audio-transport")).toEqual([
      { type: "audio-transport", command: "play-track", playlistId: "warmup", path: "tracks/4.flac" },
    ]);
  });

  it("sends nothing from a client that is not the audio authority", () => {
    // The display half of the rule the server enforces inbound. A control that
    // looks live and does nothing is the dead control the take-authority button
    // exists to prevent.
    const h = sounding({ audioAuthority: false });
    expect(screen.getByTestId("play-4.flac")).toBeDisabled();
    fireEvent.click(screen.getByTestId("play-4.flac"));
    expect(h.sent.filter((m) => m.type === "audio-transport")).toEqual([]);
  });

  it("sends nothing when the playlist on screen is not the one sounding", () => {
    const h = sounding({ audioTransport: transport({ playlistId: "closing" }) });
    expect(screen.getByTestId("play-4.flac")).toBeDisabled();
    fireEvent.click(screen.getByTestId("play-4.flac"));
    expect(h.sent.filter((m) => m.type === "audio-transport")).toEqual([]);
  });

  it("leaves the other controls on the row doing only their own job", () => {
    const h = sounding();
    fireEvent.click(screen.getByTestId("remove-3.flac"));
    fireEvent.click(screen.getByTestId("down-1.flac"));
    expect(h.sent.map((m) => m.type).filter((type) => type !== "list-playlists")).toEqual([
      "remove-track",
      "reorder-playlist",
    ]);
  });
});

describe("the shuffle switch", () => {
  function editor(over: Partial<Parameters<typeof testState>[0]> = {}, list = playlist()) {
    const h = harness();
    mount(
      <PlaylistEditor
        state={testState({ playlist: list, world: testWorld(), ...over })}
        send={h.send}
        onClose={() => {}}
      />,
    );
    return h;
  }

  it("shows what the playlist holds and sends the opposite", () => {
    const off = editor();
    expect(screen.getByTestId("toggle-shuffle")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByTestId("toggle-shuffle"));
    expect(off.sent.filter((m) => m.type === "set-playlist-shuffle")).toEqual([
      { type: "set-playlist-shuffle", playlistId: "warmup", shuffle: true },
    ]);
  });

  it("sends the switch off again when it is on", () => {
    const on = editor({}, playlist({ shuffle: true }));
    expect(screen.getByTestId("toggle-shuffle")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("toggle-shuffle"));
    expect(on.sent.filter((m) => m.type === "set-playlist-shuffle")).toEqual([
      { type: "set-playlist-shuffle", playlistId: "warmup", shuffle: false },
    ]);
  });

  it("stays live for a client that is not the audio authority", () => {
    // It is an index edit, not a transport command. Editing a playlist and
    // sounding one are separate permissions, exactly as a reorder is.
    const h = editor({ audioAuthority: false, audioTransport: transport() });
    expect(screen.getByTestId("toggle-shuffle")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("toggle-shuffle"));
    expect(h.sent.filter((m) => m.type === "set-playlist-shuffle")).toHaveLength(1);
  });
});

describe("what a removal costs the Worlds that play the playlist", () => {
  it("covers AE13: names both Worlds and the conditions the removal invalidated", () => {
    const h = harness();
    const before = playlist();
    // Two removals, and the editor sends one message for each.
    const { rerender } = mount(
      <PlaylistEditor state={testState({ playlist: before, world: testWorld() })} send={h.send} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("remove-4.flac"));
    fireEvent.click(screen.getByTestId("remove-3.flac"));
    expect(h.sent.filter((m) => m.type === "remove-track")).toEqual([
      { type: "remove-track", playlistId: "warmup", path: "tracks/4.flac" },
      { type: "remove-track", playlistId: "warmup", path: "tracks/3.flac" },
    ]);

    // What the server answers with. Derived by the same pure function the
    // server calls, so this fixture invents no report — the shape and the
    // wording are the product's, not the test's.
    const b = worldOnTrack("booth", "DJ Booth", 4);
    const c = worldOnTrack("lounge", "Lounge", 3);
    const after = { ...before, tracks: before.tracks.slice(0, 2) };
    rerender(
      <PlaylistEditor
        state={testState({
          playlist: after,
          world: testWorld(),
          playlistImpact: {
            playlistId: "warmup",
            action: "remove-track",
            impacts: [
              { worldId: b.id, worldName: b.name, conditions: unreachableIndexConditions(b, 2) },
              { worldId: c.id, worldName: c.name, conditions: unreachableIndexConditions(c, 2) },
            ],
          },
        })}
        send={h.send}
        onClose={() => {}}
      />,
    );

    // Both Worlds, at the moment of the edit — not when each is next opened.
    expect(screen.getByTestId("playlist-impact")).toBeInTheDocument();
    expect(screen.getByTestId("impact-booth")).toHaveTextContent("DJ Booth");
    expect(screen.getByTestId("impact-booth")).toHaveTextContent("audio.track eq 4");
    expect(screen.getByTestId("impact-lounge")).toHaveTextContent("Lounge");
    expect(screen.getByTestId("impact-lounge")).toHaveTextContent("audio.track eq 3");
  });

  it("says nothing about a playlist other than the one on screen", () => {
    const h = harness();
    const b = worldOnTrack("booth", "DJ Booth", 4);
    mount(
      <PlaylistEditor
        state={testState({
          playlist: playlist(),
          playlistImpact: {
            playlistId: "closing-set",
            action: "remove-track",
            impacts: [{ worldId: b.id, worldName: b.name, conditions: unreachableIndexConditions(b, 2) }],
          },
        })}
        send={h.send}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByTestId("playlist-impact")).toBeNull();
  });
});

describe("the track browser", () => {
  it("stays open across picks and commits the whole selection in one send", () => {
    const h = harness();
    mount(
      <AudioBrowser
        state={testState({ audioLibrary: audioListing() })}
        send={h.send}
        playlistId="warmup"
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByText("one.flac"));
    // Still open, and nothing has been committed. `ClipBrowser` would have sent
    // and closed here — this is the one place the two deliberately differ.
    expect(screen.getByTestId("audio-browser")).toBeInTheDocument();
    expect(h.countOf("import-tracks")).toBe(0);

    fireEvent.click(screen.getByText("three.mp3"));
    fireEvent.click(screen.getByText("two.flac"));
    expect(screen.getByTestId("audio-picked-count")).toHaveTextContent("3 picked");
    expect(h.countOf("import-tracks")).toBe(0);

    fireEvent.click(screen.getByTestId("audio-commit"));
    // One message, carrying the whole selection in the order it was picked.
    expect(h.countOf("import-tracks")).toBe(1);
    expect(h.sent.at(-1)).toEqual({
      type: "import-tracks",
      playlistId: "warmup",
      sourcePaths: ["/music/one.flac", "/music/three.mp3", "/music/two.flac"],
    });
  });

  it("discards a listing for a folder nobody is in any more", () => {
    const h = harness();
    const { rerender } = mount(
      <AudioBrowser
        state={testState({ audioLibrary: audioListing() })}
        send={h.send}
        playlistId="warmup"
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("audio-browser-folder")).toHaveTextContent("/music");

    // Off into a subfolder. The reply for it has not landed yet.
    fireEvent.click(screen.getByTestId("audio-folder-dnb").querySelector("button")!);
    rerender(
      <AudioBrowser
        state={testState({ audioLibrary: audioListing() })}
        send={h.send}
        playlistId="warmup"
        onClose={() => {}}
      />,
    );
    // The slow reply for `/music` arriving now is for a folder nobody is in,
    // and showing it would put the user somewhere they did not navigate.
    expect(screen.getByTestId("audio-browser-folder")).toHaveTextContent("looking…");
    expect(screen.queryByText("one.flac")).toBeNull();

    rerender(
      <AudioBrowser
        state={testState({ audioLibrary: audioListing({ folder: "/music/dnb", parent: "/music", folders: [], tracks: [] }) })}
        send={h.send}
        playlistId="warmup"
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("audio-browser-folder")).toHaveTextContent("/music/dnb");
  });
});

describe("the track filter", () => {
  // The filter is a server request now, and a debounced one, so these tests own
  // the clock. Real timers would make every assertion below a race.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const settle = () => act(() => void vi.advanceTimersByTime(500));

  const browser = (h: ReturnType<typeof harness>, over: Partial<AudioListing> = {}) => (
    <AudioBrowser
      state={testState({ audioLibrary: audioListing(over) })}
      send={h.send}
      playlistId="warmup"
      onClose={() => {}}
    />
  );

  it("asks the server rather than filtering what already arrived", () => {
    const h = harness();
    mount(browser(h));

    fireEvent.change(screen.getByLabelText("filter tracks"), { target: { value: "one" } });
    settle();

    expect(h.sent.at(-1)).toEqual({ type: "browse-audio", path: "/music", filter: "one" });
    // And nothing was filtered here: the three tracks the server sent are all
    // still on screen, because narrowing is the next listing's job. A local
    // filter would have dropped two of them — and would never have been able to
    // show a track the server had not sent, which is the whole defect.
    expect(screen.getByText("two.flac")).toBeInTheDocument();
  });

  it("asks once for a word typed quickly, not once a keystroke", () => {
    const h = harness();
    mount(browser(h));
    const box = screen.getByLabelText("filter tracks");

    for (const text of ["a", "am", "ame", "amen"]) {
      fireEvent.change(box, { target: { value: text } });
      act(() => void vi.advanceTimersByTime(40));
    }
    settle();

    // One for the mount, one for the word. A request per keystroke over a
    // folder of thousands is what the debounce is for.
    expect(h.countOf("browse-audio")).toBe(2);
    expect(h.sent.at(-1)).toMatchObject({ filter: "amen" });
  });

  it("discards a listing for a filter the user has already typed past", () => {
    const h = harness();
    const { rerender } = mount(browser(h));
    fireEvent.change(screen.getByLabelText("filter tracks"), { target: { value: "drum" } });
    settle();

    // The wider `dr` reply, slower because more matched it, landing now. Showing
    // it would put back the list the user is typing their way out of.
    rerender(
      browser(h, { filter: "dr", tracks: [{ name: "dr-hit.flac", path: "/music/dr-hit.flac", sizeBytes: 1 }], matched: 1 }),
    );
    expect(screen.queryByText("dr-hit.flac")).toBeNull();
    expect(screen.getByTestId("audio-browser-folder")).toHaveTextContent("looking…");

    rerender(
      browser(h, { filter: "drum", tracks: [{ name: "drum-loop.flac", path: "/music/drum-loop.flac", sizeBytes: 1 }], matched: 1 }),
    );
    expect(screen.getByText("drum-loop.flac")).toBeInTheDocument();
  });

  it("counts what matched, not what fitted", () => {
    const h = harness();
    const { rerender } = mount(browser(h));
    // A whole small folder: the count is the folder.
    expect(screen.getByTestId("audio-browser-count")).toHaveTextContent("3 tracks");

    // The same three, out of a folder of 701. Nothing else on screen says the
    // other 698 exist, and a user shown a bare list of three would scroll.
    rerender(browser(h, { matched: 701, truncated: true }));
    expect(screen.getByTestId("audio-browser-count")).toHaveTextContent("3 of 701");
  });
});

describe("editing a tempo by hand", () => {
  it("refuses 740 with its reason and sends nothing; takes 174", () => {
    const h = harness();
    mount(
      <PlaylistEditor state={testState({ playlist: playlist() })} send={h.send} onClose={() => {}} />,
    );

    fireEvent.change(screen.getByLabelText("tempo for 2.flac"), { target: { value: "740" } });
    fireEvent.click(screen.getByTestId("set-bpm-2.flac"));
    expect(screen.getByTestId("bpm-error")).toHaveTextContent("between 60 and 200");
    expect(screen.getByTestId("bpm-error")).toHaveTextContent("740");
    expect(h.countOf("set-track-bpm")).toBe(0);

    fireEvent.change(screen.getByLabelText("tempo for 2.flac"), { target: { value: "174" } });
    fireEvent.click(screen.getByTestId("set-bpm-2.flac"));
    expect(h.countOf("set-track-bpm")).toBe(1);
    // `set`, not `measured`, is the server's job — what matters here is that the
    // hand-typed number is the one that leaves.
    expect(h.sent.at(-1)).toEqual({
      type: "set-track-bpm",
      playlistId: "warmup",
      path: "tracks/2.flac",
      bpm: 174,
    });
    expect(screen.queryByTestId("bpm-error")).toBeNull();
  });

  it("shows a hand-set tempo as the author's rather than as a measurement", () => {
    const h = harness();
    const edited = playlist({
      tracks: [track({ path: "tracks/1.flac", name: "1.flac", bpm: 174, bpmSource: "set" })],
    });
    mount(<PlaylistEditor state={testState({ playlist: edited })} send={h.send} onClose={() => {}} />);
    const cell = screen.getByTestId("bpm-1.flac");
    expect(cell).toHaveTextContent("174 bpm");
    expect(cell.className).toContain("bpm-set");
    expect(cell.className).not.toContain("bpm-measured");
  });

  it("renders a tempo nobody has established distinctly, and never as zero", () => {
    const h = harness();
    const mixed = playlist({
      tracks: [
        track({ path: "tracks/1.flac", name: "measured.flac", bpm: 174, bpmSource: "measured" }),
        track({ path: "tracks/2.flac", name: "absent.flac" }),
        // A zero on disk is not a tempo: `usableBpm` refuses it, so it means
        // *not yet known* like an absent one. What must never happen is the
        // playlist printing `0 bpm` — the value that satisfies every
        // below-threshold condition an author writes (origin R34).
        track({ path: "tracks/3.flac", name: "zero.flac", bpm: 0, bpmSource: "measured" }),
        track({ path: "tracks/4.flac", name: "gone.flac", unplayable: true }),
      ],
    });
    mount(<PlaylistEditor state={testState({ playlist: mixed })} send={h.send} onClose={() => {}} />);

    expect(screen.getByTestId("bpm-measured.flac").className).toContain("bpm-measured");
    expect(screen.getByTestId("bpm-absent.flac").className).toContain("bpm-pending");
    const zero = screen.getByTestId("bpm-zero.flac");
    expect(zero.className).toContain("bpm-pending");
    expect(zero.textContent ?? "").not.toContain("0");
    expect(screen.getByTestId("bpm-gone.flac").className).toContain("bpm-unplayable");
    expect(screen.getByTestId("bpm-gone.flac")).toHaveTextContent("unplayable");
  });
});

describe("the transport", () => {
  it("keeps a volume set under one World after switching to another", () => {
    const h = harness();
    const level = transport({ volume: 0.4 });
    const { rerender } = mount(
      <AudioPlayer
        state={testState({ world: testWorld({ id: "a", name: "A" }), audioTransport: level, audioAuthority: true })}
        send={h.send}
      />,
    );
    const slider = screen.getByLabelText("volume") as HTMLInputElement;
    expect(slider.value).toBe("0.4");
    expect((screen.getByTestId("audio-element") as HTMLAudioElement).volume).toBeCloseTo(0.4);

    // The World changed; the transport did not, because it belongs to no World.
    rerender(
      <AudioPlayer
        state={testState({ world: testWorld({ id: "b", name: "B" }), audioTransport: level, audioAuthority: true })}
        send={h.send}
      />,
    );
    expect((screen.getByLabelText("volume") as HTMLInputElement).value).toBe("0.4");
    expect((screen.getByTestId("audio-element") as HTMLAudioElement).volume).toBeCloseTo(0.4);
    // And nothing re-asserted it: a client that re-sent the volume on a World
    // switch would be a second source of truth for it.
    expect(h.sent.filter((m) => m.type === "audio-transport" && m.command === "volume")).toEqual([]);
  });

  it("disables every control on a client that is not the authority, and sends nothing", () => {
    const h = harness();
    mount(
      <AudioPlayer
        state={testState({ world: testWorld(), audioTransport: transport({ playing: true }), audioAuthority: false })}
        send={h.send}
      />,
    );

    for (const id of [
      "audio-previous",
      "audio-play",
      "audio-next",
      "audio-stop",
      "audio-start-world",
      "audio-seek",
      "audio-volume",
    ]) {
      expect(screen.getByTestId(id)).toBeDisabled();
    }
    expect(screen.getByTestId("audio-readonly")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("audio-play"));
    fireEvent.click(screen.getByTestId("audio-stop"));
    fireEvent.click(screen.getByTestId("audio-start-world"));
    fireEvent.change(screen.getByTestId("audio-seek"), { target: { value: "12000" } });
    fireEvent.change(screen.getByTestId("audio-volume"), { target: { value: "0.2" } });
    // Not one message, including the announcement: a client that is not the
    // loudspeaker does not tell the server it is one.
    expect(h.countOf("audio-transport")).toBe(0);
  });

  it("offers the whole transport to the authority", () => {
    const h = harness();
    mount(
      <AudioPlayer
        state={testState({ world: testWorld({ id: "booth", name: "DJ Booth" }), audioTransport: transport(), audioAuthority: true })}
        send={h.send}
      />,
    );
    fireEvent.click(screen.getByTestId("audio-stop"));
    fireEvent.change(screen.getByTestId("audio-seek"), { target: { value: "12000" } });
    fireEvent.change(screen.getByTestId("audio-volume"), { target: { value: "0.25" } });
    fireEvent.click(screen.getByTestId("audio-start-world"));

    const commands = h.sent
      .filter((m): m is Extract<typeof m, { type: "audio-transport" }> => m.type === "audio-transport")
      .map((m) => m.command);
    expect(commands).toContain("stop");
    expect(commands).toContain("seek");
    expect(commands).toContain("volume");
    expect(commands).toContain("start-world-playlist");
    expect(h.sent).toContainEqual({ type: "audio-transport", command: "seek", positionMs: 12000 });
    expect(h.sent).toContainEqual({ type: "audio-transport", command: "volume", volume: 0.25 });
    expect(h.sent).toContainEqual({
      type: "audio-transport",
      command: "start-world-playlist",
      worldId: "booth",
    });
  });
});

describe("renaming and deleting the playlist itself", () => {
  it("renames on the button and on Enter, and sends nothing for a name nobody changed", () => {
    const h = harness();
    mount(<PlaylistEditor state={testState({ playlist: playlist() })} send={h.send} onClose={() => {}} />);

    const field = screen.getByLabelText("playlist name") as HTMLInputElement;
    // The store's name is what the field shows before anything is typed.
    expect(field.value).toBe("Warmup");
    fireEvent.click(screen.getByTestId("rename-playlist"));
    // Unchanged: a message here would redraw every client's picker for nothing.
    expect(h.countOf("rename-playlist")).toBe(0);

    fireEvent.change(field, { target: { value: "  Peak Time  " } });
    fireEvent.click(screen.getByTestId("rename-playlist"));
    fireEvent.change(field, { target: { value: "Closing" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(h.sent.filter((m) => m.type === "rename-playlist")).toEqual([
      { type: "rename-playlist", playlistId: "warmup", name: "Peak Time" },
      { type: "rename-playlist", playlistId: "warmup", name: "Closing" },
    ]);
  });

  it("deletes on the second press only, and drops the set the moment it is asked for", () => {
    const h = harness();
    const state = () =>
      testState({ playlist: playlist(), playlists: [{ id: "warmup", name: "Warmup", tracks: 4 }] });
    const { rerender } = mount(
      <PlaylistEditor state={state()} send={h.send} onClose={() => {}} />,
    );

    fireEvent.click(screen.getByTestId("remove-playlist"));
    // The first press only opens the confirmation. Nothing has been destroyed.
    expect(h.countOf("remove-playlist")).toBe(0);
    expect(screen.getByTestId("confirm-remove-playlist")).toHaveTextContent("Warmup");

    fireEvent.click(screen.getByTestId("confirm-remove-playlist"));
    expect(h.sent).toContainEqual({ type: "remove-playlist", playlistId: "warmup" });

    // Nothing on the wire announces a playlist's absence: the store still holds
    // the deleted set's own last broadcast, and re-rendering with it must not
    // put its tracks back on screen under live controls.
    rerender(<PlaylistEditor state={state()} send={h.send} onClose={() => {}} />);
    expect(screen.queryByTestId("entry-1.flac")).toBeNull();
    expect(screen.queryByTestId("playlist-name")).toBeNull();
  });

  it("says which Worlds the deletion left playing nothing, after the set has gone", () => {
    const h = harness();
    const withTrack = worldOnTrack("booth", "DJ Booth", 4);
    const state = (over = {}) =>
      testState({ playlist: playlist(), playlists: [{ id: "warmup", name: "Warmup", tracks: 4 }], ...over });
    const { rerender } = mount(
      <PlaylistEditor state={state()} send={h.send} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("remove-playlist"));
    fireEvent.click(screen.getByTestId("confirm-remove-playlist"));

    // What the server answers with. A deletion strands every position condition
    // — nothing is left to reach — and it names a World holding none of them
    // too, because that World has lost its whole soundtrack.
    rerender(
      <PlaylistEditor
        state={state({
          playlistImpact: {
            playlistId: "warmup",
            action: "remove-playlist",
            impacts: [
              { worldId: "booth", worldName: "DJ Booth", conditions: unreachableIndexConditions(withTrack, 0) },
              { worldId: "lounge", worldName: "Lounge", conditions: [] },
            ],
          },
        })}
        send={h.send}
        onClose={() => {}}
      />,
    );

    // Reported with no playlist on screen at all, which is the state a deletion
    // leaves behind — a warning guarded on the open set would say nothing here.
    expect(screen.getByTestId("playlist-impact")).toHaveTextContent("gone");
    expect(screen.getByTestId("impact-booth")).toHaveTextContent("audio.track eq 4");
    expect(screen.getByTestId("impact-lounge")).toHaveTextContent("Lounge");
  });
});

describe("which playlist the editor is holding", () => {
  it("ignores a broadcast for a playlist nobody opened here", () => {
    const h = harness();
    const editor = (held: Playlist) => (
      <PlaylistEditor state={testState({ playlist: held })} send={h.send} onClose={() => {}} />
    );
    const { rerender } = mount(editor(playlist()));
    expect(screen.getByTestId("entry-1.flac")).toBeInTheDocument();

    // A `playlist` broadcast is not addressed to this editor: a tempo landing on
    // another set, a second tab's edit, an import into something nobody here is
    // looking at. Adopted, it retargeted the editor silently — and the next
    // remove or reorder names a *position*, so it would have acted on the wrong
    // index of the wrong playlist.
    rerender(
      editor({
        id: "cooldown",
        name: "Cooldown",
        tracks: [track({ path: "tracks/9.flac", name: "9.flac" })],
      }),
    );
    expect(screen.getByTestId("entry-1.flac")).toBeInTheDocument();
    expect(screen.queryByTestId("entry-9.flac")).toBeNull();

    // And it is still the one an edit names.
    fireEvent.click(screen.getByTestId("remove-1.flac"));
    expect(h.sent).toContainEqual({ type: "remove-track", playlistId: "warmup", path: "tracks/1.flac" });
  });

  it("takes the one it asked for, including an edit to it", () => {
    const h = harness();
    const other: Playlist = { id: "cooldown", name: "Cooldown", tracks: [track({ name: "9.flac" })] };
    const editor = (held: Playlist) => (
      <PlaylistEditor
        state={testState({
          playlist: held,
          playlists: [
            { id: "warmup", name: "Warmup", tracks: 4 },
            { id: "cooldown", name: "Cooldown", tracks: 1 },
          ],
        })}
        send={h.send}
        onClose={() => {}}
      />
    );
    const { rerender } = mount(editor(playlist()));

    fireEvent.click(screen.getByRole("button", { name: "Cooldown" }));
    expect(h.sent).toContainEqual({ type: "list-playlists", playlistId: "cooldown" });
    rerender(editor(other));
    expect(screen.getByTestId("entry-9.flac")).toBeInTheDocument();

    // The playlist on screen changing under an edit of its own is the ordinary
    // case and must still land.
    rerender(editor({ ...other, tracks: [] }));
    expect(screen.getByTestId("playlist-empty")).toBeInTheDocument();
  });
});

describe("asking for what it shows", () => {
  /**
   * A fresh `send` on every render, which is what the loop needs to happen.
   *
   * The harness hands out a stable one because App does, so a component that
   * depends on `send` in a mount effect looks fine under it. The failure
   * AGENTS.md records — each ask triggers a broadcast, which re-renders, which
   * asks again — needs an unstable one to be visible at all, and a component
   * has to survive that.
   */
  it("asks for the playlists once under an unstable send", () => {
    const h = harness();
    const editor = () => (
      <PlaylistEditor
        state={testState({ playlist: playlist() })}
        send={(msg) => h.send(msg)}
        onClose={() => {}}
      />
    );
    const { rerender } = mount(editor());
    rerender(editor());
    rerender(editor());
    expect(h.countOf("list-playlists")).toBe(1);
  });

  it("browses once under an unstable send", () => {
    const h = harness();
    const browser = () => (
      <AudioBrowser
        state={testState({ audioLibrary: audioListing() })}
        send={(msg) => h.send(msg)}
        playlistId="warmup"
        onClose={() => {}}
      />
    );
    const { rerender } = mount(browser());
    rerender(browser());
    rerender(browser());
    expect(h.countOf("browse-audio")).toBe(1);
  });
});

describe("the words the overlay draws, where they are typed", () => {
  it("commits the header on blur and on Enter, sends nothing unchanged, and clears on empty", () => {
    const h = harness();
    mount(
      <PlaylistEditor state={testState({ playlist: playlist({ header: "Late Set" }) })} send={h.send} onClose={() => {}} />,
    );

    const field = screen.getByLabelText("playlist header") as HTMLInputElement;
    expect(field.value).toBe("Late Set");
    expect(field.maxLength).toBe(TEXT_MAX);
    fireEvent.blur(field);
    expect(h.countOf("set-playlist-header")).toBe(0);

    fireEvent.change(field, { target: { value: "  Later Set  " } });
    fireEvent.blur(field);
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(h.sent.filter((m) => m.type === "set-playlist-header")).toEqual([
      { type: "set-playlist-header", playlistId: "warmup", header: "Later Set" },
      { type: "set-playlist-header", playlistId: "warmup", header: null },
    ]);
  });

  it("commits a track's description by path, on its own line beneath the controls", () => {
    const h = harness();
    const set = playlist();
    set.tracks[1] = { ...set.tracks[1]!, description: "A slow one" };
    mount(<PlaylistEditor state={testState({ playlist: set })} send={h.send} onClose={() => {}} />);

    const field = screen.getByLabelText("description for 2.flac") as HTMLInputElement;
    expect(field.value).toBe("A slow one");
    expect(field.maxLength).toBe(TEXT_MAX);
    // Beneath the controls: the last child of the row, not squeezed among them.
    const row = screen.getByTestId("entry-2.flac");
    expect(row.lastElementChild).toBe(field);

    fireEvent.change(field, { target: { value: "A slower one" } });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.change(screen.getByLabelText("description for 1.flac"), { target: { value: "" } });
    fireEvent.blur(screen.getByLabelText("description for 1.flac"));
    expect(h.sent.filter((m) => m.type === "set-track-description")).toEqual([
      { type: "set-track-description", playlistId: "warmup", path: "tracks/2.flac", description: "A slower one" },
    ]);
  });

  it("shows why a header or description write was refused", () => {
    const h = harness();
    mount(
      <PlaylistEditor
        state={testState({
          playlist: playlist(),
          playlistResults: {
            "set-playlist-header": { ok: false, error: "No such playlist." },
            "set-track-description": { ok: false, error: "That playlist holds no such track." },
          },
        })}
        send={h.send}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("set-playlist-header-error")).toHaveTextContent("No such playlist.");
    expect(screen.getByTestId("set-track-description-error")).toHaveTextContent("no such track");
  });

  it("still marks the sounding track by path with the description field on the row", () => {
    const h = harness();
    const set = playlist();
    mount(
      <PlaylistEditor
        state={testState({
          playlist: set,
          audioTransport: {
            playlistId: "warmup",
            generation: 1,
            index: 2,
            path: "tracks/3.flac",
            name: "3.flac",
            header: null,
            description: null,
            playing: true,
            positionMs: 0,
            durationMs: 300_000,
            volume: 1,
            tracks: 4,
            shuffle: false,
            bpm: null,
            audible: true,
          },
          audioAuthority: true,
        })}
        send={h.send}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("entry-3.flac").className).toContain("track-playing");
    expect(screen.getByTestId("entry-2.flac").className).not.toContain("track-playing");
  });
});
