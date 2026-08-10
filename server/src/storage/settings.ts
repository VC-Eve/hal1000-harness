import path from "node:path";
import { promises as fs } from "node:fs";
import {
  ADAPTER_IDS,
  VISION_SENSITIVITIES,
  type AdapterId,
  type AdapterSettings,
  BACKEND_SLOTS,
  type Backends,
  type BackendPatch,
  type BackendSettings,
  type BackendSlot,
  type ChatColors,
  type ProtocolPreference,
  type Settings,
  type SettingsPatch,
  type TemplateBaselines,
  type TemplateSettings,
  type VisionSettings,
  MIN_BAND_SEPARATION,
} from "../../../shared/src/types.js";
import { TEMPLATE_ROLES } from "../../../shared/src/templates.js";
import { forgetAllProtocols } from "../providers/detect.js";
import { forgetWindows } from "../providers/windows.js";
import { BackendKeyStore } from "./backend-keys.js";
import { readJson, writeJsonAtomic } from "./atomic.js";
import { normalizeColor } from "./colors.js";
import { narrationPreset } from "../../../shared/src/prompts.js";

// Defaults preserve the current appearance: the adapter colour is the
// stylesheet's `.feed-entry.narration .feed-text` value and both chat roles
// use `--text`, the colour messages already render in. Nothing changes on
// screen until the user picks something.
const DEFAULT_ADAPTER_COLOR = "#e8c8c2";
const DEFAULT_CHAT_COLOR = "#d6d6d2";

function defaultAdapters(): Record<AdapterId, AdapterSettings> {
  return Object.fromEntries(
    ADAPTER_IDS.map((id) => [id, { enabled: true, color: DEFAULT_ADAPTER_COLOR }]),
  ) as Record<AdapterId, AdapterSettings>;
}

// Off, and pointed at llama.cpp's default loopback port. Nothing here opens a
// camera: Vision touches no device until someone turns it on (R15).
//
// The interval is a minute and the cycle five, which is the shape the feature
// was measured against — a captioner run costs seconds even on CPU, and a desk
// does not change faster than that.
export const DEFAULT_VISION: VisionSettings = {
  enabled: false,
  device: null,
  captionerEndpoint: "http://127.0.0.1:8099",
  intervalSeconds: 60,
  cycleSeconds: 300,
  sensitivity: "medium",
  // On, so Vision behaves as it always has until someone says otherwise.
  narrateToFeed: true,
  // "jade" from the UI palette — a curated value that survives normalization
  // untouched. Distinct from the adapter default and well clear of HAL's red,
  // so a Vision entry is placeable at a glance among the other two roles.
  color: "#5fd3a6",
  retainFrames: 20,
  prompt: null,
  captionPrompt: null,

  // Recognition is off and pointed at the recogniser sidecar's own loopback
  // default. Vision with recognition off behaves exactly as it did before this
  // existed (R1), which is a test rather than an intention.
  recognitionEnabled: false,
  recogniserEndpoint: "http://127.0.0.1:8100",
  // Seconds-scale, three orders of magnitude clear of the ~7.5ms a face
  // actually costs. The reconcile tick is the practical floor.
  detectionIntervalSeconds: 3,
  // Deliberately conservative, and deliberately provisional.
  //
  // This comment used to justify the value against a same-person figure of
  // 0.93. That number does not support it: it was measured over synthetic
  // variants of one frame, so it described the embedder's invariance to
  // rotation and scale rather than agreement between two real captures. See
  // docs/solutions/a-measurement-on-synthetic-variants-measures-your-own-transform.md.
  // Independent captures of one person score 0.53 to 0.78, so 0.5 sits just
  // under the observed floor — which is the right place for a threshold whose
  // job is to admit a real match.
  //
  // What it still does not rest on is different-person similarity, the quantity
  // it actually arbitrates. Two enrolled people in daily use have produced no
  // cross-person false positive here, which bounds the risk for one pair in one
  // room without measuring a ceiling.
  confidenceThreshold: 0.5,
  // Where HAL stops attributing and starts asserting (R2).
  //
  // Provenance matters more than the number here, because the obvious figure is
  // the wrong one. The often-quoted 0.93 same-person similarity was measured
  // over synthetic variants of a single frame — rotated, scaled, shifted — so
  // it measured the embedder's invariance to those transforms rather than
  // whether two real captures of a person agree. See
  // docs/solutions/a-measurement-on-synthetic-variants-measures-your-own-transform.md.
  // Genuinely independent captures score 0.53 to 0.78, and a threshold above
  // that range would simply never fire.
  //
  // What supports 0.6 is use rather than a spike: two enrolled people running
  // against each other daily, with no cross-person false positive seen at the
  // 0.5 recognition threshold. That bounds different-person similarity for one
  // pair in one room — it is not a measured ceiling, which is why this is
  // settable and why the hedged band below it is kept rather than removed.
  statementThreshold: 0.6,
  // Twenty visits' worth of faces to triage. Generous enough that a day is not
  // lost between glances, small enough that the folder stays reviewable.
  candidateFaces: 20,
  // Opt-in. A confirmed uncertain match makes the next match better; a
  // carelessly confirmed one puts the wrong face in someone's gallery and makes
  // false positives more likely, which is a loop that runs backwards.
  queueUncertainMatches: false,
  // Two minutes to halve. At a seconds-scale detection interval a present
  // person saturates quickly, and someone who leaves reads as gone within a few
  // minutes rather than within a frame. Provisional: both identity thresholds
  // needed correcting against real readings and there is no reason to expect
  // these to be different, which is why they are settings.
  weightHalfLifeSeconds: 120,
  weightGain: 0.35,
};

