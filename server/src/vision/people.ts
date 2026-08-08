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
import type { Person, PersonSummary } from "../../../shared/src/types.js";
import { readJson, writeJsonAtomic } from "../storage/atomic.js";
import { cosine } from "./recogniser.js";

export interface Match {
  personId: string;
  name: string;
  confidence: number;
}

// The gallery as the service sees it. A structural interface so tests can fake
// it with an object literal rather than writing biometric fixtures to disk —
// the same shape `VisionHub` and `ReadinessAdapters` already use.
export interface Gallery {
  list(): Promise<PersonSummary[]>;
  create(name: string, embedding: number[], thumbnail: Buffer): Promise<Person>;
  remove(id: string): Promise<boolean>;
  match(embedding: number[], threshold: number): Promise<Match | null>;
  // Name-first enrolment: adds to the person already called this, or creates
  // them. See `enrolByName` for why this is the default path.
  enrolByName(name: string, embedding: number[], thumbnail: Buffer): Promise<{ person: Person; added: boolean }>;
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
    const first = person.faces[0];
    let thumbnail: string | undefined;
    if (first) {
      const bytes = await fs.readFile(this.thumbPath(first.id)).catch(() => null);
      if (bytes) thumbnail = `data:image/jpeg;base64,${bytes.toString("base64")}`;
    }
    return {
      id: person.id,
      name: person.name,
      createdAt: person.createdAt,
      faceCount: person.faces.length,
      ...(thumbnail ? { thumbnail } : {}),
    };
  }

  private async createUnlocked(name: string, embedding: number[], thumbnail: Buffer): Promise<Person> {
    const people = await this.load();
    const faceId = crypto.randomUUID();
    const person: Person = {
      id: crypto.randomUUID(),
      // Names are not keys. Two people may share one and stay distinct records,
      // which is why the id is generated rather than derived from the name.
      name: name.trim(),
      createdAt: new Date().toISOString(),
      faces: [{ id: faceId, addedAt: new Date().toISOString(), embedding }],
    };
    await this.writeThumb(faceId, thumbnail);
    await this.persist([...people, person]);
    return person;
  }

  // A person accumulates faces rather than being defined by one (R16). Unused
  // by this slice's one-shot enrolment, and present because the matching rule
  // below is only meaningful once a person has several.
  private async addFaceUnlocked(personId: string, embedding: number[], thumbnail: Buffer): Promise<boolean> {
    const people = await this.load();
    const person = people.find((p) => p.id === personId);
    if (!person) return false;
    const faceId = crypto.randomUUID();
    await this.writeThumb(faceId, thumbnail);
    person.faces.push({ id: faceId, addedAt: new Date().toISOString(), embedding });
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
  ): Promise<{ person: Person; added: boolean }> {
    const trimmed = name.trim();
    const people = await this.load();
    const existing = people.find((p) => p.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) {
      await this.addFaceUnlocked(existing.id, embedding, thumbnail);
      return { person: existing, added: true };
    }
    return { person: await this.createUnlocked(trimmed, embedding, thumbnail), added: false };
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
    if (!best || best.confidence < threshold) return null;
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
  create(name: string, embedding: number[], thumbnail: Buffer): Promise<Person> {
    return this.withLock(() => this.createUnlocked(name, embedding, thumbnail));
  }

  addFace(personId: string, embedding: number[], thumbnail: Buffer): Promise<boolean> {
    return this.withLock(() => this.addFaceUnlocked(personId, embedding, thumbnail));
  }

  remove(id: string): Promise<boolean> {
    return this.withLock(() => this.removeUnlocked(id));
  }

  enrolByName(name: string, embedding: number[], thumbnail: Buffer): Promise<{ person: Person; added: boolean }> {
    return this.withLock(() => this.enrolByNameUnlocked(name, embedding, thumbnail));
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
