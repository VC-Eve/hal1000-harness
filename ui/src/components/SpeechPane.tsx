import { useEffect, useRef, useState } from "react";
import type { ClientMessage, VoicePreset } from "../../../shared/src/types";
import type { AppState } from "../store";
import { VoiceEditor } from "./VoiceEditor";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
}

/**
 * The speech control: a line, a voice, and a button.
 *
 * The editor sits **behind a toggle** and is mounted only while open, mirroring
 * `playlists` in `LivePane`. The column it lives in already holds the Parameters
 * and Node panels and a conditional problems group, and `StateGraph` records
 * nine stacked sections as what made that column unreadable — a permanently
 * expanded editor would crowd out panels the operator needs mid-World-edit.
 *
 * Speaking is disabled for a reason that is always stated. Four different things
 * stop it and they call for four different responses: the model files are still
 * downloading (wait), they are missing (go and look), nothing is listening
 * (press the sound control), or nothing has been typed. A single greyed-out
 * button would leave the operator guessing which.
 */
export function SpeechPane({ state, send }: Props) {
  const [line, setLine] = useState("");
  const [editing, setEditing] = useState(false);
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const speaking = state.speech !== null;

  const presets = state.voices.presets;
  const chosen = presets.find((preset) => preset.id === voiceId) ?? presets[0] ?? null;

  const ready = state.readiness?.voice;
  const blockedReason =
    ready === "fetching"
      ? "The voice model is still downloading. This happens once, and it is about 350MB."
      : ready === "unavailable"
        ? "The voice model is not available. HAL fetches it on first use; check the log if this persists."
        : !chosen
          ? "There is no voice to speak in yet."
          : null;

  const speak = () => {
    if (!chosen || line.trim().length === 0) return;
    send({ type: "speak", text: line, voice: { id: chosen.id } });
  };

  return (
    <section className="speech-pane" data-testid="speech-pane">
      <header>
        <h3>Speech</h3>
        <button
          className="ghost speech-edit-toggle"
          data-testid="open-voice-editor"
          onClick={() => setEditing((open) => !open)}
        >
          {editing ? "close voices" : "voices"}
        </button>
      </header>

      <textarea
        className="speech-line"
        data-testid="speech-line"
        value={line}
        onChange={(event) => setLine(event.target.value)}
        placeholder="What should the character say?"
        rows={3}
      />

      <div className="speech-controls">
        <label>
          voice
          <select
            data-testid="speech-voice"
            value={chosen?.id ?? ""}
            onChange={(event) => setVoiceId(event.target.value)}
            disabled={presets.length === 0}
          >
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="speech-speak"
          data-testid="speak"
          onClick={speak}
          disabled={blockedReason !== null || line.trim().length === 0 || speaking}
        >
          {/* An in-flight state, because a synthesis costs roughly the length of
              the line — several seconds for a paragraph. Without it the control
              looks dead for the whole render and there is no way to tell a slow
              synthesis from a stuck one. */}
          {speaking ? "speaking…" : "Speak"}
        </button>
        {speaking && (
          <button className="ghost" data-testid="stop-speaking" onClick={() => send({ type: "stop-speaking" })}>
            stop
          </button>
        )}
      </div>

      {blockedReason && (
        <p className="speech-blocked-reason muted" data-testid="speech-blocked-reason">
          {blockedReason}
        </p>
      )}

      {editing && (
        <VoiceEditor state={state} send={send} onClose={() => setEditing(false)} />
      )}
    </section>
  );
}

/** What the picker calls a preset that has never been named. */
export function presetLabel(preset: VoicePreset): string {
  return preset.label.trim().length > 0 ? preset.label : preset.id;
}

/**
 * Ask the server what a line will be read as, once per change rather than once
 * per render.
 *
 * A component must survive an unstable `send` — depending on it in an effect
 * once produced an unbounded request loop, which is the defect the component
 * harness exists to catch. So the effect depends on the text and the latest
 * `send` is read from a ref.
 */
export function usePhonemes(text: string, send: (msg: ClientMessage) => void): void {
  const latest = useRef(send);
  latest.current = send;
  useEffect(() => {
    if (text.trim().length === 0) return;
    const timer = setTimeout(() => latest.current({ type: "phonemes-for", text }), 250);
    return () => clearTimeout(timer);
  }, [text]);
}