// Both destinations, both configured, both pointing at the same loopback
// server — which is the ordinary single-server setup, arrived at without
// anybody having to turn anything on.
//
// `auto` rather than `ollama`: the default port is Ollama's, but a user who
// replaces the endpoint with llama.cpp's should not also have to know there is
// a protocol to change.
const DEFAULT_ENDPOINT = "http://localhost:11434";

export const DEFAULT_BACKENDS: Backends = {
  chat: { endpoint: DEFAULT_ENDPOINT, protocol: "auto", hasKey: false },
  observation: { endpoint: DEFAULT_ENDPOINT, protocol: "auto", hasKey: false },
};

export const DEFAULT_SETTINGS: Settings = {
  backends: DEFAULT_BACKENDS,
  chatModel: null,
  narrationModel: null,
  // Both prompts start unedited so they track the shipped defaults.
  narrationPrompt: null,
  chatDefaultPrompt: null,
  monitorPrompt: null,
  chatContextPreamble: null,
  personaIntensity: "medium",
  watchedSessionId: null,
  // How much context a chat request may allocate, in tokens.
  //
  // Conservative on purpose. This is what `num_ctx` is set from, and raising it
  // grows the KV cache on the card already holding the chat and narration
  // models — the contention that put the Captioner in its own process. It is a
  // setting rather than a constant because it is about the machine, not about
  // the feature; a model advertising 262,144 tokens does not mean this card can
  // hold them.
  chatContextCap: 8192,
  // Whether the user has been told what identity data leaves the machine, and
  // accepted it. Not a per-Conversation choice: the exposure is the same
  // whichever thread carries it, and the recogniser endpoint is a second route
  // for the same data.
  offMachineAcknowledged: false,
  // Every template unedited, so each resolves to what shipped and a release
  // that improves one reaches an install that left it alone.
  templates: {},
  templateBaselines: {},
  adapters: defaultAdapters(),
  chatColors: { user: DEFAULT_CHAT_COLOR, assistant: DEFAULT_CHAT_COLOR },
  vision: DEFAULT_VISION,
};

// A submitted colour that cannot be parsed is dropped and the prior value
// kept — a malformed colour is not worth an error message in a local tool,
// and silently storing garbage would break the feed instead.
function mergeColor(previous: string, next: string | undefined): string {
  if (next === undefined) return previous;
  return normalizeColor(next) ?? previous;
}

function mergeAdapters(
  base: Record<AdapterId, AdapterSettings>,
  patch: SettingsPatch["adapters"],
): Record<AdapterId, AdapterSettings> {
  // Merged per adapter id, never by replacing the map: a patch carrying one
  // adapter's enabled state must not drop another adapter's stored colour.
  // Iterating the known ids also re-seeds adapters a stored file omits and
  // discards ids that are no longer registered.
  return Object.fromEntries(
    ADAPTER_IDS.map((id) => {
      const previous = base[id] ?? { enabled: true, color: DEFAULT_ADAPTER_COLOR };
      const incoming = patch?.[id];
      return [
        id,
        {
          enabled: incoming?.enabled ?? previous.enabled,
          // Normalization runs even with no incoming colour so a stored value
          // that never passed through update() — a hand-edited file, or one
          // written before the thresholds were tuned — is corrected on load.
          color: normalizeColor(mergeColor(previous.color, incoming?.color)) ?? DEFAULT_ADAPTER_COLOR,
        },
      ];
    }),
  ) as Record<AdapterId, AdapterSettings>;
}

