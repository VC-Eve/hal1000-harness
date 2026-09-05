import { useEffect, useRef, useState } from "react";
import type { ClientMessage, ClipRef } from "../../../shared/src/types";
import type { AppState } from "../store";

/** Where the bytes come from. Query parameters, so a clip path is never a URL path segment. */
export function clipUrl(worldId: string, clip: ClipRef): string {
  return `/api/live/clip?world=${encodeURIComponent(worldId)}&clip=${encodeURIComponent(clip.path)}`;
}

/**
 * Silence any captions the file carries.
 *
 * A `<video>` renders in-band text tracks itself, over the picture, and nothing
 * in the DOM shows it — so the broadcast surface's no-text-nodes rule is blind
 * to this by construction, and so is every test written against it. A clip cut
 * with burned-in-adjacent subtitle tracks would put text on the projector with
 * every other guard still green.
 *
 * Done in the engine rather than on the broadcast surface so both surfaces
 * behave the same, and so the surface keeps no text-shaped code of its own.
 * Tracks are discovered progressively, hence the listener as well as the sweep.
 */
function silenceTextTracks(element: HTMLVideoElement): void {
  // jsdom implements no track list at all, and a browser may expose it late.
  const tracks = element.textTracks as TextTrackList | undefined;
  if (!tracks) return;
  for (let i = 0; i < tracks.length; i += 1) {
    const track = tracks[i];
    if (track) track.mode = "disabled";
  }
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

/** What one element needs bound to it to take part in the swap. */
export interface ElementHandlers {
  onEnded: () => void;
  onLoadedMetadata: (event: { currentTarget: HTMLVideoElement }) => void;
  onError: () => void;
}

export interface ClipStage {
  /** The two elements, in index order. Bind both; only one is visible at a time. */
  videos: readonly [React.RefObject<HTMLVideoElement>, React.RefObject<HTMLVideoElement>];
  /** Which index is currently the visible one. */
  front: number;
  /** The events each element must report, by index. */
  handlers: (index: number) => ElementHandlers;
  /** The path of a clip that would not load, or null. A surface may render it or ignore it. */
  failed: string | null;
  /**
   * Whether there is nothing to play — no World open, or a State holding no
   * clip.
   *
   * Distinct from a fault: nothing has gone wrong, there is simply nothing
   * assigned. The engine cannot act on it alone because the two surfaces want
   * opposite things — `/live` says so in words, and `/broadcast` must show
   * black. What it must not do is what it did before this existed: return early
   * and leave the element holding its source, so the browser goes on painting
   * the last decoded frame of a clip that is no longer assigned.
   */
  blank: boolean;
}

/**
 * The clip engine: two elements, one visible, swapped on `canplay`.
 *
 * Extracted from `ClipPlayer` so that a second surface can mount the same
 * behaviour without inheriting the first one's chrome. The split is not
 * cosmetic — `/broadcast` must render no text at all, and a component that
 * *has* no fault renderer cannot leak one, where a component that branches
 * around its fault renderer is one edit away from leaking it.
 *
 * What stays here is everything about *what plays*. What each surface does with
 * a fault, and whether it offers fullscreen, stays with the surface.
 *
 * The server owns which State is current (KTD1), so this reacts to a broadcast
 * and decides nothing. Its clip-end report is a resync signal only — the
 * server's own timer is the authority (KTD1a) — and it carries the World, State
 * and generation it was issued for so a stale or duplicated report is discarded
 * rather than advancing the machine twice.
 */
export function useClipStage(state: AppState, send: (msg: ClientMessage) => void): ClipStage {
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
   * engine shipped with. `ended` was reported with whatever generation was
   * rendered at the time, and the outgoing element was never paused — so in the
   * ordinary case, where the server's timer fires slightly before the browser
   * finishes, the demoted element's `ended` arrived after the next broadcast
   * and was reported as the NEW clip having ended. The runtime accepted it and
   * truncated the clip that had just started, on every loop.
   */
  const loaded = useRef<[Issued | null, Issued | null]>([null, null]);
  // Which issued clips have already been reported. A set rather than a single
  // value, because "once per clip" must survive any number of rerenders.
  const reported = useRef(new Set<string>());
  const measured = useRef(new Set<string>());
  const [failed, setFailed] = useState<string | null>(null);

  // The State, the generation and the path together. The generation is what
  // makes this work for a bridge as well as a loop: during a crossing the
  // server keeps `stateId` on the source and only the generation and the path
  // move, and it moves again at the landing. This engine needs to know nothing
  // about bridges, but it does depend on that — see the bridge cases in
  // ClipPlayer.test.tsx, which are what would catch it changing.
  const key = live?.clip ? `${live.stateId ?? ""}#${live.generation}#${live.clip.path}` : null;
  const blank = worldId === null || !live?.clip;

  /**
   * Stop both elements when there is nothing assigned.
   *
   * A hidden `<video>` keeps playing and keeps firing events, so without this
   * the outgoing clip runs to its end and reports it — against a generation the
   * server has moved past. Harmless, because the runtime discards it, but the
   * frame it leaves on a broadcast output is not.
   */
  useEffect(() => {
    if (!blank) return;
    for (const video of videos) video.current?.pause?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blank]);

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
    // source restarts a loop that was playing perfectly well. This is also what
    // keeps a StrictMode double-invoked mount effect from reloading the element
    // a second time — see useClipStage.test.tsx.
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
    // Swept now and watched from here on: a track that arrives mid-playback
    // would otherwise start drawing over the picture.
    silenceTextTracks(element);
    const silence = () => silenceTextTracks(element);
    element.textTracks?.addEventListener?.("addtrack", silence);
    // Wrapped rather than chained: `play` is absent in a DOM with no media
    // pipeline, and an autoplay refusal is a rejection either way.
    void Promise.resolve(element.play?.()).catch(() => {});
    return () => {
      element.removeEventListener("canplay", show);
      element.textTracks?.removeEventListener?.("addtrack", silence);
    };
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
  const onLoadedMetadata = (index: number) => (event: { currentTarget: HTMLVideoElement }) => {
    const issued = loaded.current[index];
    if (!issued) return;
    // Also swept here: metadata is when a file's own tracks become known.
    silenceTextTracks(event.currentTarget);
    const seconds = event.currentTarget.duration;
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const durationMs = Math.round(seconds * 1000);
    if (Math.abs(durationMs - issued.durationMs) <= DURATION_TOLERANCE_MS) return;
    const token = `${issued.worldId}#${issued.path}#${durationMs}`;
    if (measured.current.has(token)) return;
    measured.current.add(token);
    send({ type: "report-clip-duration", worldId: issued.worldId, path: issued.path, durationMs });
  };

  const handlers = (index: number): ElementHandlers => ({
    onEnded: onEnded(index),
    onLoadedMetadata: onLoadedMetadata(index),
    onError: () => setFailed(loaded.current[index]?.path ?? "that clip"),
  });

  return { videos, front, handlers, failed, blank };
}
