// The gallery: people the user named, and the faces held for them.
//
// This is the only place in HAL that stores biometric data, and the brief draws
// a hard line around it — HAL holds face data only for people the user
// deliberately named. Someone who merely walked past leaves nothing here, which
// is a property of what never gets written rather than of what gets cleaned up.
//
// Deletion is therefore a first-class operation, not a maintenance chore
// (R27). It removes the person from matching first and their thumbnails second,
// because the guarantee the user actually cares about is "stop recognising
// them", and an unlink that fails must not leave a person still matchable.

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MAX_PROFILE_CHARS, type Person, type PersonSummary } from "../../../shared/src/types.js";
import { readJson, writeJsonAtomic } from "../storage/atomic.js";
import { cosine } from "./recogniser.js";

export interface Match {
  personId: string;
  name: string;
  confidence: number;
}

// Editing outcomes are typed rather than boolean, because every refusal here
// has a reason the user can act on — the same argument that made enrolment
// return a result instead of an error.
export type RenameResult =
  | { ok: true; merged: boolean; personId: string; faceCount: number; mergedFrom?: string }
  | { ok: false; reason: string };

export type RemoveFaceResult =
  | { ok: true; faceCount: number }
  | { ok: false; reason: string; lastFace?: boolean };

export type ProfileResult = { ok: true } | { ok: false; reason: string };

/**
 * A stable key for "this is the same face already held".
 *
 * Embeddings are unit vectors the recogniser produced, so two records of one
 * capture are bit-identical and this is exact rather than a similarity test.
 * A near-duplicate from a different capture is a genuinely different face and
 * should be kept — a person accumulating faces is the point.
 *
 * Rounded before joining so a value that survived a JSON round trip with a
 * different final digit still matches the one it came from.
 */
function fingerprint(embedding: number[]): string {
  return embedding.map((n) => n.toFixed(6)).join(",");
}

// The gallery as the service sees it. A structural interface so tests can fake
// it with an object literal rather than writing biometric fixtures to disk —
// the same shape `VisionHub` and `ReadinessAdapters` already use.
export interface Gallery {
  list(): Promise<PersonSummary[]>;
  create(name: string, embedding: number[], thumbnail: Buffer, sourceWidth?: number): Promise<Person>;
  remove(id: string): Promise<boolean>;
  match(embedding: number[], threshold: number): Promise<Match | null>;
  tally(): Promise<{ people: number; faces: number }>;
  clear(): Promise<void>;
  rename(id: string, name: string): Promise<RenameResult>;
  removeFace(personId: string, faceId: string): Promise<RemoveFaceResult>;
  setProfile(id: string, profile: string): Promise<ProfileResult>;
  setOperator(id: string | null): Promise<ProfileResult>;
  addFace(personId: string, embedding: number[], thumbnail: Buffer, sourceWidth?: number): Promise<boolean>;
  // Name-first enrolment: adds to the person already called this, or creates
  // them. See `enrolByName` for why this is the default path.
  enrolByName(
    name: string,
    embedding: number[],
    thumbnail: Buffer,
    sourceWidth?: number,
  ): Promise<{ person: Person; added: boolean }>;
}

interface PeopleFile {
  people: Person[];
}

