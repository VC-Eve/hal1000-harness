import path from "node:path";
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import type {
  ClipRef,
  ClipSequence,
  Effect,
  Condition,
  IncompleteClip,
  IncompleteReason,
  Parameter,
  ParameterValue,
  StateDraft,
  StatePatch,
  Transition,
  TransitionDraft,
  TransitionPatch,
  World,
  WorldState,
  WorldSummary,
} from "../../../shared/src/types.js";
import {
  NODE_H,
  NODE_ROW_GAP,
  NODE_W,
  PARAMETER_TYPES,
  WORLD_VERSION,
  opsFor,
  sequencesOf,
} from "../../../shared/src/worlds.js";
import { defaultValueOf, valueFits } from "../../../shared/src/world-graph.js";
import { withDeadline } from "../deadline.js";
import { readJson, writeJsonAtomic } from "./atomic.js";
import { worldsDir } from "../paths.js";

const MANIFEST = "world.json";
const CLIPS_DIR = "clips";
const LAST_OPEN = "last-open.json";
const LAST_LIBRARY = "last-library.json";
const NAME_MAX = 60;
const SLUG_MAX = 48;

/**
 * The longest a recorded clip may claim to be.
 *
 * `setTimeout` truncates a delay to 32 bits, so a manifest claiming 2^31 ms
 * does not produce a long wait — it produces a 1ms one, and the runtime then
 * broadcasts and re-requests a clip a thousand times a second. Clamped where
 * the number enters, not where it is used, so no consumer has to remember.
 */
export const MAX_CLIP_MS = 60 * 60 * 1000;

/**
 * How many clips one State or transition may hold.
 *
 * Every member is confined on every mutation and resolved again on every draw,
 * so an unbounded set is unbounded filesystem work behind one message. Far more
 * than anyone would author by hand.
 *
 * Counted in **clips, not sequences**, because the work the bound exists to
 * limit is per clip: two hundred runs of ten would be two thousand `realpath`
 * pairs on every mutation, which is the thing this number was chosen to stop.
 */
export const MAX_CLIPS_PER_SET = 200;

/** How long the confinement pass waits on one path before it stops asking. */
const CLIP_CHECK_MS = 2_000;

/**
 * The fields a World must have, in one place.
 *
 * Every branch that produces a World — a fresh one, a parsed one, and the
 * fallback for a manifest that will not parse — takes its defaults from here,
 * so the branches cannot disagree about what an empty World is. Returned fresh
 * each call because the arrays are mutable and a shared literal would let one
 * World's positions appear in another's.
 */
function emptyFields(): Omit<World, "id" | "name"> {
  return { version: WORLD_VERSION, defaultStateId: null, states: [], transitions: [], parameters: [] };
}

/**
 * Rebuild a loaded World by spreading what was parsed.
 *
 * Never by naming every field. A World is portable by design, so it will be
 * opened by a build older than the one that wrote it, and a key the file
 * carries that this literal forgets would be deleted on the next ordinary write
 * — silently, permanently, and travelling between machines with the folder.
 * Only the fields that need a default are re-added afterwards. See
 * docs/solutions/rebuilding-a-cache-field-by-field-turns-a-read-into-a-delete.md.
 */
/**
 * The elements of a manifest collection that are shaped like entries at all.
 *
 * A World travels between machines and is hand-edited, so an array can hold a
 * `null` left by a deleted entry or a stray scalar. Reading `.id` off one threw
 * out of `load()`, and because `startApp` awaits the World service, a single
 * null in the last-open World stopped HAL booting.
 *
 * Only non-objects are dropped, deliberately. An object missing a field this
 * build knows about is still somebody's work and is kept — consumers guard
 * instead. Dropping it here would be the same silent deletion the spread
 * rebuild exists to prevent, one level down.
 */
function entries<T>(value: unknown, fallback: T[]): T[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((v): v is T => typeof v === "object" && v !== null && !Array.isArray(v));
}

/**
 * The entries of an `effects` array that are shaped like Effects at all.
 *
 * A World is hand-editable and travels between machines, so this array can hold a
 * null left by a deletion or a stray scalar. Only non-objects are dropped, the
 * same rule `entries()` applies one level up — an Effect missing a field this
 * build knows about is still somebody's work, and the op registry decides at fire
 * time whether it can be applied. Deleting it here would be the silent loss the
 * spread rebuild exists to prevent.
 */
function effectEntries(value: unknown): Effect[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is Effect => typeof v === "object" && v !== null && !Array.isArray(v));
}

/**
 * Whether a set's members are sequences, rather than the bare clips of version 3.
 *
 * Asked of the members rather than of the manifest's version number: a version
 * is one number for a whole World, and a hand-edited manifest can hold a State
 * migrated by an earlier open beside one that was pasted in. Each set answers
 * for itself.
 */
function isSequenceSet(clips: unknown): boolean {
  if (!Array.isArray(clips)) return false;
  return clips.every((entry) => typeof entry === "object" && entry !== null && Array.isArray((entry as ClipSequence).clips));
}

/**
 * Bring one owner's set forward to sequences.
 *
 * A version 3 set held clips and each becomes a run of one, which is what makes
 * a migrated World play exactly as it did. An empty set stays empty and still
 * means "holds silently" on a State and "instant cut" on a transition.
 */
