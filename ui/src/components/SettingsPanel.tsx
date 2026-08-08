import { useState, type ReactNode } from "react";
import {
  VISION_SENSITIVITIES,
  MIN_BAND_SEPARATION,
  type ChatColors,
  type ClientMessage,
  type PersonaIntensity,
  type VisionSensitivity,
  type VisionSettings,
} from "../../../shared/src/types";
import { adapterRows, type AppState } from "../store";
import { DEFAULT_CHAT_COLOR, DEFAULT_VISION_COLOR } from "../palette";
import { isHandEdited } from "../prompts";
import {
  DEFAULT_CHAT_PROMPT,
  DEFAULT_MONITOR_PROMPT,
  DEFAULT_NARRATION_PROMPT,
  DEFAULT_VISION_CAPTION_PROMPT,
  DEFAULT_VISION_PROMPT,
  KNOWN_NARRATION_TEXTS,
  NARRATION_PRESETS,
  resolvePrompt,
} from "../../../shared/src/prompts";
import { MonitorsPanel } from "./MonitorsPanel";
import { CaptionerSetup } from "./CaptionerSetup";
import { ImageError, fileToJpegBase64 } from "../face-image";
import { ColorField } from "./ColorField";
import { ModelOptions } from "./ModelOptions";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
  onClose: () => void;
}

const INTENSITIES: PersonaIntensity[] = ["low", "medium", "high"];

// The panel shows one category at a time. Clusters are the grouping the reader
// already had implicitly from reading order — named here so it survives the
// move off a single column, where adjacency was doing that work for free.
type CategoryId = "provider" | "sessions" | "monitors" | "vision" | "chat" | "interface" | "readiness";

const CATEGORIES: { cluster: string; items: { id: CategoryId; label: string }[] }[] = [
  { cluster: "model", items: [{ id: "provider", label: "provider" }] },
  {
    // The three observation roles, together because they are siblings and
    // apart because none of them starts, stops, or interferes with another.
    cluster: "observation",
    items: [
      { id: "sessions", label: "sessions" },
      { id: "monitors", label: "log monitors" },
      { id: "vision", label: "vision" },
    ],
  },
  {
    cluster: "app",
    items: [
      { id: "chat", label: "chat" },
      { id: "interface", label: "interface" },
    ],
  },
  // Readiness is a diagnostic, not a setting — it reports what is reachable
  // rather than changing anything. It sat under `interface` only because that
  // was the last section in the column.
  { cluster: "status", items: [{ id: "readiness", label: "readiness" }] },
];

const CHAT_ROLES: (keyof ChatColors)[] = ["user", "assistant"];

// What each sensitivity means in the drawer. The dial is the whole point of the
// setting, so the labels say what HAL will do rather than naming a level.
const SENSITIVITY_COPY: Record<VisionSensitivity, string> = {
  always: "every cycle",
  high: "unless nothing changed",
  medium: "when something is worth saying",
  low: "only when notable",
};

// "1 person" / "2 people". Written out because a purge confirmation that reads
// "1 people" undercuts the one thing it exists to do, which is be believed.
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * Add a face from a picture on disk.
 *
 * A label wrapping a hidden input: the native file button cannot be styled and
 * would be the one control in the panel that looks like it came from somewhere
 * else. The input is reset after every pick so choosing the same file twice in
 * a row still fires a change event.
 */
function AddFaceButton({
  personId,
  onPicked,
  onError,
}: {
  personId: string;
  onPicked: (jpegBase64: string) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <label className={`ghost person-add-face${busy ? " busy" : ""}`} data-testid="add-face">
      {busy ? "reading…" : "add photo"}
      <input
        type="file"
        accept="image/*"
        data-testid="add-face-input"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset immediately: the same file picked twice must fire again, and
          // the element outlives this handler.
          e.target.value = "";
          if (!file) return;
          setBusy(true);
          fileToJpegBase64(file)
            .then(onPicked)
            .catch((err: unknown) => {
              onError(err instanceof ImageError ? err.message : "Something went wrong reading that picture.");
            })
            .finally(() => setBusy(false));
        }}
      />
    </label>
  );
}

