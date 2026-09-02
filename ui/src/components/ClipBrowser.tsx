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
            <ClipDuration clip={clip} />
          </li>
        ))}
        {listing && !listing.error && listing.folders.length === 0 && clips.length === 0 && (
          <li className="muted" data-testid="browser-empty">
            Nothing here HAL can play.
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
 * A `file://` URL for an absolute path on disk.
 *
 * `file://` + `C:/takes/x.mp4` parses `C:` as the *host*, so the probe asks the
 * network for a machine called C and the duration never arrives. A Windows path
 * needs the third slash, and each segment needs escaping — a `#` in a filename
 * would otherwise truncate the URL at the fragment. The drive letter keeps its
 * colon: percent-encoded it stops naming a drive.
 */
export function fileUrl(absolute: string): string {
  const slashed = absolute.split("\\").join("/");
  const rooted = slashed.startsWith("/") ? slashed : `/${slashed}`;
  const escaped = rooted
    .split("/")
    .map((segment) => (/^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/");
  return `file://${escaped}`;
}

function ClipDuration({ clip }: { clip: LibraryClip }) {
  const [seconds, setSeconds] = useState<number | null>(null);
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.muted = true;
    const done = (value: number | null) => {
      probe.removeAttribute("src");
      setSeconds(value);
    };
    probe.addEventListener("loadedmetadata", () => done(Number.isFinite(probe.duration) ? probe.duration : null), {
      once: true,
    });
    probe.addEventListener("error", () => done(null), { once: true });
    probe.src = fileUrl(clip.path);
    return () => probe.removeAttribute("src");
  }, [clip.path]);

  return (
    <span className="muted clip-duration" data-testid={`duration-${clip.name}`}>
      {seconds === null ? `${Math.round(clip.sizeBytes / 1024)} kB` : `${seconds.toFixed(1)}s`}
    </span>
  );
}
