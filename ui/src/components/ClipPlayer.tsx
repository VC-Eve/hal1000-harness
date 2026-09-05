import { useEffect, useRef, useState } from "react";
import type { ClientMessage } from "../../../shared/src/types";
import type { AppState } from "../store";
import { useClipStage } from "./useClipStage";
import { OverlayLayer } from "./OverlayLayer";

// Re-exported because this was its home before the engine was extracted, and
// callers and tests import it from here.
export { clipUrl } from "./useClipStage";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
}

/**
 * The character on screen, on `/live`.
 *
 * The playing itself lives in `useClipStage`; what is left here is everything
 * the operator's surface adds to it — the fullscreen control, and the fault
 * text. `/broadcast` mounts the same engine and renders none of that, which is
 * why the split exists: a surface that must never say anything is safest when
 * it has no renderer for anything to say.
 */
export function ClipPlayer({ state, send }: Props) {
  const live = state.worldLive;
  const { videos, front, handlers, failed, blank } = useClipStage(state, send);

  /**
   * Fullscreen the stage, not a `<video>`.
   *
   * The player keeps two elements and swaps between them, so taking one of them
   * fullscreen would show the clip playing now and lose the next one at the
   * swap. The container holds both, and the videos are positioned against it,
   * so it scales without any layout of its own.
   */
  const stage = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  // Rendered only where the browser offers it, rather than as a button that
  // does nothing — an inert control costs more than an absent one.
  const canFullscreen = typeof document !== "undefined" && document.fullscreenEnabled === true;

  // Read from the browser rather than from the click. Escape leaves fullscreen
  // without telling the page, so a flag the button owns would drift out of step
  // with what is actually on screen.
  useEffect(() => {
    const sync = () => setFull(document.fullscreenElement === stage.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement === stage.current) {
      void document.exitFullscreen?.().catch(() => {});
      return;
    }
    // A refusal is an answer, not a fault: a browser may decline, and the video
    // carries on playing where it is.
    void stage.current?.requestFullscreen?.().catch(() => {});
  };

  return (
    <div className="clip-player" data-testid="clip-player" ref={stage}>
      {[0, 1].map((index) => (
        <video
          key={index}
          ref={videos[index]}
          data-testid={`clip-video-${index}`}
          className={index === front ? "clip-video front" : "clip-video back"}
          muted
          playsInline
          {...handlers(index)}
        />
      ))}
      {/* The same layer `/broadcast` mounts, so the two surfaces cannot drift. */}
      <OverlayLayer state={state} videos={videos} front={front} blank={blank} />
      {canFullscreen && (
        <button
          type="button"
          className="clip-fullscreen"
          data-testid="clip-fullscreen"
          aria-label={full ? "exit fullscreen" : "fullscreen"}
          title={full ? "Exit fullscreen" : "Fullscreen the video"}
          onClick={toggleFullscreen}
        >
          {full ? "⤡" : "⤢"}
        </button>
      )}
      {!live?.clip && <p className="muted" data-testid="clip-empty">Nothing is assigned to play here yet.</p>}
      {failed && (
        <p className="warn" data-testid="clip-fault">
          {failed} would not load.
        </p>
      )}
      {live?.fault && (
        <p className="warn" data-testid="live-fault">
          {live.fault}
        </p>
      )}
    </div>
  );
}
