import { useState } from "react";
import type { ClientMessage, PersonaIntensity } from "../../../shared/src/types";
import type { AppState } from "../store";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
  onClose: () => void;
}

const INTENSITIES: PersonaIntensity[] = ["low", "medium", "high"];

export function SettingsPanel({ state, send, onClose }: Props) {
  const settings = state.settings;
  const [endpoint, setEndpoint] = useState(settings?.providerEndpoint ?? "http://localhost:11434");

  if (!settings) return null;

  const readinessRow = (label: string, ok: boolean, detail: string) => (
    <li className={ok ? "ok" : "fail"}>
      <span className="dot" /> {label}: {detail}
    </li>
  );

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} data-testid="settings-panel">
        <div className="drawer-header">
          <h2>settings</h2>
          <button className="ghost" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </div>

        <label className="field">
          provider endpoint
          <div className="endpoint-row">
            <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} spellCheck={false} />
            <button
              className="ghost"
              disabled={endpoint === settings.providerEndpoint}
              onClick={() => {
                send({ type: "update-settings", patch: { providerEndpoint: endpoint } });
                send({ type: "list-models" });
              }}
            >
              apply
            </button>
          </div>
          <small>changes apply to the next request; streams in flight are never cut</small>
        </label>

        <label className="field">
          default chat model
          <select
            value={settings.chatModel ?? ""}
            onChange={(e) => send({ type: "update-settings", patch: { chatModel: e.target.value || null } })}
          >
            <option value="">(none selected)</option>
            {state.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          narration model
          <select
            value={settings.narrationModel ?? ""}
            onChange={(e) => send({ type: "update-settings", patch: { narrationModel: e.target.value || null } })}
          >
            <option value="">(follow chat model)</option>
            {state.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="field">
          <legend>persona intensity</legend>
          <div className="segmented">
            {INTENSITIES.map((level) => (
              <button
                key={level}
                className={settings.personaIntensity === level ? "seg selected" : "seg"}
                onClick={() => send({ type: "update-settings", patch: { personaIntensity: level } })}
              >
                {level}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="field">
          <div className="readiness-header">
            <span>readiness</span>
            <button className="ghost" onClick={() => send({ type: "check-readiness" })}>
              re-check
            </button>
          </div>
          {state.readiness ? (
            <ul className="readiness-list">
              {readinessRow("ollama", state.readiness.ollama === "ok", state.readiness.ollama)}
              {readinessRow("models", state.readiness.models === "ok", state.readiness.models)}
              {readinessRow("claude code logs", state.readiness.claudeLogs === "ok", state.readiness.claudeLogs)}
            </ul>
          ) : (
            <p className="empty-state">no probe yet</p>
          )}
        </div>
      </aside>
    </div>
  );
}