/**
 * The rename field, with the merge stated before it happens.
 *
 * The hint mirrors the server's own case-insensitive trimmed match rather than
 * approximating it: a hint that disagrees with the behaviour would be worse
 * than none. It exists because retyping a name and hoping is precisely how one
 * person became five records the last time round.
 */
function RenameField({
  person,
  people,
  onSubmit,
  onCancel,
}: {
  person: { id: string; name: string };
  people: { id: string; name: string; faceCount: number }[];
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(person.name);
  const trimmed = draft.trim();
  const collides = people.find((p) => p.id !== person.id && p.name.toLowerCase() === trimmed.toLowerCase());

  return (
    <span className="person-rename">
      <input
        className="vision-enrol-name"
        data-testid="rename-input"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && trimmed) onSubmit(trimmed);
          if (e.key === "Escape") onCancel();
        }}
      />
      <button className="ghost" data-testid="rename-submit" disabled={!trimmed} onClick={() => onSubmit(trimmed)}>
        {collides ? "merge" : "rename"}
      </button>
      <button className="ghost" onClick={onCancel}>
        cancel
      </button>
      {collides ? (
        <small data-testid="merge-hint">
          merges into {collides.name} ({collides.faceCount} {collides.faceCount === 1 ? "face" : "faces"}) — this cannot
          be undone
        </small>
      ) : null}
    </span>
  );
}