// null is meaningful (reset to "never edited"); undefined preserves; a string
// is taken verbatim. Anything else is garbage from a hand-edited file and is
// dropped in favour of what was already stored.
function mergePrompt(previous: string | null, next: string | null | undefined): string | null {
  if (next === undefined) return previous;
  if (next === null) return null;
  return typeof next === "string" ? next : previous;
}

// Bounds are floors and ceilings, not validation errors: this file is
// hand-editable and a client can send anything, and a zero-second interval
// would capture in a loop rather than fail loudly.
function clamp(next: unknown, previous: number, min: number, max: number): number {
  if (typeof next !== "number" || !Number.isFinite(next)) return previous;
  return Math.min(max, Math.max(min, Math.round(next)));
}

/**
 * Whether this is a keyed object rather than a string, an array, or null.
 *
 * Both sides of a template merge need it. `settings.json` is hand-editable, so
 * `"templates": "abc"` is reachable — spread it and you store
 * `{0:"a",1:"b",2:"c"}`, and the `in` test that follows throws on a string
 * outright, taking the settings load with it.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge the template map per role.
 *
 * Same three-way rule the prompts follow — null resets to "never edited",
 * undefined preserves, a string is taken verbatim — applied one role at a time
 * so setting the Monitor's template cannot drop the chat context's.
 */
function mergeTemplates(base: TemplateSettings | undefined, patch: SettingsPatch["templates"]): TemplateSettings {
  // Only an object is spread. A hand-edited `"templates": "abc"` would
  // otherwise spread into `{0:"a",1:"b",2:"c"}` and be written back in that
  // shape, the way `mergeBaselines` already refuses a malformed baseline.
  const out: TemplateSettings = isPlainObject(base) ? { ...base } : {};
  if (!isPlainObject(patch)) return out;
  for (const role of TEMPLATE_ROLES) {
    if (!(role in patch)) continue;
    const next = patch[role];
    if (next === null) {
      delete out[role];
      continue;
    }
    if (typeof next === "string") out[role] = next;
  }
  return out;
}

/** Baselines merge per role too; null forgets one. */
function mergeBaselines(
  base: TemplateBaselines | undefined,
  patch: SettingsPatch["templateBaselines"],
): TemplateBaselines {
  const out: TemplateBaselines = isPlainObject(base) ? { ...base } : {};
  if (!isPlainObject(patch)) return out;
  for (const role of TEMPLATE_ROLES) {
    if (!(role in patch)) continue;
    const next = patch[role];
    if (next === null) {
      delete out[role];
      continue;
    }
    // A hand-edited file can put anything here; a baseline that is not a pair
    // of strings is no baseline and is dropped rather than stored.
    if (next && typeof next.text === "string" && typeof next.shippedDefault === "string") {
      out[role] = { text: next.text, shippedDefault: next.shippedDefault };
    }
  }
  return out;
}

