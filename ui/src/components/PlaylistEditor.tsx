import { useEffect, useRef, useState } from "react";
import type { ClientMessage, Playlist, PlaylistTrack } from "../../../shared/src/types";
import { MAX_BPM, MIN_BPM, bpmOf, usableBpm } from "../../../shared/src/audio";
import { TEXT_MAX } from "../../../shared/src/overlays";
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
  /**
   * Per-playlist name drafts, keyed by playlist id — the tempo field's idiom,
   * one level up. Absent means nothing has been typed, and the field shows the
   * name the store holds.
   */
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  /**
   * The words the overlay draws, as drafts: the playlist's header keyed by
   * playlist id, and each track's description keyed by path. Committed on blur
   * or Enter, the name field's idiom, and never per keystroke — every keystroke
   * would otherwise redraw the projector.
   */
  const [headerDrafts, setHeaderDrafts] = useState<Record<string, string>>({});
  const [descriptionDrafts, setDescriptionDrafts] = useState<Record<string, string>>({});
  /** Whether the open playlist is one press from being deleted. */
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  /**
   * A playlist deleted from here, so its last broadcast is not adopted again.
   *
   * Nothing on the wire says "that playlist is gone": the store answers a
   * deletion with the summaries and a result, and the last `playlist` message
   * — the one this editor is holding — stays exactly as true-looking as it was.
   * Without this the tracks of a set that no longer exists sat on screen with
   * every control still live, and reopening was the only way out.
   */
  const [removedId, setRemovedId] = useState<string | null>(null);
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
  } else if (arrived.id === removedId) {
    // The set this editor just deleted. Its own last broadcast is still the
    // newest one in the store, so this is the only thing that can tell it apart
    // from a set to adopt.
    held.current = null;
    wanted.current = null;
  } else if (wanted.current === null || arrived.id === wanted.current) {
    held.current = arrived;
    wanted.current = arrived.id;
  }
  const playlist = held.current;
  const world = state.world;
  const impact = state.playlistImpact;
  /**
   * Which playlist a report is allowed to be about.
   *
   * The one on screen, or — for the length of the deletion that emptied the
   * screen — the one just deleted. A deletion's report arrives after the set it
   * is about has gone, so a guard reading the open playlist alone would drop
   * the one report nothing else says out loud.
   */
  const reporting = playlist?.id ?? removedId;
  /**
   * The transport, and whether it is holding the set on screen.
   *
   * Both halves are required before a row is marked or clicked: a playlist
   * belongs to no World and this editor opens any of them, so the tracks in
   * front of the operator are very often not the ones making a sound.
   */
  const transport = state.audioTransport;
  const sounding = playlist !== null && transport?.playlistId === playlist.id;
  /**
   * Whether a click here could start a track.
   *
   * The display half of the authority rule. The server refuses a transport
   * command from any other client, and a control that looks live and does
   * nothing is the dead control the take-authority button exists to prevent.
   */
  const canPlay = sounding && state.audioAuthority;
  const failure = (action: string) => {
    const result = state.playlistResults[action];
    return result?.ok === false ? (result.error ?? null) : null;
  };

  const open = (playlistId: string) => {
    wanted.current = playlistId;
    // A confirmation belongs to the set it was opened on, and the id a deletion
    // is remembered by is free again the moment something asks for it — an id is
    // slugged from a name, so a playlist created under the same name later is
    // the same id and must be adoptable.
    setConfirmingDelete(false);
    setRemovedId(null);
    send({ type: "list-playlists", playlistId });
  };

  const create = () => {
    if (name.trim().length === 0) return;
    // The server slugs the name into an id, so there is nothing to match on and
    // the next playlist to arrive is the one this asked for.
    wanted.current = null;
    setConfirmingDelete(false);
    setRemovedId(null);
    send({ type: "create-playlist", name: name.trim() });
    setName("");
  };

  /**
   * Rename the open playlist (agent parity, the other way round).
   *
   * `rename-playlist` has been on the wire and implemented on the server since
   * the feature shipped, with no control anywhere that sent it: an agent could
   * rename a playlist and the person whose playlist it was could not. Inline and
   * committed on Enter or on the button, which is the tempo field's idiom one
   * level up.
   *
   * A name that has not changed sends nothing. The server takes it — `rename` on
   * an identical name is a no-op there — but a message per keystroke-then-blur
   * is a broadcast to every client that redraws a picker for nothing.
   */
  /** Commit the header. Unchanged sends nothing; empty clears. */
  const commitHeader = () => {
    if (!playlist) return;
    const draft = headerDrafts[playlist.id];
    if (draft === undefined) return;
    setHeaderDrafts((held) => {
      const { [playlist.id]: _done, ...rest } = held;
      return rest;
    });
    const asked = draft.trim();
    if (asked === (playlist.header ?? "")) return;
    send({ type: "set-playlist-header", playlistId: playlist.id, header: asked.length === 0 ? null : asked });
  };

  /** Commit one track's description, by path. Unchanged sends nothing; empty clears. */
  const commitDescription = (track: PlaylistTrack) => {
    if (!playlist) return;
    const draft = descriptionDrafts[track.path];
    if (draft === undefined) return;
    setDescriptionDrafts((held) => {
      const { [track.path]: _done, ...rest } = held;
      return rest;
    });
    const asked = draft.trim();
    if (asked === (track.description ?? "")) return;
    send({
      type: "set-track-description",
      playlistId: playlist.id,
      path: track.path,
      description: asked.length === 0 ? null : asked,
    });
  };

  const commitName = () => {
    if (!playlist) return;
    const asked = (nameDrafts[playlist.id] ?? playlist.name).trim();
    if (asked.length === 0 || asked === playlist.name) return;
    send({ type: "rename-playlist", playlistId: playlist.id, name: asked });
  };

  /**
   * Delete the open playlist, on the second press.
   *
   * Two presses rather than a dialog — `SettingsPanel`'s idiom for forgetting a
   * person, which is the codebase's existing answer for a destructive control
   * and destroys rather more. The tracks themselves stay in the store; what goes
   * is the index, and with it every World's reference to it.
   *
   * What that costs those Worlds is the server's to say and arrives as
   * `playlist-impact`, on the same channel a track removal reports on: this
   * client holds no manifest and cannot know which Worlds play the set. It
   * lands after the deletion, which is why the report above is not inside the
   * open-playlist block — by then there is no open playlist.
   */
  const remove = () => {
    if (!playlist) return;
    send({ type: "remove-playlist", playlistId: playlist.id });
    // Dropped here rather than waiting for a message that never comes: nothing
    // on the wire announces a playlist's absence.
    held.current = null;
    wanted.current = null;
    setRemovedId(playlist.id);
    setConfirmingDelete(false);
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
      {/* Outside the open-playlist block on purpose: a deletion closes the set
          on screen the moment it is asked for, so a refusal reported inside
          would have nowhere left to appear. The set is still in the list above,
          because a refused deletion broadcast no new summaries. */}
      {failure("remove-playlist") && (
        <p className="warn" data-testid="remove-playlist-error">
          {failure("remove-playlist")}
        </p>
      )}

      {/* What the last edit cost the Worlds that play this playlist (origin R17,
          AE13). Said here, at the moment of the edit, rather than left to each
          affected World's own reports — those are true and arrive when that
          World is next opened, which during a set is hours too late. */}
      {impact && impact.playlistId === reporting && impact.impacts.length > 0 && (
        <div className="warn playlist-impact" data-testid="playlist-impact">
          <p>
            {impact.action === "reorder-playlist"
              ? "Reordering moved what these conditions point at:"
              : impact.action === "remove-playlist"
                ? "That deletion left these Worlds playing a playlist that is gone:"
                : "That removal left these conditions naming a position this playlist no longer reaches:"}
          </p>
          <ul>
            {impact.impacts.map((affected) => (
              <li key={affected.worldId} data-testid={`impact-${affected.worldId}`}>
                {affected.worldName}
                {/* A deletion names Worlds that hold no position condition at
                    all — they have still lost their soundtrack — so the colon
                    and the list are printed only when there is a list. */}
                {affected.conditions.length > 0 && (
                  <>
                    :{" "}
                    {affected.conditions
                      .map((c) => `${c.parameter} ${c.op} ${String(c.value)}`)
                      .join(", ")}
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {playlist && (
        <>
          {/* The playlist itself: its name, and whether it goes on existing.
              Both were on the wire and implemented on the server from the day
              the feature shipped, with nothing anywhere that sent either — the
              parity gap the other way round. */}
          <div className="playlist-name">
            <input
              aria-label="playlist name"
              value={nameDrafts[playlist.id] ?? playlist.name}
              onChange={(e) =>
                setNameDrafts((held) => ({ ...held, [playlist.id]: e.target.value }))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") commitName();
              }}
            />
            <button className="ghost" data-testid="rename-playlist" onClick={commitName}>
              rename
            </button>
            {/* Confirmed, because this cannot be undone and the Worlds that
                play the set lose their soundtrack with it. Two presses rather
                than a dialog: the idiom `SettingsPanel` already uses for
                forgetting a person. */}
            {confirmingDelete ? (
              <>
                <button className="ghost danger" data-testid="confirm-remove-playlist" onClick={remove}>
                  delete {playlist.name} — any World playing it falls silent
                </button>
                <button className="ghost" onClick={() => setConfirmingDelete(false)}>
                  cancel
                </button>
              </>
            ) : (
              <button
                className="ghost"
                data-testid="remove-playlist"
                onClick={() => setConfirmingDelete(true)}
              >
                delete
              </button>
            )}
          </div>
          {failure("rename-playlist") && (
            <p className="warn" data-testid="rename-playlist-error">
              {failure("rename-playlist")}
            </p>
          )}
          {/* What the audience is told about the whole set, drawn above the
              track's own line by the World's playlist-header slot. Stored with
              the playlist because it is a fact about the tracks. */}
          <div className="playlist-name">
            <input
              aria-label="playlist header"
              maxLength={TEXT_MAX}
              placeholder="header shown over the picture"
              value={headerDrafts[playlist.id] ?? playlist.header ?? ""}
              onChange={(e) => setHeaderDrafts((held) => ({ ...held, [playlist.id]: e.target.value }))}
              onBlur={commitHeader}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitHeader();
              }}
            />
          </div>
          {failure("set-playlist-header") && (
            <p className="warn" data-testid="set-playlist-header-error">
              {failure("set-playlist-header")}
            </p>
          )}
          {failure("set-track-description") && (
            <p className="warn" data-testid="set-track-description-error">
              {failure("set-track-description")}
            </p>
          )}

          <div className="playlist-tools">
            <button data-testid="add-tracks" onClick={() => setBrowsing((shown) => !shown)}>
              {browsing ? "close tracks" : "add tracks"}
            </button>
            {/* A saved property of the playlist, so it sits with the playlist
                tools rather than with the transport buttons — and so it is not
                gated on the audio authority: editing a playlist and sounding
                one are separate permissions, exactly as a reorder is. */}
            <button
              className="ghost"
              data-testid="toggle-shuffle"
              aria-pressed={playlist.shuffle === true}
              onClick={() =>
                send({
                  type: "set-playlist-shuffle",
                  playlistId: playlist.id,
                  shuffle: playlist.shuffle !== true,
                })
              }
            >
              {playlist.shuffle === true ? "shuffle — on" : "shuffle — off"}
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
              <li
                key={track.path}
                data-testid={`entry-${track.name}`}
                /* Matched by path, not by position. The index a row is drawn at
                   and the index the transport is holding are two counts of two
                   arrays that an edit in another tab can separate, and under
                   shuffle the transport's own next track is not this row's
                   neighbour either. */
                className={sounding && transport?.path === track.path ? "track-playing" : undefined}
              >
                <button
                  className="track-name"
                  data-testid={`play-${track.name}`}
                  disabled={!canPlay}
                  title={canPlay ? "play this track" : undefined}
                  onClick={() => {
                    if (!canPlay) return;
                    send({
                      type: "audio-transport",
                      command: "play-track",
                      playlistId: playlist.id,
                      path: track.path,
                    });
                  }}
                >
                  {track.name}
                </button>
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
                {/* A line of its own beneath the controls, not squeezed into
                    their row: a control may not be squeezed, and the row is
                    already full (docs/solutions/a-label-may-be-squeezed-a-control-may-not.md). */}
                <input
                  className="track-description"
                  aria-label={`description for ${track.name}`}
                  maxLength={TEXT_MAX}
                  placeholder="description shown while this plays"
                  value={descriptionDrafts[track.path] ?? track.description ?? ""}
                  onChange={(e) =>
                    setDescriptionDrafts((held) => ({ ...held, [track.path]: e.target.value }))
                  }
                  onBlur={() => commitDescription(track)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitDescription(track);
                  }}
                />
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