function migrateClips(clips: unknown): ClipSequence[] {
  if (!Array.isArray(clips)) return [];
  if (isSequenceSet(clips)) return clips as ClipSequence[];
  return sequencesOf(
    clips.filter(
      (clip): clip is ClipRef =>
        typeof clip === "object" && clip !== null && typeof (clip as ClipRef).path === "string",
    ),
  );
}

/**
 * Bring a manifest written before version 3 up to the shape this build reads.
 *
 * Here rather than "on open", because `mutate` re-reads the manifest from disk
 * inside its lock and edits *that*. A migration that ran only where a World is
 * opened would be undone by the first edit made to it.
 *
 * Spread first, like everything else that rebuilds a parsed value: a State
 * carries keys this build has never heard of and they have to come through.
 * Three rules, and none of them infers anything — `clip` becomes a one-item
 * set, the `clip: null` that meant "holds silently" becomes the empty set that
 * means the same thing, and a version 3 set of clips becomes a set of one-clip
 * sequences. A World migrated this way plays exactly as it did.
 */
function migrateEntries(base: Partial<World>): Pick<World, "states" | "transitions"> {
  const empty = emptyFields();
  const legacy = (v: unknown): ClipRef[] => {
    const clip = (v as { clip?: unknown }).clip;
    // Not merely an object: an array is one too, and `clip: []` in a
    // hand-edited manifest became a member with no path — reported to the
    // author as a missing file for a State nothing was ever assigned to.
    const shaped =
      clip !== null &&
      typeof clip === "object" &&
      !Array.isArray(clip) &&
      typeof (clip as ClipRef).path === "string" &&
      (clip as ClipRef).path.trim().length > 0;
    return shaped ? [clip as ClipRef] : [];
  };
  return {
    states: entries<WorldState>(base.states, empty.states).map((state) => {
      const effects = effectEntries((state as WorldState).effects);
      if (Array.isArray(state.clips)) {
        return effects === undefined
          ? { ...state, clips: migrateClips(state.clips) }
          : { ...state, clips: migrateClips(state.clips), effects };
      }
      // The one key this build deliberately removes. Spreading preserves what
      // it does not understand; `clip` it understands and has just replaced,
      // and leaving it would put a second, silently ignored clip path in the
      // manifest to drift out of step with the set that supersedes it.
      const { clip: _superseded, ...rest } = state as WorldState & { clip?: unknown };
      return { ...rest, clips: sequencesOf(legacy(state)) } as WorldState;
    }),
    transitions: entries<Transition>(base.transitions, empty.transitions).map((t) => ({
      ...t,
      clips: migrateClips(t.clips),
    })),
  };
}

/** The version a manifest holds once its entries have been brought forward. */
function migratedVersion(stored: unknown): number {
  if (typeof stored !== "number") return 1;
  return stored >= OLDEST_MIGRATABLE && stored < WORLD_VERSION ? WORLD_VERSION : stored;
}

function rebuild(parsed: unknown, id: string): World {
  const base = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Partial<World>;
  const empty = emptyFields();
  const migrated = migrateEntries(base);
  return {
    ...(base as World),
    // The directory is the identity: a manifest carried in from elsewhere names
    // whatever slug it had on the machine that wrote it, and the folder here is
    // the one that is true.
    id,
    name: typeof base.name === "string" && base.name.trim().length > 0 ? base.name.slice(0, NAME_MAX) : id,
    // The version this World now *is*, not the one on disk: the entries above
    // were brought forward, so saying 2 would make every later reader migrate
    // again and would write a manifest whose version contradicted its shape.
    version: migratedVersion(base.version),
    defaultStateId: typeof base.defaultStateId === "string" ? base.defaultStateId : null,
    states: migrated.states,
    transitions: migrated.transitions,
    parameters: entries(base.parameters, empty.parameters),
    // Named after the spread rather than left to it, because the shape guard has
    // to run: `effects` is an array a hand edit can fill with anything.
    ...(effectEntries(base.effects) === undefined ? {} : { effects: effectEntries(base.effects) }),
  };
}

/**
 * Why this build will not write to a manifest, or null when it will.
 *
 * A missing version is the camera-model layout: its `states` held Scene and
 * Position pairings, so reading it as this shape produces a machine with no
 * States. A higher version was written by a build that knows something this one
 * does not. Both open read-only and say which, because the alternative is an
 * empty graph and no explanation.
 */
/**
 * The oldest layout this build can bring forward.
 *
 * Version 2 is the state machine with one clip per State. Turning that into a
 * one-item set adds no information and loses none, so it migrates. Anything
 * older is the camera layout, whose `states` held Scene and Position pairings —
 * there is no honest way to read those as States, so it is still refused.
 */
const OLDEST_MIGRATABLE = 2;

function versionRefusal(world: World): string | null {
  if (world.version === WORLD_VERSION) return null;
  if (world.version < WORLD_VERSION) {
    // A migratable version never reaches here: `rebuild` brings it forward
    // before this runs, so by now it reads as the current one. Kept as the
    // statement of which side of the line a version falls on, for a caller that
    // one day checks a World it did not rebuild.
    if (world.version >= OLDEST_MIGRATABLE) return null;
    return "This World was made by an earlier layout of HAL and cannot be edited by this one.";
  }
  return "This World was made by a newer build of HAL. Update before editing it.";
}

// The Windows device names. A folder called `con` cannot be created at all, so
// an ordinary World name would fail creation with an error naming nothing.
export const RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/**
 * The directory segment for a display name (KTD3).
 *
 * Derived server-side so a client supplies a name and never a path segment,
 * which is what lets a World id skip the UUID guard a conversation id needs —
 * the same reasoning that exempts Monitor ids. Readable, because R3 wants a
 * folder a person recognises when they copy it.
 */