function mergeVision(base: VisionSettings, patch: SettingsPatch["vision"]): VisionSettings {
  const sensitivity =
    patch?.sensitivity !== undefined && VISION_SENSITIVITIES.includes(patch.sensitivity)
      ? patch.sensitivity
      : base.sensitivity;
  return {
    enabled: typeof patch?.enabled === "boolean" ? patch.enabled : base.enabled,
    // Null is meaningful — "whatever camera this OS lists first" — so it is
    // preserved rather than treated as absent.
    device: patch?.device === undefined ? base.device : (patch.device ?? null),
    captionerEndpoint:
      typeof patch?.captionerEndpoint === "string" && patch.captionerEndpoint.trim()
        ? patch.captionerEndpoint.trim()
        : base.captionerEndpoint,
    // A capture costs a captioner run, so the floor is well above zero. The
    // cycle floor matches it: a cycle shorter than an interval would summarise
    // one observation at a time and turn the sensitivity dial into a no-op.
    intervalSeconds: clamp(patch?.intervalSeconds, base.intervalSeconds, 5, 3_600),
    cycleSeconds: clamp(patch?.cycleSeconds, base.cycleSeconds, 10, 21_600),
    sensitivity,
    // Absent reads as on, so a settings file written before this existed keeps
    // behaving the way it did.
    narrateToFeed: typeof patch?.narrateToFeed === "boolean" ? patch.narrateToFeed : (base.narrateToFeed ?? true),
    // Normalized on every merge, like the adapter and chat colours: a stored
    // value written before normalization existed is corrected on load.
    color: normalizeColor(mergeColor(base.color, patch?.color)) ?? DEFAULT_VISION.color,
    retainFrames: clamp(patch?.retainFrames, base.retainFrames, 0, 500),
    prompt: mergePrompt(base.prompt, patch?.prompt),
    captionPrompt: mergePrompt(base.captionPrompt, patch?.captionPrompt),

    // Stored independently of `enabled`. Recognition does nothing while Vision
    // is off, but the preference must survive the toggle — losing it every
    // time the camera is released would make the setting feel broken.
    recognitionEnabled:
      typeof patch?.recognitionEnabled === "boolean" ? patch.recognitionEnabled : base.recognitionEnabled,
    recogniserEndpoint:
      typeof patch?.recogniserEndpoint === "string" && patch.recogniserEndpoint.trim()
        ? patch.recogniserEndpoint.trim()
        : base.recogniserEndpoint,
    // Floored at the reconcile tick: asking for faster than the loop can
    // reconcile would store a number the system cannot honour.
    detectionIntervalSeconds: clamp(
      patch?.detectionIntervalSeconds,
      base.detectionIntervalSeconds,
      MIN_DETECTION_INTERVAL_SECONDS,
      3_600,
    ),
    // A threshold of 0 would match everyone to the first person in the gallery,
    // which is exactly the guess R9 forbids, so the floor is above it.
    // The pair is resolved together below — see `separateBands`.
    ...separateBands(
      clampFloat(patch?.confidenceThreshold, base.confidenceThreshold, 0.05, 0.99),
      clampFloat(patch?.statementThreshold, base.statementThreshold, 0.1, 0.99),
    ),
    // Zero is meaningful — triage off, nothing kept — so the floor is zero
    // rather than one.
    candidateFaces: clamp(patch?.candidateFaces, base.candidateFaces, 0, 500),
    queueUncertainMatches:
      typeof patch?.queueUncertainMatches === "boolean" ? patch.queueUncertainMatches : base.queueUncertainMatches,
    // A half-life of zero would make weight meaningless rather than fast, so
    // the floor is above it.
    weightHalfLifeSeconds: clamp(patch?.weightHalfLifeSeconds, base.weightHalfLifeSeconds, 5, 86_400),
    weightGain: clampFloat(patch?.weightGain, base.weightGain, 0.01, 1),
  };
}

// The reconcile tick is two seconds, so detection cannot meaningfully run
// faster than that. Declared here because it is a settings constraint; the loop
// imports it rather than the other way round.
export const MIN_DETECTION_INTERVAL_SECONDS = 2;

// The highest either threshold may reach. Above this a real match essentially
// never lands, which turns recognition off by arithmetic rather than by a
// toggle the user can see.
const MAX_THRESHOLD = 0.99;

/**
 * Resolve the two thresholds together, keeping a hedged band between them.
 *
 * The first cross-field rule in this file — every other is per-field and
 * independent — so it runs after both values are individually clamped, and it
 * has to cope with a patch carrying either one or both.
 *
 * The statement threshold yields first, because it is the one this feature
 * added and the recognition threshold is what decides whether a face is
 * recognised at all. Only when raising it would breach the ceiling does the
 * recognition threshold come down instead.
 */
