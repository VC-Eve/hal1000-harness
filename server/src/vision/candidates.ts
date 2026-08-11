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
import type { CandidateOverflow, OverflowKind, ShelfMatchTally, VisionCandidate } from "../../../shared/src/types.js";
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
  // How wide the face was in the frame, so the reviewer can tell a distant
  // capture from a close one before confirming it.
  sourceWidth?: number;
  // When the user shelved this one. Absent means it is still in the active
  // queue — the same absent-means-the-original-kind convention `suspected`
  // uses, which is why this needed no migration.
  setAsideAt?: string;
  // When a shelved face was last seen again.
  lastSeenAt?: string;
  // Who this face probably is, when it matched an enrolled person in the hedged
  // band. Absent means nobody was suspected — the original kind of candidate.
  suspected?: { personId: string; name: string; confidence: number };
}

const isShelved = (c: StoredCandidate): boolean => c.setAsideAt !== undefined;

interface CandidateFile {
  candidates: StoredCandidate[];
  overflow: CandidateOverflow;
  // The shelf's own eviction count. Deliberately not the same counter as
  // `overflow`: "faces you set aside were dropped" and "strangers you never
  // looked at were dropped" are different sentences, and the second one's
  // wording points at a limit that did not bite.
  setAsideOverflow?: CandidateOverflow;
  shelfMatches?: ShelfMatchTally;
}

const EMPTY_OVERFLOW: CandidateOverflow = { dropped: 0, since: null };
const EMPTY_MATCHES: ShelfMatchTally = { matched: 0, since: null };

// The store as the service sees it, so tests can fake it rather than writing
// face crops to disk.
// What `take` hands back. `setAside` rides along so a failed enrolment can put
// the face back in the pool it came from.
export interface TakenCandidate {
  embedding: number[];
  thumbnail: Buffer;
  sourceWidth?: number;
  setAside?: boolean;
}

