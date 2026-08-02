import type { ClientMessage, PersonaIntensity, SessionSummary } from "../../../shared/src/types";
import { personaCopy } from "../persona";

interface Props {
  sessions: SessionSummary[];
  send: (msg: ClientMessage) => void;
  intensity: PersonaIntensity;
}

export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function SessionPicker({ sessions, send, intensity }: Props) {
  const byProject = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const list = byProject.get(s.projectName) ?? [];
    list.push(s);
    byProject.set(s.projectName, list);
  }

  return (
    <div className="session-picker" data-testid="session-picker">
      <div className="picker-header">
        <span>{personaCopy("no-session", intensity)}</span>
        <button className="ghost" onClick={() => send({ type: "list-sessions" })}>
          refresh
        </button>
      </div>
      {sessions.length === 0 && <p className="empty-state">{personaCopy("no-sessions-found", intensity)}</p>}
      {[...byProject.entries()].map(([project, list]) => (
        <div key={project} className="picker-project">
          <h3>{project}</h3>
          <ul>
            {list.map((s) => (
              <li key={s.id}>
                <button className="session-row" onClick={() => send({ type: "watch-session", sessionId: s.id })}>
                  <span className={`badge ${s.state}`}>{s.state}</span>
                  <span className="session-id">{s.id.slice(0, 8)}</span>
                  <span className="session-when">{timeAgo(s.lastActivity)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
