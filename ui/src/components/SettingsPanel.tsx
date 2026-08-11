import { useEffect, useState, type ReactNode } from "react";
import {
  VISION_SENSITIVITIES,
  MIN_BAND_SEPARATION,
  MAX_PROFILE_CHARS,
  type BackendPatch,
  type BackendSettings,
  type ChatColors,
  type ClientMessage,
  type ProtocolPreference,
  type PersonaIntensity,
  type VisionSensitivity,
  type VisionSettings,
} from "../../../shared/src/types";
import { adapterRows, type AppState } from "../store";
import { DEFAULT_CHAT_COLOR, DEFAULT_VISION_COLOR } from "../palette";
import { isHandEdited } from "../prompts";
import {
  DEFAULT_CHAT_PROMPT,
  DEFAULT_CONTEXT_PREAMBLE,
  DEFAULT_MONITOR_PROMPT,
  DEFAULT_NARRATION_PROMPT,
  DEFAULT_VISION_CAPTION_PROMPT,
  DEFAULT_VISION_PROMPT,
  DEFAULT_TEMPLATES,
  KNOWN_NARRATION_TEXTS,
  NARRATION_PRESETS,
  PROMPT_FIELDS,
  resolvePrompt,
} from "../../../shared/src/prompts";
import { validateTemplate, vocabularyFor, type TemplateRole } from "../../../shared/src/templates";
import { PHRASES, type PhraseGroup, type PhraseSpec } from "../../../shared/src/phrases";
import { SettingsDisclosure, summarise, type ContainedState } from "./SettingsDisclosure";
import { TemplateField } from "./TemplateField";
import { PhraseField } from "./PhraseField";
import { TemplateHelp } from "./TemplateHelp";
import { MonitorsPanel } from "./MonitorsPanel";
import { CaptionerSetup } from "./CaptionerSetup";
import { ImageError, fileToJpegBase64 } from "../face-image";
import { FaceZoom } from "./FaceZoom";
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
type CategoryId =
  | "provider"
  | "sessions"
  | "monitors"
  | "vision"
  | "chat"
  | "interface"
  | "readiness";

/**
 * The roles this drawer does not own.
 *
 * `TEMPLATE_ROLES` has nine members and the drawer edits eight —
 * `conversation-system` belongs to a Conversation and is edited in
 * `ConversationPrompt.tsx`. Named rather than skipped: the sweep in
 * `SettingsPanel.test.tsx` asserts the catalogue is covered by this set and
 * `TEMPLATE_FIELDS` together, so a tenth role added tomorrow has to be
 * classified instead of quietly landing nowhere. An exemption list that grows
 * without anyone noticing is how a completeness guard stops being one.
 */
export const NOT_A_SETTING: readonly TemplateRole[] = ["conversation-system"];

// What each role is for, read by the section that owns it.
//
// These had their own category for a while, called `what I send`. The argument
// was volume: fifteen editors across eight roles, each carrying a slot list, a
// preview and four buttons, and threading those through the existing sections
// would have buried the settings already there. That was true, and the cost was
// that vision wording was configured in two places.
//
// Collapsing them answers the volume half without paying that cost, so the
// category is gone and each role sits with the tool it configures. The list
// stays: a role added tomorrow needs one obvious place to say what it is for,
// and the sweep proves each entry reaches exactly one section.
export const TEMPLATE_FIELDS: { role: TemplateRole; label: string; note: string }[] = [
  {
    role: "chat-context",
    label: "conversation context",
    note: "assembled beneath a conversation's own prompt when either context switch is on; never sent when both are off, and never sent at all to a backend off this machine you have not agreed to",
  },
  { role: "narration-system", label: "narration — system", note: "HAL's standing voice while narrating a session" },
  { role: "narration-user", label: "narration — the request", note: "how the log lines are handed over, and what is asked of them" },
  { role: "monitor-system", label: "log monitors — system", note: "HAL's standing voice while watching a log" },
  { role: "monitor-user", label: "log monitors — the request", note: "one branch per reason the monitor spoke" },
  { role: "vision-system", label: "vision — system", note: "HAL's voice for a cycle, and what it knows about the people it may see" },
  { role: "vision-user", label: "vision — the request", note: "one branch per sensitivity, and how the captions are handed over" },
  { role: "captioner-user", label: "captioner — the question", note: "asked of the small vision model about each frame; it has no system message" },
];

