import { useEffect, useMemo, useState } from "react";
import type { ClientMessage } from "../../../shared/src/types";
import type { World } from "../../../shared/src/worlds";
import { setMembers } from "../../../shared/src/worlds";
import type { AppState } from "../store";
import { loadLiveLayout, saveLiveLayout } from "../liveLayout";
import { StateGraph } from "./StateGraph";
import { ClipPlayer } from "./ClipPlayer";
import { AudioPlayer } from "./AudioPlayer";
import { PlaylistEditor } from "./PlaylistEditor";

/**
 * The clips in this World that no `<video>` has ever measured.
 *
 * A clip's real length reaches the manifest exactly one way: the player reports
 * it at `loadedmetadata` the first time the clip plays, because the clip route
 * serves only clips the manifest already references and so cannot answer a probe
 * at assign time. `/broadcast` cannot stand in — it connects as an observer and
 * the server refuses the report from one.
 *
 * So a World worked on with the picture hidden quietly accumulates clips the
 * runtime will play for its default three seconds whatever the footage is. That
 * is the price of the video toggle, and the column that hid the picture is the
 * honest place to charge it.
 */
function unmeasuredClips(world: World | null): string[] {
  if (!world) return [];
  const paths = new Set<string>();
  for (const sets of [world.states.map((s) => s.clips), world.transitions.map((t) => t.clips)]) {
    for (const set of sets) {
      // Not `durationMs === 0`: the store normalises anything non-finite or
      // non-positive to zero on the way in, and a hand-edited manifest reaches
      // this function through the same door.
      for (const clip of setMembers(set)) if (!(clip.durationMs > 0)) paths.add(clip.path);
    }
  }
  return [...paths];
}

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
}

/**
 * The `/live` surface: a World picker, or a World.
 *
 * An alternative to the three-pane body rather than a fourth pane, so none of
 * the rail and collapse machinery reaches it — the topbar and the settings
 * drawer stay above the switch in `App`.
 */
