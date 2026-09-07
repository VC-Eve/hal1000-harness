import { useEffect, useRef, useState } from "react";
import type { ClientMessage } from "../../../shared/src/types";
import type { AppState } from "../store";
import { clampLiveLayout, deriveLiveTracks, loadLiveLayout, saveLiveLayout } from "../liveLayout";
import { StateGraph } from "./StateGraph";
import { ClipPlayer } from "./ClipPlayer";
import { AudioPlayer } from "./AudioPlayer";
import { SpeechPlayer } from "./SpeechPlayer";
import { SpeechPane } from "./SpeechPane";
import { PlaylistEditor } from "./PlaylistEditor";

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
  /**
   * Whether this page has had a user activation.
   *
   * Held here rather than inside `AudioPlayer` because two elements on one page
   * share one activation: the press that unlocks the transport unlocks the
   * character's voice too, and asking for a second gesture is the two-controls
   * problem `enable-sound` already refuses to repeat.
   */
  const [gestured, setGestured] = useState(false);
  const [picking, setPicking] = useState(false);
  // The playlist editor is a panel rather than a route: it edits a shared store
  // that belongs to no World, but the only place anyone wants it is beside the
  // World they are about to point at it.
  const [editing, setEditing] = useState(false);
  const [asked, setAsked] = useState<string | null>(null);
  // Seeded from storage once, lazily, so the first paint is already the layout
  // the user left rather than the default flashing past it.
  const [layout, setLayout] = useState(loadLiveLayout);
  // The element the seams measure against, and the one they write their live
  // geometry to while a drag is in flight.
  const bodyRef = useRef<HTMLDivElement>(null);

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

  /**
   * Both seams, one gesture.
   *
   * The pointer is *captured* on the bar rather than the window being listened
   * to. `LayoutShell` does the latter and removes its listeners only from inside
   * its `pointerup`, which leaves three exits that never tear down: a cancelled
   * pointer, a release outside the viewport, and — the one that matters here —
   * unmount mid-drag, since `App` mounts this pane on a route and the Back
   * button can take it away from outside the component. The pattern used
   * instead is the one `StateGraph` already applies to node dragging, in this
   * same surface, for this same reason.
   *
   * Everything is computed from where the gesture *started*, not from the
   * layout as it currently stands, and that is what makes a drag reversible:
   * at zero delta the arithmetic returns exactly the two numbers the press
   * began with, so a seam pushed aside on the way out recovers on the way back
   * with no bookkeeping. Recomputing from current state would ratchet — the
   * pressured seam would keep whatever it had been squeezed to.
   *
   * It also means no constant for the gutters. A percentage grid track resolves
   * against the container's content box, so a *delta* in pixels is a delta in
   * percent regardless of how much of the container the four gaps and two bars
   * are using — and grabbing the bar off-centre does not make it jump.
   */
  const onSeamDown = (seam: "stage" | "side") => (event: React.PointerEvent<HTMLDivElement>) => {
    const body = bodyRef.current;
    if (!body) return;
    event.preventDefault();
    const bar = event.currentTarget;
    bar.setPointerCapture?.(event.pointerId);
    const width = body.getBoundingClientRect().width;
    const startX = event.clientX;
    const start = layout;
    let latest = start;

    const move = (e: PointerEvent) => {
      const delta = ((e.clientX - startX) / width) * 100;
      const next = seam === "stage" ? { ...start, stage: start.stage + delta } : { ...start, side: start.side - delta };
      latest = clampLiveLayout(next, seam);
      // Written straight to the element for the duration of the drag. Putting it
      // through state would reconcile this pane's whole subtree — the playlist,
      // the panels, and an SVG of every node and transition curve — at pointer
      // rate, beside two decoding `<video>` elements. One write per gesture is
      // the rule `StateGraph` already keeps for node drags.
      body.style.setProperty("--live-cols", deriveLiveTracks(latest));
    };
    const end = () => {
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", end);
      bar.removeEventListener("pointercancel", end);
      bar.releasePointerCapture?.(event.pointerId);
      setLayout(latest);
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", end);
    // The exit `LayoutShell` has never had. A touch-drag on a 6px bar is exactly
    // what a browser claims as a pan gesture, and a cancelled pointer sends no
    // `pointerup` at all.
    bar.addEventListener("pointercancel", end);
  };

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
        <div
          className="live-body"
          data-testid="live-body"
          ref={bodyRef}
          style={{ ["--live-cols" as string]: deriveLiveTracks(layout) }}
        >
          {/* The stage: what this World looks like. What it *sounds* like is not
              here — the transport belongs to no World, so it is mounted above
              the switch instead. */}
          <div className={layout.video ? "live-stage" : "live-stage no-video"} data-testid="live-stage">
            {/* Mounted whether or not it is shown, and hidden by the
                stylesheet with `display: none`.

                Unmounting it was the obvious reading of "hide the video" and it
                was the wrong one. The `<video>` is the only thing that ever
                measures a clip — `report-clip-duration` fires from
                `loadedmetadata`, and `/broadcast` is refused it as an observer —
                so a player that is not in the tree is a World whose new clips
                never get their real length, and the machine runs them at its
                three-second default. Taking it out also restarted whatever was
                playing when it came back, because `LiveState` carries no elapsed
                position to seek to.

                Hiding costs none of that and saves the same room: a
                `display: none` element is out of the layout entirely, and — as
                `.clip-video.back` records two rules down — it does not decode,
                which is the expense worth avoiding. It keeps playing and keeps
                firing events, which here is the point rather than the hazard. */}
            <ClipPlayer state={state} send={send} />
            <button
              className="ghost live-playlists"
              data-testid="open-playlists"
              onClick={() => setEditing((open) => !open)}
            >
              {editing ? "close playlists" : "playlists"}
            </button>
            {editing && <PlaylistEditor state={state} send={send} onClose={() => setEditing(false)} />}
            <SpeechPane state={state} send={send} />
          </div>
          <div
            className="divider"
            data-testid="live-divider-stage"
            onPointerDown={onSeamDown("stage")}
            role="separator"
            aria-orientation="vertical"
          />
          <StateGraph state={state} send={send} onSideSeamDown={onSeamDown("side")} />
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
      <AudioPlayer state={state} send={send} onGestured={() => setGestured(true)} />
      <SpeechPlayer state={state} send={send} gestured={gestured} />
      {body}
    </div>
  );
}