function separateBands(
  recognition: number,
  statement: number,
): { confidenceThreshold: number; statementThreshold: number } {
  // Written as acceptance rather than `statement < recognition + sep`.
  // `NaN` fails every comparison, so the negated form would treat a non-finite
  // value as a satisfied constraint and let it through — the exact shape of the
  // bug recorded in
  // docs/solutions/a-threshold-guard-written-as-a-negation-fails-open-on-nan.md.
  // `clampFloat` already rejects non-finite input; this is the second lock on a
  // door that decides whether a human gets named.
  const wide = (lo: number, hi: number): boolean => hi >= lo + MIN_BAND_SEPARATION;

  if (wide(recognition, statement)) return round(recognition, statement);

  const raised = recognition + MIN_BAND_SEPARATION;
  if (raised <= MAX_THRESHOLD) return round(recognition, raised);

  // The statement threshold cannot go higher, so the recognition threshold
  // gives way instead. Both stay inside the ceiling and the band survives.
  return round(MAX_THRESHOLD - MIN_BAND_SEPARATION, MAX_THRESHOLD);
}

// Float addition leaves 0.55000000000000004 in a settings file a user may open
// and edit by hand.
function round(recognition: number, statement: number): { confidenceThreshold: number; statementThreshold: number } {
  const to4 = (n: number): number => Math.round(n * 10_000) / 10_000;
  return { confidenceThreshold: to4(recognition), statementThreshold: to4(statement) };
}

// Like `clamp` but without rounding to an integer — a similarity threshold is
// fractional by nature. A non-finite value keeps the previous one, matching how
// a malformed colour is handled rather than erroring at a settings patch.
function clampFloat(next: unknown, previous: number, min: number, max: number): number {
  if (typeof next !== "number" || !Number.isFinite(next)) return previous;
  return Math.min(max, Math.max(min, next));
}

function mergeChatColors(base: ChatColors, patch: SettingsPatch["chatColors"]): ChatColors {
  const role = (key: keyof ChatColors) =>
    normalizeColor(mergeColor(base[key], patch?.[key])) ?? DEFAULT_CHAT_COLOR;
  return { user: role("user"), assistant: role("assistant") };
}

// Bounds on the allocation cap. The floor is the fallback window — a cap below
// it would make every budget zero and quietly disable the feature rather than
// reporting anything. The ceiling is the largest window any local model here
// advertises; above that the cap stops meaning anything, since the model's own
// window is always the smaller of the two.
const MIN_CONTEXT_CAP = 2048;
const MAX_CONTEXT_CAP = 262_144;

function normalizeCap(next: unknown, previous: number): number {
  if (next === undefined) return previous;
  if (typeof next !== "number" || !Number.isFinite(next)) return previous;
  return Math.min(MAX_CONTEXT_CAP, Math.max(MIN_CONTEXT_CAP, Math.floor(next)));
}

// One merge for both paths: load merges the stored file onto the defaults,
// update merges the client patch onto the cached settings. Both normalize.
const PROTOCOL_PREFERENCES: readonly ProtocolPreference[] = ["auto", "ollama", "openai"];

function isProtocol(value: unknown): value is ProtocolPreference {
  return PROTOCOL_PREFERENCES.includes(value as ProtocolPreference);
}

/**
 * A slot name that names a slot.
 *
 * Acceptance-shaped for the same reason `isProtocol` is, and for a sharper one:
 * `copyFrom` arrives over the wire and is used as an index into both the
 * backends map and the key store. An unrecognised name indexes to undefined,
 * which spreads into a backend with no endpoint and is then written to disk —
 * a settings file that throws on every read, from a single typo.
 */
function isSlot(value: unknown): value is BackendSlot {
  return BACKEND_SLOTS.includes(value as BackendSlot);
}

/**
 * One backend slot, merged per field.
 *
 * `apiKey` is deliberately not read here. It never lives in settings — the
 * store lifts it out of the patch and hands it to `BackendKeyStore` — and
 * `hasKey` is set from that store rather than from anything a client sent, so
 * a client cannot claim a key exists by saying so.
 */
function mergeBackend(base: BackendSettings, patch: BackendPatch | undefined): BackendSettings {
  if (!patch) return base;
  return {
    endpoint: typeof patch.endpoint === "string" ? patch.endpoint.trim() : base.endpoint,
    // Acceptance-shaped, like the colour and the context cap: this file is
    // hand-editable, and an unrecognised protocol reaching the factory would be
    // a switch with no matching arm.
    protocol: isProtocol(patch.protocol) ? patch.protocol : base.protocol,
    hasKey: base.hasKey,
  };
}

/**
 * Copy resolves before the field merge, so an explicit endpoint in the same
 * patch still wins over what was copied. The key half is handled by the store,
 * which is the only place that holds one.
 */
