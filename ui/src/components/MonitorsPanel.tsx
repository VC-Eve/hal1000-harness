import { useEffect, useState } from "react";
import type { ClientMessage, MonitorSource, MonitorVerbosity } from "../../../shared/src/types";
import type { AppState } from "../store";
import { describeSource, draftFromSuggestion, isComplete, suggestionRow } from "../monitors";
import { ColorField } from "./ColorField";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
}

const VERBOSITIES: MonitorVerbosity[] = ["quiet", "full"];

const blankSource = (kind: MonitorSource["kind"]): MonitorSource =>
  kind === "file" ? { kind: "file", path: "" } : { kind: "command", command: "", intervalMs: 30_000 };

export function MonitorsPanel({ state, send }: Props) {
  const { monitors, monitorSuggestions } = state;
  const [kind, setKind] = useState<MonitorSource["kind"]>("file");
  const [label, setLabel] = useState("");
  const [draft, setDraft] = useState<MonitorSource>(blankSource("file"));

  // Suggestions are probed server-side per request, so they are asked for when
  // the section mounts rather than cached from an earlier session.
  useEffect(() => {
    send({ type: "list-monitor-suggestions" });
    send({ type: "list-monitors" });
  }, [send]);

  const switchKind = (next: MonitorSource["kind"]) => {
    setKind(next);
    setDraft(blankSource(next));
  };

  const add = () => {
    if (!isComplete(draft) || label.trim().length === 0) return;
    send({ type: "add-monitor", monitor: { label: label.trim(), source: draft, verbosity: "quiet" } });
    setLabel("");
    setDraft(blankSource(kind));
  };

  return (
    <fieldset className="field">
      <legend>monitors</legend>

      {monitors.length === 0 ? (
        <p className="empty-state">No monitors. I am watching nothing but the session.</p>
      ) : (
        monitors.map((m) => (
          <div className="monitor-row" key={m.id}>
            <div className="monitor-head">
              <span className="monitor-label">{m.label}</span>
              <div className="segmented">
                {VERBOSITIES.map((v) => (
                  <button
                    key={v}
                    className={m.verbosity === v ? "seg selected" : "seg"}
                    onClick={() => send({ type: "update-monitor", monitorId: m.id, patch: { verbosity: v } })}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
            {/* The full command, never elided: what HAL runs on a schedule must
                be visible wherever monitors are managed (R6). */}
            <code className="monitor-source">{describeSource(m.source)}</code>
            <ColorField
              label="entry colour"
              value={m.color}
              onChange={(color) => send({ type: "update-monitor", monitorId: m.id, patch: { color } })}
            />
            <div className="prompt-actions">
              <button
                className="ghost"
                onClick={() => send({ type: "update-monitor", monitorId: m.id, patch: { enabled: !m.enabled } })}
              >
                {m.enabled ? "disable" : "enable"}
              </button>
              <button className="ghost" onClick={() => send({ type: "remove-monitor", monitorId: m.id })}>
                remove
              </button>
            </div>
          </div>
        ))
      )}

      <label className="field">
        add a monitor
        <div className="segmented">
          <button className={kind === "file" ? "seg selected" : "seg"} onClick={() => switchKind("file")}>
            file
          </button>
          <button className={kind === "command" ? "seg selected" : "seg"} onClick={() => switchKind("command")}>
            command
          </button>
        </div>
        <input placeholder="label" value={label} onChange={(e) => setLabel(e.target.value)} spellCheck={false} />
        {draft.kind === "file" ? (
          <input
            placeholder="path to a log file"
            value={draft.path}
            onChange={(e) => setDraft({ kind: "file", path: e.target.value })}
            spellCheck={false}
          />
        ) : (
          <>
            <input
              placeholder="command to run"
              value={draft.command}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
              spellCheck={false}
            />
            <small>runs on this machine every {Math.round(draft.intervalMs / 1000)}s, never elevated</small>
          </>
        )}
        <button className="ghost" disabled={!isComplete(draft) || label.trim().length === 0} onClick={add}>
          add
        </button>
      </label>

      <div className="field">
        <span>suggested for this machine</span>
        {monitorSuggestions.length === 0 ? (
          <p className="empty-state">No suggestions yet.</p>
        ) : (
          monitorSuggestions.map(suggestionRow).map(({ suggestion, disabled, note }) => (
            <div className={disabled ? "suggestion unavailable" : "suggestion"} key={suggestion.id}>
              <div className="suggestion-head">
                <span>{suggestion.label}</span>
                <button
                  className="ghost"
                  disabled={disabled}
                  onClick={() => send({ type: "add-monitor", monitor: draftFromSuggestion(suggestion) })}
                >
                  add
                </button>
              </div>
              <small>{note}</small>
            </div>
          ))
        )}
      </div>
    </fieldset>
  );
}