export function worldSlug(name: string): string {
  const cleaned = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    // A run of dots survives every other rule here and then fails
    // `validWorldId`, which refuses `..` anywhere — so "Hal.. Room" used to
    // create a directory the store could never open again.
    .replace(/\.{2,}/g, ".")
    .replace(/^[-._]+/, "")
    .slice(0, SLUG_MAX)
    // Trimmed AFTER the slice, because slicing can expose a new trailing
    // separator. Windows silently drops a trailing dot from a directory name,
    // which would leave the id the server reports and the id on disk different.
    .replace(/[-._]+$/, "");
  const base = cleaned.length > 0 ? cleaned : "world";
  // Windows reserves the stem whatever follows the dot, so `con.room` is
  // refused as surely as `con`.
  const stem = base.split(".")[0]!.toUpperCase();
  return RESERVED.has(stem) ? `${base}-world` : base;
}

/**
 * Whether an id is safely usable as one path segment, before it touches disk.
 *
 * Mixed case is accepted even though `worldSlug` only ever produces lowercase:
 * the whole point of a World is that its folder can be copied in from another
 * machine, and a folder arriving as `Lounge` must be listable. Refusing it
 * would have made it invisible AND let a new World called "lounge" mkdir
 * straight into it on a case-folding filesystem.
 */
export function validWorldId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 80 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) &&
    !id.includes("..")
  );
}