function mergeBackends(base: Backends, patch: SettingsPatch["backends"]): Backends {
  const next = {} as Backends;
  for (const slot of BACKEND_SLOTS) {
    const requested = patch?.[slot]?.copyFrom;
    const from = isSlot(requested) && requested !== slot ? requested : undefined;
    const start = from ? (base[from] ?? DEFAULT_BACKENDS[from]) : (base[slot] ?? DEFAULT_BACKENDS[slot]);
    next[slot] = mergeBackend({ ...start, hasKey: (base[slot] ?? DEFAULT_BACKENDS[slot]).hasKey }, patch?.[slot]);
  }
  return next;
}

function merge(base: Settings, patch: SettingsPatch): Settings {
  // Keys are listed rather than spread so the nested maps cannot be replaced
  // wholesale, and so an explicit undefined never erases a stored value —
  // null is a meaningful value for the model and session fields.
  const keep = <T>(next: T | undefined, previous: T): T => (next === undefined ? previous : next);
  return {
    backends: mergeBackends(base.backends ?? DEFAULT_BACKENDS, patch.backends),
    chatModel: keep(patch.chatModel, base.chatModel),
    narrationModel: keep(patch.narrationModel, base.narrationModel),
    // keep() gives reset for free: a patch carrying null clears the prompt back
    // to "never edited", and one omitting the key leaves it alone. mergePrompt
    // additionally drops a non-string, the way a malformed colour is dropped —
    // this file is user-editable and a number here would otherwise be stamped
    // onto every new conversation.
    narrationPrompt: mergePrompt(base.narrationPrompt, patch.narrationPrompt),
    chatDefaultPrompt: mergePrompt(base.chatDefaultPrompt, patch.chatDefaultPrompt),
    monitorPrompt: mergePrompt(base.monitorPrompt, patch.monitorPrompt),
    chatContextPreamble: mergePrompt(base.chatContextPreamble, patch.chatContextPreamble),
    personaIntensity: keep(patch.personaIntensity, base.personaIntensity),
    watchedSessionId: keep(patch.watchedSessionId, base.watchedSessionId),
    // Validated rather than kept: this file is hand-editable, and a cap that
    // arrived as a string or NaN would reach `num_ctx` and size every budget in
    // the app. Acceptance-shaped, so a non-number falls back rather than
    // slipping past a negated comparison.
    chatContextCap: normalizeCap(patch.chatContextCap, base.chatContextCap),
    offMachineAcknowledged: patch.offMachineAcknowledged === undefined
      ? base.offMachineAcknowledged
      : patch.offMachineAcknowledged === true,
    adapters: mergeAdapters(base.adapters, patch.adapters),
    chatColors: mergeChatColors(base.chatColors, patch.chatColors),
    // Merged per field for the same reason the adapter map is: a patch turning
    // Vision on must not drop a tuned interval or an edited prompt.
    vision: mergeVision(base.vision ?? DEFAULT_VISION, patch.vision),
    templates: mergeTemplates(base.templates, patch.templates),
    templateBaselines: mergeBaselines(base.templateBaselines, patch.templateBaselines),
  };
}

// What a settings file written before backends existed looked like. Read only
// by the migration below.
// Shapes this file has held before. Read only by the migrations in `load`.
interface LegacySettings {
  // One endpoint for everything, before backends existed.
  providerEndpoint?: unknown;
  backends?: {
    // The observation slot's earlier name, when chat was an override switched
    // off by default rather than a destination of its own.
    shared?: { endpoint?: unknown; protocol?: unknown };
    chat?: { endpoint?: unknown; enabled?: unknown };
  };
}