const CATEGORIES: { cluster: string; items: { id: CategoryId; label: string }[] }[] = [
  { cluster: "model", items: [{ id: "provider", label: "connections" }] },
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
 * What HAL is told about someone.
 *
 * Drafted locally and saved on click, like the prompts above — patching per
 * keystroke would broadcast the whole settings object for every character. The
 * count shows only as the bound approaches: a counter on an empty field is
 * noise, and one that appears late says something.
 */
function ProfileField({
  person,
  onSave,
}: {
  person: { id: string; name: string; profile?: string };
  onSave: (profile: string) => void;
}) {
  const stored = person.profile ?? "";
  const [draft, setDraft] = useState(stored);
  const over = draft.trim().length - MAX_PROFILE_CHARS;
  const near = draft.length > MAX_PROFILE_CHARS * 0.75;

  return (
    <div className="person-profile" data-testid="person-profile">
      <textarea
        className="prompt-input"
        rows={3}
        data-testid="profile-input"
        placeholder={`who ${person.name} is, and why they matter`}
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="prompt-actions">
        {near ? (
          <small className={over > 0 ? "over" : undefined} data-testid="profile-count">
            {draft.trim().length} / {MAX_PROFILE_CHARS}
          </small>
        ) : null}
        <button
          className="ghost"
          data-testid="save-profile"
          // Nothing to save, or too long to accept. The refusal is visible here
          // rather than only after the server answers.
          disabled={draft === stored || over > 0}
          onClick={() => onSave(draft.trim())}
        >
          save
        </button>
      </div>
      <small>HAL is told this when it states this name, and never in a caption</small>
    </div>
  );
}

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
/**
 * One configured backend: endpoint, protocol, and whether a key is held.
 *
 * The protocol select defaults to `auto` because the point of this work is that
 * pointing HAL at a server is enough. The override exists for when the probe is
 * wrong, not as the route people are expected to take.
 *
 * The key field never shows a stored key — the server does not send one. It
 * says whether one is held and lets it be replaced or cleared, which is all a
 * client can honestly offer about a credential it is not trusted with.
 */
function BackendCard({
  label,
  note,
  backend,
  otherLabel,
  sameAsOther,
  onCopyFromOther,
  onApply,
  model,
}: {
  label: string;
  note: string;
  backend: BackendSettings;
  // Named so the copy button says what it will do rather than "copy".
  otherLabel: string;
  sameAsOther: boolean;
  onCopyFromOther: () => void;
  onApply: (patch: BackendPatch) => void;
  // The model this backend runs, chosen from this backend's own list. It lives
  // in the card because a model name is only meaningful against the server that
  // holds it — listing them apart is how the narration picker came to offer
  // chat's models.
  model: ReactNode;
}) {
  const [endpoint, setEndpoint] = useState(backend.endpoint);
  const [key, setKey] = useState("");

  // Re-seed when the stored value changes underneath — another tab, or the
  // server normalising what was typed.
  useEffect(() => {
    setEndpoint(backend.endpoint);
  }, [backend.endpoint]);

  const dirty = endpoint !== backend.endpoint;

  return (
    <fieldset className="field backend-card" data-testid={`backend-${label}`}>
      <legend>{label}</legend>
      <label className="field">
        endpoint
        <div className="endpoint-row">
          <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} spellCheck={false} />
          <button className="ghost" disabled={!dirty} onClick={() => onApply({ endpoint })}>
            apply
          </button>
        </div>
        <small>{note}</small>
      </label>

      {/* Both destinations are independent, so neither follows the other when
          it changes. This is how a setting moves between them on purpose — and
          it copies the key as well, which is why the server performs it: a
          client is never told a credential and could not copy one itself. */}
      <div className="backend-copy">
        <button className="ghost" disabled={sameAsOther} onClick={onCopyFromOther}>
          use the same as {otherLabel}
        </button>
        {sameAsOther ? <small>already the same as {otherLabel}</small> : null}
      </div>

      <label className="field">
        protocol
        <select
          value={backend.protocol}
          onChange={(e) => onApply({ protocol: e.target.value as ProtocolPreference })}
        >
          <option value="auto">detect from the endpoint</option>
          <option value="ollama">ollama</option>
          <option value="openai">openai-compatible</option>
        </select>
        <small>auto asks the endpoint what it is; set it by hand only if that gets it wrong</small>
      </label>

      <label className="field">
        api key
        <div className="endpoint-row">
          <input
            type="password"
            value={key}
            placeholder={backend.hasKey ? "a key is set" : "none"}
            onChange={(e) => setKey(e.target.value)}
            spellCheck={false}
          />
          <button
            className="ghost"
            disabled={key.length === 0}
            onClick={() => {
              onApply({ apiKey: key });
              setKey("");
            }}
          >
            set
          </button>
          <button className="ghost" disabled={!backend.hasKey} onClick={() => onApply({ apiKey: null })}>
            clear
          </button>
        </div>
        <small>only needed for a hosted endpoint; kept on this machine and never shown back</small>
      </label>

      {model}
    </fieldset>
  );
}

