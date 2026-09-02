import { useEffect, useRef, useState } from "react";
import type { ClientMessage, ClipRef } from "../../../shared/src/types";
import type { AppState } from "../store";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
}

/** Where the bytes come from. Query parameters, so a clip path is never a URL path segment. */
export function clipUrl(worldId: string, clip: ClipRef): string {
  return `/api/live/clip?world=${encodeURIComponent(worldId)}&clip=${encodeURIComponent(clip.path)}`;
}

/** How far off a recorded duration has to be before it is worth correcting. */
const DURATION_TOLERANCE_MS = 150;

/** What one video element was last told to play. */
interface Issued {
  worldId: string;
  stateId: string;
  generation: number;
  path: string;
  durationMs: number;
}

/**
 * The character on screen.
 *
 * Two video elements: one visible while the other holds the next clip already
 * loaded, swapped on `canplay` rather than on a timer, which is what keeps the
 * join between two clips free of a black frame (R22). The server owns which
 * State is current (KTD1), so this reacts to a broadcast and decides nothing.
 *
 * Its clip-end report is a resync signal only — the server's own timer is the
 * authority (KTD1a) — and it carries the World, State and generation it was
 * issued for so a stale or duplicated report is discarded rather than advancing
 * the machine twice.
 */
export function ClipPlayer({ state, send }: Props) {
  const live = state.worldLive;
  const worldId = state.world?.id ?? null;
  const back = useRef<HTMLVideoElement>(null);
  const forward = useRef<HTMLVideoElement>(null);
  const videos = [back, forward] as const;
  const [front, setFront] = useState(0);
  // Which clip each element currently holds, so a rerender with unchanged live
  // State does not reassign a source and restart playback.
  const held = useRef<[string | null, string | null]>([null, null]);
  /**
   * What each element was loaded to play.
   *
   * Per element, not per component, and this is the whole of the defect this
   * component shipped with. `ended` was reported with whatever generation was
   * rendered at the time, and the outgoing element was never paused — so in the
   * ordinary case, where the server's timer fires slightly before the browser
   * finishes, the demoted element's `ended` arrived after the next broadcast
   * and was reported as the NEW clip having ended. The runtime accepted it and
   * truncated the clip that had just started, on every loop.
   */
  const loaded = useRef<[Issued | null, Issued | null]>([null, null]);
  // Which issued clips have already been reported. A set rather than a single
  // value, because "once per clip" must survive StrictMode double-invoking a
  // mount effect and any number of rerenders.
  const reported = useRef(new Set<string>());
  const measured = useRef(new Set<string>());
  const [failed, setFailed] = useState<string | null>(null);

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

  // The State, the generation and the path together. The generation is what
  // makes this work for a bridge as well as a loop: during a crossing the
  // server keeps `stateId` on the source and only the generation and the path
  // move, and it moves again at the landing. This component needs to know
  // nothing about bridges, but it does depend on that — see the bridge cases in
  // ClipPlayer.test.tsx, which are what would catch it changing.
  const key = live?.clip ? `${live.stateId ?? ""}#${live.generation}#${live.clip.path}` : null;

  useEffect(() => {
    if (!worldId || !live?.clip) return;
    const next = front === 0 ? 1 : 0;
    const element = videos[next].current;
    const source = clipUrl(worldId, live.clip);
    if (!element) return;

    setFailed(null);
    loaded.current[next] = {
      worldId,
      stateId: live.stateId ?? "",
      generation: live.generation,
      path: live.clip.path,
      durationMs: live.clip.durationMs,
    };
    // Only touch `src` when the file actually changes: reassigning the same
    // source restarts a loop that was playing perfectly well.
    if (held.current[next] !== source) {
      element.src = source;
      held.current[next] = source;
      element.load();
    } else {
      element.currentTime = 0;
    }
    const show = () => {
      // The outgoing element is paused as it is demoted. It is hidden, but a
      // hidden <video> keeps playing and keeps firing events.
      videos[next === 0 ? 1 : 0].current?.pause?.();
      setFront(next);
    };
    // Swapping on `canplay` rather than immediately is the whole point of the
    // second element: the incoming clip has decoded a frame before it becomes
    // the visible one.
    element.addEventListener("canplay", show, { once: true });
    // Wrapped rather than chained: `play` is absent in a DOM with no media
    // pipeline, and an autoplay refusal is a rejection either way.
    void Promise.resolve(element.play?.()).catch(() => {});
    return () => element.removeEventListener("canplay", show);
    // Keyed on the clip identity rather than on `live`, so an unrelated
    // broadcast does not restart playback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, worldId]);

  /**
   * Report what this element actually finished.
   *
   * Read from the element's own record, never from the current render: the
   * element that fires `ended` may well be the demoted one, finishing the clip
   * before last.
   */
  const onEnded = (index: number) => () => {
    const issued = loaded.current[index];
    if (!issued || issued.stateId.length === 0) return;
    const token = `${issued.worldId}#${issued.stateId}#${issued.generation}`;
    if (reported.current.has(token)) return;
    reported.current.add(token);
    send({
      type: "report-clip-end",
      worldId: issued.worldId,
      stateId: issued.stateId,
      generation: issued.generation,
    });
  };

  /**
   * Tell the server how long this clip really is.
   *
   * The duration cannot be measured at assignment time — the clip route serves
   * only clips the manifest already references, so a probe then is answered 404
   * and every assignment recorded zero. Measuring at first play is what makes
   * KTD1a work at all, and it also self-corrects the drift the plan records as
   * a residual: replace a clip with a longer take and the next viewing fixes
   * the number.
   */
  const onMetadata = (index: number) => (event: React.SyntheticEvent<HTMLVideoElement>) => {
    const issued = loaded.current[index];
    if (!issued) return;
    const seconds = event.currentTarget.duration;
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const durationMs = Math.round(seconds * 1000);
    if (Math.abs(durationMs - issued.durationMs) <= DURATION_TOLERANCE_MS) return;
    const token = `${issued.worldId}#${issued.path}#${durationMs}`;
    if (measured.current.has(token)) return;
    measured.current.add(token);
    send({ type: "report-clip-duration", worldId: issued.worldId, path: issued.path, durationMs });
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
          onEnded={onEnded(index)}
          onLoadedMetadata={onMetadata(index)}
          onError={() => setFailed(loaded.current[index]?.path ?? "that clip")}
        />
      ))}
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
