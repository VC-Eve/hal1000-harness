import { useEffect, useState } from "react";
import type { ClientMessage } from "../../../shared/src/types";
import type { AppState } from "../store";
import { Floorplan } from "./Floorplan";
import { ClipPlayer } from "./ClipPlayer";

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

  // Empty deps deliberately: this asks once, on mount. Depending on `send`
  // re-ran it every render, and since each run triggers a broadcast that
  // updates the store and re-renders, that was an unbounded request loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    send({ type: "list-worlds" });
  }, []);

  const world = state.world;
  const create = () => {
    if (name.trim().length === 0) return;
    send({ type: "create-world", world: { name: name.trim() } });
    setName("");
  };

  if (!world || picking) {
    return (
      <div className="live-pane live-picker" data-testid="world-picker">
        <h2>Worlds</h2>
        {state.worlds.length === 0 && <p className="muted">No Worlds yet. Name one and it gets its own folder.</p>}
        <ul className="world-list">
          {state.worlds.map((summary) => (
            <li key={summary.id} data-testid={`world-${summary.id}`}>
              <button
                className="ghost"
                onClick={() => {
                  send({ type: "open-world", worldId: summary.id });
                  setPicking(false);
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
        {world && (
          <button className="ghost" onClick={() => setPicking(false)}>
            back to {world.name}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="live-pane" data-testid="live-world">
      <header className="live-header">
        <h2>{world.name}</h2>
        <button className="ghost" onClick={() => setPicking(true)}>
          worlds
        </button>
        {!state.worldReadable && <span className="warn">read-only: this manifest will not parse</span>}
      </header>
      <div className="live-body">
        <ClipPlayer state={state} send={send} />
        <Floorplan state={state} send={send} />
      </div>
    </div>
  );
}
