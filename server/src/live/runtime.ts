import type { ClipRef, Edge, LiveState, World } from "../../../shared/src/types.js";
import { conditionsHold } from "../../../shared/src/world-geometry.js";

/**
 * How long a clip runs when the manifest does not say.
 *
 * A State whose clip was assigned before durations were recorded, or whose
 * duration arrived as zero, still has to advance: a machine that waited forever
 * on an unknown length would freeze the World rather than report anything.
 */
export const DEFAULT_CLIP_MS = 3_000;

export interface RuntimeOptions {
  /** Called whenever what is on screen changes. */
  onChange(live: LiveState): void;
  /**
   * Whether a clip can actually be played. Absent means "assume it can",
   * which is what a test wanting no filesystem uses.
   */
  clipUsable?(clip: ClipRef): Promise<boolean>;
}

interface Pending {
  generation: number;
  resolve(): void;
  timer: NodeJS.Timeout | null;
}

/**
 * The state machine: what the character is doing, and what should be on screen.
 *
 * It lives on the server rather than in the browser (KTD1) because a Parameter
 * set by an agent must move the character whether or not anything is watching.
 * That has a consequence the browser version would not have had: the runtime is
 * also the timing authority, so clip end is fired by its own timer seeded from
 * the duration the manifest records (KTD1a). A watching client's clip-end
 * report is a resync signal and never the trigger — with the trigger on the
 * client, a headless World would take exactly one edge and freeze, possibly
 * mid-Cut with the camera already changed.
 */
export class WorldRuntime {
  private world: World;
  private values: Record<string, string> = {};
  private stateId: string | null = null;
  private sceneId: string | null = null;
  private clip: ClipRef | null = null;
  private phase: LiveState["phase"] = "holding";
  private fault: string | null = null;
  private generation = 0;
  private pending: Pending | null = null;
  private running = false;

  constructor(world: World, private readonly opts: RuntimeOptions) {
    this.world = world;
  }

  /**
   * Begin at the declared defaults.
   *
   * Parameter values reset rather than persisting across a restart: they are
   * live state, the manifest holds the graph, and a World that reopened
   * mid-circuit would be describing a character who had not moved.
   */
  start(): void {
    this.running = true;
    this.values = {};
    for (const parameter of this.world.parameters ?? []) {
      this.values[parameter.name] = parameter.defaultValue;
    }
    this.enter(this.initialStateId(), "holding");
  }

  stop(): void {
    this.running = false;
    this.clearPending();
  }

  private initialStateId(): string | null {
    const states = this.world.states ?? [];
    // A State with a clip is somewhere to actually be; one without is a
    // placeholder the author has drawn but not filmed.
    return (states.find((s) => !!s.clip) ?? states[0])?.id ?? null;
  }

  /** The manifest changed under a running World — re-seat without restarting it. */
  setWorld(world: World): void {
    this.world = world;
    for (const parameter of world.parameters ?? []) {
      if (!(parameter.name in this.values)) this.values[parameter.name] = parameter.defaultValue;
    }
    if (!this.stateId || !(world.states ?? []).some((s) => s.id === this.stateId)) {
      this.supersede();
      this.enter(this.initialStateId(), "holding");
      return;
    }
    // Holding on a State whose clip was just assigned: pick it up rather than
    // waiting for a trigger that may never come.
    if (this.phase === "holding") {
      this.supersede();
      this.enter(this.stateId, "holding");
    }
  }

  live(): LiveState {
    return {
      worldId: this.world.id,
      stateId: this.stateId,
      sceneId: this.sceneId,
      clip: this.clip,
      phase: this.phase,
      parameters: { ...this.values },
      generation: this.generation,
      fault: this.fault,
    };
  }

  private emit(): void {
    this.opts.onChange(this.live());
  }

  // Every clip issued gets its own generation, including the two halves of a
  // Cut and each turn of a loop. That is what makes a report identifiable as
  // stale: the triple it carries names the clip it was issued for and nothing
  // else.
  private bump(): number {
    this.generation += 1;
    return this.generation;
  }

