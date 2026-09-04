import { useEffect, useMemo, useRef, useState } from "react";
import type { AudioFile, ClientMessage } from "../../../shared/src/types";
import type { AppState } from "../store";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
  /** The playlist the commit appends to. */
  playlistId: string;
  onClose: () => void;
}

/**
 * Finding tracks by looking, and picking as many as you want before committing.
 *
 * `ClipBrowser` is the model and this keeps almost all of it — one folder at a
 * time because a recursive walk behind a message with no cancel is unbounded
 * work, the `wanted` ref that discards a listing for a folder nobody is in any
 * more, and the same reuse of the last action's result for the error line.
 *
 * **One thing is deliberately different** (origin R12). `ClipBrowser` sends and
 * closes in the same handler: it commits on the first pick and the dialog goes
 * away. That is right for a clip, which is assigned to one State. It is wrong
 * for a playlist, where the ordinary act is building twenty tracks out of one
 * folder — through a close-on-add dialog that is twenty visits, each of which
 * re-opens wherever the browser last was rather than where the user was
 * standing. So picks accumulate, the browser stays open, and the whole
 * selection commits in one `import-tracks` in the order it was picked.
 */
export function AudioBrowser({ state, send, playlistId, onClose }: Props) {
  const [filter, setFilter] = useState("");
  /**
   * The selection so far, in pick order.
   *
   * Kept as the files rather than as paths, so the tray can name what is in it
   * after the user has browsed away from the folder each came from — which is
   * the whole point of accumulating.
   */
  const [picked, setPicked] = useState<AudioFile[]>([]);
  // The folder most recently asked for. The server does not await one handler
  // before starting the next and listing cost varies with folder size, so a
  // reply for a big folder can land after the reply for the small one navigated
  // to next — leaving the browser showing a folder nobody is in.
  const wanted = useRef<string | null>(null);
  const browse = (path?: string) => {
    wanted.current = path ?? null;
    send(path === undefined ? { type: "browse-audio" } : { type: "browse-audio", path });
  };
  const arrived = state.audioLibrary;
  const listing =
    arrived && (wanted.current === null || arrived.folder === wanted.current) ? arrived : null;
  const result = state.playlistResults["import-tracks"];

  // Empty deps deliberately: this asks once, on open. Depending on `send`
  // re-ran it every render, and since each run triggers a broadcast that
  // updates the store and re-renders, that was an unbounded request loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    browse();
  }, []);

  const tracks = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = listing?.tracks ?? [];
    return needle.length === 0 ? all : all.filter((t) => t.name.toLowerCase().includes(needle));
  }, [listing, filter]);

  const chosen = useMemo(() => new Set(picked.map((file) => file.path)), [picked]);

  // A second click takes it out again. Picking is the only way in, so it has to
  // be the way out too — otherwise a mis-pick can only be undone after the
  // commit, by removing a track that has already been copied into the store.
  const toggle = (file: AudioFile) =>
    setPicked((current) =>
      current.some((held) => held.path === file.path)
        ? current.filter((held) => held.path !== file.path)
        : [...current, file],
    );

  const commit = () => {
    if (picked.length === 0) return;
    send({ type: "import-tracks", playlistId, sourcePaths: picked.map((file) => file.path) });
    onClose();
  };

  return (
    <section className="audio-browser" data-testid="audio-browser">
      <header>
        <h3>tracks</h3>
        <button className="ghost" onClick={onClose}>
          close
        </button>
      </header>

      <p className="muted" data-testid="audio-browser-folder">
        {listing?.folder ?? "looking…"}
      </p>
      {listing?.error && (
        <p className="warn" data-testid="audio-browser-error">
          {listing.error}
        </p>
      )}

      <div className="browser-controls">
        <button
          className="ghost"
          disabled={!listing?.parent}
          onClick={() => listing?.parent && browse(listing.parent)}
        >
          up
        </button>
        <input
          aria-label="filter tracks"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter"
        />
      </div>

      <ul className="browser-list">
        {(listing?.folders ?? []).map((folder) => (
          <li key={folder.path} data-testid={`audio-folder-${folder.name}`}>
            <button className="ghost" onClick={() => browse(folder.path)}>
              {folder.name}/
            </button>
          </li>
        ))}
        {tracks.map((file) => (
          <li key={file.path} data-testid={`track-${file.name}`}>
            <button
              className={chosen.has(file.path) ? "ghost picked" : "ghost"}
              aria-pressed={chosen.has(file.path)}
              onClick={() => toggle(file)}
            >
              {chosen.has(file.path) ? "✓ " : ""}
              {file.name}
            </button>
            <span className="muted clip-duration">{Math.round(file.sizeBytes / 1024)} kB</span>
          </li>
        ))}
        {listing && !listing.error && listing.folders.length === 0 && tracks.length === 0 && (
          <li className="muted" data-testid="audio-browser-empty">
            Nothing here HAL can play.
          </li>
        )}
        {listing?.truncated && (
          <li className="muted" data-testid="audio-browser-truncated">
            More here than HAL will list. Open a folder further in.
          </li>
        )}
      </ul>

      {/* The tray. Visible from the first pick, because a selection the browser
          does not show is one the user cannot check before committing it. */}
      <div className="browser-tray">
        <span className="muted" data-testid="audio-picked-count">
          {picked.length === 0 ? "nothing picked" : `${picked.length} picked`}
        </span>
        <button data-testid="audio-commit" disabled={picked.length === 0} onClick={commit}>
          add to playlist
        </button>
        <button className="ghost" disabled={picked.length === 0} onClick={() => setPicked([])}>
          clear
        </button>
      </div>

      {result?.ok === false && result.error && (
        <p className="warn" data-testid="import-tracks-error">
          {result.error}
        </p>
      )}
    </section>
  );
}
