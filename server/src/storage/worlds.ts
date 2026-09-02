import path from "node:path";
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import type {
  Camera,
  CameraPatch,
  ClipRef,
  ClipTarget,
  Condition,
  Edge,
  EdgeDraft,
  EdgePatch,
  IncompleteClip,
  IncompleteReason,
  Parameter,
  World,
  WorldState,
  WorldSummary,
} from "../../../shared/src/types.js";
import { cameraUsable } from "../../../shared/src/world-geometry.js";
import { readJson, writeJsonAtomic } from "./atomic.js";
import { worldsDir } from "../paths.js";

const MANIFEST = "world.json";
const CLIPS_DIR = "clips";
const LAST_OPEN = "last-open.json";
const NAME_MAX = 60;
const SLUG_MAX = 48;

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
  return { positions: [], scenes: [], states: [], edges: [], parameters: [], struck: [] };
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
    positions: Array.isArray(base.positions) ? base.positions : empty.positions,
    scenes: Array.isArray(base.scenes) ? base.scenes : empty.scenes,
    states: Array.isArray(base.states) ? base.states : empty.states,
    edges: Array.isArray(base.edges) ? base.edges : empty.edges,
    parameters: Array.isArray(base.parameters) ? base.parameters : empty.parameters,
    struck: Array.isArray(base.struck) ? base.struck : empty.struck,
  };
}

