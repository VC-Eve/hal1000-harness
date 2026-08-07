import { useEffect, useRef } from "react";
import type { ClientMessage, VisionState } from "../../../shared/src/types";
import type { AppState } from "../store";
import { CollapseButton } from "./SectionRail";
import { CaptionerSetup } from "./CaptionerSetup";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
  collapseDisabled: boolean;
  onCollapse: () => void;
}

// What each state says for itself. Faults are HAL's own condition and are
// reported here rather than narrated into the feed (R17), so this is the only
// place a missing camera is ever mentioned.
const STATE_COPY: Record<VisionState, string> = {
  off: "I am not watching.",
  idle: "watching",
  capturing: "looking",
  captioning: "considering what I saw",
  narrating: "composing",
  "no-camera": "I cannot open the camera.",
  "no-captioner": "I cannot reach the captioner.",
  error: "Something went wrong.",
};

// A map rather than a list, so adding a VisionState fails to compile until it
// has been classified as a fault or not. A list would silently default a new
// fault state to "fine".
const IS_FAULT: Record<VisionState, boolean> = {
  off: false,
  idle: false,
  capturing: false,
  captioning: false,
  narrating: false,
  "no-camera": true,
  "no-captioner": true,
  error: true,
};

/**
 * The third section: what HAL currently sees.
 *
 * It shows the captions rather than the feed entries they produce. The feed
 * carries what HAL chose to say about a cycle; this carries what it was told,
 * which is the only way to tell an over-eager sensitivity from a captioner
 * that is describing the wrong thing.
 */
export function WebcamPane({ state, send, collapseDisabled, onCollapse }: Props) {
  const enabled = state.settings?.vision.enabled ?? false;
  const fault = IS_FAULT[state.visionState];
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Newest observation is the interesting one, same as the feed. Assigning
    // scrollTop rather than calling scrollTo is the idiom the other panes use.
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.visionObservations.length]);

  return (
    <section className="pane webcam-pane" data-testid="webcam-pane">
      <div className="pane-header">
        <span className="pane-title">vision</span>
        <div className="pane-actions">
          <span className={fault ? "vision-state fail" : "vision-state"} data-testid="vision-state">
            {STATE_COPY[state.visionState]}
          </span>
          <button
            className="ghost"
            onClick={() => send({ type: "vision-capture-now" })}
            // Disabled while stopped as well as while busy: the server refuses
            // to look while Vision is off, so offering the button would be an
            // affordance that does nothing.
            disabled={!enabled || state.visionState === "capturing" || state.visionState === "captioning"}
            title={enabled ? "Capture and describe a frame now" : "Start Vision first"}
          >
            look now
          </button>
          <button
            className="ghost"
            onClick={() =>
              send({ type: "update-settings", patch: { vision: { enabled: !enabled } } })
            }
          >
            {enabled ? "stop" : "start"}
          </button>
          <CollapseButton id="webcam" disabled={collapseDisabled} onCollapse={onCollapse} />
        </div>
      </div>

      {fault && state.visionDetail ? (
        <p className="vision-fault" data-testid="vision-fault">
          {state.visionDetail}
        </p>
      ) : null}

      {/* The one fault a user cannot act on without being told what to install.
          A missing camera explains itself; a missing captioner does not. */}
      {state.visionState === "no-captioner" ? <CaptionerSetup compact /> : null}

      <div className="vision-body">
        {/* Live left, last capture right, equal halves. The live feed is the
            server's stream rather than getUserMedia: a camera is an exclusive
            device, and a browser holding it would stop every capture. */}
        <div className="vision-views">
          <figure className="vision-view">
            {enabled ? (
              <img className="vision-image" src="/api/vision/stream" alt="the live camera" />
            ) : (
              <div className="vision-image vision-dark">not watching</div>
            )}
            <figcaption>live</figcaption>
          </figure>
          <figure className="vision-view">
            {state.visionFrame ? (
              <img className="vision-image" src={state.visionFrame.dataUrl} alt="the most recent capture" />
            ) : (
              <div className="vision-image vision-dark">no capture yet</div>
            )}
            <figcaption>
              {state.visionFrame ? new Date(state.visionFrame.at).toLocaleTimeString() : "last capture"}
            </figcaption>
          </figure>
        </div>

        <div className="vision-observations" ref={listRef} data-testid="vision-observations">
          {state.visionObservations.length === 0 ? (
            <p className="empty-state webcam-placeholder">
              {enabled ? "No eyes yet. I will tell you what I see." : "No eyes yet. Start me when you are ready."}
            </p>
          ) : (
            state.visionObservations.map((o) => (
              <p className="vision-observation" key={o.at}>
                <span className="vision-time">{new Date(o.at).toLocaleTimeString()}</span>
                {o.identity ? <span className="vision-identity">{o.identity}</span> : null}
                {o.caption}
              </p>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
