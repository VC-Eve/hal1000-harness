import { useEffect, useRef, useState } from "react";
import type { ClientMessage } from "../../../shared/src/types";
import type { AppState } from "../store";
import { useClipStage } from "./useClipStage";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
}

/**
 * How long a held frame stays up before the surface fades to black.
 *
 * Long enough that a stumble reads as a slow cut rather than a dead feed, short
 * enough that a real outage does not sit on a frozen frame pretending. Named
 * rather than inline because the value is meant to be chosen against real
 * playback on a real output, not argued about here.
 */
const FADE_AFTER_MS = 3000;

/**
 * What the audience sees. Video, and nothing else, ever.
 *
 * This is a containment surface rather than a simplified one. Every failure
 * mode of `/live` is authored to be informative — the clip path that would not
 * load, the server's fault text, the error boundary's message — and on a
 * projector every one of those is a leak. So this component does not decide
 * *whether* to render them: it has no renderer for them at all, which is a
 * property no later edit can accidentally invert.
 *
 * The engine is shared with `ClipPlayer` (`useClipStage`). Its fault values are
 * received here and deliberately ignored — see `failed` below, which is read
 * only to time the fade and never to say anything.
 *
 * Three things that are not text are leaks too, and are closed on the elements:
 * the native context menu (whose "Copy video address" resolves to the clip
 * route, carrying the World id and the clip path), Picture-in-Picture (which
 * opens a floating window with its own chrome), and the remote-playback and
 * download affordances `controlsList` covers.
 */
export function BroadcastStage({ state, send }: Props) {
  const { videos, front, handlers, failed } = useClipStage(state, send);
  const stage = useRef<HTMLDivElement>(null);
  const [faded, setFaded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelFade = () => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  };

  /**
   * The fade is armed by the picture stopping, not by the fault.
   *
   * A clip that will not load fails on the *back* element, while it preloads —
   * and the front element carries on playing correctly, possibly for seconds.
   * Arming on the fault itself would therefore dip a good picture to black
   * mid-clip. What R7 asks for is a fade that follows a *held* frame, and the
   * frame is only held once the front element has ended with nothing to swap
   * in, which is exactly this condition.
   */
  const onEnded = (index: number) => () => {
    handlers(index).onEnded();
    if (index !== front || failed === null) return;
    cancelFade();
    timer.current = setTimeout(() => setFaded(true), FADE_AFTER_MS);
  };

  /**
   * Recovery. The engine clears its fault as it assigns the next clip, so a
   * cleared fault is the signal that something is coming — whether or not the
   * fade had finished by then.
   */
  useEffect(() => {
    if (failed !== null) return;
    cancelFade();
    setFaded(false);
  }, [failed]);

  // A timer outliving the surface would fade a component nobody is rendering.
  useEffect(() => cancelFade, []);

  /**
   * Fullscreen, with no control to show for it.
   *
   * Double-click rather than a button, because a button is chrome on the
   * projector even when it carries no words — and a single click is too easy
   * to do by accident while an audience is watching. It is also the convention
   * every video player already uses, so it needs no explaining and no label,
   * which is just as well since this surface may not carry one.
   *
   * The container is what goes fullscreen, not a `<video>`: the engine swaps
   * between two elements, so fullscreening the visible one would strand it at
   * the next swap.
   */
  const toggleFullscreen = () => {
    if (document.fullscreenElement === stage.current) {
      void document.exitFullscreen?.().catch(() => {});
      return;
    }
    // A refusal is an answer, not a fault: a browser may decline, and the video
    // carries on playing where it is. Nothing is rendered about it either way —
    // there is no state here to keep in step, because there is no control.
    void stage.current?.requestFullscreen?.().catch(() => {});
  };

  return (
    <div
      className={faded ? "broadcast-stage faded" : "broadcast-stage"}
      data-testid="broadcast-stage"
      ref={stage}
      // Not a text leak, but a leak: the native menu offers the clip's address.
      onContextMenu={(event) => event.preventDefault()}
      onDoubleClick={toggleFullscreen}
    >
      {[0, 1].map((index) => (
        <video
          key={index}
          ref={videos[index]}
          data-testid={`broadcast-video-${index}`}
          className={index === front ? "broadcast-video front" : "broadcast-video back"}
          muted
          playsInline
          disablePictureInPicture
          controlsList="nodownload noremoteplayback noplaybackrate"
          onEnded={onEnded(index)}
          onLoadedMetadata={handlers(index).onLoadedMetadata}
          onError={handlers(index).onError}
        />
      ))}
    </div>
  );
}
