import { useState } from "react";
import type { ChatColors, ClientMessage, PersonaIntensity } from "../../../shared/src/types";
import { adapterRows, type AppState } from "../store";
import { DEFAULT_CHAT_COLOR } from "../palette";
import { ColorField } from "./ColorField";
import { ModelOptions } from "./ModelOptions";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
  onClose: () => void;
}

const INTENSITIES: PersonaIntensity[] = ["low", "medium", "high"];

const CHAT_ROLES: (keyof ChatColors)[] = ["user", "assistant"];

// A readiness leg is three-valued now: "disabled" means nobody wants that
// prerequisite, which is a choice rather than a fault and must not be red.
const tone = (value: string) => (value === "ok" ? "ok" : value === "disabled" ? "neutral" : "fail");

export function SettingsPanel({ state, send, onClose }: Props) {
  const settings = state.settings;
  const [endpoint, setEndpoint] = useState(settings?.providerEndpoint ?? "http://localhost:11434");

  if (!settings) return null;

  const readinessRow = (label: string, value: string) => (
    <li className={tone(value)}>
      <span className="dot" /> {label}: {value}
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
            <ModelOptions models={state.models} />
          </select>
        </label>

        <label className="field">
          narration model
          <select
            value={settings.narrationModel ?? ""}
            onChange={(e) => send({ type: "update-settings", patch: { narrationModel: e.target.value || null } })}
          >
            <option value="">(follow chat model)</option>
            <ModelOptions models={state.models} />
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

        <fieldset className="field">
          <legend>adapters</legend>
          {state.adapters.length === 0 ? (
            <p className="empty-state">no adapters registered</p>
          ) : (
            adapterRows(state).map((adapter) => (
              <div className="adapter-row" key={adapter.id}>
                <div className="adapter-head">
                  <span className="adapter-label">{adapter.label}</span>
                  <div className="segmented">
                    {/* Lifecycle rides its own message: starting and stopping
                        watchers is the registry's, not a settings write. */}
                    <button
                      className={adapter.enabled ? "seg selected" : "seg"}
                      onClick={() => send({ type: "set-adapter-enabled", adapterId: adapter.id, enabled: true })}
                    >
                      on
                    </button>
                    <button
                      className={adapter.enabled ? "seg" : "seg selected"}
                      onClick={() => send({ type: "set-adapter-enabled", adapterId: adapter.id, enabled: false })}
                    >
                      off
                    </button>
                  </div>
                </div>
                <ColorField
                  label="observation colour"
                  value={adapter.color}
                  onChange={(color) =>
                    send({ type: "update-settings", patch: { adapters: { [adapter.id]: { color } } } })
                  }
                />
              </div>
            ))
          )}
        </fieldset>

        <fieldset className="field">
          <legend>chat colours</legend>
          {CHAT_ROLES.map((role) => (
            <ColorField
              key={role}
              label={role}
              value={settings.chatColors?.[role] ?? DEFAULT_CHAT_COLOR}
              onChange={(color) => send({ type: "update-settings", patch: { chatColors: { [role]: color } } })}
            />
          ))}
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
              {readinessRow("ollama", state.readiness.ollama)}
              {readinessRow("models", state.readiness.models)}
              {readinessRow("claude code logs", state.readiness.claudeLogs)}
            </ul>
          ) : (
            <p className="empty-state">no probe yet</p>
          )}
        </div>
      </aside>
    </div>
  );
}
