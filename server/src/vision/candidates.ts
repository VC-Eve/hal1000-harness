// Faces waiting to be named, and faces the user set aside to decide about
// later. Two pools, one collection, told apart by `setAsideAt`.
//
// The brief refused a standing gallery of unrecognised people: HAL holding
// biometric data for people who never agreed to it. A pending item was the
// answer — a face kept so the user can decide, and gone the moment they do.
// Naming it enrols the person; dismissing it deletes the crop and records
// nothing.
//
// The shelf inverts that, and this file is where it happens, so say it plainly:
// HAL now keeps a bounded pool of unnamed faces indefinitely. There is no
// third outcome that ends a shelved item on its own. It waits until the user
// names it, dismisses it, or the shelf's own bound evicts it. That is a gallery
// of unrecognised people, kept deliberately, because the user was offered a
// bounded clock instead and chose retention.
//
// What is left of the original property is that it is bounded, visible, counted
// and separately tallied — not that neglect empties it. Nothing here expires:
// the brief's R14 is still unbuilt and is now owed against two pools rather
// than one, recorded in
// docs/residual-review-findings/feat-enrolment-candidates.md.

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CandidateOverflow, OverflowKind, ShelfMatchTally, VisionCandidate } from "../../../shared/src/types.js";
import { readJson, writeFileAtomic, writeJsonAtomic } from "../storage/atomic.js";
import { cosine } from "./recogniser.js";

// Above this, a new face is someone already waiting rather than a new visitor.
//
// This is what makes "one visit is one queue item" hold even when appearance
// continuity fragments a visit — the brief warns the queue would otherwise
// fill with a hundred crops of a single person. Deliberately looser than the
// identity threshold: over-merging costs one queue item, while under-merging
// costs the flood.
//
// That trade was priced against a queue of about twenty items that empties.
// The shelf changes the second half of it. A match against a SHELVED face is
// what keeps its owner from re-queueing on every visit forever — there is no
// expiry to end that — so the comparison must span both pools. But a shelved
// face never leaves, so over-merging against it no longer costs one queue item:
// a genuinely different visitor who scores over this line is folded into
// somebody else's card and never queued at all, and the queue is the only way a
// stranger is ever surfaced.
//
// Hence the two things this file does with a shelf match rather than declining
// silently: it stamps the face as seen again and takes the better crop, so a
// returning person improves their own card, and it counts the match in
// `shelfMatches` — at most once per shelved face per day, since a visit
// fragments into several appearances and the same person comes back tomorrow.
//
// What that number is worth, precisely, because it was oversold once: it proves
// a match was not silent, which is what R10 asks for. It does NOT settle whether
// 0.45 is too loose here, because it climbs the same way when the threshold is
// right — a shelved regular in the room is indistinguishable from a stranger
// being absorbed. Settling that needs the match SCORES, which nothing stores.
// See docs/residual-review-findings/feat-enrolment-candidates.md.
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

// Both shelf tallies at zero, as one value. Written once so the corruption path
// and a fresh file cannot disagree about what an empty store looks like.
const EMPTY_TALLIES = {
  setAsideOverflow: { ...EMPTY_OVERFLOW },
  shelfMatches: { ...EMPTY_MATCHES },
};

/**
 * One tally off disk, or a fresh one if what was there is not a tally.
 *
 * A hand-edited or half-written file can carry a string, a null or an object
 * with the wrong key where a count belongs. Reading it as a number and adding
 * one produces `NaN`, which persists, survives every restart, and renders as
 * "NaN faces you set aside were dropped" — a corrupt count is worse than a lost
 * one, because the user has no reason to disbelieve it.
 */
function tally<T extends CandidateOverflow | ShelfMatchTally>(
  stored: unknown,
  empty: T,
  key: keyof T & string,
  file: string,
): T {
  if (stored === undefined) return { ...empty };
  const value = (stored as Record<string, unknown> | null)?.[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    console.error(`vision candidates file at ${file} has an unreadable ${key} tally; starting that count at zero`);
    return { ...empty };
  }
  return stored as T;
}

// What `take` hands back.
//
// `embedding`, `thumbnail` and `sourceWidth` are what enrolment needs. `record`
// and `position` are what a FAILED enrolment needs: the whole stored shape, so
// the face can be reinstated as it was rather than re-offered as if it had just
// walked in. `setAside` is the one flag callers branch on without unpacking the
// record, and it is what tells them which pool the face came from.
export interface TakenCandidate {
  embedding: number[];
  thumbnail: Buffer;
  sourceWidth?: number;
  setAside?: boolean;
  record?: StoredCandidate;
  position?: number;
}