export function LivePane({ state, send }: Props) {
  const [name, setName] = useState("");
  const [picking, setPicking] = useState(false);
  // The playlist editor is a panel rather than a route: it edits a shared store
  // that belongs to no World, but the only place anyone wants it is beside the
  // World they are about to point at it.
  const [editing, setEditing] = useState(false);
  const [asked, setAsked] = useState<string | null>(null);
  // Seeded from storage once, lazily, so the first paint is already the layout
  // the user left rather than the default flashing past it.
  const [layout, setLayout] = useState(loadLiveLayout);

  useEffect(() => {
    saveLiveLayout(layout);
  }, [layout]);

  // Empty deps deliberately: this asks once, on mount. Depending on `send`
  // re-ran it every render, and since each run triggers a broadcast that
  // updates the store and re-renders, that was an unbounded request loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    send({ type: "list-worlds" });
  }, []);

  const world = state.world;
  const openError = state.worldResults["open-world"]?.ok === false ? state.worldResults["open-world"].error : null;
  const unmeasured = useMemo(() => (layout.video ? [] : unmeasuredClips(world)), [layout.video, world]);

  /**
   * Hide the picture, and open the playlist in its place.
   *
   * Opening the editor is not a convenience bundled onto the toggle — without
   * it the gesture produces a column holding one `playlists` button and nothing
   * else, since the editor is a panel behind that button rather than a fixture.
   * Showing the picture again deliberately does not close it: the toggle opens
   * the panel, it does not own it.
   */
  const toggleVideo = () => {
    // The `setEditing` sits outside the updater deliberately: an updater is
    // called for its return value and may be called more than once, so a state
    // change made from inside one is a side effect in a place that promises to
    // have none.
    if (layout.video) setEditing(true);
    setLayout((current) => ({ ...current, video: !current.video }));
  };

  /**
   * The World arriving is what closes the picker, not the click that asked for
   * it — a World that failed to open must leave the picker where it was, with
   * the reason on screen.
   *
   * Keyed on the id actually asked for rather than on the id changing: picking
   * the World that is already open changes nothing, and a picker that then sat
   * there ignoring the click is worse than one that never closed at all.
   */
  useEffect(() => {
    if (asked && world?.id === asked) {
      setPicking(false);
      setAsked(null);
    }
  }, [asked, world?.id]);

  const create = () => {
    if (name.trim().length === 0) return;
    send({ type: "create-world", world: { name: name.trim() } });
    setName("");
  };

  /**
   * The picker, or the World — whichever this pane is showing.
   *
   * A value rather than an early return, because the loudspeaker has to outlive
   * the switch between the two. See the mount below.
   */
  const body =
    !world || picking ? (
      <div className="live-picker" data-testid="world-picker">
        <h2>Worlds</h2>
        {state.worlds.length === 0 && <p className="muted">No Worlds yet. Name one and it gets its own folder.</p>}
        <ul className="world-list">
          {state.worlds.map((summary) => (
            <li key={summary.id} data-testid={`world-${summary.id}`}>
              <button
                className="ghost"
                onClick={() => {
                  // The picker is left open. Closing it here would hide a
                  // refusal the server is about to send, and the World arriving
                  // is what actually closes it — see the effect above.
                  setAsked(summary.id);
                  send({ type: "open-world", worldId: summary.id });
                }}
              >
                {summary.name}
              </button>
              {!summary.readable && <span className="warn"> — its manifest will not parse, so it opens read-only</span>}
            </li>
          ))}
        </ul>
        <div className="world-create">
          <input
            aria-label="New World name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
            }}
            placeholder="Streamer lounge"
          />
          <button onClick={create} disabled={name.trim().length === 0}>
            create
          </button>
        </div>
        {state.worldResults["create-world"]?.error && <p className="warn">{state.worldResults["create-world"].error}</p>}
        {openError && <p className="warn" data-testid="open-error">{openError}</p>}
        {world && (
          <button className="ghost" onClick={() => setPicking(false)}>
            back to {world.name}
          </button>
        )}
      </div>
    ) : (
      <div className="live-world" data-testid="live-world">
        <header className="live-header">
          <h2>{world.name}</h2>
          <button className="ghost" onClick={() => setPicking(true)}>
            worlds
          </button>
          {/* The label says what the press does, matching `playlists` /
              `close playlists` below. It lives in the header rather than on the
              player because a control that disappears with the thing it
              controls cannot bring it back. */}
          <button className="ghost" data-testid="toggle-video" onClick={toggleVideo}>
            {layout.video ? "video off" : "video on"}
          </button>
          {!state.worldReadable && (
            <span className="warn">{state.worldReadOnlyReason ?? "read-only"}</span>
          )}
        </header>
        <div className="live-body">
          {/* The stage: what this World looks like. What it *sounds* like is not
              here — the transport belongs to no World, so it is mounted above
              the switch instead. */}
          <div className={layout.video ? "live-stage" : "live-stage no-video"} data-testid="live-stage">
            {layout.video && <ClipPlayer state={state} send={send} />}
            {unmeasured.length > 0 && (
              <p className="muted stage-unmeasured" data-testid="stage-unmeasured">
                {unmeasured.length === 1
                  ? `1 clip has never been measured (${unmeasured[0]}), so the machine runs it on its default length.`
                  : `${unmeasured.length} clips have never been measured, so the machine runs them on its default length.`}{" "}
                <button className="ghost" data-testid="measure-clips" onClick={toggleVideo}>
                  show the video to measure
                </button>
              </p>
            )}
            <button
              className="ghost live-playlists"
              data-testid="open-playlists"
              onClick={() => setEditing((open) => !open)}
            >
              {editing ? "close playlists" : "playlists"}
            </button>
            {editing && <PlaylistEditor state={state} send={send} onClose={() => setEditing(false)} />}
          </div>
          <StateGraph state={state} send={send} />
        </div>
      </div>
    );

  /**
   * The loudspeaker sits above the switch, and that is the fix rather than the
   * arrangement.
   *
   * It used to be inside the World branch, so opening the picker — or having no
   * World open at all — unmounted the `<audio>` element and the music stopped.
   * Worse, the server heard nothing about it: a socket that stays open still
   * looks like an attending client, so `audible` stayed true and the transport
   * went on waiting out its end-of-track grace period for an `ended` that no
   * element would ever send.
   *
   * Mounting it here says what the design already says (origin R3): the
   * transport belongs to no World. A World arms its playlist; it does not own
   * it, and browsing for another one is not a reason to stop the music.
   */
  return (
    <div className="live-pane" data-testid="live-pane">
      <AudioPlayer state={state} send={send} />
      {body}
    </div>
  );
}