export interface CandidateQueue {
  list(): Promise<VisionCandidate[]>;
  overflow(): CandidateOverflow;
  setAsideOverflow(): CandidateOverflow;
  shelfMatches(): ShelfMatchTally;
  acknowledgeOverflow(which: OverflowKind): Promise<void>;
  count(): Promise<{ pending: number; setAside: number; total: number }>;
  offer(
    embedding: number[],
    thumbnail: Buffer,
    cap: number,
    suspected?: { personId: string; name: string; confidence: number },
    sourceWidth?: number,
  ): Promise<VisionCandidate | null>;
  take(id: string): Promise<TakenCandidate | null>;
  dismiss(id: string): Promise<boolean>;
  setAside(id: string, cap: number): Promise<boolean>;
  restore(id: string, cap: number): Promise<boolean>;
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
      out.push({
        id: c.id,
        at: c.at,
        thumbnail: `data:image/jpeg;base64,${bytes.toString("base64")}`,
        ...(c.suspected ? { suspected: c.suspected } : {}),
        ...(c.sourceWidth ? { sourceWidth: c.sourceWidth } : {}),
        ...(c.setAsideAt ? { setAsideAt: c.setAsideAt } : {}),
        ...(c.lastSeenAt ? { lastSeenAt: c.lastSeenAt } : {}),
      });
    }
    return out;
  }

  overflow(): CandidateOverflow {
    return this.cache?.overflow ?? { ...EMPTY_OVERFLOW };
  }

  setAsideOverflow(): CandidateOverflow {
    return this.cache?.setAsideOverflow ?? { ...EMPTY_OVERFLOW };
  }

  shelfMatches(): ShelfMatchTally {
    return this.cache?.shelfMatches ?? { ...EMPTY_MATCHES };
  }

  /**
   * How many records this store holds, split by pool.
   *
   * Counted from the record rather than from `list()`, which drops entries
   * whose crop has gone missing. A purge confirmation should name what it is
   * about to delete, including anything already half-gone — and it names the
   * two pools separately, because "faces you chose to keep" is the part of an
   * irreversible deletion a user most needs to see before agreeing to it.
   *
   * Through the lock now. It was not, and an offer holding the lock across a
   * purge would load its state before and persist after, putting the deleted
   * faces back on disk. Seconds-old faces made that survivable; a shelf meant
   * to hold them for years does not.
   */
  count(): Promise<{ pending: number; setAside: number; total: number }> {
    return this.withLock(async () => {
      const { candidates } = await this.load();
      const setAside = candidates.filter(isShelved).length;
      return { pending: candidates.length - setAside, setAside, total: candidates.length };
    });
  }

  /**
   * Offer an unrecognised face to the queue.
   *
   * Returns null when it was not kept — either triage is off, or this face is
   * already waiting. Deduplicating here rather than relying on appearance
   * continuity means a fragmented visit still produces one item, which is the
   * property the brief actually asks for.
   */
  private async offerUnlocked(
    embedding: number[],
    thumbnail: Buffer,
    cap: number,
    suspected?: { personId: string; name: string; confidence: number },
    sourceWidth?: number,
  ): Promise<VisionCandidate | null> {
    if (cap <= 0) return null;
    const state = await this.load();
    const now = new Date().toISOString();

    const match = state.candidates.find((c) => cosine(embedding, c.embedding) >= SAME_FACE);
    if (match) {
      // A pending duplicate is simply not kept, as it always was.
      if (!isShelved(match)) return null;

      // A shelved one is a person coming back, and that is worth something.
      // Dropping the arrival silently would freeze the face at whatever
      // capture made it undecidable — which is usually WHY it was shelved —
      // and leave no sign the person had been in the room since.
      match.lastSeenAt = now;
      if (sourceWidth !== undefined && sourceWidth > (match.sourceWidth ?? 0)) {
        await fs.mkdir(this.dir, { recursive: true });
        await fs.writeFile(this.cropPath(match.id), thumbnail);
        match.embedding = embedding;
        match.sourceWidth = sourceWidth;
      }
      const matches = (state.shelfMatches ??= { ...EMPTY_MATCHES });
      matches.matched += 1;
      matches.since ??= now;
      await this.persist(state);
      return null;
    }

    const id = crypto.randomUUID();
    const at = now;
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.cropPath(id), thumbnail);
    state.candidates.push({ id, at, embedding, ...(suspected ? { suspected } : {}), ...(sourceWidth ? { sourceWidth } : {}) });

    // Oldest off the front, and only from the active queue — a shelved face is
    // there because the user put it there, and must not be displaced by a
    // stranger arriving. Counted, because a bound that discards silently tells
    // the user their queue is empty when it was merely full.
    await this.evictPending(state, cap);

    await this.persist(state);
    return {
      id,
      at,
      thumbnail: `data:image/jpeg;base64,${thumbnail.toString("base64")}`,
      ...(suspected ? { suspected } : {}),
      ...(sourceWidth ? { sourceWidth } : {}),
    };
  }

  // Drop the oldest ACTIVE faces until the active pool is within its bound.
  private async evictPending(state: CandidateFile, cap: number): Promise<void> {
    while (state.candidates.filter((c) => !isShelved(c)).length > cap) {
      const dropped = state.candidates.find((c) => !isShelved(c));
      if (!dropped) break;
      state.candidates = state.candidates.filter((c) => c.id !== dropped.id);
      await fs.rm(this.cropPath(dropped.id), { force: true }).catch(() => {});
      state.overflow.dropped += 1;
      state.overflow.since ??= dropped.at;
    }
  }

  /**
   * Drop the longest-shelved faces until the shelf is within its bound.
   *
   * By `setAsideAt`, not by `at`. The array is in first-sighting order, so
   * array order would evict a face first seen in June and shelved this morning
   * ahead of one seen yesterday and shelved last week. A shelf loses what was
   * put down longest ago, not what was photographed longest ago — and the
   * tally's `since` has to read the same way or the notice describes a period
   * in which nobody shelved anything.
   */
  private async evictShelved(state: CandidateFile, cap: number): Promise<void> {
    const overflow = (state.setAsideOverflow ??= { ...EMPTY_OVERFLOW });
    for (;;) {
      const shelved = state.candidates.filter(isShelved).sort((a, b) => (a.setAsideAt! < b.setAsideAt! ? -1 : 1));
      if (shelved.length <= cap) break;
      const dropped = shelved[0];
      if (!dropped) break;
      state.candidates = state.candidates.filter((c) => c.id !== dropped.id);
      await fs.rm(this.cropPath(dropped.id), { force: true }).catch(() => {});
      overflow.dropped += 1;
      overflow.since ??= dropped.setAsideAt!;
    }
  }

  // Shelve one. The face keeps its crop, its embedding and its place in the
  // duplicate check — that last one is the whole feature, since it is what
  // stops the person re-queueing on their next visit.
  private async setAsideUnlocked(id: string, cap: number): Promise<boolean> {
    const state = await this.load();
    const found = state.candidates.find((c) => c.id === id);
    if (!found || isShelved(found)) return false;
    found.setAsideAt = new Date().toISOString();
    await this.evictShelved(state, cap);
    await this.persist(state);
    return true;
  }

  /**
   * Put one back in the active queue.
   *
   * Refuses when the active pool is full rather than evicting to make room.
   * Evicting here would charge a pending face to the overflow tally the user
   * reads as "dropped before you looked at it" — a sentence about a stranger,
   * for a drop the user caused by clicking restore.
   */
  private async restoreUnlocked(id: string, cap: number): Promise<boolean> {
    const state = await this.load();
    const found = state.candidates.find((c) => c.id === id);
    if (!found || !isShelved(found)) return false;
    if (state.candidates.filter((c) => !isShelved(c)).length >= cap) return false;
    delete found.setAsideAt;
    await this.persist(state);
    return true;
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
    // `setAside` travels with it so a failed enrolment can put the face back
    // where it came from. Without it the rollback re-offers a shelved face as
    // pending: the user's deferral is undone, an active slot is consumed, and
    // a real pending face can be evicted and reported as a stranger nobody
    // looked at.
    return {
      embedding: found.embedding,
      thumbnail,
      ...(found.sourceWidth ? { sourceWidth: found.sourceWidth } : {}),
      ...(isShelved(found) ? { setAside: true } : {}),
    };
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

  /**
   * The user has read the tally; reset it.
   *
   * The count exists so an empty queue is never mistaken for a quiet one — it
   * converts "you never learned about someone" into "you learned that N were
   * missed". Once read, it has done that job, and a notice that cannot be
   * cleared stops being read at all. Dropping more faces starts a fresh count,
   * which is the behaviour that keeps it meaningful.
   */
  acknowledgeOverflow(which: OverflowKind): Promise<void> {
    return this.withLock(async () => {
      const state = await this.load();
      if (which === "pending") {
        if (state.overflow.dropped === 0) return;
        state.overflow = { ...EMPTY_OVERFLOW };
      } else if (which === "setAside") {
        if (!state.setAsideOverflow?.dropped) return;
        state.setAsideOverflow = { ...EMPTY_OVERFLOW };
      } else {
        if (!state.shelfMatches?.matched) return;
        state.shelfMatches = { ...EMPTY_MATCHES };
      }
      await this.persist(state);
    });
  }

  // Everything, including every tally — the biometric purge's share of this
  // store. Through the lock, for the reason `count` gives: an offer in flight
  // across a purge used to re-persist what the purge had just deleted.
  clear(): Promise<void> {
    return this.withLock(async () => {
      await fs.rm(this.dir, { recursive: true, force: true }).catch(() => {});
      await this.persist({
        candidates: [],
        overflow: { ...EMPTY_OVERFLOW },
        setAsideOverflow: { ...EMPTY_OVERFLOW },
        shelfMatches: { ...EMPTY_MATCHES },
      });
    });
  }

  // Public surface: one mutation at a time, so an offer landing mid-dismiss
  // cannot resurrect what was just deleted.
  offer(
    embedding: number[],
    thumbnail: Buffer,
    cap: number,
    suspected?: { personId: string; name: string; confidence: number },
    sourceWidth?: number,
  ): Promise<VisionCandidate | null> {
    return this.withLock(() => this.offerUnlocked(embedding, thumbnail, cap, suspected, sourceWidth));
  }

  take(id: string): Promise<TakenCandidate | null> {
    return this.withLock(() => this.takeUnlocked(id));
  }

  dismiss(id: string): Promise<boolean> {
    return this.withLock(() => this.dismissUnlocked(id));
  }

  setAside(id: string, cap: number): Promise<boolean> {
    return this.withLock(() => this.setAsideUnlocked(id, cap));
  }

  restore(id: string, cap: number): Promise<boolean> {
    return this.withLock(() => this.restoreUnlocked(id, cap));
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
