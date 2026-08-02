import { useEffect, useRef, useState } from "react";
import type { ClientMessage, PersonaIntensity } from "../../../shared/src/types";
import type { Action, AppState } from "../store";
import { personaCopy } from "../persona";
import { SessionPicker } from "./SessionPicker";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
  dispatch: (action: Action) => void;
  intensity: PersonaIntensity;
  onOpenSettings: () => void;
}

export function NarrationPane({ state, send, dispatch, intensity, onOpenSettings }: Props) {
  const { readiness, sessions, watchedSessionId, sessionState, narration, narrationStatus, newSession } = state;
  const feedRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const lastCount = useRef(0);

  // Auto-scroll only while pinned to the bottom; otherwise hold position and
  // count new entries (review decision: scroll-lock with jump control).
  useEffect(() => {
    const added = narration.length - lastCount.current;
    lastCount.current = narration.length;
    const el = feedRef.current;
    if (!el || added <= 0) return;
    if (atBottom) {
      el.scrollTop = el.scrollHeight;
    } else {
      setUnseen((u) => u + added);
    }
  }, [narration.length, atBottom]);

  const onScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAtBottom(pinned);
    if (pinned) setUnseen(0);
  };

  const jump = () => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setUnseen(0);
    setAtBottom(true);
  };

  const noClaude = readiness?.claudeLogs === "missing";

  return (
    <section className="pane narration-pane" data-testid="narration-pane">
      <div className="narration-header">
        <span className="pane-title">session observation</span>
        {watchedSessionId && sessionState && <span className={`badge ${sessionState}`}>{sessionState}</span>}
        {narrationStatus !== "idle" && <span className={`badge status-${narrationStatus}`}>{narrationStatus}</span>}
        {watchedSessionId && (
          <button className="ghost" onClick={() => send({ type: "unwatch" })}>
            detach
          </button>
        )}
      </div>

      {noClaude ? (
        <div className="empty-state tall" data-testid="no-claude">
          <p>{personaCopy("no-claude", intensity)}</p>
          <button
            className="ghost"
            onClick={() => {
              send({ type: "check-readiness" });
              send({ type: "list-sessions" });
            }}
          >
            re-check
          </button>
        </div>
      ) : !watchedSessionId ? (
        <SessionPicker sessions={sessions} send={send} intensity={intensity} />
      ) : (
        <>
          {newSession && (
            <div className="banner notice" data-testid="new-session-notice">
              <span>
                A new session has appeared in {newSession.projectName}. Shall I follow it instead?
              </span>
              <button className="ghost" onClick={() => send({ type: "watch-session", sessionId: newSession.id })}>
                switch
              </button>
              <button className="ghost" onClick={() => dispatch({ type: "dismiss-new-session" })}>
                dismiss
              </button>
            </div>
          )}
          {narrationStatus === "paused-missing-model" && (
            <div className="banner warn">
              <span>{personaCopy("paused-missing-model", intensity)}</span>
              <button className="ghost" onClick={onOpenSettings}>
                open settings
              </button>
            </div>
          )}
          {narrationStatus === "catching-up" && <div className="banner notice">{personaCopy("catching-up", intensity)}</div>}
          {narrationStatus === "provider-unavailable" && <div className="banner error">{personaCopy("provider_unavailable", intensity)}</div>}
          {sessionState && sessionState !== "live" && (
            <div className="banner subtle" data-testid="session-state-copy">
              {personaCopy(sessionState, intensity)}
            </div>
          )}
          <div className="feed" ref={feedRef} onScroll={onScroll} data-testid="narration-feed">
            {narration.length === 0 && <p className="empty-state">The session is under observation. I will describe what I see.</p>}
            {narration.map((e) => (
              <div key={e.id} className={`feed-entry ${e.kind}`}>
                <span className="feed-time">{e.at.slice(11, 19)}</span>
                <span className="feed-text">{e.text}</span>
              </div>
            ))}
          </div>
          {unseen > 0 && (
            <button className="jump-latest" onClick={jump}>
              ▾ {unseen} new observation{unseen === 1 ? "" : "s"}
            </button>
          )}
        </>
      )}
    </section>
  );
}
