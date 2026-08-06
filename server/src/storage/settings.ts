import path from "node:path";
import { promises as fs } from "node:fs";
import {
  ADAPTER_IDS,
  type AdapterId,
  type AdapterSettings,
  type ChatColors,
  type Settings,
  type SettingsPatch,
} from "../../../shared/src/types.js";
import { readJson, writeJsonAtomic } from "./atomic.js";
import { normalizeColor } from "./colors.js";

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

export const DEFAULT_SETTINGS: Settings = {
  providerEndpoint: "http://localhost:11434",
  chatModel: null,
  narrationModel: null,
  // Both prompts start unedited so they track the shipped defaults.
  narrationPrompt: null,
  chatDefaultPrompt: null,
  personaIntensity: "medium",
  watchedSessionId: null,
  adapters: defaultAdapters(),
  chatColors: { user: DEFAULT_CHAT_COLOR, assistant: DEFAULT_CHAT_COLOR },
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
    // to "never edited", and one omitting the key leaves it alone.
    narrationPrompt: keep(patch.narrationPrompt, base.narrationPrompt),
    chatDefaultPrompt: keep(patch.chatDefaultPrompt, base.chatDefaultPrompt),
    personaIntensity: keep(patch.personaIntensity, base.personaIntensity),
    watchedSessionId: keep(patch.watchedSessionId, base.watchedSessionId),
    adapters: mergeAdapters(base.adapters, patch.adapters),
    chatColors: mergeChatColors(base.chatColors, patch.chatColors),
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