  private clearPending(): void {
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  /** Abandon whatever is in flight; the generation check downstream does the rest. */
  private supersede(): void {
    const pending = this.pending;
    this.clearPending();
    this.bump();
    pending?.resolve();
  }

  private durationOf(clip: ClipRef | null): number {
    const ms = clip?.durationMs;
    return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_CLIP_MS;
  }

  /**
   * Wait out one clip.
   *
   * The timer is the authority. `step()` and a matching clip-end report resolve
   * it early, which is what makes a test deterministic and what lets a browser
   * that is a little ahead of the recorded duration resync — neither of them is
   * what makes the machine advance.
   */
  private playClip(generation: number, clip: ClipRef | null): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending?.generation === generation) {
          this.clearPending();
          resolve();
        }
      }, this.durationOf(clip));
      timer.unref?.();
      this.pending = { generation, resolve, timer };
    });
  }

  private stateById(id: string | null): World["states"][number] | undefined {
    if (!id) return undefined;
    return (this.world.states ?? []).find((s) => s.id === id);
  }

  /** Settle on a State and start its loop. */
  private enter(stateId: string | null, phase: LiveState["phase"]): void {
    const state = this.stateById(stateId);
    this.stateId = state?.id ?? null;
    this.sceneId = state?.sceneId ?? null;
    this.clip = state?.clip ?? null;
    this.phase = phase;
    // Bumped before the emit, not inside `armLoop`: a client reports back the
    // generation it was told, so the number in the broadcast has to be the one
    // the clip about to play was issued under.
    const generation = this.bump();
    this.emit();
    this.armLoop(generation);
  }

  /**
   * Arm the current State's loop.
   *
   * A State with no clip holds silently: there is nothing to end, so there is
   * no clip-end trigger, and the only way out is a Parameter change.
   */
  private armLoop(generation: number): void {
    if (!this.running || !this.clip) return;
    void this.playClip(generation, this.clip).then(() => {
      if (!this.running || this.generation !== generation) return;
      this.onTrigger("clip-end");
    });
  }

  /**
   * Set a Parameter and evaluate (R20).
   *
   * The same path the plan view and an agent both take (AE5) — there is no
   * second entry point that could behave differently.
   */
  setParameter(name: string, value: string): boolean {
    const parameter = (this.world.parameters ?? []).find((p) => p.name === name);
    if (!parameter) return false;
    if (!parameter.values.includes(value)) return false;
    this.values[name] = value;
    this.onTrigger("parameter");
    return true;
  }

  parameters(): Record<string, string> {
    return { ...this.values };
  }

  /**
   * A watching browser's clip-end report.
   *
   * Discarded unless every part of the triple matches what is actually playing.
   * Two open tabs, or one tab reloading mid-clip, would otherwise advance the
   * machine twice — which is the chaining R21 forbids, arriving by the back
   * door.
   */
  reportClipEnd(worldId: string, stateId: string, generation: number): boolean {
    if (worldId !== this.world.id) return false;
    if ((this.stateId ?? "") !== stateId) return false;
    if (!this.pending || this.pending.generation !== generation) return false;
    const pending = this.pending;
    this.clearPending();
    pending.resolve();
    return true;
  }

  /**
   * End the current clip now.
   *
   * A test seam, so a suite need not wait out real clip durations. It is
   * deliberately not the only path exercised — a seam every test uses leaves
   * the production trigger, the timer, entirely uncovered.
   */
  step(): boolean {
    if (!this.pending) return false;
    const pending = this.pending;
    this.clearPending();
    pending.resolve();
    return true;
  }

  /** Whether a clip is currently being waited on — the shape a test polls. */
  get idle(): boolean {
    return this.pending === null;
  }

  private eligible(trigger: "parameter" | "clip-end"): Edge | undefined {
    const outbound = (this.world.edges ?? []).filter((e) => e.from === this.stateId);
    // First satisfied edge, in manifest order, and exactly one (R21). The
    // machine holds afterwards until a trigger fires again, which is what keeps
    // a missing edge a visible dead end rather than an infinite search.
    return outbound.find((edge) => {
      const waits = edge.onClipEnd !== false;
      // `onClipEnd` is what an edge means by "when": an edge that waits lets the
      // current loop finish (F2's floor idle), one that does not cuts as soon as
      // the value changes.
      if (trigger === "clip-end" ? !waits : waits) return false;
      return conditionsHold(edge, this.values);
    });
  }

  private onTrigger(trigger: "parameter" | "clip-end"): void {
    if (!this.running) return;
    const edge = this.eligible(trigger);
    if (!edge) {
      // Nothing satisfied. On a clip end that means the same clip plays again
      // (R11); on a Parameter change it means the character stays put.
      if (trigger === "clip-end") {
        this.phase = "holding";
        const generation = this.bump();
        this.emit();
        this.armLoop(generation);
      }
      return;
    }
    this.supersede();
    void this.take(edge).catch((err: unknown) => {
      console.error(`world runtime error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * Play one edge through.
   *
   * A transition spans awaits, so it takes a generation at each clip and checks
   * it after every one: a Parameter change mid-transition supersedes the
   * in-flight edge rather than letting a stale clip land the character in a
   * State the machine has already left. The discipline is the one recorded in
   * docs/solutions/exclusive-device-one-owner-many-consumers.md.
   */
  private async take(edge: Edge): Promise<void> {
    const destination = this.stateById(edge.to);
    if (!destination) {
      this.faulted("That edge leads to a State this World no longer has.");
      return;
    }

    if (!(await this.usable(edge.clip))) {
      this.faulted("That edge's clip could not be played.");
      return;
    }
    if (edge.kind === "cut" && !(await this.usable(edge.entryClip ?? null))) {
      this.faulted("That Cut's entry clip could not be played.");
      return;
    }
    if (!(await this.usable(destination.clip))) {
      this.faulted("The clip waiting at the other end could not be played.");
      return;
    }

    let generation = this.bump();
    this.fault = null;
    this.phase = "playing";
    this.clip = edge.clip;
    this.emit();
    // An edge with no clip assigned is an instant hop, not a three-second
    // pause: there is no footage to wait out, and waiting a default duration
    // for nothing is how a half-authored World reads as frozen.
    if (edge.clip) {
      await this.playClip(generation, edge.clip);
      if (!this.running || this.generation !== generation) return;
    }

    if (edge.kind === "cut") {
      // The camera changes on the join (R14): the Scene is the incoming one
      // from here on, and the entry clip plays inside it. A Cut between two
      // States at the same Position is a re-frame — the same two clips, no
      // travel between them (R16), which needs no special case because the
      // Position simply does not change.
      generation = this.bump();
      this.phase = "cutting";
      this.sceneId = destination.sceneId;
      this.clip = edge.entryClip ?? null;
      this.emit();
      if (this.clip) {
        await this.playClip(generation, this.clip);
        if (!this.running || this.generation !== generation) return;
      }
    }

    this.enter(destination.id, "holding");
  }

  private async usable(clip: ClipRef | null): Promise<boolean> {
    // An edge with no clip is legal — a condition-only hop between two States
    // in one Scene. Only an assigned clip that will not resolve is a fault.
    if (!clip) return true;
    if (!this.opts.clipUsable) return true;
    return this.opts.clipUsable(clip);
  }

  /**
   * A transition that cannot play says so and rests.
   *
   * It deliberately does not leave the previous loop running as though the
   * transition had succeeded: a World that keeps dancing while the walk clip is
   * missing hides the very thing the author needs to see.
   */
  private faulted(reason: string): void {
    this.clearPending();
    this.bump();
    this.fault = reason;
    this.phase = "holding";
    this.clip = null;
    this.emit();
  }
}