export class SettingsStore {
  private readonly file: string;
  private cached: Settings = merge(DEFAULT_SETTINGS, {});
  private readonly keys: BackendKeyStore;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "settings.json");
    this.keys = new BackendKeyStore(dataDir);
  }

  /**
   * The credential for one backend, for the resolver alone.
   *
   * The only way out of the key store, and it returns to the server rather than
   * to a client: nothing that reaches `hub.broadcast` calls this.
   */
  keyFor(slot: BackendSlot): string | undefined {
    return this.keys.get(slot);
  }

  async load(): Promise<Settings> {
    const stored = await readJson<SettingsPatch & LegacySettings>(this.file);
    await this.keys.load();
    this.cached = this.withKeyFlags(merge(DEFAULT_SETTINGS, stored ?? {}));

    // Upgrade path 1: one `providerEndpoint` string became a set of backends.
    // Keyed on the absence of `backends` rather than on the presence of the old
    // field, so an installation that has already migrated is never re-read —
    // the same shape as the personaIntensity migration below.
    if (stored && !("backends" in stored) && typeof stored.providerEndpoint === "string") {
      const endpoint = stored.providerEndpoint;
      await this.update({ backends: { chat: { endpoint }, observation: { endpoint } } });
    }

    // Upgrade path 2: the observation slot was `shared`, and chat was an
    // override that was off by default and could hold a blank endpoint. Both
    // destinations are now first-class, so the old shared endpoint becomes the
    // observation one, and chat inherits it unless it had a real endpoint of
    // its own — a disabled override pointing somewhere was still a statement
    // about where chat should go, and dropping it would lose a choice.
    const legacyShared = stored?.backends?.shared;
    if (legacyShared && typeof legacyShared.endpoint === "string") {
      const observation = { endpoint: legacyShared.endpoint, ...(isProtocol(legacyShared.protocol) ? { protocol: legacyShared.protocol } : {}) };
      const priorChat = stored?.backends?.chat;
      const chatEndpoint =
        typeof priorChat?.endpoint === "string" && priorChat.endpoint.trim().length > 0
          ? priorChat.endpoint
          : legacyShared.endpoint;
      await this.update({ backends: { observation, chat: { endpoint: chatEndpoint } } });
    }
    // Upgrade path: before prompts existed, personaIntensity chose the
    // narration wording. Leaving it unedited would silently move a low/high
    // user to the medium voice, so their intensity is converted once into the
    // matching prompt. Keyed on the absence of the key rather than a null
    // value, so a later deliberate reset is never re-migrated.
    if (stored && !("narrationPrompt" in stored) && this.cached.personaIntensity !== "medium") {
      const preset = narrationPreset(this.cached.personaIntensity === "low" ? "plain" : "full");
      if (preset) await this.update({ narrationPrompt: preset.text });
    }
    return this.cached;
  }

  // Settings apply next-request (R18): readers call get() at the moment they
  // need a value; nothing holds a long-lived copy.
  get(): Settings {
    return this.cached;
  }

  async update(patch: SettingsPatch): Promise<Settings> {
    // Credentials are lifted out of the patch before anything is merged, so
    // there is no window in which one exists inside a `Settings` object. The
    // file written below is the same object that gets broadcast.
    for (const slot of BACKEND_SLOTS) {
      const request = patch.backends?.[slot];
      if (!request) continue;
      // Copy first, so an explicit key in the same patch still wins. A copy
      // moves the credential too — that is the whole reason this happens
      // server-side, since a client is never told one and could not copy it.
      if (isSlot(request.copyFrom) && request.copyFrom !== slot) {
        await this.keys.set(slot, this.keys.get(request.copyFrom) ?? null);
      }
      if (request.apiKey !== undefined) await this.keys.set(slot, request.apiKey);
    }
    this.cached = this.withKeyFlags(merge(this.cached, patch));
    // Every remembered protocol is dropped, because applying settings is the
    // gesture a user makes after changing what is listening. The endpoint need
    // not have changed for the answer to have: stopping Ollama and starting
    // llama-server on the same port is the swap this app exists to allow, and
    // a cache with no way to be wrong would answer `ollama` until a restart.
    // Re-probing costs one round trip per endpoint, paid on a keystroke nobody
    // is waiting behind.
    forgetAllProtocols();
    // And every remembered window, for the same reason and the same swap: the
    // llama-server that replaced Ollama on that port fixed its `n_ctx` at
    // launch, and a window cached from the previous occupant would size the
    // next request against a number nobody is serving.
    forgetWindows();
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await writeJsonAtomic(this.file, this.cached);
    return this.cached;
  }

  /**
   * Stamp `hasKey` from the key store.
   *
   * Derived rather than merged, so a client cannot assert that a key exists by
   * sending the flag, and so the flag cannot drift from the file that actually
   * holds the credential.
   */
  private withKeyFlags(settings: Settings): Settings {
    const backends = {} as Backends;
    for (const slot of BACKEND_SLOTS) {
      backends[slot] = { ...settings.backends[slot], hasKey: this.keys.has(slot) };
    }
    return { ...settings, backends };
  }
}
