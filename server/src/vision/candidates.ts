// Faces waiting to be named.
//
// The brief refuses a standing gallery of unrecognised people — that would
// mean HAL holding biometric data for people who never agreed to it. What it
// allows is a pending item: a face kept so the user can decide, and gone the
// moment they do. Naming it enrols the person; dismissing it deletes the crop
// and records nothing. Neither outcome leaves a trace of someone who merely
// walked past, and that is the whole difference between a queue and a gallery.
//
// This one persists until triaged. No expiry sweep yet, which is a deliberate
// departure from the brief's R14 and is recorded in
// docs/residual-review-findings/feat-enrolment-candidates.md. The bound is
// what stops it growing without limit, and because a bound silently discards,
// what it discarded is counted.

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CandidateOverflow, VisionCandidate } from "../../../shared/src/types.js";
import { readJson, writeJsonAtomic } from "../storage/atomic.js";
import { cosine } from "./recogniser.js";

// Above this, a new face is someone already waiting rather than a new visitor.
//
// This is what makes "one visit is one queue item" hold even when appearance
// continuity fragments a visit — the brief warns the queue would otherwise
// fill with a hundred crops of a single person. Deliberately looser than the
// identity threshold: over-merging costs one queue item, while under-merging
// costs the flood.
const SAME_FACE = 0.45;

interface StoredCandidate {
  id: string;
  at: string;
  embedding: number[];
}

interface CandidateFile {
  candidates: StoredCandidate[];
  overflow: CandidateOverflow;
}

const EMPTY_OVERFLOW: CandidateOverflow = { dropped: 0, since: null };

// The store as the service sees it, so tests can fake it rather than writing
// face crops to disk.
export interface CandidateQueue {
  list(): Promise<VisionCandidate[]>;
  overflow(): CandidateOverflow;
  count(): Promise<number>;
  offer(embedding: number[], thumbnail: Buffer, cap: number): Promise<VisionCandidate | null>;
  take(id: string): Promise<{ embedding: number[]; thumbnail: Buffer } | null>;
  dismiss(id: string): Promise<boolean>;
  clear(): Promise<void>;
}

