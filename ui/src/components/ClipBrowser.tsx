import { useEffect, useMemo, useRef, useState } from "react";
import type { ClientMessage, LibraryClip } from "../../../shared/src/types";
import type { AppState } from "../store";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
  /** The State the picked clip is assigned to. */
  stateId: string;
  onClose: () => void;
}

/**
 * Finding a clip by looking, rather than by typing a path.
 *
 * Lists one folder at a time, because that is what the server offers — a
 * recursive walk of a folder the user named is unbounded work behind a message
 * with no way to cancel it. Picking a clip copies it into the World, which is
 * what keeps a World a folder that can be zipped and moved.
 */
export function ClipBrowser({ state, send, stateId, onClose }: Props) {
  const [filter, setFilter] = useState("");
  // The folder most recently asked for. The server does not await one handler
  // before starting the next and listing cost varies with folder size, so a
  // reply for a big folder can land after the reply for the small one navigated
  // to next — leaving the browser showing a folder nobody is in.
  const wanted = useRef<string | null>(null);
  const browse = (path?: string) => {
    wanted.current = path ?? null;
    send(path === undefined ? { type: "browse-clips" } : { type: "browse-clips", path });
  };
  const arrived = state.clipLibrary;
  const listing = arrived && (wanted.current === null || arrived.folder === wanted.current) ? arrived : null;
  const result = state.worldResults["import-clip"];

  // Empty deps deliberately: this asks once, on open. Depending on `send`
  // re-ran it every render, and since each run triggers a broadcast that
  // updates the store and re-renders, that was an unbounded request loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    browse();
  }, []);

  const clips = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = listing?.clips ?? [];
    return needle.length === 0 ? all : all.filter((c) => c.name.toLowerCase().includes(needle));
  }, [listing, filter]);

  const worldId = state.world?.id;

  return (
    <section className="clip-browser" data-testid="clip-browser">
      <header>
        <h3>clips</h3>
        <button className="ghost" onClick={onClose}>
          close
        </button>
      </header>

      <p className="muted" data-testid="browser-folder">
        {listing?.folder ?? "looking…"}
      </p>
      {listing?.error && (
        <p className="warn" data-testid="browser-error">
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
        <input aria-label="filter clips" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter" />
      </div>

      <ul className="browser-list">
        {(listing?.folders ?? []).map((folder) => (
          <li key={folder.path} data-testid={`folder-${folder.name}`}>
            <button className="ghost" onClick={() => browse(folder.path)}>
              {folder.name}/
            </button>
          </li>
        ))}
        {clips.map((clip) => (
          <li key={clip.path} data-testid={`clip-${clip.name}`}>
            <button
              className="ghost"
              disabled={!worldId}
              onClick={() => {
                if (!worldId) return;
                send({ type: "import-clip", worldId, sourcePath: clip.path, stateId });
                onClose();
              }}
            >
              {clip.name}
            </button>
            <ClipSize clip={clip} />
          </li>
        ))}
        {listing && !listing.error && listing.folders.length === 0 && clips.length === 0 && (
          <li className="muted" data-testid="browser-empty">
            Nothing here HAL can play.
          </li>
        )}
        {listing?.truncated && (
          <li className="muted" data-testid="browser-truncated">
            More here than HAL will list. Open a folder further in.
          </li>
        )}
      </ul>

      {result?.ok === false && result.error && (
        <p className="warn" data-testid="import-error">
          {result.error}
        </p>
      )}
    </section>
  );
}

/**
 * How long a clip runs, read in the browser.
 *
 * The server inspects no video, so the length has to be measured where a video
 * element exists. This reads the file directly off disk rather than through the
 * clip route, which serves only clips a manifest already references — a file
 * not yet imported is not one of them.
 *
 * Absent when it cannot be read: a missing duration should not stop the file
 * being pickable.
 */
/**
 * How big a clip is, as the only thing a browser can tell about it here.
 *
 * Not how long it runs. A page served over http cannot load a `file://` URL at
 * all — Chromium refuses it as a local resource — so probing the file for its
 * duration could never have worked from here, whatever the URL said. The real
 * duration is measured server-side the first time the clip actually plays.
 */
function ClipSize({ clip }: { clip: LibraryClip }) {
  return (
    <span className="muted clip-duration" data-testid={`duration-${clip.name}`}>
      {Math.round(clip.sizeBytes / 1024)} kB
    </span>
  );
}
