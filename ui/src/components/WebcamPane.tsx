import { useEffect, useMemo, useRef, useState } from "react";
import type { ClientMessage, VisionState } from "../../../shared/src/types";
import { identityBand } from "../../../shared/src/prompts";
import type { AppState } from "../store";
import { faceLabel, spanLabel, timelineRows, type TimelineRow } from "../vision-rows";
import { CollapseButton } from "./SectionRail";
import { FaceZoom } from "./FaceZoom";
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
  // Read from settings rather than hardcoded: both thresholds are user
  // settings, and a pane using its own numbers would draw a band the server
  // does not agree with.
  const recognition = state.settings?.vision.confidenceThreshold ?? 0.5;
  const statement = state.settings?.vision.statementThreshold ?? 0.6;
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
      {named.map((a) => {
        // The band comes from the same helper the server uses to build the line
        // it hands the summariser. This used to be the shipped hedge written
        // out again as literal JSX, which meant the pane and the model could
        // disagree about what HAL believes — and the copy that lagged would be
        // the one telling the user something untrue.
        const band = identityBand(a.match!.confidence, recognition, statement);
        const percent = `${Math.round(a.match!.confidence * 100)}%`;
        return (
          <span
            key={a.id}
            className={`vision-identity vision-band-${band}`}
            data-testid="vision-identity"
            data-band={band}
          >
            {band === "hedged" ? "someone who looks like " : null}
            <strong>{a.match!.name}</strong>
            {/* The confidence is what makes a wrong match reviewable rather
                than invisible (R24), so it shows in both bands. */}
            <span className="vision-confidence"> {percent}</span>
          </span>
        );
      })}

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
// One face already held for the person a candidate might be, so the reviewer
// compares pictures rather than agreeing with a name.
function suspectedFace(state: AppState, candidate: { suspected?: { personId: string } }): string | undefined {
  if (!candidate.suspected) return undefined;
  return state.visionPeople.find((p) => p.id === candidate.suspected!.personId)?.thumbnail;
}

