import path from "node:path";
import { promises as fs } from "node:fs";
import type { Settings } from "../../../shared/src/types.js";
import { readJson, writeJsonAtomic } from "./atomic.js";

export const DEFAULT_SETTINGS: Settings = {
  providerEndpoint: "http://localhost:11434",
  chatModel: null,
  narrationModel: null,
  personaIntensity: "medium",
  watchedSessionId: null,
};

export class SettingsStore {
  private readonly file: string;
  private cached: Settings = { ...DEFAULT_SETTINGS };

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "settings.json");
  }

  async load(): Promise<Settings> {
    const stored = await readJson<Partial<Settings>>(this.file);
    this.cached = { ...DEFAULT_SETTINGS, ...stored };
    return this.cached;
  }

  // Settings apply next-request (R18): readers call get() at the moment they
  // need a value; nothing holds a long-lived copy.
  get(): Settings {
    return this.cached;
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    this.cached = { ...this.cached, ...patch };
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await writeJsonAtomic(this.file, this.cached);
    return this.cached;
  }
}
