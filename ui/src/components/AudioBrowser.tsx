import { useEffect, useMemo, useRef, useState } from "react";
import type { AudioFile, ClientMessage } from "../../../shared/src/types";
import { TRACK_FILTER_MAX, normaliseTrackFilter } from "../../../shared/src/audio";
import type { AppState } from "../store";

/**
 * How long the filter box waits before it asks.
 *
 * The filter is a server request now, and a request per keystroke over a folder
 * of a few thousand files is the shape this codebase already avoids elsewhere:
 * every one of them stats its matches and answers with a listing that re-renders
 * the list. Long enough that typing a word costs one request, short enough that
 * a pause reads as an answer arriving rather than as a hang.
 */
const FILTER_DEBOUNCE_MS = 200;

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
 *
 * **The filter is the server's**, and that is the second difference. It used to
 * be a `useMemo` over the arrived listing, which filtered the tracks the server
 * had already chosen to send — so in a folder of 701 tracks the last 201 could
 * not be scrolled to *and* could not be searched for, because they were never
 * in the browser at all. It is sent now, debounced, and the `wanted` discipline
 * covers it as well as the folder: a reply for `dr` landing after the user has
 * typed `drum` is discarded exactly as a reply for a folder nobody is in is.
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
  // The filter most recently asked for, normalised the way the server will echo
  // it. The same idea as `wanted` one keystroke over: listing cost varies with
  // how much matches, so the wide reply for `dr` can land after the narrow one
  // for `drum` and put back the list the user was typing their way out of.
  const wantedFilter = useRef("");
  const browse = (path?: string, text = filter) => {
    const needle = normaliseTrackFilter(text);
    wanted.current = path ?? null;
    wantedFilter.current = needle;
    send({
      type: "browse-audio",
      ...(path === undefined ? {} : { path }),
      ...(needle.length === 0 ? {} : { filter: needle }),
    });
  };
  const arrived = state.audioLibrary;
  const listing =
    arrived &&
    (wanted.current === null || arrived.folder === wanted.current) &&
    (arrived.filter ?? "") === wantedFilter.current
      ? arrived
      : null;
  const result = state.playlistResults["import-tracks"];

  // Empty deps deliberately: this asks once, on open. Depending on `send`
  // re-ran it every render, and since each run triggers a broadcast that
  // updates the store and re-renders, that was an unbounded request loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    browse();
  }, []);

  // Debounced, and only when there is something new to ask: a keystroke that
  // normalises to what was already requested — a trailing space, a letter typed
  // and taken back inside the window — asks nothing.
  //
  // The folder is taken from the listing on screen rather than from `wanted`,
  // which is null until the first reply names where the browser opened.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (normaliseTrackFilter(filter) === wantedFilter.current) return;
    const at = listing?.folder;
    const timer = setTimeout(() => browse(at), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filter]);

  const tracks = listing?.tracks ?? [];

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
          maxLength={TRACK_FILTER_MAX}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter"
        />
        {/* What is on screen against what matched. A user looking at 2000 of
            3412 needs to know that typing reaches the other 1412, where a bare
            list of 2000 reads as the whole folder. */}
        {listing && !listing.error && (
          <span className="muted" data-testid="audio-browser-count">
            {tracks.length === listing.matched
              ? `${listing.matched} tracks`
              : `${tracks.length} of ${listing.matched}`}
          </span>
        )}
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
            More here than HAL will list. Type to narrow — the filter runs over the whole folder,
            not over this list.
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