function TriageQueue({ state, send }: { state: AppState; send: (msg: ClientMessage) => void }) {
  const [naming, setNaming] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState<{ src: string; sourceWidth?: number; caption: string } | null>(null);
  const [name, setName] = useState("");
  const { visionCandidates: queue, visionCandidateOverflow: overflow } = state;

  // Whoever the typed name would land on. The server matches case-insensitively
  // on a trimmed name, and this mirrors that exactly — a hint that disagreed
  // with what actually happens would be worse than no hint.
  const existing = state.visionPeople.find(
    (p) => p.name.trim().toLowerCase() === name.trim().toLowerCase() && name.trim() !== "",
  );

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
        //
        // Dismissible, because this is a tally of what already happened rather
        // than a description of the queue as it stands — clearing the queue does
        // not clear it, so without a way to acknowledge it, it sits there
        // forever and stops being read. Acknowledging resets the count on the
        // server; dropping more faces starts a fresh one.
        <p className="vision-triage-overflow" data-testid="triage-overflow">
          <span>
            {overflow.dropped} {overflow.dropped === 1 ? "face" : "faces"} dropped before you looked at{" "}
            {overflow.dropped === 1 ? "it" : "them"}. Raise the limit in settings to keep more.
          </span>
          <button
            className="triage-overflow-dismiss"
            title="I have read this"
            aria-label="dismiss"
            data-testid="triage-overflow-dismiss"
            onClick={() => send({ type: "acknowledge-overflow" })}
          >
            ×
          </button>
        </p>
      ) : null}

      {/* Native autocomplete over the roster, so naming someone already known
          is a pick rather than a retype. A typo used to cost a duplicate
          person, silently. */}
      <datalist id="vision-known-people">
        {state.visionPeople.map((p) => (
          <option key={p.id} value={p.name} />
        ))}
      </datalist>

      <div className="vision-triage-row">
        {queue.map((candidate) => (
          <figure className="triage-face" key={candidate.id} data-testid="triage-face">
            {/* A suspected face is shown NEXT TO the person it might be, not
                described as them. Confirming an uncertain match adds a face to
                that person, so a wrong confirmation makes future false
                positives more likely — the one thing the reviewer needs is the
                two pictures side by side, not a name to agree with. */}
            <span className="triage-compare">
              {/* Clickable, because deciding whether a capture is worth keeping
                  is a judgment about image quality and a 64px tile cannot carry
                  it. The recorded width sits under the tile so a queue can be
                  scanned without opening every face. */}
              <button
                className="person-face-button"
                title="see this capture at full size"
                data-testid="zoom-candidate"
                onClick={() =>
                  setZoomed({
                    src: candidate.thumbnail,
                    sourceWidth: candidate.sourceWidth,
                    caption: candidate.suspected ? `might be ${candidate.suspected.name}` : "waiting to be named",
                  })
                }
              >
                <img src={candidate.thumbnail} alt="a face waiting to be named" />
              </button>
              {suspectedFace(state, candidate) ? (
                <img
                  className="triage-known"
                  src={suspectedFace(state, candidate)}
                  alt={`a face already held for ${candidate.suspected?.name}`}
                  data-testid="triage-known-face"
                />
              ) : null}
            </span>
            <figcaption title={new Date(candidate.at).toLocaleString()}>
              {new Date(candidate.at).toLocaleTimeString()}
              {candidate.sourceWidth !== undefined ? (
                <span
                  className={candidate.sourceWidth < 112 ? "triage-width thin" : "triage-width"}
                  data-testid="triage-width"
                  title={
                    candidate.sourceWidth < 112
                      ? "smaller than the embedder's 112px, so this capture was upscaled"
                      : "how wide the face was in the frame"
                  }
                >
                  {" "}
                  {candidate.sourceWidth}px
                </span>
              ) : null}
            </figcaption>

            {candidate.suspected ? (
              <small className="triage-suspected" data-testid="triage-suspected">
                might be {candidate.suspected.name} ({Math.round(candidate.suspected.confidence * 100)}%)
              </small>
            ) : null}

            {naming === candidate.id ? (
              <span className="triage-actions triage-naming">
                <input
                  autoFocus
                  list="vision-known-people"
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
                {/* Say which way this will go before it happens. Retyping a
                    name and hoping is how one person becomes several records,
                    and the difference is invisible until the roster is a mess. */}
                {existing ? (
                  <small className="triage-hint" data-testid="triage-merge-hint">
                    adds a face to {existing.name} ({existing.faceCount})
                  </small>
                ) : name.trim() ? (
                  <small className="triage-hint" data-testid="triage-new-hint">
                    creates someone new
                  </small>
                ) : null}
              </span>
            ) : (
              <span className="triage-actions">
                {candidate.suspected ? (
                  <button
                    className="ghost"
                    onClick={() =>
                      send({ type: "confirm-candidate", id: candidate.id, personId: candidate.suspected!.personId })
                    }
                    data-testid="triage-confirm"
                  >
                    yes, {candidate.suspected.name}
                  </button>
                ) : null}
                <button
                  className="ghost"
                  onClick={() => {
                    setNaming(candidate.id);
                    setName("");
                  }}
                  data-testid="triage-name"
                >
                  {/* "someone else" rather than "name" when a person was
                      suspected: rejecting the suspicion is not dismissing the
                      face, it is naming it as somebody different. */}
                  {candidate.suspected ? "someone else" : "name"}
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
      {zoomed ? (
        <FaceZoom
          src={zoomed.src}
          sourceWidth={zoomed.sourceWidth}
          caption={zoomed.caption}
          onClose={() => setZoomed(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * One line of the timeline.
 *
 * Checks and captions have to be told apart at a glance — that is the whole
 * point of recording them separately. A check says who was there and how
 * certain HAL was; a caption says what the frame looked like and knows nothing
 * about identity.
 */
function TimelineRowLine({ row }: { row: TimelineRow }) {
  const time = new Date(row.at).toLocaleTimeString();

  if (row.kind === "caption") {
    return (
      <p className="vision-observation vision-row-caption" data-testid="timeline-caption">
        <span className="vision-time">{time}</span>
        <span className="vision-row-kind">saw</span>
        {row.caption}
      </p>
    );
  }

  if (row.kind === "absence") {
    const span = spanLabel(row.at, row.until);
    return (
      <p className="vision-observation vision-row-absence" data-testid="timeline-absence">
        <span className="vision-time">{time}</span>
        <span className="vision-row-kind">nobody</span>
        {row.count === 1 ? "1 check" : `${row.count} checks`}
        {span ? ` ${span}` : ""}
      </p>
    );
  }

  return (
    <p className="vision-observation vision-row-check" data-testid="timeline-check">
      <span className="vision-time">{time}</span>
      <span className="vision-row-kind">found</span>
      {row.faces.map((face, i) => (
        <span className={`vision-row-face band-${face.band ?? "unrecognised"}`} key={`${face.personId ?? "?"}-${i}`}>
          {faceLabel(face)}
          {/* Weight is telemetry: it decides nothing, and is shown so the
              record can be judged before anything is promoted to read it. */}
          {typeof face.weight === "number" ? (
            <span className="vision-row-weight" title="recognition weight — recorded, not acted on">
              w {face.weight.toFixed(2)}
            </span>
          ) : null}
        </span>
      ))}
    </p>
  );
}

/**
 * The third section: what HAL currently sees.
 *
 * It shows the timeline rather than the feed entries it produces. The feed
 * carries what HAL chose to say about a cycle; this carries what it was told
 * and when — every recognition check as well as every caption — which is the
 * only way to tell an over-eager sensitivity from a captioner that is
 * describing the wrong thing, or a face recognised at 10:04 from a frame
 * described at 10:05.
 */
export function WebcamPane({ state, send, collapseDisabled, onCollapse }: Props) {
  const enabled = state.settings?.vision.enabled ?? false;
  // Recognition is subordinate to Vision, so the strip appears only when both
  // are on — showing it while Vision is off would advertise a camera that is
  // deliberately not open.
  const recognising = enabled && (state.settings?.vision.recognitionEnabled ?? false);
  const fault = IS_FAULT[state.visionState];
  const listRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => timelineRows(state.visionTimeline), [state.visionTimeline]);
  // The window is full, so the oldest entries are off the top of the list. Said
  // only when it is true — a claim about a bound nobody has reached yet is
  // noise on an empty pane.
  const full = state.visionTimeline.length >= state.visionTimelineWindow;

  useEffect(() => {
    // Newest entry is the interesting one, same as the feed. Assigning
    // scrollTop rather than calling scrollTo is the idiom the other panes use.
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.visionTimeline.length]);

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
          {rows.length === 0 ? (
            <p className="empty-state webcam-placeholder">
              {enabled ? "No eyes yet. I will tell you what I see." : "No eyes yet. Start me when you are ready."}
            </p>
          ) : (
            <>
              {/* Stated rather than silently truncating. The record itself keeps
                  everything — this bound is about what a pane can be read. */}
              {full ? (
                <p className="vision-bound" data-testid="vision-timeline-bound">
                  the last {state.visionTimelineWindow} entries. the record keeps them all.
                </p>
              ) : null}
              {rows.map((row, i) => (
                <TimelineRowLine key={`${row.kind}-${row.at}-${i}`} row={row} />
              ))}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