export class CandidateStore implements CandidateQueue {
  private readonly file: string;
  private readonly dir: string;
  private cache: CandidateFile | null = null;
  // Same reason as `PeopleStore`: every mutation is load-modify-write, the
  // detection loop offers while the user dismisses, and nothing upstream
  // serialises them.
  private chain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "vision-candidates.json");
    this.dir = path.join(dataDir, "vision-candidates");
  }

  private async load(): Promise<CandidateFile> {
    if (this.cache) return this.cache;
    const stored = await readJson<CandidateFile>(this.file).catch(() => null);
    if (stored && !Array.isArray(stored.candidates)) {
      console.error(`vision candidates file at ${this.file} is unreadable; starting empty`);
      this.cache = { candidates: [], overflow: { ...EMPTY_OVERFLOW } };
      return this.cache;
    }
    this.cache = {
      candidates: stored?.candidates ?? [],
      overflow: stored?.overflow ?? { ...EMPTY_OVERFLOW },
    };
    return this.cache;
  }

  async list(): Promise<VisionCandidate[]> {
    const { candidates } = await this.load();
    const out: VisionCandidate[] = [];
    // Newest first: the face you just saw is the one you are most likely to be
    // able to name.
    for (const c of [...candidates].reverse()) {
      const bytes = await fs.readFile(this.cropPath(c.id)).catch(() => null);
      if (!bytes) continue;
      out.push({ id: c.id, at: c.at, thumbnail: `data:image/jpeg;base64,${bytes.toString("base64")}` });
    }
    return out;
  }

  overflow(): CandidateOverflow {
    return this.cache?.overflow ?? { ...EMPTY_OVERFLOW };
  }

  // Counted from the record rather than from `list()`, which drops entries
  // whose crop has gone missing. A purge confirmation should name what it is
  // about to delete, including anything already half-gone.
  async count(): Promise<number> {
    const { candidates } = await this.load();
    return candidates.length;
  }

  /**
   * Offer an unrecognised face to the queue.
   *
   * Returns null when it was not kept — either triage is off, or this face is
   * already waiting. Deduplicating here rather than relying on appearance
   * continuity means a fragmented visit still produces one item, which is the
   * property the brief actually asks for.
   */
  private async offerUnlocked(embedding: number[], thumbnail: Buffer, cap: number): Promise<VisionCandidate | null> {
    if (cap <= 0) return null;
    const state = await this.load();

    for (const existing of state.candidates) {
      if (cosine(embedding, existing.embedding) >= SAME_FACE) return null;
    }

    const id = crypto.randomUUID();
    const at = new Date().toISOString();
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.cropPath(id), thumbnail);
    state.candidates.push({ id, at, embedding });

    // Oldest off the front. Counted, because a bound that discards silently
    // tells the user their queue is empty when it was merely full.
    while (state.candidates.length > cap) {
      const dropped = state.candidates.shift();
      if (!dropped) break;
      await fs.rm(this.cropPath(dropped.id), { force: true }).catch(() => {});
      state.overflow.dropped += 1;
      state.overflow.since ??= dropped.at;
    }

    await this.persist(state);
    return { id, at, thumbnail: `data:image/jpeg;base64,${thumbnail.toString("base64")}` };
  }

  // Remove and return one, for enrolment. Taking rather than reading: a
  // candidate that becomes a person must stop being a candidate in the same
  // step, or a moment's failure leaves the same face in both places.
  private async takeUnlocked(id: string): Promise<{ embedding: number[]; thumbnail: Buffer } | null> {
    const state = await this.load();
    const found = state.candidates.find((c) => c.id === id);
    if (!found) return null;

    // Read the crop before removing it: it becomes the enrolled person's face
    // in the roster, so it moves rather than being deleted and re-made.
    const thumbnail = (await fs.readFile(this.cropPath(id)).catch(() => null)) ?? Buffer.alloc(0);

    state.candidates = state.candidates.filter((c) => c.id !== id);
    await this.persist(state);
    await fs.rm(this.cropPath(id), { force: true }).catch(() => {});
    return { embedding: found.embedding, thumbnail };
  }

  // Dismissal. The item and its crop go, and nothing about the face is kept.
  private async dismissUnlocked(id: string): Promise<boolean> {
    const state = await this.load();
    if (!state.candidates.some((c) => c.id === id)) return false;
    state.candidates = state.candidates.filter((c) => c.id !== id);
    await this.persist(state);
    await fs.rm(this.cropPath(id), { force: true }).catch((err: unknown) => {
      console.error(`vision: could not delete candidate crop ${id}: ${err instanceof Error ? err.message : String(err)}`);
    });
    return true;
  }

  // Everything, including the overflow tally — the biometric purge's share of
  // this store.
  async clear(): Promise<void> {
    this.cache = { candidates: [], overflow: { ...EMPTY_OVERFLOW } };
    await fs.rm(this.dir, { recursive: true, force: true }).catch(() => {});
    await writeJsonAtomic(this.file, this.cache);
  }

  // Public surface: one mutation at a time, so an offer landing mid-dismiss
  // cannot resurrect what was just deleted.
  offer(embedding: number[], thumbnail: Buffer, cap: number): Promise<VisionCandidate | null> {
    return this.withLock(() => this.offerUnlocked(embedding, thumbnail, cap));
  }

  take(id: string): Promise<{ embedding: number[]; thumbnail: Buffer } | null> {
    return this.withLock(() => this.takeUnlocked(id));
  }

  dismiss(id: string): Promise<boolean> {
    return this.withLock(() => this.dismissUnlocked(id));
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private cropPath(id: string): string {
    return path.join(this.dir, `${id}.jpg`);
  }

  private async persist(state: CandidateFile): Promise<void> {
    this.cache = state;
    await writeJsonAtomic(this.file, state);
  }
}
