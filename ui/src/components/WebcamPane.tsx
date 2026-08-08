import { useEffect, useRef, useState } from "react";
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
  "no-recogniser": "I cannot reach the recogniser.",
  "recogniser-slow": "The recogniser cannot keep up.",
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
  // Faults, but partial ones: Vision keeps capturing, captioning and
  // summarising without a recogniser (R7). They read as conditions rather than
  // as Vision being broken, which is what the copy above has to convey.
  "no-recogniser": true,
  "recogniser-slow": true,
  error: true,
};

/**
 * Who recognition currently sees, and the only way into the gallery.
 *
 * The brief makes the triage queue the enrolment path; this slice has no
 * queue, so naming the face in view is it. Enrolment is offered only for an
 * unrecognised face that the recogniser could actually describe — offering it
 * for a face with no embedding would create a person who never matches.
 */
function RecognitionStrip({ state, send }: { state: AppState; send: (msg: ClientMessage) => void }) {
  const [name, setName] = useState("");
  const appearances = state.visionAppearances;
  const named = appearances.filter((a) => a.match !== null);
  const unnamed = appearances.filter((a) => a.match === null);
  // One unrecognised face and nothing ambiguous: enrolling from a crowded frame
  // would attach the wrong face to a name, and the server refuses it anyway.
  const canEnrol = appearances.length === 1 && unnamed.length === 1 && unnamed[0]!.embedded;

  function enrol() {
    const trimmed = name.trim();
    if (!trimmed) return;
    send({ type: "enrol-person", name: trimmed });
    setName("");
  }

  return (
    <div className="vision-recognition" data-testid="vision-recognition">
      {named.map((a) => (
        <span key={a.id} className="vision-identity" data-testid="vision-identity">
          {/* The hedge is the shipped form, and the confidence is what makes a
              wrong match reviewable rather than invisible (R24). */}
          someone who looks like <strong>{a.match!.name}</strong>
          <span className="vision-confidence"> {Math.round(a.match!.confidence * 100)}%</span>
        </span>
      ))}

      {appearances.length === 0 ? (
        <span className="vision-identity vision-muted" data-testid="vision-nobody">
          nobody in view
        </span>
      ) : null}

      {unnamed.length > 0 ? (
        <span className="vision-identity vision-muted" data-testid="vision-unknown">
          {unnamed.length === 1 ? "someone I do not know" : `${unnamed.length} people I do not know`}
        </span>
      ) : null}

      {unnamed.length > 0 ? (
        <span className="vision-enrol">
          <input
            className="vision-enrol-name"
            placeholder="this is…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") enrol();
            }}
            disabled={!canEnrol}
            data-testid="vision-enrol-name"
          />
          <button className="ghost" onClick={enrol} disabled={!canEnrol || !name.trim()} data-testid="vision-enrol">
            enrol
          </button>
        </span>
      ) : null}

      {state.visionEnrolError ? (
        <span className="vision-fault" data-testid="vision-enrol-error">
          {state.visionEnrolError}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Faces HAL kept, waiting to be named or dismissed.
 *
 * This is what makes enrolment work when the live view will not cooperate —
 * two people in frame, or a visit that fragmented into several appearances, or
 * someone who has already walked away. The face is chosen rather than assumed.
 *
 * Naming enrols. Dismissing deletes the crop and records nothing. The two are
 * kept apart so neither is reachable by a misclick meant for the other.
 */
function TriageQueue({ state, send }: { state: AppState; send: (msg: ClientMessage) => void }) {
  const [naming, setNaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const { visionCandidates: queue, visionCandidateOverflow: overflow } = state;

  if (queue.length === 0 && overflow.dropped === 0) return null;

  function submit(id: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    send({ type: "enrol-person", name: trimmed, candidateId: id });
    setNaming(null);
    setName("");
  }

  return (
    <div className="vision-triage" data-testid="vision-triage">
      {overflow.dropped > 0 ? (
        // A bound that discards silently would let an empty queue read as a
        // quiet week when it was a full one.
        <p className="vision-triage-overflow" data-testid="triage-overflow">
          {overflow.dropped} {overflow.dropped === 1 ? "face" : "faces"} dropped before you looked at{" "}
          {overflow.dropped === 1 ? "it" : "them"}. Raise the limit in settings to keep more.
        </p>
      ) : null}

      <div className="vision-triage-row">
        {queue.map((candidate) => (
          <figure className="triage-face" key={candidate.id} data-testid="triage-face">
            <img src={candidate.thumbnail} alt="an unrecognised face" />
            <figcaption title={new Date(candidate.at).toLocaleString()}>
              {new Date(candidate.at).toLocaleTimeString()}
            </figcaption>

            {naming === candidate.id ? (
              <span className="triage-actions">
                <input
                  autoFocus
                  className="vision-enrol-name"
                  placeholder="this is…"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submit(candidate.id);
                    if (e.key === "Escape") setNaming(null);
                  }}
                  data-testid="triage-name-input"
                />
                <button className="ghost" disabled={!name.trim()} onClick={() => submit(candidate.id)} data-testid="triage-save">
                  save
                </button>
              </span>
            ) : (
              <span className="triage-actions">
                <button
                  className="ghost"
                  onClick={() => {
                    setNaming(candidate.id);
                    setName("");
                  }}
                  data-testid="triage-name"
                >
                  name
                </button>
                <button
                  className="ghost"
                  onClick={() => send({ type: "dismiss-candidate", id: candidate.id })}
                  data-testid="triage-dismiss"
                >
                  dismiss
                </button>
              </span>
            )}
          </figure>
        ))}
      </div>
    </div>
  );
}

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
  // Recognition is subordinate to Vision, so the strip appears only when both
  // are on — showing it while Vision is off would advertise a camera that is
  // deliberately not open.
  const recognising = enabled && (state.settings?.vision.recognitionEnabled ?? false);
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

      {recognising ? <RecognitionStrip state={state} send={send} /> : null}
      {recognising ? <TriageQueue state={state} send={send} /> : null}

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
