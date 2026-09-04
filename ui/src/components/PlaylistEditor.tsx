import { useEffect, useRef, useState } from "react";
import type { ClientMessage, Playlist, PlaylistTrack } from "../../../shared/src/types";
import { MAX_BPM, MIN_BPM, bpmOf, usableBpm } from "../../../shared/src/audio";
import type { AppState } from "../store";
import { AudioBrowser } from "./AudioBrowser";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
  onClose: () => void;
}

/**
 * Building a playlist: what is in it, what order it is in, and what tempo each
 * track runs at.
 *
 * A playlist belongs to no World — several may name the same one and deleting a
 * World takes none of it — so this edits the shared store and merely sits beside
 * whichever World is open. The one thing it says *about* Worlds is what an edit
 * just cost them (origin R17), and that arrives from the server rather than
 * being derived here: it is a claim about manifests this client does not hold.
 */
export function PlaylistEditor({ state, send, onClose }: Props) {
  const [name, setName] = useState("");
  const [browsing, setBrowsing] = useState(false);
  /** Per-track tempo drafts, keyed by store path. Not committed until asked for. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** Why the last tempo edit was refused. One at a time: only one is being typed. */
  const [bpmError, setBpmError] = useState<string | null>(null);
  /**
   * The playlist last explicitly opened here — `AudioBrowser`'s `wanted` ref,
   * one surface over.
   *
   * `playlist` in the store is whatever the *last* `playlist` broadcast carried,
   * and those are not all answers to this editor: a tempo landing on another set,
   * a second tab's edit, an import into a playlist nobody here opened. Adopting
   * one of those silently retargeted the editor — the tracks on screen changed
   * under the cursor and the next remove or reorder, which names a position
   * rather than a track, acted on the wrong index of the wrong set.
   *
   * Null means nothing has been asked for yet, and the first arrival is adopted:
   * creating a playlist is an open of a set whose id the server chooses, so there
   * is nothing to match against. Adopting one latches it, so the *second* foreign
   * broadcast is measured against something.
   */
  const wanted = useRef<string | null>(null);
  /**
   * The playlist on screen.
   *
   * Held here rather than read straight off the store, which is the difference
   * from `AudioBrowser`: a discarded listing there leaves the browser with
   * nothing to show and that is honest, but a discarded *playlist* must leave
   * the one being edited exactly where it was. Otherwise ignoring a foreign
   * broadcast would empty the editor, which is the same interruption by another
   * route.
   */
  const held = useRef<Playlist | null>(null);

  // Empty deps deliberately: this asks once, on open. Depending on `send`
  // re-ran it every render, and each run triggers a broadcast that re-renders —
  // the unbounded request loop `LivePane` carries the same disable for.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    send({ type: "list-playlists" });
  }, []);

  const arrived = state.playlist;
  if (arrived === null) {
    // The store clears this when a playlist is gone and by no other route, so
    // there is nothing left to edit.
    held.current = null;
    wanted.current = null;
  } else if (wanted.current === null || arrived.id === wanted.current) {
    held.current = arrived;
    wanted.current = arrived.id;
  }
  const playlist = held.current;
  const world = state.world;
  const impact = state.playlistImpact;
  const failure = (action: string) => {
    const result = state.playlistResults[action];
    return result?.ok === false ? (result.error ?? null) : null;
  };

  const open = (playlistId: string) => {
    wanted.current = playlistId;
    send({ type: "list-playlists", playlistId });
  };

  const create = () => {
    if (name.trim().length === 0) return;
    // The server slugs the name into an id, so there is nothing to match on and
    // the next playlist to arrive is the one this asked for.
    wanted.current = null;
    send({ type: "create-playlist", name: name.trim() });
    setName("");
  };

  /**
   * Move a track one place, as the whole order.
   *
   * `reorder-playlist` takes the entire list by design — order is what a
   * playlist *is*, and a partial order would leave the server deciding where
   * the rest went — so a one-place move is still expressed as the full result.
   */
  const move = (index: number, delta: number) => {
    if (!playlist) return;
    const next = [...playlist.tracks];
    const to = index + delta;
    if (to < 0 || to >= next.length) return;
    const [held] = next.splice(index, 1);
    if (!held) return;
    next.splice(to, 0, held);
    send({ type: "reorder-playlist", playlistId: playlist.id, order: next.map((t) => t.path) });
  };

  /**
   * Commit a hand-typed tempo (origin R32).
   *
   * Refused here with its reason rather than sent and refused there, because the
   * person is looking at the field: a round trip to be told 740 is not a tempo
   * is a worse answer than the same sentence beside the input. The server
   * refuses it as well — this is the half that explains, not the half that
   * protects — and an empty field clears the value back to not-yet-known rather
   * than writing a zero, which is a tempo every below-threshold condition is
   * satisfied by.
   */
  const commitBpm = (track: PlaylistTrack) => {
    if (!playlist) return;
    const draft = (drafts[track.path] ?? "").trim();
    if (draft.length === 0) {
      setBpmError(null);
      send({ type: "set-track-bpm", playlistId: playlist.id, path: track.path, bpm: null });
      return;
    }
    const asked = Number(draft);
    if (usableBpm(asked) === null) {
      setBpmError(`A tempo has to be between ${MIN_BPM} and ${MAX_BPM} BPM. ${draft} is not.`);
      return;
    }
    setBpmError(null);
    send({ type: "set-track-bpm", playlistId: playlist.id, path: track.path, bpm: asked });
  };

  return (
    <section className="playlist-editor" data-testid="playlist-editor">
      <header>
        <h3>playlists</h3>
        <button className="ghost" onClick={onClose}>
          close
        </button>
      </header>

      <ul className="playlist-list">
        {state.playlists.map((summary) => (
          <li key={summary.id} data-testid={`playlist-${summary.id}`}>
            <button
              className={playlist?.id === summary.id ? "ghost open" : "ghost"}
              onClick={() => open(summary.id)}
            >
              {summary.name}
            </button>
            <span className="muted">{summary.tracks} tracks</span>
          </li>
        ))}
        {state.playlists.length === 0 && (
          <li className="muted" data-testid="no-playlists">
            No playlists yet. Name one and tracks can go in it.
          </li>
        )}
      </ul>

      <div className="playlist-create">
        <input
          aria-label="New playlist name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
          }}
          placeholder="Warmup"
        />
        <button onClick={create} disabled={name.trim().length === 0}>
          create
        </button>
      </div>
      {failure("create-playlist") && (
        <p className="warn" data-testid="create-playlist-error">
          {failure("create-playlist")}
        </p>
      )}

      {/* What the last edit cost the Worlds that play this playlist (origin R17,
          AE13). Said here, at the moment of the edit, rather than left to each
          affected World's own reports — those are true and arrive when that
          World is next opened, which during a set is hours too late. */}
      {impact && playlist && impact.playlistId === playlist.id && impact.impacts.length > 0 && (
        <div className="warn playlist-impact" data-testid="playlist-impact">
          <p>
            {impact.action === "reorder-playlist"
              ? "Reordering moved what these conditions point at:"
              : "That removal left these conditions naming a position this playlist no longer reaches:"}
          </p>
          <ul>
            {impact.impacts.map((affected) => (
              <li key={affected.worldId} data-testid={`impact-${affected.worldId}`}>
                {affected.worldName}:{" "}
                {affected.conditions
                  .map((c) => `${c.parameter} ${c.op} ${String(c.value)}`)
                  .join(", ")}
              </li>
            ))}
          </ul>
        </div>
      )}

      {playlist && (
        <>
          <div className="playlist-tools">
            <button data-testid="add-tracks" onClick={() => setBrowsing((shown) => !shown)}>
              {browsing ? "close tracks" : "add tracks"}
            </button>
            {/* Which playlist this World plays (origin R10). The reference is a
                manifest edit, so it answers on `world-result` like every other. */}
            {world && (
              <button
                className="ghost"
                data-testid="assign-playlist"
                onClick={() =>
                  send({
                    type: "set-world-playlist",
                    worldId: world.id,
                    playlistId: world.playlistId === playlist.id ? null : playlist.id,
                  })
                }
              >
                {world.playlistId === playlist.id
                  ? `${world.name} plays this — unset`
                  : `${world.name} plays this`}
              </button>
            )}
          </div>

          {browsing && (
            <AudioBrowser
              state={state}
              send={send}
              playlistId={playlist.id}
              onClose={() => setBrowsing(false)}
            />
          )}

          <ol className="playlist-tracks">
            {playlist.tracks.map((track, index) => (
              <li key={track.path} data-testid={`entry-${track.name}`}>
                <span className="track-name">{track.name}</span>
                <TrackTempo track={track} />
                <input
                  aria-label={`tempo for ${track.name}`}
                  className="bpm-input"
                  value={drafts[track.path] ?? ""}
                  onChange={(e) => setDrafts((held) => ({ ...held, [track.path]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitBpm(track);
                  }}
                  placeholder="bpm"
                />
                <button
                  className="ghost"
                  data-testid={`set-bpm-${track.name}`}
                  onClick={() => commitBpm(track)}
                >
                  set
                </button>
                <button
                  className="ghost"
                  data-testid={`up-${track.name}`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  className="ghost"
                  data-testid={`down-${track.name}`}
                  disabled={index === playlist.tracks.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
                <button
                  className="ghost"
                  data-testid={`remove-${track.name}`}
                  onClick={() =>
                    send({ type: "remove-track", playlistId: playlist.id, path: track.path })
                  }
                >
                  remove
                </button>
              </li>
            ))}
            {playlist.tracks.length === 0 && (
              <li className="muted" data-testid="playlist-empty">
                Nothing in this playlist yet.
              </li>
            )}
          </ol>

          {bpmError && (
            <p className="warn" data-testid="bpm-error">
              {bpmError}
            </p>
          )}
          {failure("set-track-bpm") && (
            <p className="warn" data-testid="set-bpm-error">
              {failure("set-track-bpm")}
            </p>
          )}
          {failure("remove-track") && (
            <p className="warn" data-testid="remove-track-error">
              {failure("remove-track")}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * What is known about one track's tempo, and whether it can be played at all.
 *
 * Four states, each with its own class so they are distinguishable by eye as
 * well as by text (origin R33, R34). The tempo is read through `bpmOf` and never
 * off the field: a stored `0`, a stored `Infinity` and an absent value are all
 * *not yet known*, and rendering the raw number would print `0 bpm` for a track
 * nothing has measured — which is exactly the value that satisfies every
 * below-threshold condition an author writes.
 */
function TrackTempo({ track }: { track: PlaylistTrack }) {
  if (track.unplayable) {
    return (
      <span className="bpm bpm-unplayable" data-testid={`bpm-${track.name}`}>
        unplayable
      </span>
    );
  }
  const bpm = bpmOf(track);
  if (!bpm.known) {
    return (
      <span className="bpm bpm-pending" data-testid={`bpm-${track.name}`}>
        tempo unknown
      </span>
    );
  }
  return (
    <span
      className={bpm.source === "set" ? "bpm bpm-set" : "bpm bpm-measured"}
      data-testid={`bpm-${track.name}`}
    >
      {bpm.bpm} bpm{bpm.source === "set" ? " · set" : ""}
    </span>
  );
}
