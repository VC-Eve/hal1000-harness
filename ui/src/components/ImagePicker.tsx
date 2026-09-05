import { useEffect, useRef, useState } from "react";
import type { ClientMessage } from "../../../shared/src/types";
import type { AppState } from "../store";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
  worldId: string;
  /** Which slot the chosen image is attached to, by list position. */
  slot: number;
  onClose: () => void;
}

/**
 * Finding an image by looking, rather than by typing a path.
 *
 * `ClipBrowser`'s shape, against the same browse: one folder at a time, because
 * a recursive walk of a folder the operator named is unbounded work behind a
 * message with no way to cancel it. The listing carries clips and images
 * together, so this reads the half it wants and the clip browser reads the
 * other — one walk answers both.
 *
 * There is no way to type a path here. An image arrives by being copied into
 * the World, and a typed path would be a second door onto the World with
 * different confinement from the one the import keeps. An agent has the door
 * this lacks: `import-overlay-image` takes a source path.
 */
export function ImagePicker({ state, send, worldId, slot, onClose }: Props) {
  const [filter, setFilter] = useState("");
  // The folder most recently asked for. The server does not await one handler
  // before starting the next, so a reply for a big folder can land after the
  // small one navigated away — leaving the picker showing a folder nobody is
  // in. `ClipBrowser` keeps the same ref for the same reason.
  const wanted = useRef<string | null>(null);
  const browse = (path?: string) => {
    wanted.current = path ?? null;
    send(path === undefined ? { type: "browse-clips" } : { type: "browse-clips", path });
  };
  const arrived = state.clipLibrary;
  const listing = arrived && (wanted.current === null || arrived.folder === wanted.current) ? arrived : null;
  const result = state.worldResults["import-overlay-image"];

  // Empty deps deliberately: asked once, on open. `ClipBrowser` records why —
  // each run triggers a broadcast that updates the store and re-renders, so a
  // dependency on `send` is an unbounded request loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => browse(), []);

  const needle = filter.trim().toLowerCase();
  const images = (listing?.images ?? []).filter(
    (image) => needle.length === 0 || image.name.toLowerCase().includes(needle),
  );

  return (
    <div className="clip-browser image-picker" data-testid="image-picker">
      <div className="clip-browser-head">
        <span className="muted">{listing?.folder ?? "reading…"}</span>
        <button className="ghost" aria-label="close image picker" onClick={onClose}>
          close
        </button>
      </div>

      {listing?.error && <p className="warn">{listing.error}</p>}

      <input
        aria-label="filter images"
        placeholder="filter"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      <ul className="clip-browser-list">
        {listing?.parent !== null && listing?.parent !== undefined && (
          <li>
            <button className="ghost" onClick={() => browse(listing.parent!)}>
              ../
            </button>
          </li>
        )}
        {(listing?.folders ?? []).map((folder) => (
          <li key={folder.path}>
            <button className="ghost" onClick={() => browse(folder.path)}>
              {folder.name}/
            </button>
          </li>
        ))}
        {images.map((image) => (
          <li key={image.path}>
            <button
              className="ghost"
              onClick={() => {
                send({ type: "import-overlay-image", worldId, sourcePath: image.path, slot });
                onClose();
              }}
            >
              {image.name}
            </button>
          </li>
        ))}
      </ul>

      {listing !== null && images.length === 0 && (
        <p className="muted">No images in this folder.</p>
      )}
      {listing?.truncated && (
        <p className="muted">More here than is shown. Narrow the filter or open a smaller folder.</p>
      )}
      {result?.ok === false && (
        <p className="warn" data-testid="image-import-error">
          {result.error ?? "That image was refused."}
        </p>
      )}
    </div>
  );
}
