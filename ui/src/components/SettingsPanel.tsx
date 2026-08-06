import { useState } from "react";
import type { ChatColors, ClientMessage, PersonaIntensity } from "../../../shared/src/types";
import { adapterRows, type AppState } from "../store";
import { DEFAULT_CHAT_COLOR } from "../palette";
import { isHandEdited } from "../prompts";
import {
  DEFAULT_CHAT_PROMPT,
  DEFAULT_NARRATION_PROMPT,
  NARRATION_PRESETS,
  resolvePrompt,
} from "../../../shared/src/prompts";
import { ColorField } from "./ColorField";
import { ModelOptions } from "./ModelOptions";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
  onClose: () => void;
}

const INTENSITIES: PersonaIntensity[] = ["low", "medium", "high"];

const CHAT_ROLES: (keyof ChatColors)[] = ["user", "assistant"];

// Text the user did not write: the shipped default and every preset.
const KNOWN_NARRATION_TEXTS = [DEFAULT_NARRATION_PROMPT, ...NARRATION_PRESETS.map((p) => p.text)];

// A readiness leg is three-valued now: "disabled" means nobody wants that
// prerequisite, which is a choice rather than a fault and must not be red.
const tone = (value: string) => (value === "ok" ? "ok" : value === "disabled" ? "neutral" : "fail");

export function SettingsPanel({ state, send, onClose }: Props) {
  const settings = state.settings;
  const [endpoint, setEndpoint] = useState(settings?.providerEndpoint ?? "http://localhost:11434");
  // Prompts are drafted locally and applied on click, like the endpoint field.
  // Patching per keystroke would broadcast the whole settings object to every
  // open tab for every character of a multi-paragraph prompt.
  const storedNarration = resolvePrompt(settings?.narrationPrompt, DEFAULT_NARRATION_PROMPT);
  const storedChatDefault = resolvePrompt(settings?.chatDefaultPrompt, DEFAULT_CHAT_PROMPT);
  const [narration, setNarration] = useState(storedNarration);
  const [chatDefault, setChatDefault] = useState(storedChatDefault);

  const applyNarration = (text: string) => send({ type: "update-settings", patch: { narrationPrompt: text } });

  const seedNarration = (text: string) => {
    // Only warn when there is real work to lose — cycling between presets is
    // not editing, so it must not nag.
    if (isHandEdited(settings?.narrationPrompt, KNOWN_NARRATION_TEXTS) && !confirm("Replace your edited narration prompt with this preset?")) {
      return;
    }
    setNarration(text);
    applyNarration(text);
  };

  const resetNarration = () => {
    setNarration(DEFAULT_NARRATION_PROMPT);
    send({ type: "update-settings", patch: { narrationPrompt: null } });
  };

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
          <legend>system prompts</legend>

          <label className="field">
            narration
            <textarea
              className="prompt-input"
              rows={8}
              value={narration}
              onChange={(e) => setNarration(e.target.value)}
              spellCheck={false}
            />
            <div className="prompt-actions">
              <div className="segmented">
                {NARRATION_PRESETS.map((preset) => (
                  <button key={preset.id} className="seg" onClick={() => seedNarration(preset.text)}>
                    {preset.label}
                  </button>
                ))}
              </div>
              <button className="ghost" disabled={narration === storedNarration} onClick={() => applyNarration(narration)}>
                apply
              </button>
              <button className="ghost" disabled={settings.narrationPrompt === null} onClick={resetNarration}>
                reset
              </button>
            </div>
            <small>the whole prompt, guardrails included; applies to the next narration</small>
          </label>

          <label className="field">
            chat default
            <textarea
              className="prompt-input"
              rows={5}
              value={chatDefault}
              onChange={(e) => setChatDefault(e.target.value)}
              spellCheck={false}
            />
            <div className="prompt-actions">
              <button
                className="ghost"
                disabled={chatDefault === storedChatDefault}
                onClick={() => send({ type: "update-settings", patch: { chatDefaultPrompt: chatDefault } })}
              >
                apply
              </button>
              <button
                className="ghost"
                disabled={settings.chatDefaultPrompt === null}
                onClick={() => {
                  setChatDefault(DEFAULT_CHAT_PROMPT);
                  send({ type: "update-settings", patch: { chatDefaultPrompt: null } });
                }}
              >
                reset
              </button>
            </div>
            <small>copied into each new conversation; existing ones keep the prompt they were made with</small>
          </label>
        </fieldset>

        <fieldset className="field">
          <legend>interface copy tone</legend>
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
          <small>HAL's tone in the app's own messages; narration is governed by its prompt above</small>
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
