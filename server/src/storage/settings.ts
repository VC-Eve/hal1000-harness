import path from "node:path";
import { promises as fs } from "node:fs";
import {
  ADAPTER_IDS,
  VISION_SENSITIVITIES,
  type AdapterId,
  type AdapterSettings,
  type ChatColors,
  type Settings,
  type SettingsPatch,
  type VisionSettings,
} from "../../../shared/src/types.js";
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
  // The warp measured same-person similarity floored at 0.93 and a non-face at
  // 0.21, but different-person-versus-same-person — the discrimination this
  // number actually arbitrates — is untested, because only one face has ever
  // been available. So this sits well above SFace's published same-identity
  // figure and well below the measured same-person floor, and errs toward
  // "unrecognised": the failure mode is "does not know you", never "calls you
  // by someone else's name". Calibrating it needs a second enrolled face, not
  // more code.
  confidenceThreshold: 0.5,
  // Twenty visits' worth of faces to triage. Generous enough that a day is not
  // lost between glances, small enough that the folder stays reviewable.
  candidateFaces: 20,
};

export const DEFAULT_SETTINGS: Settings = {
  providerEndpoint: "http://localhost:11434",
  chatModel: null,
  narrationModel: null,
  // Both prompts start unedited so they track the shipped defaults.
  narrationPrompt: null,
  chatDefaultPrompt: null,
  monitorPrompt: null,
  personaIntensity: "medium",
  watchedSessionId: null,
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
    confidenceThreshold: clampFloat(patch?.confidenceThreshold, base.confidenceThreshold, 0.05, 0.99),
    // Zero is meaningful — triage off, nothing kept — so the floor is zero
    // rather than one.
    candidateFaces: clamp(patch?.candidateFaces, base.candidateFaces, 0, 500),
  };
}

// The reconcile tick is two seconds, so detection cannot meaningfully run
// faster than that. Declared here because it is a settings constraint; the loop
// imports it rather than the other way round.
export const MIN_DETECTION_INTERVAL_SECONDS = 2;

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

// One merge for both paths: load merges the stored file onto the defaults,
// update merges the client patch onto the cached settings. Both normalize.
function merge(base: Settings, patch: SettingsPatch): Settings {
  // Keys are listed rather than spread so the nested maps cannot be replaced
  // wholesale, and so an explicit undefined never erases a stored value —
  // null is a meaningful value for the model and session fields.
  const keep = <T>(next: T | undefined, previous: T): T => (next === undefined ? previous : next);
  return {
    providerEndpoint: keep(patch.providerEndpoint, base.providerEndpoint),
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
    personaIntensity: keep(patch.personaIntensity, base.personaIntensity),
    watchedSessionId: keep(patch.watchedSessionId, base.watchedSessionId),
    adapters: mergeAdapters(base.adapters, patch.adapters),
    chatColors: mergeChatColors(base.chatColors, patch.chatColors),
    // Merged per field for the same reason the adapter map is: a patch turning
    // Vision on must not drop a tuned interval or an edited prompt.
    vision: mergeVision(base.vision ?? DEFAULT_VISION, patch.vision),
  };
}

export class SettingsStore {
  private readonly file: string;
  private cached: Settings = merge(DEFAULT_SETTINGS, {});

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "settings.json");
  }

  async load(): Promise<Settings> {
    const stored = await readJson<SettingsPatch>(this.file);
    this.cached = merge(DEFAULT_SETTINGS, stored ?? {});
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
    this.cached = merge(this.cached, patch);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await writeJsonAtomic(this.file, this.cached);
    return this.cached;
  }
}
