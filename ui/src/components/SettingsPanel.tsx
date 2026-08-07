import { useState, type ReactNode } from "react";
import type { ChatColors, ClientMessage, PersonaIntensity } from "../../../shared/src/types";
import { adapterRows, type AppState } from "../store";
import { DEFAULT_CHAT_COLOR } from "../palette";
import { isHandEdited } from "../prompts";
import {
  DEFAULT_CHAT_PROMPT,
  DEFAULT_MONITOR_PROMPT,
  DEFAULT_NARRATION_PROMPT,
  KNOWN_NARRATION_TEXTS,
  NARRATION_PRESETS,
  resolvePrompt,
} from "../../../shared/src/prompts";
import { MonitorsPanel } from "./MonitorsPanel";
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

interface PromptFieldProps {
  label: string;
  value: string;
  stored: string;
  isDefault: boolean;
  note: string;
  onChange: (value: string) => void;
  onApply: () => void;
  onReset: () => void;
  // Presets, for the one prompt that has them.
  extraActions?: ReactNode;
}

// One prompt editor. Extracted because there are three of them and they now sit
// in three different sections — each beside the tool it configures rather than
// stacked in a prompts box, which is what made the tools look like one thing.
function PromptField({ label, value, stored, isDefault, note, onChange, onApply, onReset, extraActions }: PromptFieldProps) {
  return (
    <label className="field">
      {label}
      <textarea
        className="prompt-input"
        rows={6}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      <div className="prompt-actions">
        {extraActions}
        <button className="ghost" disabled={value === stored} onClick={onApply}>
          apply
        </button>
        <button className="ghost" disabled={isDefault} onClick={onReset}>
          reset
        </button>
      </div>
      <small>{note}</small>
    </label>
  );
}

export function SettingsPanel({ state, send, onClose }: Props) {
  const settings = state.settings;
  const [endpoint, setEndpoint] = useState(settings?.providerEndpoint ?? "http://localhost:11434");
  // Prompts are drafted locally and applied on click, like the endpoint field.
  // Patching per keystroke would broadcast the whole settings object to every
  // open tab for every character of a multi-paragraph prompt.
  const storedNarration = resolvePrompt(settings?.narrationPrompt, DEFAULT_NARRATION_PROMPT);
  const storedChatDefault = resolvePrompt(settings?.chatDefaultPrompt, DEFAULT_CHAT_PROMPT);
  const storedMonitorPrompt = resolvePrompt(settings?.monitorPrompt, DEFAULT_MONITOR_PROMPT);
  const [narration, setNarration] = useState(storedNarration);
  const [chatDefault, setChatDefault] = useState(storedChatDefault);
  const [monitorPrompt, setMonitorPrompt] = useState(storedMonitorPrompt);

  const applyNarration = (text: string) => send({ type: "update-settings", patch: { narrationPrompt: text } });

  const seedNarration = (text: string) => {
    // Warn when there is real work to lose. Unapplied text in the textarea
    // counts: checking only the stored value would discard whatever the user
    // typed but had not pressed apply on. Cycling presets still never nags,
    // because seeding sets the draft and the stored value together.
    const unappliedDraft = narration !== storedNarration;
    const atRisk = unappliedDraft || isHandEdited(settings?.narrationPrompt, KNOWN_NARRATION_TEXTS);
    if (atRisk && !confirm("Replace the narration prompt with this preset? Unsaved changes will be lost.")) {
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

        <section className="settings-group">
          <h3>model provider</h3>

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
            <small>shared by session observation and log monitors; one model runs at a time</small>
          </label>
        </section>

        {/* Two observation tools, deliberately apart. They share the feed and
            the model and nothing else — neither can start, stop, or break the
            other, and the drawer should not imply otherwise. */}
        <section className="settings-group" data-testid="group-sessions">
          <h3>session observation</h3>
          <p className="group-note">
            Watches one coding session at a time, discovered from a coding agent's own logs. Runs
            independently of log monitors below.
          </p>

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

          <PromptField
            label="narration prompt"
            value={narration}
            stored={storedNarration}
            isDefault={settings.narrationPrompt === null}
            note="the whole prompt, guardrails included; applies to the next narration"
            onChange={setNarration}
            onApply={() => applyNarration(narration)}
            onReset={resetNarration}
            extraActions={
              <div className="segmented">
                {NARRATION_PRESETS.map((preset) => (
                  <button key={preset.id} className="seg" onClick={() => seedNarration(preset.text)}>
                    {preset.label}
                  </button>
                ))}
              </div>
            }
          />
        </section>

        <section className="settings-group" data-testid="group-monitors">
          <h3>log monitors</h3>
          <p className="group-note">
            Watches log files and commands you point it at. Nothing to do with coding sessions — these keep
            running whether or not a session is attached.
          </p>

          <MonitorsPanel state={state} send={send} />

          <PromptField
            label="monitor prompt"
            value={monitorPrompt}
            stored={storedMonitorPrompt}
            isDefault={settings.monitorPrompt === null}
            note="describes no log tags, because a machine log has none"
            onChange={setMonitorPrompt}
            onApply={() => send({ type: "update-settings", patch: { monitorPrompt } })}
            onReset={() => {
              setMonitorPrompt(DEFAULT_MONITOR_PROMPT);
              send({ type: "update-settings", patch: { monitorPrompt: null } });
            }}
          />
        </section>

        <section className="settings-group">
          <h3>chat</h3>

          <PromptField
            label="default conversation prompt"
            value={chatDefault}
            stored={storedChatDefault}
            isDefault={settings.chatDefaultPrompt === null}
            note="copied into each new conversation; existing ones keep the prompt they were made with"
            onChange={setChatDefault}
            onApply={() => send({ type: "update-settings", patch: { chatDefaultPrompt: chatDefault } })}
            onReset={() => {
              setChatDefault(DEFAULT_CHAT_PROMPT);
              send({ type: "update-settings", patch: { chatDefaultPrompt: null } });
            }}
          />

          <fieldset className="field">
            <legend>message colours</legend>
            {CHAT_ROLES.map((role) => (
              <ColorField
                key={role}
                label={role}
                value={settings.chatColors?.[role] ?? DEFAULT_CHAT_COLOR}
                onChange={(color) => send({ type: "update-settings", patch: { chatColors: { [role]: color } } })}
              />
            ))}
          </fieldset>
        </section>

        <section className="settings-group">
          <h3>interface</h3>

          <fieldset className="field">
            <legend>copy tone</legend>
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
            <small>HAL's tone in the app's own messages; narration and monitors use their own prompts</small>
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
        </section>
      </aside>
    </div>
  );
}
