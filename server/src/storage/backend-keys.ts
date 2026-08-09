// Credentials for the backends HAL sends inference to.
//
// A separate file from `settings.json`, and that separation is the whole point.
// Settings are broadcast wholesale to every connected client on connect and
// after every update; a key stored among them would have to be stripped at
// each of those points, and the failure mode for "a check applied at most
// places" is written down in
// docs/solutions/a-gate-that-checks-one-direction-is-half-a-gate.md. Nothing
// here is ever put on the wire, so there is no redaction to forget.
//
// Stored in plain text. The data directory already holds the per-boot WS token,
// the server binds loopback only, and this is a single-user local tool —
// encrypting a credential beside its own key material would be ceremony rather
// than security. What is enforced instead is narrow and real: the key does not
// reach a client, the inference log, or an error message.

import path from "node:path";
import { promises as fs } from "node:fs";
import { readJson, writeJsonAtomic } from "./atomic.js";

export type BackendSlot = "shared" | "chat";

type Stored = Partial<Record<BackendSlot, string>>;

export class BackendKeyStore {
  private readonly file: string;
  private cached: Stored = {};

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "backend-keys.json");
  }

  async load(): Promise<void> {
    const stored = await readJson<Stored>(this.file);
    // Validated rather than trusted: this file is hand-editable, and a number
    // or an object in a slot would otherwise reach an Authorization header.
    this.cached = {};
    for (const slot of ["shared", "chat"] as const) {
      const value = stored?.[slot];
      if (typeof value === "string" && value.length > 0) this.cached[slot] = value;
    }
  }

  get(slot: BackendSlot): string | undefined {
    return this.cached[slot];
  }

  has(slot: BackendSlot): boolean {
    return this.cached[slot] !== undefined;
  }

  /** A string sets the key; null or an empty string clears it. */
  async set(slot: BackendSlot, key: string | null): Promise<void> {
    const next = typeof key === "string" && key.length > 0 ? key : undefined;
    if (this.cached[slot] === next) return;
    if (next === undefined) delete this.cached[slot];
    else this.cached[slot] = next;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await writeJsonAtomic(this.file, this.cached);
  }
}
