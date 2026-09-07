import { useState } from "react";
import type { ClientMessage, VoiceWeight } from "../../../shared/src/types";
import { MIX_MAX, SPEED_MAX, SPEED_MIN, idFromLabel, shares } from "../../../shared/src/voices";
import type { AppState } from "../store";
import { usePhonemes } from "./SpeechPane";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
  onClose: () => void;
}

const SAMPLE = "I am entirely operational, and all my circuits are functioning perfectly.";

/**
 * Where a voice is designed.
 *
 * The loop is adjust, hear, adjust, and everything here serves it. Audition
 * renders the mix **without saving it**, which is why the speak path accepts an
 * inline preset as well as a name — a Speak that could only name a stored voice
 * would force a save before every listen and fill the picker with drafts.
 *
 * Weights are the author's numbers and are normalised at use, so each row shows
 * its **effective share** beside the raw weight. Without it two voices at 1 and
 * 1 read as "1 and 1" while sounding 50/50, and adding a third silently moves
 * both to a third with no slider appearing to move — designing by ear depends on
 * knowing what you are actually hearing.
 *
 * The phoneme readout is here because the failure it guards against is silent:
 * grapheme-to-phoneme gets proper nouns wrong and the audio is clean while the
 * word is not. It updates with the sample text rather than on request, so it is
 * visible without being asked for.
 */
export function VoiceEditor({ state, send, onClose }: Props) {
  const [label, setLabel] = useState("");
  const [mix, setMix] = useState<VoiceWeight[]>([{ voice: "am_michael", weight: 1 }]);
  const [speed, setSpeed] = useState(1);
  const [sample, setSample] = useState(SAMPLE);

  usePhonemes(sample, send);
  const readout = state.phonemes?.text === sample ? state.phonemes.ipa : null;

  const stock = state.voices.stock;
  const effective = shares(mix) ?? [];
  const id = idFromLabel(label);
  const unusable =
    !state.voices.available ||
    id === undefined ||
    mix.length === 0 ||
    mix.every((entry) => entry.weight === 0);

  const setWeight = (index: number, weight: number) =>
    setMix((current) => current.map((entry, i) => (i === index ? { ...entry, weight } : entry)));

  const addVoice = () => {
    const unused = stock.find((name) => !mix.some((entry) => entry.voice === name));
    if (!unused || mix.length >= MIX_MAX) return;
    setMix((current) => [...current, { voice: unused, weight: 1 }]);
  };

  const preset = () => ({ id: id ?? "", label: label.trim(), mix, speed });

  return (
    <div className="voice-editor" data-testid="voice-editor">
      <header>
        <h4>Voices</h4>
        <button className="ghost" data-testid="close-voice-editor" onClick={onClose}>
          close
        </button>
      </header>

      {!state.voices.available && (
        <p className="muted" data-testid="voice-pack-missing">
          The voice pack has not been read, so a voice cannot be checked or saved yet.
        </p>
      )}

      <ul className="voice-mix" data-testid="voice-mix">
        {mix.map((entry, index) => (
          <li key={entry.voice}>
            <select
              data-testid={`mix-voice-${index}`}
              value={entry.voice}
              onChange={(event) =>
                setMix((current) =>
                  current.map((row, i) => (i === index ? { ...row, voice: event.target.value } : row)),
                )
              }
            >
              {stock.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={entry.weight}
              data-testid={`mix-weight-${index}`}
              onChange={(event) => setWeight(index, Number(event.target.value))}
            />
            <span className="voice-weight">{entry.weight.toFixed(2)}</span>
            {/* What this voice actually contributes. The raw weight above is the
                author's number and means nothing on its own. */}
            <span className="voice-share muted" data-testid={`mix-share-${index}`}>
              {Math.round((effective[index]?.share ?? 0) * 100)}%
            </span>
            <button
              className="ghost"
              data-testid={`mix-remove-${index}`}
              onClick={() => setMix((current) => current.filter((_, i) => i !== index))}
              disabled={mix.length <= 1}
            >
              remove
            </button>
          </li>
        ))}
      </ul>

      <button
        className="ghost"
        data-testid="mix-add"
        onClick={addVoice}
        disabled={mix.length >= MIX_MAX || stock.length <= mix.length}
      >
        add a voice
      </button>

      <label className="voice-speed">
        speed
        <input
          type="range"
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={0.01}
          value={speed}
          data-testid="voice-speed"
          onChange={(event) => setSpeed(Number(event.target.value))}
        />
        <span>{speed.toFixed(2)}</span>
      </label>

      <textarea
        className="voice-sample"
        data-testid="voice-sample"
        value={sample}
        onChange={(event) => setSample(event.target.value)}
        rows={2}
      />

      {/* The IPA the model will actually read. Present because a wrong
          pronunciation is otherwise silent: the audio is clean and the word is
          wrong, and nothing else on screen would say so. */}
      <p className="voice-phonemes" data-testid="voice-phonemes">
        {readout ?? "…"}
      </p>

      <div className="voice-actions">
        <button
          data-testid="voice-audition"
          onClick={() => send({ type: "speak", text: sample, voice: { preset: preset() } })}
          disabled={!state.voices.available || mix.every((entry) => entry.weight === 0)}
        >
          Audition
        </button>
        <input
          data-testid="voice-label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="name this voice"
        />
        <button
          data-testid="voice-save"
          onClick={() => send({ type: "save-voice-preset", preset: preset() })}
          disabled={unusable}
        >
          Save
        </button>
      </div>

      <ul className="voice-presets" data-testid="voice-presets">
        {state.voices.presets.map((saved) => (
          <li key={saved.id}>
            <span>{saved.label}</span>
            <button
              className="ghost"
              data-testid={`voice-delete-${saved.id}`}
              onClick={() => send({ type: "delete-voice-preset", id: saved.id })}
            >
              delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
