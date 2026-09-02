import path from "node:path";
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import type {
  ClipRef,
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
} from "../../../shared/src/worlds.js";
import { defaultValueOf, valueFits } from "../../../shared/src/world-graph.js";
import { readJson, writeJsonAtomic } from "./atomic.js";
import { worldsDir } from "../paths.js";

const MANIFEST = "world.json";
const CLIPS_DIR = "clips";
const LAST_OPEN = "last-open.json";
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

function rebuild(parsed: unknown, id: string): World {
  const base = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Partial<World>;
  const empty = emptyFields();
  return {
    ...(base as World),
    // The directory is the identity: a manifest carried in from elsewhere names
    // whatever slug it had on the machine that wrote it, and the folder here is
    // the one that is true.
    id,
    name: typeof base.name === "string" && base.name.trim().length > 0 ? base.name.slice(0, NAME_MAX) : id,
    version: typeof base.version === "number" ? base.version : 1,
    defaultStateId: typeof base.defaultStateId === "string" ? base.defaultStateId : null,
    states: entries(base.states, empty.states),
    transitions: entries(base.transitions, empty.transitions),
    parameters: entries(base.parameters, empty.parameters),
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
function versionRefusal(world: World): string | null {
  if (world.version === WORLD_VERSION) return null;
  if (world.version < WORLD_VERSION) {
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
/**
 * Whether two versions of a World name the same clip files.
 *
 * Identity is the set of paths, not their order or the States holding them: a
 * clip moved from one State to another is still a path already confined.
 */
function sameClipPaths(a: World, b: World): boolean {
  const paths = (w: World) =>
    (w.states ?? [])
      .map((s) => s.clip?.path)
      .filter((p): p is string => typeof p === "string")
      .sort();
  const before = paths(a);
  const after = paths(b);
  return before.length === after.length && before.every((p, i) => p === after[i]);
}

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
    for (const state of world.states) {
      // An entry the manifest kept but this build cannot identify has nothing
      // to report against; `entries()` deliberately keeps it rather than
      // deleting somebody's work, so the guard belongs here.
      if (typeof state?.id !== "string" || state.id.length === 0) continue;
      const clip = state.clip;
      if (!clip || typeof clip !== "object") continue;
      const resolved = await resolveClipPath(dir, clip.path);
      if (!resolved.ok) out.push({ stateId: state.id, path: String(clip.path ?? ""), reason: resolved.reason });
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
      // Only when a clip path actually moved. `validate` costs two realpath
      // calls per clip-bearing State, and a node drag or a rename — the two
      // highest-rate mutations there are — change no clip at all.
      const incomplete = sameClipPaths(loaded.world, next)
        ? (loaded.incomplete ?? (await this.validate(dir, next)))
        : await this.validate(dir, next);
      return { ok: true, loaded: { world: next, readable: true, incomplete } };
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
    clip: null,
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
  if (patch.x !== undefined && !finite(patch.x)) return null;
  if (patch.y !== undefined && !finite(patch.y)) return null;
  // Keys are named rather than spread, so a junk key cannot ride into the
  // manifest and be preserved there forever by the spread rebuild.
  const next: WorldState = {
    ...state,
    name: patch.name === undefined ? state.name : clean(patch.name, NAME_MAX, state.name),
    clip: patch.clip === undefined ? state.clip : cleanClip(patch.clip),
    x: patch.x ?? state.x,
    y: patch.y ?? state.y,
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

/** A fraction of the clip. Outside 0–1 it is not a fraction. */
function clampExitTime(value: unknown): number {
  if (!finite(value)) return 1;
  return Math.min(Math.max(value, 0), 1);
}

export function updateTransition(world: World, transitionId: string, patch: TransitionPatch): World | null {
  const transition = world.transitions.find((t) => t.id === transitionId);
  if (!transition) return null;
  const next: Transition = {
    ...transition,
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

function cleanClip(clip: ClipRef | null | undefined): ClipRef | null {
  if (!clip || typeof clip.path !== "string" || clip.path.trim().length === 0) return null;
  // Clamped where the number enters. `setTimeout` truncates its delay to 32
  // bits, so an unbounded duration is not a long wait — it is a 1ms one, with a
  // broadcast storm behind it.
  const durationMs =
    Number.isFinite(clip.durationMs) && clip.durationMs > 0 ? Math.min(clip.durationMs, MAX_CLIP_MS) : 0;
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
  const states = world.states.map((state) => {
    if (!state.clip || state.clip.path !== wanted || state.clip.durationMs === ms) return state;
    changed = true;
    return { ...state, clip: { ...state.clip, durationMs: ms } };
  });
  // Unchanged is success, not refusal: `null` reaches the client as "that change
  // could not be applied", and two tabs measuring the same clip both report it.
  return changed ? { ...world, states } : world;
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
    transitions: world.transitions.map((t) => ({ ...t, conditions: cleanConditions(t.conditions, parameters) })),
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