// A readiness leg is three-valued now: "disabled" means nobody wants that
// prerequisite, which is a choice rather than a fault and must not be red.
// "degraded" earns its own tone rather than reading as failure. The recogniser
// reports its detector and embedder separately precisely so a process that can
// detect but not match stays distinguishable from one that is not running, and
// collapsing that back to red here would throw the distinction away at the last
// step.
const tone = (value: string) =>
  value === "ok" ? "ok" : value === "disabled" ? "neutral" : value === "degraded" ? "warn" : "fail";

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

  const vision = settings?.vision;
  const storedVisionPrompt = resolvePrompt(vision?.prompt, DEFAULT_VISION_PROMPT);
  const storedCaptionPrompt = resolvePrompt(vision?.captionPrompt, DEFAULT_VISION_CAPTION_PROMPT);
  const [visionPrompt, setVisionPrompt] = useState(storedVisionPrompt);
  const [captionPrompt, setCaptionPrompt] = useState(storedCaptionPrompt);
  const [captionerEndpoint, setCaptionerEndpoint] = useState(vision?.captionerEndpoint ?? "");
  const [recogniserEndpoint, setRecogniserEndpoint] = useState(vision?.recogniserEndpoint ?? "");
  // Which person is one click from being forgotten. Held here rather than per
  // row so opening a second confirmation closes the first.
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [purging, setPurging] = useState(false);
  // One row at a time for each, so opening a second closes the first — the same
  // reason `confirmingDelete` is held here rather than per row.
  const [editingName, setEditingName] = useState<string | null>(null);
  const [showingFaces, setShowingFaces] = useState<string | null>(null);
  // Failures from reading the picked file, which never reach the server and so
  // have no roster result to arrive in.
  const [imageError, setImageError] = useState<string | null>(null);
  const rename = state.visionRosterResult.rename;
  const prune = state.visionRosterResult["remove-face"];
  const addFace = state.visionRosterResult["add-face"];
  const rosterError =
    imageError ??
    (rename?.ok === false ? rename.error : undefined) ??
    (prune?.ok === false ? prune.error : undefined) ??
    (addFace?.ok === false ? addFace.error : undefined);
  const rosterNote = rename?.ok ? rename.note : undefined;
  // Which category the panel is showing. Opens on the provider because that is
  // the one setting a new install must touch before anything else works.
  const [active, setActive] = useState<CategoryId>("provider");
  // Numeric vision fields are drafted locally and committed on blur. Sending per
  // keystroke means clearing the box sends Number("") — zero — which the server
  // clamps to the floor, so the field fights back while it is being typed in.
  const [numberDrafts, setNumberDrafts] = useState<Partial<Record<keyof VisionSettings, string>>>({});

  const numberField = (
    key:
      | "intervalSeconds"
      | "cycleSeconds"
      | "retainFrames"
      | "detectionIntervalSeconds"
      | "confidenceThreshold"
      | "statementThreshold"
      | "candidateFaces",
    fallback: number,
  ) => ({
    value: numberDrafts[key] ?? String(vision?.[key] ?? fallback),
    onChange: (e: { target: { value: string } }) => setNumberDrafts((d) => ({ ...d, [key]: e.target.value })),
    onBlur: () => {
      const raw = numberDrafts[key];
      setNumberDrafts((d) => ({ ...d, [key]: undefined }));
      if (raw === undefined || raw === "") return;
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) send({ type: "update-settings", patch: { vision: { [key]: parsed } } });
    },
  });

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
    <div className="settings-backdrop" onClick={onClose}>
      <aside className="settings-modal" onClick={(e) => e.stopPropagation()} data-testid="settings-panel">
        <div className="settings-titlebar">
          <h2>settings</h2>
          <button className="ghost" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </div>

        <div className="settings-body">
          <nav className="settings-nav" data-testid="settings-nav">
            {CATEGORIES.map(({ cluster, items }) => (
              <div className="nav-cluster" key={cluster}>
                <span className="nav-cluster-label">{cluster}</span>
                {items.map(({ id, label }) => (
                  <button
                    key={id}
                    className={active === id ? "nav-item selected" : "nav-item"}
                    aria-current={active === id ? "page" : undefined}
                    onClick={() => setActive(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ))}
          </nav>

          {/* Every section stays mounted and inactive ones are hidden, rather
              than rendering only the active one. MonitorsPanel asks the server
              for monitors and suggestions in a mount effect, so unmounting it
              on every category switch would re-issue those requests each time —
              the request-loop shape `ui/test/components/MonitorsPanel.test.tsx`
              exists to prevent. */}
          <div className="settings-content" data-testid="settings-content">
        <section className="settings-group" data-testid="group-provider" hidden={active !== "provider"}>
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
        <section className="settings-group" data-testid="group-sessions" hidden={active !== "sessions"}>
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

        <section className="settings-group" data-testid="group-monitors" hidden={active !== "monitors"}>
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

        {/* The third observation role. It sits apart from the other two for the
            same reason they sit apart from each other: nothing it does starts,
            stops, or interferes with them. */}
        <section className="settings-group" data-testid="group-vision" hidden={active !== "vision"}>
          <h3>vision</h3>
          <p className="group-note">
            Watches through the camera and remarks on what it sees, whatever it is pointed at. The
            captioner runs outside Ollama, so looking never competes with chat for the model.
          </p>

          <fieldset className="field">
            <legend>watching</legend>
            <div className="segmented">
              <button
                className={vision?.enabled ? "seg selected" : "seg"}
                onClick={() => send({ type: "update-settings", patch: { vision: { enabled: true } } })}
              >
                on
              </button>
              <button
                className={vision?.enabled ? "seg" : "seg selected"}
                onClick={() => send({ type: "update-settings", patch: { vision: { enabled: false } } })}
              >
                off
              </button>
            </div>
            <small>off touches no camera at all; turning it off also deletes the frames it kept</small>
          </fieldset>

          <label className="field">
            camera
            <div className="endpoint-row">
              <select
                value={vision?.device ?? ""}
                onChange={(e) =>
                  send({ type: "update-settings", patch: { vision: { device: e.target.value || null } } })
                }
              >
                <option value="">(first camera this machine reports)</option>
                {state.visionDevices.map((device) => (
                  <option key={device} value={device}>
                    {device}
                  </option>
                ))}
              </select>
              <button className="ghost" onClick={() => send({ type: "list-vision-devices" })}>
                find
              </button>
            </div>
          </label>

          <label className="field">
            captioner endpoint
            <div className="endpoint-row">
              <input
                value={captionerEndpoint}
                onChange={(e) => setCaptionerEndpoint(e.target.value)}
                spellCheck={false}
              />
              <button
                className="ghost"
                disabled={captionerEndpoint === vision?.captionerEndpoint}
                onClick={() => {
                  send({ type: "update-settings", patch: { vision: { captionerEndpoint } } });
                  send({ type: "check-readiness" });
                }}
              >
                apply
              </button>
            </div>
            <small>a local vision model serving an OpenAI-compatible endpoint</small>
          </label>

          {/* Shown until the leg reads ok, including before Vision is switched
              on — this is the one dependency the project does not install, and
              finding that out only after enabling it is a poor first run. */}
          {state.readiness && state.readiness.captioner !== "ok" ? <CaptionerSetup /> : null}

          <fieldset className="field" data-testid="recognition-settings">
            <legend>recognition</legend>

            <div className="segmented">
              <button
                className={vision?.recognitionEnabled ? "seg selected" : "seg"}
                onClick={() => send({ type: "update-settings", patch: { vision: { recognitionEnabled: true } } })}
              >
                on
              </button>
              <button
                className={vision?.recognitionEnabled ? "seg" : "seg selected"}
                onClick={() => send({ type: "update-settings", patch: { vision: { recognitionEnabled: false } } })}
              >
                off
              </button>
            </div>
            <small>
              Off by default, and subordinate to Vision: recognition never opens the camera on its own.
            </small>

            <label className="field">
              recogniser endpoint
              <div className="endpoint-row">
                <input value={recogniserEndpoint} onChange={(e) => setRecogniserEndpoint(e.target.value)} spellCheck={false} />
                <button
                  className="ghost"
                  disabled={recogniserEndpoint === vision?.recogniserEndpoint}
                  onClick={() => {
                    send({ type: "update-settings", patch: { vision: { recogniserEndpoint } } });
                    send({ type: "check-readiness" });
                  }}
                >
                  apply
                </button>
              </div>
              <small>
                a recogniser sidecar HAL points at but never starts — `npm run start:recogniser`. Pointing it off
                this machine sends whole camera frames there, including people who are not enrolled.
              </small>
            </label>

            <label className="field">
              detection interval (seconds)
              <input type="number" min={2} {...numberField("detectionIntervalSeconds", 3)} />
              <small>separate from the capture interval; a face costs milliseconds, so this can be short</small>
            </label>

            <label className="field">
              recognition threshold
              <input type="number" min={0.05} max={0.99} step={0.05} {...numberField("confidenceThreshold", 0.5)} />
              <small>below this a face is unrecognised rather than the nearest guess</small>
            </label>

            <label className="field">
              statement threshold
              <input type="number" min={0.1} max={0.99} step={0.05} {...numberField("statementThreshold", 0.6)} />
              <small>
                at or above this I say the name outright; between the two I say who someone looks like. The gap
                is kept at least {MIN_BAND_SEPARATION} wide, so the hedge cannot be switched off by setting the
                two equal.
              </small>
            </label>

            <label className="field">
              faces kept for naming
              <input type="number" min={0} {...numberField("candidateFaces", 20)} />
              <small>
                unrecognised faces held until you name or dismiss them. Zero keeps none. The oldest is dropped
                when full, and how many were dropped is reported rather than discarded quietly.
              </small>
            </label>

            <div className="people-roster" data-testid="people-roster">
              {state.visionPeople.length === 0 ? (
                <small>Nobody enrolled. Name a face from the vision pane.</small>
              ) : (
                state.visionPeople.map((person) => (
                  <div className="person-row" key={person.id} data-testid="person-row">
                    {person.thumbnail ? (
                      <img className="person-face" src={person.thumbnail} alt={person.name} />
                    ) : (
                      <div className="person-face person-face-missing" />
                    )}
                    {editingName === person.id ? (
                      <RenameField
                        person={person}
                        people={state.visionPeople}
                        onCancel={() => setEditingName(null)}
                        onSubmit={(name) => {
                          send({ type: "rename-person", id: person.id, name });
                          setEditingName(null);
                        }}
                      />
                    ) : (
                      <button
                        className="person-name person-name-edit"
                        data-testid="rename-person"
                        title="rename"
                        onClick={() => setEditingName(person.id)}
                      >
                        {person.name}
                      </button>
                    )}
                    <AddFaceButton
                      personId={person.id}
                      onError={setImageError}
                      onPicked={(jpegBase64) => {
                        setImageError(null);
                        send({ type: "add-face-from-image", personId: person.id, jpegBase64 });
                      }}
                    />
                    <button
                      className="person-faces"
                      data-testid="show-faces"
                      onClick={() => setShowingFaces(showingFaces === person.id ? null : person.id)}
                    >
                      {person.faceCount} {person.faceCount === 1 ? "face" : "faces"}
                    </button>
                    {/* Confirmed, because this destroys data. Naming and
                        deleting are also kept apart so neither is reachable by
                        a misclick meant for the other. */}
                    {confirmingDelete === person.id ? (
                      <>
                        <button
                          className="ghost danger"
                          data-testid="confirm-delete-person"
                          onClick={() => {
                            send({ type: "delete-person", id: person.id });
                            setConfirmingDelete(null);
                          }}
                        >
                          delete {person.name} and every face
                        </button>
                        <button className="ghost" onClick={() => setConfirmingDelete(null)}>
                          cancel
                        </button>
                      </>
                    ) : (
                      <button
                        className="ghost"
                        data-testid="delete-person"
                        onClick={() => setConfirmingDelete(person.id)}
                      >
                        forget
                      </button>
                    )}

                    {showingFaces === person.id ? (
                      <div className="person-face-list" data-testid="person-face-list">
                        {person.faces.map((face) => (
                          <span className="person-face-item" key={face.id}>
                            {face.thumbnail ? (
                              <img className="person-face" src={face.thumbnail} alt="" />
                            ) : (
                              <span className="person-face person-face-missing" />
                            )}
                            {/* No confirmation stage. Removing one face of
                                several is recoverable — the person is still
                                there and can be shown again — unlike forgetting
                                them entirely, which is why that one is staged
                                and this is not. */}
                            <button
                              className="ghost"
                              data-testid="remove-face"
                              disabled={person.faceCount <= 1}
                              title={
                                person.faceCount <= 1
                                  ? `The only face I have for ${person.name}. Forget them instead.`
                                  : "remove this face"
                              }
                              onClick={() => send({ type: "remove-face", personId: person.id, faceId: face.id })}
                            >
                              remove
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))
              )}

              {rosterError ? (
                <span className="vision-fault" data-testid="roster-error">
                  {rosterError}
                </span>
              ) : null}
              {rosterNote ? (
                <span className="roster-note" data-testid="roster-note">
                  {rosterNote}
                </span>
              ) : null}
            </div>

            {/* The purge (R39). Two stages, like forgetting one person, but the
                confirmation quotes counts the server produced at the moment it
                was asked — not the roster this client happens to hold, which
                says nothing about the queue and can be stale. */}
            <div className="biometric-purge" data-testid="biometric-purge">
              {purging ? (
                <>
                  <span className="purge-warning" data-testid="purge-warning">
                    {state.biometricTally
                      ? `This deletes ${count(state.biometricTally.people, "person", "people")}, ` +
                        `${count(state.biometricTally.faces, "face", "faces")} and ` +
                        `${count(state.biometricTally.candidates, "waiting face", "waiting faces")}. ` +
                        `It cannot be undone.`
                      : "Counting what this would delete…"}
                  </span>
                  <button
                    className="ghost danger"
                    data-testid="confirm-purge-biometrics"
                    // Disabled until the count arrives: a destructive
                    // confirmation the user cannot read is not a confirmation.
                    disabled={!state.biometricTally}
                    onClick={() => {
                      send({ type: "purge-biometrics" });
                      setPurging(false);
                    }}
                  >
                    forget everyone
                  </button>
                  <button className="ghost" onClick={() => setPurging(false)}>
                    cancel
                  </button>
                </>
              ) : (
                <button
                  className="ghost"
                  data-testid="purge-biometrics"
                  onClick={() => {
                    setPurging(true);
                    send({ type: "count-biometrics" });
                  }}
                >
                  forget everyone and everything
                </button>
              )}
            </div>
          </fieldset>

          <fieldset className="field">
            <legend>how readily I speak</legend>
            <div className="segmented">
              {VISION_SENSITIVITIES.map((level) => (
                <button
                  key={level}
                  className={vision?.sensitivity === level ? "seg selected" : "seg"}
                  onClick={() => send({ type: "update-settings", patch: { vision: { sensitivity: level } } })}
                >
                  {level}
                </button>
              ))}
            </div>
            <small>
              {vision ? `I remark ${SENSITIVITY_COPY[vision.sensitivity]}.` : ""} A cycle I say nothing
              about leaves no trace in the feed.
            </small>
          </fieldset>

          <ColorField
            label="feed colour"
            value={vision?.color ?? DEFAULT_VISION_COLOR}
            onChange={(color) => send({ type: "update-settings", patch: { vision: { color } } })}
          />
          <small className="field-note">
            what my remarks look like in the observation feed, where they sit beside session and
            monitor entries
          </small>

          <label className="field">
            seconds between looks
            <input type="number" min={5} max={3600} {...numberField("intervalSeconds", 60)} />
          </label>

          <label className="field">
            seconds per cycle
            <input type="number" min={10} max={21600} {...numberField("cycleSeconds", 300)} />
            <small>how long I gather before deciding whether to speak</small>
          </label>

          <label className="field">
            frames kept
            <div className="endpoint-row">
              <input type="number" min={0} max={500} {...numberField("retainFrames", 20)} />
              <button className="ghost" onClick={() => send({ type: "clear-vision-frames" })}>
                delete now
              </button>
            </div>
            <small>pictures of you, on this disk; zero keeps none</small>
          </label>

          <PromptField
            label="vision prompt"
            value={visionPrompt}
            stored={storedVisionPrompt}
            isDefault={vision?.prompt === null}
            note="my voice over a cycle; I only ever see the descriptions, never the pictures"
            onChange={setVisionPrompt}
            onApply={() => send({ type: "update-settings", patch: { vision: { prompt: visionPrompt } } })}
            onReset={() => {
              setVisionPrompt(DEFAULT_VISION_PROMPT);
              send({ type: "update-settings", patch: { vision: { prompt: null } } });
            }}
          />

          <PromptField
            label="caption prompt"
            value={captionPrompt}
            stored={storedCaptionPrompt}
            isDefault={vision?.captionPrompt === null}
            note="what the captioner is asked of each frame; addressed to a small model, not to me"
            onChange={setCaptionPrompt}
            onApply={() => send({ type: "update-settings", patch: { vision: { captionPrompt } } })}
            onReset={() => {
              setCaptionPrompt(DEFAULT_VISION_CAPTION_PROMPT);
              send({ type: "update-settings", patch: { vision: { captionPrompt: null } } });
            }}
          />
        </section>

        <section className="settings-group" data-testid="group-chat" hidden={active !== "chat"}>
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

        <section className="settings-group" data-testid="group-interface" hidden={active !== "interface"}>
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
        </section>

        <section className="settings-group" data-testid="group-readiness" hidden={active !== "readiness"}>
          <h3>readiness</h3>
          <p className="group-note">
            What HAL can reach right now. Nothing here is a setting — it reports the state of the
            things the roles above depend on, so a leg that reads wrong is fixed elsewhere.
          </p>

          <div className="field">
            <div className="readiness-header">
              <span>probe</span>
              <button className="ghost" onClick={() => send({ type: "check-readiness" })}>
                re-check
              </button>
            </div>
            {state.readiness ? (
              <ul className="readiness-list">
                {readinessRow("ollama", state.readiness.ollama)}
                {readinessRow("models", state.readiness.models)}
                {readinessRow("claude code logs", state.readiness.claudeLogs)}
                {readinessRow("vision captioner", state.readiness.captioner)}
                {readinessRow("vision recogniser", state.readiness.recogniser)}
              </ul>
            ) : (
              <p className="empty-state">no probe yet</p>
            )}
          </div>
        </section>
          </div>
        </div>
      </aside>
    </div>
  );
}