/**
 * Whether two slots address the same server.
 *
 * Endpoint only. The key cannot be compared — a client is never told one — and
 * the protocol follows the endpoint in every case worth a button.
 */
const sameEndpoint = (a: BackendSettings, b: BackendSettings): boolean =>
  a.endpoint.trim().replace(/\/+$/, "") === b.endpoint.trim().replace(/\/+$/, "");

const tone = (value: string) =>
  value === "ok" ? "ok" : value === "disabled" ? "neutral" : value === "degraded" ? "warn" : "fail";

// The shape assembled beneath the preamble, as a worked example.
//
// Shown rather than made editable because these are not prompts: each line is
// built from a live reading — who is in view, how long for, what the last
// caption said, when each remark happened — so there is nothing here a user
// could edit that would not immediately be overwritten by the next check. What
// they were owed is sight of it, which is what was missing.
const CONTEXT_SHAPE = `What I have been saying about Claude Code [a408c0a1], oldest first; it is now 18:22:04:
- [18:14:51] I see it reading the router.
- [18:19:30] It is editing the parser.
(214 earlier remarks not recalled here.)

Who I can see, read live just now at 18:22:04:
- Creator 74%, recognised without a break as the same person for 6 minutes, steadily across that whole run.
Separately, and this is the one thing above that is not current — my last description of the room, 12 seconds ago at 18:21:52: "..."
You know Creator, whose machine this is: <their character profile>`;