export interface CandidateQueue {
  list(): Promise<VisionCandidate[]>;
  overflow(): CandidateOverflow;
  setAsideOverflow(): CandidateOverflow;
  shelfMatches(): ShelfMatchTally;
  // How many times this store has written. Callers compare it across an
  // operation to find out whether anything changed, for the mutations that
  // deliberately return nothing — a shelved face seen again is the current one.
  revision(): number;
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
  // Undo a `take`. Not `offer` — a face coming back is not an arrival. See
  // `reinstateUnlocked`.
  reinstate(taken: TakenCandidate): Promise<boolean>;
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
  // Bumped on every write. Callers that need to know whether a no-op-looking
  // call changed anything compare this across it; see `revision()`.
  private writes = 0;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "vision-candidates.json");
    this.dir = path.join(dataDir, "vision-candidates");
  }

  private async load(): Promise<CandidateFile> {
    if (this.cache) return this.cache;
    const stored = await readJson<CandidateFile>(this.file).catch(() => null);
    if (stored && !Array.isArray(stored.candidates)) {
      console.error(`vision candidates file at ${this.file} is unreadable; starting empty`);
      this.cache = { candidates: [], overflow: { ...EMPTY_OVERFLOW }, ...EMPTY_TALLIES };
      return this.cache;
    }
    // Spread first, then re-add only what needs a default. Naming every field
    // instead is how both shelf tallies were lost: a key the file carried and
    // this list did not simply disappeared, and because the cache is what
    // `persist` writes back, a restart did not merely fail to show a count
    // nobody had acknowledged — the next mutation destroyed it.
    //
    // The shapes are checked, not just the presence. The guard above validates
    // one key, and KTD1 used that as an argument FOR one collection; a second
    // and third key were then added to the same file, so a damaged tally would
    // have sailed past the guard and thrown deeper, in a caller that has no idea
    // this file exists.
    this.cache = {
      ...(stored ?? {}),
      candidates: stored?.candidates ?? [],
      overflow: tally(stored?.overflow, EMPTY_OVERFLOW, "dropped", this.file),
      setAsideOverflow: tally(stored?.setAsideOverflow, EMPTY_OVERFLOW, "dropped", this.file),
      shelfMatches: tally(stored?.shelfMatches, EMPTY_MATCHES, "matched", this.file),
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

  revision(): number {
    return this.writes;
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
      //
      // Counted at most once per shelved face per day. A visit fragments into
      // several appearances and the same person walks past again tomorrow, so
      // counting every match made this number a measure of how often a shelved
      // regular is at their desk. That is the case the design WANTS, and it
      // would have buried the case the number exists to expose. Read
      // `lastSeenAt` before stamping it — it is the only record of when this
      // face was last counted.
      const firstToday = match.lastSeenAt?.slice(0, 10) !== now.slice(0, 10);
      // The crop is replaced through a temp file and a rename, and the record is
      // updated only once that succeeded. Writing the image in place left a
      // window where the shelf's ONLY copy of a face was half-written, and
      // mutating the cached record first meant a throw here diverged the cache
      // from the disk — the coupling that erased both tallies once already.
      if (sourceWidth !== undefined && sourceWidth > (match.sourceWidth ?? 0)) {
        await fs.mkdir(this.dir, { recursive: true });
        await writeFileAtomic(this.cropPath(match.id), thumbnail);
        match.embedding = embedding;
        match.sourceWidth = sourceWidth;
      }
      match.lastSeenAt = now;
      if (firstToday) {
        const matches = (state.shelfMatches ??= { ...EMPTY_MATCHES });
        matches.matched += 1;
        matches.since ??= now;
      }
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
      await this.removeCrop(dropped.id);
      state.overflow.dropped += 1;
      state.overflow.since ??= dropped.at;
      // Written per record, not once when the loop ends. Deleting the crop while
      // the record removal is still only in memory leaves, if the process dies
      // there, an entry on disk whose crop is gone: `list()` hides it, so the
      // pane never shows it, while `count()` and these very scans still see it —
      // a slot consumed forever by something invisible. The other direction
      // (persist first, delete after) trades that for an orphan crop, a face
      // photograph no code path but a full purge can ever reach, which is the
      // worse residue for a store holding people who did not consent.
      await this.persist(state);
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
      await this.removeCrop(dropped.id);
      overflow.dropped += 1;
      overflow.since ??= dropped.setAsideAt!;
      // Per record, for the reason `evictPending` gives.
      await this.persist(state);
    }
  }

  /**
   * Delete one crop, and say so if it will not go.
   *
   * Logged rather than swallowed. A crop that outlives its record is biometric
   * data for someone who never agreed to be kept, held by a store whose whole
   * privacy position is that a face leaves when its record does — and nothing
   * else in the system will ever look at that file again. If it cannot be
   * deleted, the least this can do is leave a trace that it happened, which is
   * the discipline `dismissUnlocked` already followed and the eviction paths did
   * not.
   */
  private async removeCrop(id: string): Promise<void> {
    await fs.rm(this.cropPath(id), { force: true }).catch((err: unknown) => {
      console.error(`vision: could not delete candidate crop ${id}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // Shelve one. The face keeps its crop, its embedding and its place in the
  // duplicate check — that last one is the whole feature, since it is what
  // stops the person re-queueing on their next visit.
  private async setAsideUnlocked(id: string, cap: number): Promise<boolean> {
    const state = await this.load();
    const found = state.candidates.find((c) => c.id === id);
    if (!found || isShelved(found)) return false;
    // A shelf of zero has no meaning, unlike a queue of zero, which turns triage
    // off. Without this the face was shelved, immediately evicted by its own
    // bound, and reported back as a successful set-aside: `later` became a
    // delete button that said it had kept the face.
    if (cap <= 0) return false;
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
    // The seen-again stamp goes with the shelving. It means "came back while it
    // was on the shelf", and the pane renders it as such; leaving it on a face
    // returned to the active queue put a "back 14:30" line on a card whose own
    // documentation says the field is shelf-only.
    delete found.lastSeenAt;
    await this.persist(state);
    return true;
  }

  /**
   * Put a taken face back exactly as it was.
   *
   * The rollback path for a failed enrolment, and deliberately not `offer()`.
   * Re-offering ran the arrival logic on a face that is not an arrival: the
   * duplicate check could match it against a DIFFERENT held face and return
   * null — destroying the face this exists to rescue, while stamping and
   * possibly overwriting the crop of the unrelated card it matched. It also
   * minted a new id, lost the sighting time, lost the shelf age, lost the
   * `suspected` guess that gives a hedged card its "yes, <name>" verb, and
   * needed the caller to do cap arithmetic across two separate lock
   * acquisitions — during which a real arrival could take the slot it had
   * counted on and be evicted for it, charged to the tally that reads "dropped
   * before you looked at it".
   *
   * A face coming back is not an arrival. It is reinstated with its own id, in
   * its own pool, under no bound at all: it occupied a slot a moment ago and
   * nothing has been admitted since, so this cannot exceed a bound that was not
   * already exceeded.
   */
  private async reinstateUnlocked(taken: TakenCandidate): Promise<boolean> {
    if (!taken.record) return false;
    const state = await this.load();
    if (state.candidates.some((c) => c.id === taken.record!.id)) return false;
    await fs.mkdir(this.dir, { recursive: true });
    if (taken.thumbnail.length > 0) await writeFileAtomic(this.cropPath(taken.record.id), taken.thumbnail);
    // Back where it was in the array, as near as the remaining items allow, so
    // the queue does not reorder itself because an enrolment failed.
    state.candidates.splice(Math.min(taken.position ?? state.candidates.length, state.candidates.length), 0, {
      ...taken.record,
    });
    await this.persist(state);
    return true;
  }

  // Remove and return one, for enrolment. Taking rather than reading: a
  // candidate that becomes a person must stop being a candidate in the same
  // step, or a moment's failure leaves the same face in both places.
  private async takeUnlocked(id: string): Promise<TakenCandidate | null> {
    const state = await this.load();
    const position = state.candidates.findIndex((c) => c.id === id);
    const found = state.candidates[position];
    if (!found) return null;

    // Read the crop before removing it: it becomes the enrolled person's face
    // in the roster, so it moves rather than being deleted and re-made.
    const thumbnail = (await fs.readFile(this.cropPath(id)).catch(() => null)) ?? Buffer.alloc(0);

    state.candidates = state.candidates.filter((c) => c.id !== id);
    await this.persist(state);
    await this.removeCrop(id);
    // The WHOLE record travels, not a summary of it. A failed enrolment has to
    // put this face back as it was — same id, same sighting time, same shelf
    // age, same suspicion — and every field this forgot was a field the rollback
    // silently dropped. `setAside` stays as the one flag callers branch on
    // without unpacking the record.
    return {
      embedding: found.embedding,
      thumbnail,
      record: { ...found },
      position,
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
      } else if (which === "shelfMatches") {
        if (!state.shelfMatches?.matched) return;
        state.shelfMatches = { ...EMPTY_MATCHES };
      } else {
        // A value outside the union clears nothing. This was the catch-all
        // branch, so `which: "pendign"` from an agent — or any client built
        // against a newer union than this server knows — silently wiped the
        // shelf-match count instead of the one it named. Acknowledging a tally
        // destroys it, so guessing which one was meant is the wrong default.
        return;
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

  reinstate(taken: TakenCandidate): Promise<boolean> {
    return this.withLock(() => this.reinstateUnlocked(taken));
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
    this.writes += 1;
    await writeJsonAtomic(this.file, state);
  }
}
