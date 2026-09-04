import { useEffect, useState } from "react";
import type { ClientMessage } from "../../../shared/src/types";
import type { AppState } from "../store";
import { StateGraph } from "./StateGraph";
import { ClipPlayer } from "./ClipPlayer";
import { AudioPlayer } from "./AudioPlayer";
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
  const [picking, setPicking] = useState(false);
  // The playlist editor is a panel rather than a route: it edits a shared store
  // that belongs to no World, but the only place anyone wants it is beside the
  // World they are about to point at it.
  const [editing, setEditing] = useState(false);
  const [asked, setAsked] = useState<string | null>(null);

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
          {!state.worldReadable && (
            <span className="warn">{state.worldReadOnlyReason ?? "read-only"}</span>
          )}
        </header>
        <div className="live-body">
          {/* The stage: what this World looks like. What it *sounds* like is not
              here — the transport belongs to no World, so it is mounted above
              the switch instead. */}
          <div className="live-stage">
            <ClipPlayer state={state} send={send} />
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