export function SettingsPanel({ state, send, onClose }: Props) {
  const [helpOpen, setHelpOpen] = useState(false);
  const settings = state.settings;
  // The six settings-level prompts no longer draft here. Each is a
  // `TemplateField` now, and it owns its own draft along with the re-seed latch
  // that makes reset and take-the-new-default visibly do something. Two places
  // holding the same draft was the shape that made those three appear to do
  // nothing, and it is not worth reintroducing for prompts that are templates.
  const vision = settings?.vision;
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
  const [editingProfile, setEditingProfile] = useState<string | null>(null);
  // Which stored face is open at full size. Held at panel level so opening a
  // second closes the first.
  const [zoomed, setZoomed] = useState<{ src: string; sourceWidth?: number; caption: string } | null>(null);
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
    (addFace?.ok === false ? addFace.error : undefined) ??
    (state.visionRosterResult.profile?.ok === false ? state.visionRosterResult.profile.error : undefined) ??
    (state.visionRosterResult.operator?.ok === false ? state.visionRosterResult.operator.error : undefined);
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

  const applyNarration = (text: string) =>
    send({ type: "update-settings", patch: { narrationPrompt: text, narrationPromptIsTemplate: true } });

  const seedNarration = (text: string, draftIsDirty: boolean) => {
    // Warn when there is real work to lose. Unapplied text in the textarea
    // counts: checking only the stored value would discard whatever the user
    // typed but had not pressed apply on. Cycling presets still never nags,
    // because seeding sets the draft and the stored value together.
    // Unapplied text in the editor counts as work to lose: checking only the
    // stored value would silently discard whatever was typed but not applied.
    // The editor owns its draft now, so it reports the dirty flag rather than
    // this reading a copy of it.
    const atRisk = draftIsDirty || isHandEdited(settings?.narrationPrompt, KNOWN_NARRATION_TEXTS);
    if (atRisk && !confirm("Replace the narration prompt with this preset? Unsaved changes will be lost.")) {
      return;
    }
    applyNarration(text);
  };

  if (!settings) return null;

  const readinessRow = (label: string, value: string) => (
    <li className={tone(value)}>
      <span className="dot" /> {label}: {value}
    </li>
  );

  // What a collapsed block says about one template it holds. `needsAttention`
  // covers the two notices the editor raises on its own — a baseline whose
  // shipped default has since moved, and a stored template naming a slot a
  // release withdrew. Neither is rendered until the block is opened, so the
  // header is the only route either has to someone with no reason to click.
  const templateState = (role: TemplateRole): ContainedState => {
    const stored = settings.templates?.[role];
    const shipped = DEFAULT_TEMPLATES[role];
    const baseline = settings.templateBaselines?.[role];
    const degraded =
      stored != null && validateTemplate(stored, vocabularyFor(role)).some((e) => e.kind === "unknown-slot");
    return {
      edited: (stored ?? shipped) !== shipped,
      needsAttention: degraded || (baseline !== undefined && baseline.shippedDefault !== shipped),
    };
  };

  // Same shape as above, and for the same reason: a stored phrase naming a
  // field a release withdrew is not something the user did, and the editor
  // only says so once opened. Phrases carry no baseline, so that half is
  // absent rather than hardcoded false.
  const phraseState = (spec: PhraseSpec): ContainedState => {
    const stored = settings.phrases?.[spec.id];
    return {
      edited: (stored ?? spec.shipped) !== spec.shipped,
      needsAttention:
        stored != null && validateTemplate(stored, spec.fields).some((e) => e.kind === "unknown-slot"),
    };
  };

  /**
   * The templates a settings-level prompt is rendered into, beneath it.
   *
   * The prompt above is a slot inside these — `narrationPrompt` reaches the
   * model through `{narration_prompt}` in `narration-system`, and the same
   * holds for monitors, vision and the captioner. Putting them adjacent is the
   * whole point of the grouping; putting the envelope *under* the prompt is
   * what stops them reading as two peers that both get sent.
   */
  const envelope = (testId: string, roles: readonly TemplateRole[]) => (
    <SettingsDisclosure
      label="the wording I wrap it in"
      summary={summarise(roles.map(templateState))}
      testId={testId}
    >
      {roles.map((role) => {
        const spec = TEMPLATE_FIELDS.find((f) => f.role === role)!;
        return (
          <TemplateField
            key={role}
            role={role}
            label={spec.label}
            note={spec.note}
            stored={settings.templates?.[role]}
            shipped={DEFAULT_TEMPLATES[role]}
            slots={vocabularyFor(role)}
            baseline={settings.templateBaselines?.[role]}
            onApply={(text) => send({ type: "update-settings", patch: { templates: { [role]: text } } })}
            onReset={() => send({ type: "update-settings", patch: { templates: { [role]: null } } })}
            onSaveBaseline={(text) =>
              send({
                type: "update-settings",
                patch: {
                  templates: { [role]: text },
                  templateBaselines: { [role]: { text, shippedDefault: DEFAULT_TEMPLATES[role] } },
                },
              })
            }
            onRevertToBaseline={() => {
              const baseline = settings.templateBaselines?.[role];
              if (baseline) send({ type: "update-settings", patch: { templates: { [role]: baseline.text } } });
            }}
          />
        );
      })}
    </SettingsDisclosure>
  );

  /** A section's phrases, grouped as the catalogue groups them. */
  const phraseBlock = (testId: string, groups: readonly PhraseGroup[]) => {
    const specs = PHRASES.filter((p) => groups.includes(p.group));
    return (
      <SettingsDisclosure
        label="the lines inside them"
        summary={summarise(specs.map(phraseState))}
        testId={testId}
      >
        <small className="disclosure-note">
          a template says where a reading goes; these say how one line of it reads — one face, one
          remark, one person. same braces, smaller field lists.
        </small>
        {groups.map((group) => (
          <div key={group} className="phrase-group" data-testid={`phrase-group-${group}`}>
            <h5>{group}</h5>
            {PHRASES.filter((p) => p.group === group).map((spec) => (
              <PhraseField
                key={spec.id}
                spec={spec}
                stored={settings.phrases?.[spec.id]}
                onApply={(text) => send({ type: "update-settings", patch: { phrases: { [spec.id]: text } } })}
                onReset={() => send({ type: "update-settings", patch: { phrases: { [spec.id]: null } } })}
              />
            ))}
          </div>
        ))}
      </SettingsDisclosure>
    );
  };

  /** Every section holding an envelope offers the syntax the braces obey. */
  const cheatSheet = (section: string) => (
    <button className="ghost" data-testid={`open-template-help-${section}`} onClick={() => setHelpOpen(true)}>
      syntax cheat sheet
    </button>
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
          <h3>connections</h3>
          <p className="group-note">
            Everything HAL talks to, named by what sends there. The two model backends are
            independent — changing one leaves the other where it was — and both start on the same
            server, which is the ordinary setup. The captioner and the recogniser are configured
            under vision; none of the four are interchangeable, since a chat model cannot describe a
            frame and the recogniser is not a model server at all.
          </p>

          <BackendCard
            label="chat"
            note="where a conversation's replies come from"
            backend={settings.backends.chat}
            otherLabel="observation"
            sameAsOther={sameEndpoint(settings.backends.chat, settings.backends.observation)}
            onCopyFromOther={() => {
              send({ type: "update-settings", patch: { backends: { chat: { copyFrom: "observation" } } } });
              send({ type: "list-models" });
              send({ type: "check-readiness" });
            }}
            onApply={(patch) => {
              send({ type: "update-settings", patch: { backends: { chat: patch } } });
              send({ type: "list-models" });
              send({ type: "check-readiness" });
            }}
            model={
              <label className="field">
                default chat model
                <select
                  value={settings.chatModel ?? ""}
                  onChange={(e) => send({ type: "update-settings", patch: { chatModel: e.target.value || null } })}
                >
                  <option value="">(none selected)</option>
                  <ModelOptions models={state.models.chat} />
                </select>
                {state.modelsError.chat ? <small>this backend could not be reached</small> : null}
              </label>
            }
          />

          <BackendCard
            label="observation"
            note="narration, log monitors and vision — the three that run unattended"
            backend={settings.backends.observation}
            otherLabel="chat"
            sameAsOther={sameEndpoint(settings.backends.observation, settings.backends.chat)}
            onCopyFromOther={() => {
              send({ type: "update-settings", patch: { backends: { observation: { copyFrom: "chat" } } } });
              send({ type: "list-models" });
              send({ type: "check-readiness" });
            }}
            onApply={(patch) => {
              send({ type: "update-settings", patch: { backends: { observation: patch } } });
              send({ type: "list-models" });
              send({ type: "check-readiness" });
            }}
            model={
              <label className="field">
                narration model
                <select
                  value={settings.narrationModel ?? ""}
                  onChange={(e) => send({ type: "update-settings", patch: { narrationModel: e.target.value || null } })}
                >
                  <option value="">(follow chat model)</option>
                  <ModelOptions models={state.models.observation} />
                </select>
                <small>shared by session observation, log monitors and vision; one model runs at a time</small>
                {/* Following the chat model means naming a model chosen against
                    a different server, which this backend may not hold. Said
                    where the choice is made rather than discovered from a
                    model_not_found on the next narration. */}
                {!settings.narrationModel &&
                !sameEndpoint(settings.backends.chat, settings.backends.observation) ? (
                  <small className="warn-note">
                    following the chat model while the two backends differ — this one may not have it
                  </small>
                ) : null}
                {state.modelsError.observation ? <small>this backend could not be reached</small> : null}
              </label>
            }
          />


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
                        className={adapter.enabled ? "seg selected seg-on" : "seg"}
                        onClick={() => send({ type: "set-adapter-enabled", adapterId: adapter.id, enabled: true })}
                      >
                        on
                      </button>
                      <button
                        className={adapter.enabled ? "seg" : "seg selected seg-off"}
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

          <TemplateField
            id="narrationPrompt"
            isTemplate={settings.narrationPromptIsTemplate === true}
            label="narration prompt"
            note="the whole prompt, guardrails included; applies to the next narration"
            stored={settings.narrationPrompt}
            shipped={DEFAULT_NARRATION_PROMPT}
            slots={PROMPT_FIELDS.narrationPrompt}
            baseline={undefined}
            onApply={(text) =>
              send({ type: "update-settings", patch: { narrationPrompt: text, narrationPromptIsTemplate: true } })
            }
            onReset={() =>
              send({ type: "update-settings", patch: { narrationPrompt: null, narrationPromptIsTemplate: true } })
            }
            extraActions={({ dirty }) => (
              <div className="segmented">
                {NARRATION_PRESETS.map((preset) => (
                  <button key={preset.id} className="seg" onClick={() => seedNarration(preset.text, dirty)}>
                    {preset.label}
                  </button>
                ))}
              </div>
            )}
          />
          {envelope("narration", ["narration-system", "narration-user"])}

          {phraseBlock("session-lines", ["narration", "session"])}

          {cheatSheet("sessions")}
        </section>

        <section className="settings-group" data-testid="group-monitors" hidden={active !== "monitors"}>
          <h3>log monitors</h3>
          <p className="group-note">
            Watches log files and commands you point it at. Nothing to do with coding sessions — these keep
            running whether or not a session is attached.
          </p>

          <MonitorsPanel state={state} send={send} />

          <TemplateField
            id="monitorPrompt"
            isTemplate={settings.monitorPromptIsTemplate === true}
            label="monitor prompt"
            note="describes no log tags, because a machine log has none"
            stored={settings.monitorPrompt}
            shipped={DEFAULT_MONITOR_PROMPT}
            slots={PROMPT_FIELDS.monitorPrompt}
            baseline={undefined}
            onApply={(text) =>
              send({ type: "update-settings", patch: { monitorPrompt: text, monitorPromptIsTemplate: true } })
            }
            onReset={() =>
              send({ type: "update-settings", patch: { monitorPrompt: null, monitorPromptIsTemplate: true } })
            }
          />
          {envelope("monitor", ["monitor-system", "monitor-user"])}

          {phraseBlock("monitor-lines", ["monitor"])}

          {cheatSheet("monitors")}
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
                className={vision?.enabled ? "seg selected seg-on" : "seg"}
                onClick={() => send({ type: "update-settings", patch: { vision: { enabled: true } } })}
              >
                on
              </button>
              <button
                className={vision?.enabled ? "seg" : "seg selected seg-off"}
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
                className={vision?.recognitionEnabled ? "seg selected seg-on" : "seg"}
                onClick={() => send({ type: "update-settings", patch: { vision: { recognitionEnabled: true } } })}
              >
                on
              </button>
              <button
                className={vision?.recognitionEnabled ? "seg" : "seg selected seg-off"}
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

            <label className="field">
              keep uncertain matches for review
              <div className="segmented" data-testid="queue-uncertain">
                <button
                  className={vision?.queueUncertainMatches ? "seg selected seg-on" : "seg"}
                  data-testid="queue-uncertain-on"
                  onClick={() => send({ type: "update-settings", patch: { vision: { queueUncertainMatches: true } } })}
                >
                  on
                </button>
                <button
                  className={vision?.queueUncertainMatches ? "seg" : "seg selected seg-off"}
                  data-testid="queue-uncertain-off"
                  onClick={() => send({ type: "update-settings", patch: { vision: { queueUncertainMatches: false } } })}
                >
                  off
                </button>
              </div>
              <small>
                when I recognise someone but only just — between the two thresholds — keep that face so you can confirm
                it and give me another angle on them. Confirming the wrong one teaches me the wrong face, so compare the
                two pictures before agreeing.
              </small>
            </label>

            <div className="people-roster" data-testid="people-roster">
              {state.visionPeople.length === 0 ? (
                <small>Nobody enrolled. Name a face from the vision pane.</small>
              ) : (
                state.visionPeople.map((person) => (
                  <div className="person-row" key={person.id} data-testid="person-row">
                    {person.thumbnail ? (
                      <button
                        className="person-face-button"
                        title="see this face at full size"
                        data-testid="zoom-person-face"
                        onClick={() =>
                          setZoomed({
                            src: person.thumbnail!,
                            sourceWidth: person.faces.find((f) => f.thumbnail === person.thumbnail)?.sourceWidth,
                            caption: person.name,
                          })
                        }
                      >
                        <img className="person-face" src={person.thumbnail} alt={person.name} />
                      </button>
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

                    {/* One click, no confirmation: the mark moves rather than
                        being destroyed, and clicking the wrong row is undone by
                        clicking the right one. */}
                    <button
                      className={`ghost person-operator${person.isOperator ? " is-operator" : ""}`}
                      data-testid="set-operator"
                      title={
                        person.isOperator
                          ? "I am talking to this person. Click to clear."
                          : "Mark as the person I am talking to"
                      }
                      onClick={() => send({ type: "set-operator", id: person.isOperator ? null : person.id })}
                    >
                      {person.isOperator ? "you" : "is you"}
                    </button>

                    <button
                      className="person-faces"
                      data-testid="edit-profile"
                      onClick={() => setEditingProfile(editingProfile === person.id ? null : person.id)}
                    >
                      {person.profile ? "described" : "describe"}
                    </button>

                    {editingProfile === person.id ? (
                      <ProfileField
                        person={person}
                        onSave={(profile) => send({ type: "set-profile", id: person.id, profile })}
                      />
                    ) : null}

                    {showingFaces === person.id ? (
                      <div className="person-face-list" data-testid="person-face-list">
                        {person.faces.map((face) => (
                          <span className="person-face-item" key={face.id}>
                            {face.thumbnail ? (
                              <button
                                className="person-face-button"
                                title="see this face at full size"
                                data-testid="zoom-face"
                                onClick={() =>
                                  setZoomed({
                                    src: face.thumbnail!,
                                    sourceWidth: face.sourceWidth,
                                    caption: `${person.name} — added ${new Date(face.addedAt).toLocaleDateString()}`,
                                  })
                                }
                              >
                                <img className="person-face" src={face.thumbnail} alt="" />
                                {/* The number that predicts whether this face is
                                    worth having. Shown inline rather than only on
                                    zoom, so a gallery can be scanned for weak
                                    captures without opening each one. */}
                                <small className={face.sourceWidth !== undefined && face.sourceWidth < 112 ? "thin" : undefined}>
                                  {face.sourceWidth !== undefined ? `${face.sourceWidth}px` : "—"}
                                </small>
                              </button>
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
            <legend>remark in the observation feed</legend>
            <div className="segmented">
              <button
                className={vision?.narrateToFeed !== false ? "seg selected seg-on" : "seg"}
                onClick={() => send({ type: "update-settings", patch: { vision: { narrateToFeed: true } } })}
              >
                on
              </button>
              <button
                className={vision?.narrateToFeed !== false ? "seg" : "seg selected seg-off"}
                onClick={() => send({ type: "update-settings", patch: { vision: { narrateToFeed: false } } })}
              >
                off
              </button>
            </div>
            <small>
              off, I keep watching and the vision pane is unchanged — captures, captions, the timeline
              and recognition all carry on. Only my commentary stops, so a feed you are reading for
              session activity is not interleaved with remarks about the room.
            </small>
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

          <TemplateField
            id="visionPrompt"
            isTemplate={vision?.promptIsTemplate === true}
            label="vision prompt"
            note="my voice over a cycle; I only ever see the descriptions, never the pictures"
            stored={vision?.prompt}
            shipped={DEFAULT_VISION_PROMPT}
            slots={PROMPT_FIELDS.visionPrompt}
            baseline={undefined}
            onApply={(text) =>
              send({ type: "update-settings", patch: { vision: { prompt: text, promptIsTemplate: true } } })
            }
            onReset={() =>
              send({ type: "update-settings", patch: { vision: { prompt: null, promptIsTemplate: true } } })
            }
          />
          {envelope("vision", ["vision-system", "vision-user"])}

          <TemplateField
            id="captionPrompt"
            isTemplate={vision?.captionPromptIsTemplate === true}
            label="caption prompt"
            note="what the captioner is asked of each frame; addressed to a small model, not to me"
            stored={vision?.captionPrompt}
            shipped={DEFAULT_VISION_CAPTION_PROMPT}
            slots={PROMPT_FIELDS.captionPrompt}
            baseline={undefined}
            onApply={(text) =>
              send({
                type: "update-settings",
                patch: { vision: { captionPrompt: text, captionPromptIsTemplate: true } },
              })
            }
            onReset={() =>
              send({
                type: "update-settings",
                patch: { vision: { captionPrompt: null, captionPromptIsTemplate: true } },
              })
            }
          />
          {/* The captioner's own storage is vision-scoped and merged by
              mergeVision; its template is not. Editing the block below writes
              `templates`, not `vision` — the two sit adjacent and are easy to
              conflate. */}
          {envelope("captioner", ["captioner-user"])}

          {phraseBlock("vision-lines", ["sight", "people"])}

          {cheatSheet("vision")}
        </section>

        <section className="settings-group" data-testid="group-chat" hidden={active !== "chat"}>
          <h3>chat</h3>

          <TemplateField
            id="chatDefaultPrompt"
            isTemplate={settings.chatDefaultPromptIsTemplate === true}
            label="default conversation prompt"
            note="copied into each new conversation; existing ones keep the prompt they were made with"
            stored={settings.chatDefaultPrompt}
            shipped={DEFAULT_CHAT_PROMPT}
            slots={PROMPT_FIELDS.chatDefaultPrompt}
            baseline={undefined}
            onApply={(text) =>
              send({ type: "update-settings", patch: { chatDefaultPrompt: text, chatDefaultPromptIsTemplate: true } })
            }
            onReset={() =>
              send({ type: "update-settings", patch: { chatDefaultPrompt: null, chatDefaultPromptIsTemplate: true } })
            }
          />
          {/* Alone among the prompts in the drawer, this one has no wording
              wrapped around it here — it seeds a conversation, and a
              conversation carries its own. Said rather than left blank: every
              other prompt in every other section now has an envelope beneath
              it, so an absence reads as a control that failed to render. */}
          <small className="prompt-aside" data-testid="chat-default-aside">
            nothing wraps this one. it becomes a new conversation's own prompt, and a conversation
            carries its wording with it.
          </small>

          <TemplateField
            id="chatContextPreamble"
            isTemplate={settings.chatContextPreambleIsTemplate === true}
            label="observation context preamble"
            note="what I am told the vision and session context is, ahead of it; blank sends it unintroduced"
            stored={settings.chatContextPreamble}
            shipped={DEFAULT_CONTEXT_PREAMBLE}
            slots={PROMPT_FIELDS.chatContextPreamble}
            baseline={undefined}
            onApply={(text) =>
              send({
                type: "update-settings",
                patch: { chatContextPreamble: text, chatContextPreambleIsTemplate: true },
              })
            }
            onReset={() =>
              send({
                type: "update-settings",
                patch: { chatContextPreamble: null, chatContextPreambleIsTemplate: true },
              })
            }
          />
          {envelope("chat-context", ["chat-context"])}

          <fieldset className="field">
            <legend>what else gets added</legend>
            <small>
              beneath the preamble I assemble these from what I have actually seen and said. The
              readings are live; the wording around them and where each one goes is yours, in the
              block just above. a conversation with both switches on receives this shape:
            </small>
            <pre className="context-shape" data-testid="context-shape">{CONTEXT_SHAPE}</pre>
            <small>
              a source you have switched off contributes nothing, and neither does one with nothing to
              report — no empty headings.
            </small>
          </fieldset>

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

          {cheatSheet("chat")}
        </section>

        {helpOpen ? <TemplateHelp onClose={() => setHelpOpen(false)} /> : null}

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
                {readinessRow("chat backend", state.readiness.chatBackend)}
                {readinessRow("observation backend", state.readiness.observationBackend)}
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
      {zoomed ? (
        <FaceZoom
          src={zoomed.src}
          sourceWidth={zoomed.sourceWidth}
          caption={zoomed.caption}
          onClose={() => setZoomed(null)}
        />
      ) : null}
    </div>
  );
}