function confined(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  // `path.relative` is the check, not a string prefix: `worlds/room` and
  // `worlds/room-2` share a prefix and are different directories. The prefix
  // form in http.ts is the weaker precedent and is deliberately not copied.
  return rel.length > 0 && !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

export type ClipResolution =
  | { ok: true; file: string }
  | { ok: false; reason: IncompleteReason };

/**
 * Resolve a manifest clip path to a real file inside its own World (R17).
 *
 * Both sides go through `fs.realpath` before they are compared, so a symlink
 * inside `clips/` pointing out of the World is caught as well as an absolute
 * path and a `..` segment. Shared with the HTTP route rather than restated
 * there — two copies of one rule is how they drift, and the copy that lags is
 * the one that leaks.
 */
export async function resolveClipPath(worldDir: string, rel: unknown): Promise<ClipResolution> {
  if (typeof rel !== "string" || rel.trim().length === 0) return { ok: false, reason: "not-a-path" };
  if (path.isAbsolute(rel)) return { ok: false, reason: "escapes-world" };
  // `C:foo` is drive-relative on Windows and `path.isAbsolute` says false.
  if (/^[A-Za-z]:/.test(rel)) return { ok: false, reason: "escapes-world" };

  let root: string;
  try {
    root = await fs.realpath(worldDir);
  } catch {
    return { ok: false, reason: "missing" };
  }
  const candidate = path.resolve(root, rel);
  if (!confined(root, candidate)) return { ok: false, reason: "escapes-world" };

  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch {
    // Lexically fine, simply not there — a State whose clip has not been
    // generated yet, which is a routine stage of authoring rather than a fault.
    return { ok: false, reason: "missing" };
  }
  if (!confined(root, real)) return { ok: false, reason: "escapes-world" };
  return { ok: true, file: real };
}

/** A World as loaded: what it holds, whether it can be written, and what is wrong with it. */
export interface LoadedWorld {
  world: World;
  /** Set when the World opens read-only: says which reason applies. */
  readOnlyReason?: string;
  /**
   * False when the manifest would not parse. The World still lists and still
   * opens read-only; every mutation is refused and no write is issued.
   */
  readable: boolean;
  incomplete: IncompleteClip[];
}

export interface MutationResult {
  ok: boolean;
  error?: string;
  loaded?: LoadedWorld;
  /** The edit succeeded and left the World exactly as it was: nothing written. */
  unchanged?: boolean;
}

const UNREADABLE = "This World's manifest could not be read, so nothing may be written to it.";
const NO_SUCH_WORLD = "There is no World by that name.";

/**
 * One directory per World under `worlds/`, holding `world.json` and `clips/`.
 *
 * Mutations serialize through a per-World promise chain modelled on
 * `ConversationStore`: the World is the unit of write, and a node drag
 * produces bursts of small mutations to one manifest. Nothing is cached between
 * calls — the read path re-reads the file, so the reopen-mutate-reopen shape a
 * portable manifest depends on holds by construction rather than by discipline.
 */

export class WorldStore {
  private readonly root: string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(dataDir: string) {
    this.root = worldsDir(dataDir);
  }

  /** The directory for a World id, or null when the id is not one of ours. */
  dirFor(id: string): string | null {
    if (!validWorldId(id)) return null;
    const dir = path.join(this.root, id);
    return confined(this.root, dir) ? dir : null;
  }

  private manifest(id: string): string | null {
    const dir = this.dirFor(id);
    return dir ? path.join(dir, MANIFEST) : null;
  }

  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      id,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private async ids(): Promise<string[]> {
    await fs.mkdir(this.root, { recursive: true });
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && validWorldId(e.name)).map((e) => e.name).sort();
  }

  /** Every World the folder holds (R4). The set of Worlds is whatever is on disk. */
  async list(): Promise<WorldSummary[]> {
    const out: WorldSummary[] = [];
    for (const id of await this.ids()) {
      const loaded = await this.load(id);
      if (loaded) out.push({ id, name: loaded.world.name, readable: loaded.readable });
    }
    return out;
  }

  /**
   * Load a World, reporting rather than throwing.
   *
   * A manifest that will not parse loads read-only rather than falling back to
   * an empty World: `readJson` returns null for malformed JSON exactly as it
   * does for a missing file, so an empty fallback would have the next ordinary
   * mutation replace a hand-edited manifest for good — the same permanent loss
   * the spread-rebuild exists to prevent, triggered by a stray comma.
   */
  async load(id: string, opts: { validate?: boolean } = {}): Promise<LoadedWorld | null> {
    const dir = this.dirFor(id);
    const file = this.manifest(id);
    if (!dir || !file) return null;
    try {
      await fs.stat(dir);
    } catch {
      return null;
    }

    let present = true;
    try {
      await fs.stat(file);
    } catch {
      present = false;
    }

    if (!present) {
      // A directory with no manifest is a World in its first moment, not a
      // broken one.
      const world: World = { id, name: id, ...emptyFields() };
      return { world, readable: true, incomplete: [] };
    }

    const parsed = await readJson<unknown>(file);
    if (parsed === null) {
      const world: World = { id, name: id, ...emptyFields() };
      return {
        world,
        readable: false,
        readOnlyReason: "This World's manifest could not be read.",
        incomplete: [],
      };
    }

    const world = rebuild(parsed, id);
    const refusal = versionRefusal(world);
    const readable = refusal === null;
    // The confinement pass costs two `realpath` calls per clip the manifest
    // names, so the callers that only need the graph — a mutation about to
    // rewrite it, the clip route resolving one path — ask to skip it.
    const incomplete = opts.validate === false ? [] : await this.validate(dir, world);
    return { world, readable, ...(refusal ? { readOnlyReason: refusal } : {}), incomplete };
  }

  /**
   * One load-time pass that reports rather than throws.
   *
   * A rejected path marks its State or edge incomplete and is left in the
   * manifest untouched: the path is the author's work, and a World that
   * silently deleted it would be worse than one that says what it cannot use.
   */
  private async validate(dir: string, world: World): Promise<IncompleteClip[]> {
    const out: IncompleteClip[] = [];
    // Both owners, and every member of each. A set can hold several
    // independently broken clips, and reporting only the first would leave the
    // author fixing them one reopen at a time.
    const owners: { id: unknown; kind: "state" | "transition"; clips: unknown }[] = [
      ...world.states.map((state) => ({ id: state?.id, kind: "state" as const, clips: state?.clips })),
      ...world.transitions.map((t) => ({ id: t?.id, kind: "transition" as const, clips: t?.clips })),
    ];

    const pending: {
      ownerId: string;
      kind: "state" | "transition";
      index: number;
      memberIndex: number;
      path: unknown;
    }[] = [];
    for (const owner of owners) {
      // An entry the manifest kept but this build cannot identify has nothing
      // to report against; `entries()` deliberately keeps it rather than
      // deleting somebody's work, so the guard belongs here.
      if (typeof owner.id !== "string" || owner.id.length === 0) continue;
      if (!Array.isArray(owner.clips)) continue;
      for (const [index, sequence] of owner.clips.entries()) {
        const members = (sequence as ClipSequence)?.clips;
        if (!Array.isArray(members)) continue;
        for (const [memberIndex, clip] of members.entries()) {
          if (!clip || typeof clip !== "object") continue;
          pending.push({
            ownerId: owner.id,
            kind: owner.kind,
            index,
            memberIndex,
            path: (clip as ClipRef).path,
          });
        }
      }
    }

    // Issued together rather than one after another. Two realpath calls per
    // member, awaited in turn, was four hundred sequential round trips for a
    // twenty-State World of ten clips each — paid inside the World lock on
    // every mutation, so a fast typist queued renames behind them. The checks
    // are independent, and `Promise.all` keeps results in the order asked so
    // each verdict still belongs to the member beside it.
    // Each with a deadline. This pass runs on every mutation inside the World
    // lock, so one unreadable path on a stalled drive would hold every later
    // edit behind it. A check that does not answer reports nothing: an unknown
    // clip is not a broken one, and painting a World red because its disk is
    // slow would be worse than saying less.
    const resolutions = await Promise.all(
      pending.map((entry) =>
        withDeadline(resolveClipPath(dir, entry.path), CLIP_CHECK_MS, { ok: true, file: "" } as ClipResolution),
      ),
    );

    for (const [i, entry] of pending.entries()) {
      const resolved = resolutions[i]!;
      if (resolved.ok) continue;
      out.push({
        ownerId: entry.ownerId,
        ownerKind: entry.kind,
        index: entry.index,
        memberIndex: entry.memberIndex,
        path: String(entry.path ?? ""),
        reason: resolved.reason,
      });
    }
    return out;
  }

  /**
   * Create a World from a display name.
   *
   * The slug is derived server-side and the collision check compares lowercased
   * candidates: the filesystem folds case on Windows and macOS, so two Worlds
   * whose names differ only in case must not resolve to one directory.
   */
  async create(name: string): Promise<LoadedWorld> {
    return this.withLock("\u0000create", async () => {
      const taken = new Set((await this.ids()).map((id) => id.toLowerCase()));
      const base = worldSlug(name);
      let id = base;
      for (let n = 2; taken.has(id.toLowerCase()); n += 1) id = `${base}-${n}`;

      const dir = path.join(this.root, id);
      await fs.mkdir(path.join(dir, CLIPS_DIR), { recursive: true });
      const display = String(name ?? "").trim().slice(0, NAME_MAX);
      const world: World = { id, name: display.length > 0 ? display : id, ...emptyFields() };
      await writeJsonAtomic(path.join(dir, MANIFEST), world);
      return { world, readable: true, incomplete: [] };
    });
  }

  /**
   * Apply a change to one World's manifest under its lock.
   *
   * The World is re-read inside the lock and written back whole, so what is
   * persisted is always the spread rebuild of what was on disk a moment ago.
   */
  async mutate(id: string, apply: (world: World) => World | null): Promise<MutationResult> {
    if (!validWorldId(id)) return { ok: false, error: NO_SUCH_WORLD };
    return this.withLock(id, async () => {
      // Skipping the confinement pass here is not a shortcut: nothing reads the
      // pre-write `incomplete` list, and running it would double the realpath
      // cost of every mutation a node drag produces.
      const loaded = await this.load(id, { validate: false });
      if (!loaded) return { ok: false, error: NO_SUCH_WORLD };
      // Refused, and no write issued at all: touching the file is exactly what
      // would destroy the hand edit — or the older layout — that made it
      // unwritable.
      if (!loaded.readable) return { ok: false, error: loaded.readOnlyReason ?? UNREADABLE, loaded };

      let next: World | null;
      try {
        next = apply(loaded.world);
      } catch {
        // A manifest carrying an entry no edit function expected must not turn
        // a mutation into a rejected promise the caller can only log.
        return { ok: false, error: "That change could not be applied.", loaded };
      }
      if (!next) return { ok: false, error: "That change could not be applied.", loaded };
      // An edit that changed nothing is a success that need not be written. Two
      // tabs measuring the same clip both report it, and rewriting a
      // byte-identical manifest to broadcast it to everyone is work in exchange
      // for nothing.
      if (next === loaded.world) return { ok: true, loaded, unchanged: true };

      const dir = this.dirFor(id)!;
      // Re-checked inside the lock rather than mkdir'd: a World deleted from
      // disk while it was open would otherwise be resurrected as a manifest
      // with no clips by the next node drag.
      try {
        await fs.stat(dir);
      } catch {
        return { ok: false, error: NO_SUCH_WORLD };
      }
      await writeJsonAtomic(path.join(dir, MANIFEST), next);
      // Always, even when no clip path moved. Skipping it looks safe and is
      // not: the only list to fall back on comes from the deliberately
      // unvalidated load above, which reports `[]` rather than "not checked",
      // so reusing it erased the missing-clip marks on every drag and rename.
      // Two realpath calls per clip-bearing State, once per mutation, is the
      // price of the marks being true.
      return { ok: true, loaded: { world: next, readable: true, incomplete: await this.validate(dir, next) } };
    });
  }

  /**
   * Which World was last open (R4).
   *
   * The one piece of World state outside a World folder, kept here so it sits
   * under the same atomic-write discipline as everything else. A pointer naming
   * a World that has been deleted degrades to the picker.
   */
  async lastOpen(): Promise<string | null> {
    const stored = await readJson<{ worldId?: unknown }>(path.join(this.root, LAST_OPEN));
    const id = stored?.worldId;
    if (!validWorldId(id)) return null;
    return (await this.ids()).includes(id) ? id : null;
  }

  async setLastOpen(id: string | null): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await writeJsonAtomic(path.join(this.root, LAST_OPEN), { worldId: id });
  }

  /**
   * The folder browsing last reached, if it is still a folder.
   *
   * Checked rather than trusted: it names a place on a drive that may have been
   * unplugged since, and browsing that opened on an error would be worse than
   * one that opened at home.
   *
   * Not confined, deliberately. Browsing already reaches wherever the user
   * points it — that is the surface `live/library.ts` documents — so remembering
   * where they were reaches nowhere new. What it must not do is *fail*: a
   * hand-edited value here is a folder that does not open, not a path traversal.
   */
  async lastLibrary(): Promise<string | null> {
    const stored = await readJson<{ folder?: unknown }>(path.join(this.root, LAST_LIBRARY));
    const folder = stored?.folder;
    if (typeof folder !== "string" || folder.trim().length === 0) return null;
    const stat = await fs.stat(folder).catch(() => null);
    return stat?.isDirectory() ? folder : null;
  }

  async setLastLibrary(folder: string): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await writeJsonAtomic(path.join(this.root, LAST_LIBRARY), { folder });
  }
}

