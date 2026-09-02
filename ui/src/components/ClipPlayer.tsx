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

/**
 * Read a clip's duration from the file, so the manifest can record it.
 *
 * This is how a duration reaches the server without the server ever touching
 * video: the browser loads the metadata, and the number rides with the assign
 * message (KTD1a). Zero when nothing could be read — the runtime falls back to
 * its own default rather than waiting forever on a length nobody knows.
 */
export function probeClipDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.muted = true;
    const done = (ms: number) => {
      probe.removeAttribute("src");
      resolve(ms);
    };
    probe.addEventListener(
      "loadedmetadata",
      () => done(Number.isFinite(probe.duration) ? Math.round(probe.duration * 1000) : 0),
      { once: true },
    );
    probe.addEventListener("error", () => done(0), { once: true });
    probe.src = url;
  });
}

/**
 * The character on screen.
 *
 * Two video elements: one visible while the other holds the next clip already
 * loaded, swapped on `ended` rather than on a timer, which is what keeps the
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
  // The generation whose end has already been reported. Effects run twice under
  // StrictMode in dev and rerenders are frequent, so "once per clip" has to be
  // a fact about the clip rather than about how often this runs.
  const reported = useRef<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const key = live?.clip ? `${live.stateId ?? ""}#${live.generation}#${live.clip.path}` : null;

  useEffect(() => {
    if (!worldId || !live?.clip) return;
    const next = front === 0 ? 1 : 0;
    const element = videos[next].current;
    const source = clipUrl(worldId, live.clip);
    if (!element) return;

    setFailed(null);
    reported.current = null;
    // Only touch `src` when the file actually changes: reassigning the same
    // source restarts a loop that was playing perfectly well.
    if (held.current[next] !== source) {
      element.src = source;
      held.current[next] = source;
      element.load();
    } else {
      element.currentTime = 0;
    }
    const show = () => setFront(next);
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

  const onEnded = (generation: number) => () => {
    if (!worldId || !live?.stateId) return;
    if (reported.current === generation) return;
    reported.current = generation;
    send({ type: "report-clip-end", worldId, stateId: live.stateId, generation });
  };

  return (
    <div className="clip-player" data-testid="clip-player">
      {[0, 1].map((index) => (
        <video
          key={index}
          ref={videos[index]}
          data-testid={`clip-video-${index}`}
          className={index === front ? "clip-video front" : "clip-video back"}
          muted
          playsInline
          onEnded={live ? onEnded(live.generation) : undefined}
          onError={() => setFailed(live?.clip?.path ?? "that clip")}
        />
      ))}
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
