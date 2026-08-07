import { useEffect, useRef, useState } from "react";
import type { ClientMessage, PersonaIntensity } from "../../../shared/src/types";
import type { Action, AppState } from "../store";
import { personaCopy } from "../persona";
import { entryColor } from "../colors";
import { lensState } from "../lens";
import { NarrationLens } from "./NarrationLens";
import { SessionPicker } from "./SessionPicker";
import { CollapseButton } from "./SectionRail";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
  dispatch: (action: Action) => void;
  intensity: PersonaIntensity;
  onOpenSettings: () => void;
  collapseDisabled: boolean;
  onCollapse: () => void;
}

export function NarrationPane({ state, send, dispatch, intensity, onOpenSettings, collapseDisabled, onCollapse }: Props) {
  const { readiness, sessions, watchedSessionId, sessionState, narration, narrationStatus, newSession } = state;
  const feedRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const lastCount = useRef(0);
  const lens = lensState(narrationStatus);
  const lastLens = useRef(lens);

  // Auto-scroll only while pinned to the bottom; otherwise hold position and
  // count new entries (review decision: scroll-lock with jump control).
  //
  // The lens is a child of the scroll container, so showing or hiding it
  // changes scrollHeight without changing the entry count. On a full feed a
  // pinned reader would never see it — which is the whole feature — so lens
  // visibility is a second reason to re-pin. It is *only* that: it never
  // feeds the unseen counter, because the lens is not an observation and a
  // reader who scrolled up asked to hold position, not to be dragged to a
  // pulsing circle.
  useEffect(() => {
    const added = narration.length - lastCount.current;
    const lensChanged = lens !== lastLens.current;
    lastCount.current = narration.length;
    lastLens.current = lens;
    const el = feedRef.current;
    if (!el) return;
    if (atBottom) {
      if (added > 0 || lensChanged) el.scrollTop = el.scrollHeight;
    } else if (added > 0) {
      setUnseen((u) => u + added);
    }
  }, [narration.length, atBottom, lens]);

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

  // The log leg is three-valued: "disabled" is a deliberate choice and gets
  // HAL's own empty state, never the missing-logs fault or the session picker.
  const noAdapter = readiness?.claudeLogs === "disabled";
  const noClaude = readiness?.claudeLogs === "missing";

  // One feed, two roles. Rendered from here so it can appear alongside the
  // session picker when only Monitors are running.
  const feed = (
    <div className="feed" ref={feedRef} onScroll={onScroll} data-testid="narration-feed">
      {narration.length === 0 && <p className="empty-state">The session is under observation. I will describe what I see.</p>}
      {narration.map((e) => {
        const monitor = e.monitorId ? state.monitors.find((m) => m.id === e.monitorId) : undefined;
        // Several sessions are narrated into this one feed, so an entry from
        // the session the reader chose is set apart from the rest. Compared at
        // render time, not stamped: changing the selection must re-emphasise
        // the history too, or the highlight would describe a past choice.
        const selected = Boolean(e.sessionId) && e.sessionId === watchedSessionId;
        return (
          <div
            key={e.id}
            className={[
              "feed-entry",
              e.kind,
              e.monitorId ? "monitor" : "",
              e.fromVision ? "vision" : "",
              e.sessionId ? (selected ? "session-selected" : "session-other") : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ ["--entry-color" as string]: entryColor(e, state.settings, state.monitors) }}
          >
            <span className="feed-time">{e.at.slice(11, 19)}</span>
            {/* Several monitors can land on similar hues after normalisation,
                and a summary reads differently from session narration — the
                label is what makes the source unambiguous. Vision earns one for
                the same reason: it arrives in the same feed as the agent
                commentary and reads nothing like it. A session earns one
                because there are now several of them, all the same colour:
                without the label, whose work is being described is a guess. */}
            {monitor && <span className="feed-source">{monitor.label}</span>}
            {e.fromVision && <span className="feed-source">vision</span>}
            {e.sessionLabel && <span className="feed-source">{e.sessionLabel}</span>}
            <span className="feed-text">{e.text}</span>
          </div>
        );
      })}
      {/* Inside the scroll container and after the last entry, so the
          lens occupies the spot the next observation will take (R1). */}
      <NarrationLens state={lens} />
    </div>
  );

  // The condition banners. Rendered in both the selected and unselected
  // branches: HAL observes every live session whether or not one is selected,
  // so a paused narrator or an unreachable provider is just as true — and just
  // as worth saying — with nothing picked.
  const banners = (
    <>
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
    </>
  );

  return (
    <section className="pane narration-pane" data-testid="narration-pane">
      <div className="narration-header">
        <span className="pane-title">session observation</span>
        {watchedSessionId && sessionState && <span className={`badge ${sessionState}`}>{sessionState}</span>}
        {/* Following is automatic and plural, so the count is the only thing
            that says how much HAL is actually watching. Shown from two up: at
            one it would just restate the selection. */}
        {state.followedSessionIds.length > 1 && (
          <span className="badge following" data-testid="followed-count">
            following {state.followedSessionIds.length}
          </span>
        )}
        {narrationStatus !== "idle" && <span className={`badge status-${narrationStatus}`}>{narrationStatus}</span>}
        {watchedSessionId && (
          <button className="ghost" onClick={() => send({ type: "unwatch" })}>
            detach
          </button>
        )}
        <CollapseButton id="observation" disabled={collapseDisabled} onCollapse={onCollapse} />
      </div>

      {/* Every empty state below is about Sessions. Monitors run regardless
          (R18), so each one still shows the feed when a Monitor has spoken —
          otherwise the purest ambient setup, adapter off and monitors only,
          would render nothing at all. */}
      {noAdapter ? (
        <>
          <div className="empty-state" data-testid="no-adapter">
            <p>{personaCopy("no-adapter", intensity)}</p>
            <button className="ghost" onClick={onOpenSettings}>
              open settings
            </button>
          </div>
          {narration.length > 0 && feed}
        </>
      ) : noClaude ? (
        <>
          <div className="empty-state" data-testid="no-claude">
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
          {narration.length > 0 && feed}
        </>
      ) : !watchedSessionId ? (
        // Nothing selected, which is not the same as nothing observed: every
        // live session is followed, and Monitors run independently of any of
        // them (R18). The picker chooses what the feed centres on.
        <>
          <SessionPicker sessions={sessions} send={send} intensity={intensity} />
          {banners}
          {narration.length > 0 && feed}
        </>
      ) : (
        <>
          {newSession && (
            <div className="banner notice" data-testid="new-session-notice">
              {/* It is already being observed — following is automatic now —
                  so the offer is to centre the feed on it, not to start
                  listening. Saying "shall I follow it" would describe a
                  decision HAL has already made. */}
              <span>
                A new session has appeared in {newSession.projectName}. I am observing it. Shall I attend to it instead?
              </span>
              <button className="ghost" onClick={() => send({ type: "watch-session", sessionId: newSession.id })}>
                switch
              </button>
              <button className="ghost" onClick={() => dispatch({ type: "dismiss-new-session" })}>
                dismiss
              </button>
            </div>
          )}
          {banners}
          {sessionState && sessionState !== "live" && (
            <div className="banner subtle" data-testid="session-state-copy">
              {personaCopy(sessionState, intensity)}
            </div>
          )}
          {feed}
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