// ---------------------------------------------------------------------------
// Manifest edits
//
// Pure functions over a World, so the service holds no knowledge of the shape
// and every mutation is testable without a disk. Each returns a new World; a
// change that names something absent returns null, which the store reports as a
// refusal rather than writing an unchanged file.
// ---------------------------------------------------------------------------

function clean(value: unknown, max: number, fallback: string): string {
  const text = String(value ?? "").trim().slice(0, max);
  return text.length > 0 ? text : fallback;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * A place near the one asked for whose box overlaps no State already placed.
 *
 * Two boxes drawn over each other leave only the upper one clickable, and the
 * lower one cannot be dragged out from under it — which makes the World
 * unfixable through the graph it is authored on. The UI staggers what it
 * creates; this is what stops a caller that does not. It steps down by the same
 * row rhythm the UI lays out in, so what it produces looks placed rather than
 * nudged.
 */
function clearOf(world: World, x: number, y: number): { x: number; y: number } {
  const overlaps = (a: { x: number; y: number }, s: WorldState) =>
    finite(s.x) && finite(s.y) && Math.abs(s.x - a.x) < NODE_W && Math.abs(s.y - a.y) < NODE_H;

  let at = { x, y };
  for (let n = 0; n < 200; n += 1) {
    if (!world.states.some((s) => overlaps(at, s))) return at;
    at = { x: at.x, y: at.y + NODE_ROW_GAP };
  }
  return at;
}

/** Where the next transition out of a source sits in the order. */
function nextOrder(world: World, from: string | undefined, fromAny: boolean): number {
  const siblings = world.transitions.filter((t) =>
    fromAny ? t.fromAny === true : t.fromAny !== true && t.from === from,
  );
  return siblings.reduce((max, t) => Math.max(max, t.order ?? 0), -1) + 1;
}

/**
 * Add a State.
 *
 * The first State becomes the default, because a machine with States and no
 * entry point cannot run and nobody would choose that on purpose.
 */
export function addState(world: World, draft: StateDraft): World | null {
  if (!finite(draft?.x) || !finite(draft?.y)) return null;
  const at = clearOf(world, draft.x, draft.y);
  const state: WorldState = {
    id: crypto.randomUUID(),
    name: clean(draft.name, NAME_MAX, "state"),
    clips: [],
    ...at,
  };
  return {
    ...world,
    states: [...world.states, state],
    defaultStateId: world.defaultStateId ?? state.id,
  };
}

export function updateState(world: World, stateId: string, patch: StatePatch): World | null {
  const state = world.states.find((s) => s.id === stateId);
  if (!state) return null;
  const cleaned = patch.clips === undefined ? undefined : cleanClips(patch.clips);
  if (patch.clips !== undefined && cleaned === null) return null;
  if (patch.x !== undefined && !finite(patch.x)) return null;
  if (patch.y !== undefined && !finite(patch.y)) return null;
  // Keys are named rather than spread, so a junk key cannot ride into the
  // manifest and be preserved there forever by the spread rebuild.
  const next: WorldState = {
    ...state,
    name: patch.name === undefined ? state.name : clean(patch.name, NAME_MAX, state.name),
    // Untouched when the patch does not carry them. Re-cleaning a set the edit
    // never mentioned ran the client-input sanitiser over the manifest's own
    // clips on every rename and every drag, stripping any key a newer build had
    // written onto a member — the deletion the spread rebuild exists to stop,
    // one level down.
    clips: patch.clips === undefined ? state.clips : (cleaned ?? state.clips),
    // Named like every other field, and only when the patch carries it: an edit
    // that renames a State must not decide its atomicity by omission.
    atomic: patch.atomic === undefined ? state.atomic : patch.atomic === true,
    ...movedTo(world, state, patch),
  };
  return { ...world, states: world.states.map((s) => (s.id === stateId ? next : s)) };
}

/**
 * Remove a State, and every transition that pointed at it.
 *
 * Leaving the orphans would draw arrows to nothing and let the runtime take a
 * transition into a State that is not there.
 */
export function removeState(world: World, stateId: string): World | null {
  if (!world.states.some((s) => s.id === stateId)) return null;
  const states = world.states.filter((s) => s.id !== stateId);
  return {
    ...world,
    states,
    transitions: world.transitions.filter((t) => t.from !== stateId && t.to !== stateId),
    defaultStateId: world.defaultStateId === stateId ? (states[0]?.id ?? null) : world.defaultStateId,
  };
}

export function setDefaultState(world: World, stateId: string): World | null {
  if (!world.states.some((s) => s.id === stateId)) return null;
  return { ...world, defaultStateId: stateId };
}

/**
 * Remove the clauses a re-typed Parameter has left meaningless.
 *
 * Dropped rather than corrected. `cleanConditions` substitutes the first
 * allowed op and the type's default, which is right for a patch being edited —
 * but applied to a re-type it rewrites the author's guard into a different one:
 * `speed gt 5` on an int becomes `speed is false` on a bool, which holds at the
 * default and *fires* the transition the guard existed to hold shut. Removing
 * the clause leaves a transition that is too eager rather than one that acts on
 * a condition nobody wrote, and the graph's own reports are what say so.
 */
function dropUnfit(conditions: unknown, parameter: Parameter): Condition[] {
  if (!Array.isArray(conditions)) return [];
  const allowed = opsFor(parameter.type);
  return (conditions as Condition[]).filter(
    (c) =>
      c.parameter !== parameter.name ||
      (allowed.includes(c.op) && valueFits(parameter.type, c.value)),
  );
}

function cleanConditions(conditions: unknown, parameters: Parameter[]): Condition[] {
  if (!Array.isArray(conditions)) return [];
  const byName = new Map(parameters.map((p) => [p.name, p]));
  return conditions
    .filter((c): c is Condition => !!c && typeof c === "object" && typeof (c as Condition).parameter === "string")
    .map((c) => {
      const parameter = byName.get(c.parameter);
      // A clause naming a Parameter that does not exist keeps its shape rather
      // than being dropped: the author may be about to declare it, and silently
      // deleting their work is the failure this whole store guards against.
      if (!parameter) return { parameter: c.parameter, op: c.op, value: c.value };
      const allowed = opsFor(parameter.type);
      const op = allowed.includes(c.op) ? c.op : allowed[0]!;
      const value = valueFits(parameter.type, c.value) ? c.value : defaultValueOf(parameter);
      return { parameter: c.parameter, op, value };
    });
}

export function addTransition(world: World, draft: TransitionDraft): World | null {
  if (!world.states.some((s) => s.id === draft?.to)) return null;
  const fromAny = draft.fromAny === true;
  if (!fromAny && !world.states.some((s) => s.id === draft.from)) return null;
  const transition: Transition = {
    id: crypto.randomUUID(),
    ...(fromAny ? { fromAny: true } : { from: draft.from }),
    to: draft.to,
    clips: [],
    conditions: cleanConditions(draft.conditions, world.parameters),
    // Waiting for the clip is the useful default: a transition that fires the
    // instant its conditions hold cuts the current clip short, which is the
    // less common intent.
    hasExitTime: draft.hasExitTime !== false,
    exitTime: clampExitTime(draft.exitTime),
    order: nextOrder(world, draft.from, fromAny),
  };
  return { ...world, transitions: [...world.transitions, transition] };
}

/**
 * Keep a node somewhere it can be grabbed again.
 *
 * A drag can end anywhere the pointer goes, including above and left of the
 * canvas — and a node dragged past the origin is drawn partly or wholly outside
 * the area that receives clicks, so there is no way to drag it back.
 */
/**
 * Where this edit leaves a State's node.
 *
 * Only when the patch actually carries a position: a rename or a clip
 * assignment must not relocate a node as a side effect, and a stored coordinate
 * can be absent or junk — `entries()` keeps a State this build cannot fully
 * read rather than dropping somebody's work, and `Math.max` of that is NaN,
 * which writes as `null`.
 *
 * A move is clamped to the canvas and then stepped clear of anything already
 * there, for the same reason `addState` is: two boxes on the same spot leave
 * only the upper one clickable, and the lower one cannot be dragged out.
 */
function movedTo(world: World, state: WorldState, patch: StatePatch): { x: number; y: number } {
  if (patch.x === undefined && patch.y === undefined) return { x: state.x, y: state.y };
  const asked = {
    x: Math.max(finite(patch.x) ? patch.x : state.x, 0),
    y: Math.max(finite(patch.y) ? patch.y : state.y, 0),
  };
  if (!finite(asked.x) || !finite(asked.y)) return { x: state.x, y: state.y };
  return clearOf({ ...world, states: world.states.filter((s) => s.id !== state.id) }, asked.x, asked.y);
}

/** A fraction of the clip. Outside 0–1 it is not a fraction. */
function clampExitTime(value: unknown): number {
  if (!finite(value)) return 1;
  return Math.min(Math.max(value, 0), 1);
}

export function updateTransition(world: World, transitionId: string, patch: TransitionPatch): World | null {
  const transition = world.transitions.find((t) => t.id === transitionId);
  if (!transition) return null;
  const cleanedClips = patch.clips === undefined ? undefined : cleanClips(patch.clips);
  if (patch.clips !== undefined && cleanedClips === null) return null;
  const next: Transition = {
    ...transition,
    clips: patch.clips === undefined ? transition.clips : (cleanedClips ?? transition.clips),
    conditions:
      patch.conditions === undefined ? transition.conditions : cleanConditions(patch.conditions, world.parameters),
    // Compared against `true` rather than taken for truthiness: the string
    // "maybe" would otherwise silently change what the transition waits for.
    hasExitTime: patch.hasExitTime === undefined ? transition.hasExitTime : patch.hasExitTime === true,
    exitTime: patch.exitTime === undefined ? transition.exitTime : clampExitTime(patch.exitTime),
    muted: patch.muted === undefined ? transition.muted : patch.muted === true,
    solo: patch.solo === undefined ? transition.solo : patch.solo === true,
  };
  return { ...world, transitions: world.transitions.map((t) => (t.id === transitionId ? next : t)) };
}

export function removeTransition(world: World, transitionId: string): World | null {
  if (!world.transitions.some((t) => t.id === transitionId)) return null;
  return { ...world, transitions: world.transitions.filter((t) => t.id !== transitionId) };
}

/**
 * Set the order of the transitions out of one source.
 *
 * Every id must belong to that source, and the list must name all of them —
 * a partial reorder would leave the unnamed ones at an order the author did not
 * choose, which is worse than refusing.
 */
export function reorderTransitions(
  world: World,
  from: string | undefined,
  fromAny: boolean,
  order: string[],
): World | null {
  if (!Array.isArray(order)) return null;
  const siblings = world.transitions.filter((t) =>
    fromAny ? t.fromAny === true : t.fromAny !== true && t.from === from,
  );
  if (siblings.length !== order.length) return null;
  const ids = new Set(siblings.map((t) => t.id));
  if (!order.every((id) => ids.has(id)) || new Set(order).size !== order.length) return null;

  const position = new Map(order.map((id, index) => [id, index]));
  return {
    ...world,
    transitions: world.transitions.map((t) => (position.has(t.id) ? { ...t, order: position.get(t.id)! } : t)),
  };
}

/**
 * A set of clips, with every member cleaned and the junk dropped.
 *
 * The whole set is rebuilt rather than trusted, for the reason `updateState`
 * names its keys: a member that arrived over the protocol must not carry a
 * stray field into the manifest, where the spread rebuild would then preserve
 * it forever.
 */
function cleanClips(clips: unknown): ClipSequence[] | null {
  if (!Array.isArray(clips)) return [];
  const sequences = clips.map((s) => (s as ClipSequence)?.clips);
  // Refused rather than trimmed. Slicing dropped the member the author had just
  // added — it is appended last — and reported success, leaving a copied file
  // that nothing names. Counted in clips across the whole set, which is what
  // the bound is actually about.
  const total = sequences.reduce<number>((n, c) => n + (Array.isArray(c) ? c.length : 0), 0);
  if (total > MAX_CLIPS_PER_SET) return null;
  return (
    sequences
      .map((members) =>
        Array.isArray(members)
          ? members.map((c) => cleanClip(c as ClipRef)).filter((c): c is ClipRef => c !== null)
          : [],
      )
      // A run whose every member was junk is dropped rather than kept as an
      // empty sequence: an empty run is a draw that plays nothing, which is a
      // silent hole in a State that still claims to hold clips.
      .filter((members) => members.length > 0)
      .map((members) => ({ clips: members }))
  );
}

function cleanClip(clip: ClipRef | null | undefined): ClipRef | null {
  if (!clip || typeof clip.path !== "string" || clip.path.trim().length === 0) return null;
  // Clamped where the number enters. `setTimeout` truncates its delay to 32
  // bits, so an unbounded duration is not a long wait — it is a 1ms one, with a
  // broadcast storm behind it.
  const durationMs =
    Number.isFinite(clip.durationMs) && clip.durationMs > 0 ? Math.min(clip.durationMs, MAX_CLIP_MS) : 0;
  // Named, not spread. This runs only on a set the client supplied, and
  // spreading let arbitrary keys of arbitrary size ride into the manifest where
  // the rebuild would preserve them forever. A key a newer build wrote survives
  // by a different route: a patch that does not mention `clips` leaves them
  // untouched, which is every edit except one that deliberately replaces a set.
  return { path: clip.path.trim(), durationMs };
}

/**
 * Correct the recorded length of every State naming this clip.
 *
 * Addressed by path rather than by State: the browser that measured it knows
 * which file played, not which State pointed at it, and every use of one file
 * has the same true length.
 */
export function recordClipDuration(world: World, clipPath: string, durationMs: number): World | null {
  if (typeof clipPath !== "string" || clipPath.trim().length === 0) return null;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const wanted = clipPath.trim();
  const ms = Math.min(durationMs, MAX_CLIP_MS);
  let changed = false;
  const correct = <T extends { clips: ClipSequence[] }>(owner: T): T => {
    if (!Array.isArray(owner.clips)) return owner;
    let touched = false;
    // Every member of every run: one file can appear in several sequences of one
    // set, and the browser that measured it reported a length true of all of
    // them.
    const clips = owner.clips.map((sequence) => {
      if (!Array.isArray(sequence?.clips)) return sequence;
      let inner = false;
      const members = sequence.clips.map((clip) => {
        if (!clip || clip.path !== wanted || clip.durationMs === ms) return clip;
        inner = true;
        return { ...clip, durationMs: ms };
      });
      if (!inner) return sequence;
      touched = true;
      return { ...sequence, clips: members };
    });
    if (!touched) return owner;
    changed = true;
    return { ...owner, clips };
  };

  const states = world.states.map(correct);
  const transitions = world.transitions.map(correct);
  // Unchanged is success, not refusal: `null` reaches the client as "that change
  // could not be applied", and two tabs measuring the same clip both report it.
  return changed ? { ...world, states, transitions } : world;
}

export function declareParameter(world: World, parameter: Parameter): World | null {
  const name = String(parameter?.name ?? "").trim().slice(0, NAME_MAX);
  if (name.length === 0) return null;
  if (!PARAMETER_TYPES.includes(parameter.type)) return null;
  const found = world.parameters.find((p) => p.name === name);
  // Spread the Parameter that is already there before overriding, the way
  // `updateState` and `updateTransition` do. Naming the three fields rebuilt it
  // from scratch, which drops whatever a newer build had written onto it — the
  // failure docs/solutions/rebuilding-a-cache-field-by-field-turns-a-read-into-a-delete.md
  // is about, in the one array that still did it.
  const next: Parameter = {
    ...found,
    name,
    type: parameter.type,
    defaultValue: defaultValueOf({ ...parameter, name }),
  };
  const parameters = found
    ? world.parameters.map((p) => (p.name === name ? next : p))
    : [...world.parameters, next];

  // A Parameter re-declared under a different type leaves clauses behind that
  // were written against the old one — an `is true` on what is now an int can
  // never hold, and the transition is dead with nothing saying why.
  const retyped = found !== undefined && found.type !== parameter.type;
  if (!retyped) return { ...world, parameters };
  return {
    ...world,
    parameters,
    transitions: world.transitions.map((t) => ({ ...t, conditions: dropUnfit(t.conditions, next) })),
  };
}

/**
 * Remove a Parameter, and every clause that read it.
 *
 * A clause naming a Parameter that no longer exists can never hold, which would
 * silently disable its transition — a dead control with no explanation.
 */
export function removeParameter(world: World, name: string): World | null {
  if (!world.parameters.some((p) => p.name === name)) return null;
  return {
    ...world,
    parameters: world.parameters.filter((p) => p.name !== name),
    transitions: world.transitions.map((t) => ({
      ...t,
      conditions: (t.conditions ?? []).filter((c) => c.parameter !== name),
    })),
  };
}

/** Whether a value may be assigned to this Parameter at runtime. */
export function parameterAccepts(world: World, name: string, value: unknown): value is ParameterValue {
  const parameter = world.parameters.find((p) => p.name === name);
  return !!parameter && valueFits(parameter.type, value);
}