// The Windows device names. A folder called `con` cannot be created at all, so
// an ordinary World name would fail creation with an error naming nothing.
const RESERVED = new Set([
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
    .replace(/^[-._]+/, "")
    .replace(/[-._]+$/, "")
    .slice(0, SLUG_MAX);
  const base = cleaned.length > 0 ? cleaned : "world";
  // Windows reserves the stem whatever follows the dot, so `con.room` is
  // refused as surely as `con`.
  const stem = base.split(".")[0]!.toUpperCase();
  return RESERVED.has(stem) ? `${base}-world` : base;
}

/** Whether an id is safely usable as one path segment, before it touches disk. */
export function validWorldId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 80 && /^[a-z0-9][a-z0-9._-]*$/.test(id) && !id.includes("..");
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
 * `ConversationStore`: the World is the unit of write, and a floorplan drag
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
  async load(id: string): Promise<LoadedWorld | null> {
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
      return { world, readable: false, incomplete: [] };
    }

    const world = rebuild(parsed, id);
    return { world, readable: true, incomplete: await this.validate(dir, world) };
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
    const check = async (kind: "state" | "edge", id: string, slot: "clip" | "entry", clip: ClipRef | null | undefined) => {
      if (!clip || typeof clip !== "object") return;
      const resolved = await resolveClipPath(dir, clip.path);
      if (!resolved.ok) out.push({ kind, id, slot, path: String(clip.path ?? ""), reason: resolved.reason });
    };
    for (const state of world.states) await check("state", state.id, "clip", state.clip);
    for (const edge of world.edges) {
      await check("edge", edge.id, "clip", edge.clip);
      if (edge.kind === "cut") await check("edge", edge.id, "entry", edge.entryClip);
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
    return this.withLock(" create", async () => {
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
      const loaded = await this.load(id);
      if (!loaded) return { ok: false, error: NO_SUCH_WORLD };
      // Refused, and no write issued at all: touching the file is exactly what
      // would destroy the hand edit that made it unreadable.
      if (!loaded.readable) return { ok: false, error: UNREADABLE, loaded };

      const next = apply(loaded.world);
      if (!next) return { ok: false, error: "That change could not be applied.", loaded };

      const dir = this.dirFor(id)!;
      await fs.mkdir(dir, { recursive: true });
      await writeJsonAtomic(path.join(dir, MANIFEST), next);
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

export function addPosition(world: World, name: string, x: number, y: number): World | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const position = { id: crypto.randomUUID(), name: clean(name, NAME_MAX, "position"), x, y };
  return { ...world, positions: [...world.positions, position] };
}

export function movePosition(world: World, positionId: string, x: number, y: number): World | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!world.positions.some((p) => p.id === positionId)) return null;
  return { ...world, positions: world.positions.map((p) => (p.id === positionId ? { ...p, x, y } : p)) };
}

export function addScene(world: World, name: string, camera: Camera): World | null {
  if (!cameraUsable(camera)) return null;
  const scene = {
    id: crypto.randomUUID(),
    name: clean(name, NAME_MAX, "camera"),
    camera: { x: camera.x, y: camera.y, facing: camera.facing, fov: camera.fov, range: camera.range },
  };
  return { ...world, scenes: [...world.scenes, scene] };
}

export function aimCamera(world: World, sceneId: string, patch: CameraPatch): World | null {
  const scene = world.scenes.find((s) => s.id === sceneId);
  if (!scene) return null;
  // Merged field by field and then accepted or refused whole: a patch carrying
  // a NaN range must not be half-applied.
  const camera: Camera = { ...scene.camera, ...patch };
  if (!cameraUsable(camera)) return null;
  return { ...world, scenes: world.scenes.map((s) => (s.id === sceneId ? { ...s, camera } : s)) };
}

export function strikePairing(world: World, sceneId: string, positionId: string, struck: boolean): World | null {
  if (!world.scenes.some((s) => s.id === sceneId)) return null;
  if (!world.positions.some((p) => p.id === positionId)) return null;
  const without = world.struck.filter((p) => !(p.sceneId === sceneId && p.positionId === positionId));
  return { ...world, struck: struck ? [...without, { sceneId, positionId }] : without };
}

function cleanConditions(conditions: unknown): Condition[] {
  if (!Array.isArray(conditions)) return [];
  return conditions
    .filter((c): c is Condition => !!c && typeof c === "object" && typeof (c as Condition).parameter === "string")
    .map((c) => ({ parameter: c.parameter, op: c.op === "ne" ? "ne" : "eq", value: String(c.value ?? "") }));
}

export function addEdge(world: World, draft: EdgeDraft): World | null {
  const kind = draft.kind === "cut" || draft.kind === "travel" ? draft.kind : "pose";
  if (!world.states.some((s) => s.id === draft.from)) return null;
  if (!world.states.some((s) => s.id === draft.to)) return null;
  const edge: Edge = {
    id: crypto.randomUUID(),
    kind,
    from: draft.from,
    to: draft.to,
    conditions: cleanConditions(draft.conditions),
    // An edge with no condition and no clip-end trigger can never fire, so the
    // default is the one that makes an unconditional edge behave as authored.
    onClipEnd: draft.onClipEnd !== false,
    clip: null,
    ...(kind === "cut"
      ? { entryClip: null, exitEdge: draft.exitEdge ?? null, entryEdge: draft.entryEdge ?? null }
      : {}),
  };
  return { ...world, edges: [...world.edges, edge] };
}

export function updateEdge(world: World, edgeId: string, patch: EdgePatch): World | null {
  const edge = world.edges.find((e) => e.id === edgeId);
  if (!edge) return null;
  // Keys merged individually rather than spread wholesale, so a patch carrying
  // only conditions cannot drop a clip the author already assigned.
  const next: Edge = {
    ...edge,
    ...patch,
    id: edge.id,
    kind: edge.kind,
    from: edge.from,
    to: edge.to,
    conditions: patch.conditions === undefined ? edge.conditions : cleanConditions(patch.conditions),
  };
  return { ...world, edges: world.edges.map((e) => (e.id === edgeId ? next : e)) };
}

function cleanClip(clip: ClipRef | null): ClipRef | null {
  if (!clip || typeof clip.path !== "string" || clip.path.trim().length === 0) return null;
  const durationMs = Number.isFinite(clip.durationMs) && clip.durationMs > 0 ? clip.durationMs : 0;
  return { path: clip.path.trim(), durationMs };
}

/**
 * Assign or clear a clip.
 *
 * A State is named by its pairing rather than by an id, and created on first
 * assignment: the pairing is derived from coverage, so an id for it would have
 * to be invented by whichever side spoke first. Assigning null is therefore
 * also how a State is brought into existence before its clip is generated,
 * which is what lets an edge be drawn between two Positions first.
 */
export function assignClip(world: World, target: ClipTarget, clip: ClipRef | null): World | null {
  const value = cleanClip(clip);
  if (target.kind === "edge") {
    const edge = world.edges.find((e) => e.id === target.edgeId);
    if (!edge) return null;
    if (target.slot === "entry" && edge.kind !== "cut") return null;
    const next = target.slot === "entry" ? { ...edge, entryClip: value } : { ...edge, clip: value };
    return { ...world, edges: world.edges.map((e) => (e.id === edge.id ? next : e)) };
  }

  if (!world.scenes.some((s) => s.id === target.sceneId)) return null;
  if (!world.positions.some((p) => p.id === target.positionId)) return null;
  const pose = target.pose && target.pose.length > 0 ? target.pose : undefined;
  const existing = world.states.find(
    (s) => s.sceneId === target.sceneId && s.positionId === target.positionId && (s.pose ?? "") === (pose ?? ""),
  );
  if (existing) {
    return { ...world, states: world.states.map((s) => (s.id === existing.id ? { ...s, clip: value } : s)) };
  }
  const state: WorldState = {
    id: crypto.randomUUID(),
    sceneId: target.sceneId,
    positionId: target.positionId,
    ...(pose ? { pose } : {}),
    clip: value,
  };
  return { ...world, states: [...world.states, state] };
}

export function declareParameter(world: World, parameter: Parameter): World | null {
  const name = String(parameter?.name ?? "").trim().slice(0, NAME_MAX);
  if (name.length === 0) return null;
  const values = Array.isArray(parameter.values)
    ? [...new Set(parameter.values.filter((v) => typeof v === "string" && v.length > 0))]
    : [];
  if (values.length === 0) return null;
  const defaultValue = values.includes(parameter.defaultValue) ? parameter.defaultValue : values[0]!;
  const next = { name, values, defaultValue };
  const existing = world.parameters.some((p) => p.name === name);
  return {
    ...world,
    parameters: existing ? world.parameters.map((p) => (p.name === name ? next : p)) : [...world.parameters, next],
  };
}