export class PeopleStore implements Gallery {
  private readonly file: string;
  private readonly facesDir: string;
  private cache: Person[] | null = null;
  // Every mutation is load-modify-write, and nothing serialises the callers:
  // `VisionService.handle` is fire-and-forget, so two enrolments arriving back
  // to back interleave across their awaits. Both then persist the array they
  // loaded, and the second write erases the first — a face silently lost
  // rather than a visible duplicate. One chain, as `ConversationStore` does it.
  private chain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "vision-people.json");
    this.facesDir = path.join(dataDir, "vision-faces");
  }

  async load(): Promise<Person[]> {
    if (this.cache) return this.cache;
    const stored = await readJson<PeopleFile>(this.file).catch(() => null);
    if (stored && !Array.isArray(stored.people)) {
      // A damaged gallery loads empty rather than taking Vision down with it —
      // but loudly, because the silent version of this un-enrols everyone and
      // looks identical to never having enrolled anyone.
      console.error(`vision people file at ${this.file} is unreadable; starting with an empty gallery`);
      this.cache = [];
      return this.cache;
    }
    this.cache = stored?.people ?? [];
    return this.cache;
  }

  async list(): Promise<PersonSummary[]> {
    const people = await this.load();
    return Promise.all(people.map(async (p) => this.summarize(p)));
  }

  private async summarize(person: Person): Promise<PersonSummary> {
    // Every face, so the roster can offer one to prune (R11). Still no
    // embeddings: those are the biometric payload, and pointing at a bad crop
    // needs a picture, not a vector.
    const faces = await Promise.all(
      person.faces.map(async (face) => {
        const bytes = await fs.readFile(this.thumbPath(face.id)).catch(() => null);
        return {
          id: face.id,
          addedAt: face.addedAt,
          ...(face.sourceWidth ? { sourceWidth: face.sourceWidth } : {}),
          ...(bytes ? { thumbnail: `data:image/jpeg;base64,${bytes.toString("base64")}` } : {}),
        };
      }),
    );
    const thumbnail = faces.find((f) => f.thumbnail)?.thumbnail;
    return {
      id: person.id,
      name: person.name,
      createdAt: person.createdAt,
      faceCount: person.faces.length,
      ...(thumbnail ? { thumbnail } : {}),
      faces,
      // Projected explicitly. A field the store keeps and the projection drops
      // exists on disk and nowhere the user can see it.
      ...(person.profile ? { profile: person.profile } : {}),
      ...(person.isOperator ? { isOperator: true } : {}),
    };
  }

  private async createUnlocked(
    name: string,
    embedding: number[],
    thumbnail: Buffer,
    sourceWidth?: number,
  ): Promise<Person> {
    const people = await this.load();
    const faceId = crypto.randomUUID();
    const person: Person = {
      id: crypto.randomUUID(),
      // Names are not keys. Two people may share one and stay distinct records,
      // which is why the id is generated rather than derived from the name.
      name: name.trim(),
      createdAt: new Date().toISOString(),
      faces: [{ id: faceId, addedAt: new Date().toISOString(), embedding, ...(sourceWidth ? { sourceWidth } : {}) }],
    };
    await this.writeThumb(faceId, thumbnail);
    await this.persist([...people, person]);
    return person;
  }

  // A person accumulates faces rather than being defined by one (R16). Unused
  // by this slice's one-shot enrolment, and present because the matching rule
  // below is only meaningful once a person has several.
  private async addFaceUnlocked(
    personId: string,
    embedding: number[],
    thumbnail: Buffer,
    sourceWidth?: number,
  ): Promise<boolean> {
    const people = await this.load();
    const person = people.find((p) => p.id === personId);
    if (!person) return false;
    const faceId = crypto.randomUUID();
    await this.writeThumb(faceId, thumbnail);
    person.faces.push({ id: faceId, addedAt: new Date().toISOString(), embedding, ...(sourceWidth ? { sourceWidth } : {}) });
    await this.persist(people);
    return true;
  }

  /**
   * Enrol under a name, accumulating onto whoever already has it.
   *
   * R16 has a person accumulating faces rather than being defined by one, and
   * until now nothing reached `addFace` — every enrolment minted a new record.
   * The cost showed up immediately in real use: one person whose appearances
   * fragmented got named several times and ended up as several people, each
   * holding a single face, which is strictly worse at recognising them than
   * one person holding five.
   *
   * The trade-off is deliberate and worth stating: the brief notes that names
   * are not keys and two people may share one. Typing a name you have already
   * used now means "this is that person" rather than "here is a second person
   * with the same name". Distinguishing genuine namesakes needs a different
   * name — which is what a user would do anyway when they cannot tell two
   * roster rows apart.
   */
  private async enrolByNameUnlocked(
    name: string,
    embedding: number[],
    thumbnail: Buffer,
    sourceWidth?: number,
  ): Promise<{ person: Person; added: boolean }> {
    const trimmed = name.trim();
    const people = await this.load();
    const existing = people.find((p) => p.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) {
      await this.addFaceUnlocked(existing.id, embedding, thumbnail, sourceWidth);
      return { person: existing, added: true };
    }
    return { person: await this.createUnlocked(trimmed, embedding, thumbnail, sourceWidth), added: false };
  }

  // R27. The person goes first so they stop matching even if the files resist.
  private async removeUnlocked(id: string): Promise<boolean> {
    const people = await this.load();
    const person = people.find((p) => p.id === id);
    if (!person) return false;

    await this.persist(people.filter((p) => p.id !== id));

    for (const face of person.faces) {
      await fs.rm(this.thumbPath(face.id), { force: true }).catch((err: unknown) => {
        // Reported rather than swallowed: the person is already unrecognisable,
        // so this is a leftover file rather than a retained identity — but a
        // silent failure here would quietly accumulate images of someone the
        // user asked to be forgotten.
        console.error(
          `vision: could not delete face thumbnail ${face.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    return true;
  }

  /**
   * The best person for an embedding, or null.
   *
   * A person's score is their NEAREST face, not an average (R16 has a person
   * accumulating faces). With a handful each, a maximum is more robust: one
   * poorly-framed enrolment drags a mean down and quietly stops that person
   * matching at all, whereas it merely fails to be the nearest.
   *
   * Below the threshold this returns null rather than the closest candidate.
   * R9 is explicit that a weak match is unrecognised and never a guess at the
   * nearest person — returning a nearest-with-low-score would invite exactly
   * the caller behaviour the requirement forbids.
   */
  async match(embedding: number[], threshold: number): Promise<Match | null> {
    const people = await this.load();
    let best: Match | null = null;
    for (const person of people) {
      for (const face of person.faces) {
        const score = cosine(embedding, face.embedding);
        if (!best || score > best.confidence) {
          best = { personId: person.id, name: person.name, confidence: score };
        }
      }
    }
    // Positive assertion, not a negated comparison. `NaN < threshold` is false,
    // so the old form let a NaN score — reachable from any non-finite value in
    // an embedding the sidecar returned — through as a CONFIDENT match. R9
    // exists to stop exactly that, and it failed open.
    if (!best || !(best.confidence >= threshold)) return null;
    return best;
  }

  // The whole gallery is one key: enrolling and deleting both rewrite the same
  // file, so a per-person lock would not help.
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }


  // Public surface. Each mutation runs alone, so a load-modify-write cannot be
  // interleaved by another caller and lose its write.
  create(name: string, embedding: number[], thumbnail: Buffer, sourceWidth?: number): Promise<Person> {
    return this.withLock(() => this.createUnlocked(name, embedding, thumbnail, sourceWidth));
  }

  addFace(personId: string, embedding: number[], thumbnail: Buffer, sourceWidth?: number): Promise<boolean> {
    return this.withLock(() => this.addFaceUnlocked(personId, embedding, thumbnail, sourceWidth));
  }

  remove(id: string): Promise<boolean> {
    return this.withLock(() => this.removeUnlocked(id));
  }

  enrolByName(
    name: string,
    embedding: number[],
    thumbnail: Buffer,
    sourceWidth?: number,
  ): Promise<{ person: Person; added: boolean }> {
    return this.withLock(() => this.enrolByNameUnlocked(name, embedding, thumbnail, sourceWidth));
  }

  /**
   * Rename, merging into whoever already holds the name (R10).
   *
   * Written as one locked operation composing the unlocked helpers, never the
   * public ones: `withLock` is not reentrant, so calling `addFace` from in here
   * would wait on a chain this call is already holding and deadlock. The same
   * reason `enrolByNameUnlocked` calls `addFaceUnlocked`.
   */
  private async renameUnlocked(id: string, name: string): Promise<RenameResult> {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, reason: "A name cannot be blank." };

    const people = await this.load();
    const subject = people.find((p) => p.id === id);
    if (!subject) return { ok: false, reason: "That person is no longer on the roster." };

    const target = people.find((p) => p.id !== id && p.name.toLowerCase() === trimmed.toLowerCase());

    // Renaming to a different capitalisation or spacing of the record's OWN
    // name. Without this carve-out the case-insensitive match below would find
    // the record itself, and "merging" it would fold it into itself and delete
    // it — on the single most likely rename a user performs, fixing a typo in
    // capitalisation.
    if (!target) {
      subject.name = trimmed;
      await this.persist(people);
      return { ok: true, merged: false, personId: subject.id, faceCount: subject.faces.length };
    }

    // The record already holding the name survives, matching what enrolling
    // under an existing name already does: typing a name you have used before
    // means "this is that person".
    const held = new Set(target.faces.map((f) => fingerprint(f.embedding)));
    const carried = subject.faces.filter((f) => !held.has(fingerprint(f.embedding)));
    const dropped = subject.faces.filter((f) => held.has(fingerprint(f.embedding)));
    target.faces.push(...carried);

    // Both profiles are kept by joining them. Dropping the loser's would delete
    // text the user wrote, with no undo and no warning — and a merge is not a
    // moment anyone expects to lose writing.
    const both = [target.profile, subject.profile].filter((t): t is string => Boolean(t && t.trim()));
    const joined = [...new Set(both)].join("\n\n");
    // The bound applies to what a merge produces too, and a merge is not a save
    // the user can shorten — so it truncates here rather than refusing to merge,
    // and says so in the text it keeps.
    if (joined) {
      target.profile =
        joined.length <= MAX_PROFILE_CHARS
          ? joined
          : `${joined.slice(0, MAX_PROFILE_CHARS - 24).trimEnd()}\n\n[trimmed on merge]`;
    }
    // The mark survives if either side carried it, so a merge cannot silently
    // leave HAL without an operator.
    if (subject.isOperator) target.isOperator = true;

    await this.persist(people.filter((p) => p.id !== subject.id));

    // Only the duplicates lose their images; the carried faces keep theirs,
    // because the face id travels with the record.
    for (const face of dropped) {
      await fs.rm(this.thumbPath(face.id), { force: true }).catch(() => {});
    }

    return { ok: true, merged: true, personId: target.id, faceCount: target.faces.length, mergedFrom: subject.name };
  }

  /**
   * Remove one face (R11), refusing the last one (R12).
   *
   * The record is written before the image is deleted. A failed unlink then
   * leaves a stray file rather than a person pointing at a missing face — the
   * same ordering `remove` uses, for the same reason.
   */
  private async removeFaceUnlocked(personId: string, faceId: string): Promise<RemoveFaceResult> {
    const people = await this.load();
    const person = people.find((p) => p.id === personId);
    if (!person) return { ok: false, reason: "That person is no longer on the roster." };
    if (!person.faces.some((f) => f.id === faceId)) return { ok: false, reason: "That face is already gone." };
    if (person.faces.length <= 1) {
      return {
        ok: false,
        reason: `That is the only face I have for ${person.name}. Removing it would leave someone I can never recognise — delete them instead.`,
        lastFace: true,
      };
    }

    person.faces = person.faces.filter((f) => f.id !== faceId);
    await this.persist(people);
    await fs.rm(this.thumbPath(faceId), { force: true }).catch((err: unknown) => {
      console.error(`vision: could not delete face ${faceId}: ${err instanceof Error ? err.message : String(err)}`);
    });
    return { ok: true, faceCount: person.faces.length };
  }

  /**
   * Set or clear what HAL knows about someone (R17, R23).
   *
   * The bound is enforced at save with the limit named, rather than by
   * truncating: a profile that silently loses its last sentence is worse than
   * one that was refused, because the user has no way to notice.
   */
  private async setProfileUnlocked(id: string, profile: string): Promise<ProfileResult> {
    const text = profile.trim();
    if (text.length > MAX_PROFILE_CHARS) {
      return {
        ok: false,
        reason: `That is ${text.length} characters and I can hold ${MAX_PROFILE_CHARS}. Trim it by ${text.length - MAX_PROFILE_CHARS}.`,
      };
    }

    const people = await this.load();
    const person = people.find((p) => p.id === id);
    if (!person) return { ok: false, reason: "That person is no longer on the roster." };

    // Empty clears rather than storing "". An absent profile and a blank one
    // mean the same thing and should not be two states to reason about.
    if (text) person.profile = text;
    else delete person.profile;

    await this.persist(people);
    return { ok: true };
  }

  /**
   * Mark who HAL is talking to, or clear it (R18).
   *
   * At most one, enforced by clearing every other record in the same write —
   * a second operator is not an error to report, it is a mark that moved.
   */
  private async setOperatorUnlocked(id: string | null): Promise<ProfileResult> {
    const people = await this.load();
    if (id !== null && !people.some((p) => p.id === id)) {
      return { ok: false, reason: "That person is no longer on the roster." };
    }

    for (const person of people) {
      if (person.id === id) person.isOperator = true;
      else delete person.isOperator;
    }

    await this.persist(people);
    return { ok: true };
  }

  setProfile(id: string, profile: string): Promise<ProfileResult> {
    return this.withLock(() => this.setProfileUnlocked(id, profile));
  }

  setOperator(id: string | null): Promise<ProfileResult> {
    return this.withLock(() => this.setOperatorUnlocked(id));
  }

  rename(id: string, name: string): Promise<RenameResult> {
    return this.withLock(() => this.renameUnlocked(id, name));
  }

  removeFace(personId: string, faceId: string): Promise<RemoveFaceResult> {
    return this.withLock(() => this.removeFaceUnlocked(personId, faceId));
  }

  /** How many people and faces a purge would destroy (R39). */
  async tally(): Promise<{ people: number; faces: number }> {
    const people = await this.load();
    return { people: people.length, faces: people.reduce((n, p) => n + p.faces.length, 0) };
  }

  /**
   * Forget everyone (R39).
   *
   * The gallery empties first and the images second, for the same reason
   * `remove` does it in that order: the guarantee the user asked for is "stop
   * recognising them", and a directory that resists deletion must not leave
   * anyone still matchable. A crop left behind is a file; a person left in the
   * gallery is a broken promise.
   */
  clear(): Promise<void> {
    return this.withLock(async () => {
      await this.persist([]);
      await fs.rm(this.facesDir, { recursive: true, force: true }).catch((err: unknown) => {
        console.error(
          `vision: could not delete the face directory: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
  }

  private thumbPath(faceId: string): string {
    return path.join(this.facesDir, `${faceId}.jpg`);
  }

  private async writeThumb(faceId: string, thumbnail: Buffer): Promise<void> {
    await fs.mkdir(this.facesDir, { recursive: true });
    await fs.writeFile(this.thumbPath(faceId), thumbnail);
  }

  private async persist(people: Person[]): Promise<void> {
    this.cache = people;
    await writeJsonAtomic(this.file, { people } satisfies PeopleFile);
  }
}
