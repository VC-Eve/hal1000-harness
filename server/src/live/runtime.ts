import type {
  ClipRef,
  LiveState,
  Parameter,
  ParameterValue,
  Transition,
  World,
  WorldState,
} from "../../../shared/src/types.js";
import {
  conditionsHold,
  defaultValueOf,
  drawFrom,
  liveTransitions,
  valueFits,
} from "../../../shared/src/world-graph.js";
import { MAX_CLIP_MS } from "../storage/worlds.js";

/**
 * How long a clip runs when the manifest does not say.
 *
 * A State whose clip was assigned before its duration was measured still has to
 * advance: a machine that waited forever on an unknown length would freeze
 * rather than report anything.
 */
export const DEFAULT_CLIP_MS = 3_000;

/**
 * The shortest clip the machine will pace itself against.
 *
 * A ceiling alone is half the guard. A duration of 1ms — a hostile report, or a
 * real but very short file — makes the machine enter, broadcast and re-issue a
 * thousand times a second, and because the number is persisted a restart walks
 * straight back into it.
 */
export const MIN_CLIP_MS = 250;

/**
 * The earliest point in a clip a transition can be offered at.
 *
 * An exit time of 0 has no wake point to fire at — the clip has not started —
 * so left as written it is a transition that can never be taken and nothing
 * says so. Every reader goes through `exitFraction`, so a hand-edited manifest
 * lands on the same floor as an authored one.
 */
const MIN_EXIT_FRACTION = 0.01;

/** Where in its clip a waiting transition is offered. */
function exitFraction(transition: Transition): number {
  const at = transition.exitTime;
  if (typeof at !== "number" || !Number.isFinite(at)) return 1;
  return Math.min(Math.max(at, MIN_EXIT_FRACTION), 1);
}

export interface RuntimeOptions {
  /** Called whenever what is on screen changes. */
  onChange(live: LiveState): void;
  /**
   * Whether a clip can actually be played. Absent means "assume it can",
   * which is what a test wanting no filesystem uses.
   */
  clipUsable?(clip: ClipRef): Promise<boolean>;
  /**
   * Where a draw's randomness comes from.
   *
   * Injected so a test can assert which member is chosen rather than a
   * distribution over many runs.
   */
  random?(): number;
}

interface Pending {
  generation: number;
  resolve(): void;
  timer: NodeJS.Timeout | null;
  /**
   * Whether this is the wait that ends the clip.
   *
   * A State with a mid-clip exit time issues several waits under one
   * generation, so the generation alone does not identify *which* one a
   * browser's report is about — and a report accepted against a mid-clip wait
   * cuts the clip short.
   */
  final: boolean;
}

/**
 * Whether two clip references name the same playing file at the same length.
 *
 * Identity is path *and* duration: a re-measured duration changes how the
 * machine paces the clip, so it has to re-seat even though the file is the one
 * already on screen.
 */
function samePlayingClip(a: ClipRef | null, b: ClipRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.path === b.path && a.durationMs === b.durationMs;
}

/** Why the machine woke: a value changed, or the clip reached a point. */
type Trigger = "parameter" | "exit-time" | "clip-end";

/**
 * The state machine: what the character is doing, and what is on screen.
 *
 * It lives on the server rather than in the browser because a Parameter set by
 * an agent must move the character whether or not anything is watching. That
 * makes the runtime the timing authority: clip end — and every exit time before
 * it — is fired by its own timer, seeded from the duration the manifest records.
 * A watching client's clip-end report is a resync signal and never the trigger.
 */
export class WorldRuntime {
  private world: World;
  private values: Record<string, ParameterValue> = {};
  private stateId: string | null = null;
  private clip: ClipRef | null = null;
  private fault: string | null = null;
  private generation = 0;
  private pending: Pending | null = null;
  /**
   * The clip each owner last played, so a draw can avoid repeating it.
   *
   * In memory, not in the manifest: persisting it would mean a write, a
   * broadcast and a full reports pass on every loop of every clip. It survives
   * leaving a State and coming back — returning to an idle should not replay the
   * one just seen — and resets on restart, where a single possible repeat is
   * not something anyone can see.
   */
  private readonly lastPlayed = new Map<string, string>();
  /** The wake points the pass currently in flight was issued against. */
  private schedule: number[] = [];
  private running = false;

  constructor(world: World, private readonly opts: RuntimeOptions) {
    this.world = world;
  }

  /**
   * Begin at the default State, with every Parameter at its declared default.
   *
   * Values reset rather than persisting across a restart: they are live state,
   * the manifest holds the machine, and a World that reopened mid-sequence
   * would be describing a character who had not moved.
   */
  start(): void {
    // Set before anything emits: `emit()` is silent while stopped.
    this.running = true;
    this.values = {};
    for (const parameter of this.world.parameters ?? []) {
      this.values[parameter.name] = defaultValueOf(parameter);
    }
    this.fault = null;
    this.enter(this.initialStateId());
  }

  stop(): void {
    this.running = false;
    this.clearPending();
  }

  /**
   * Where the machine starts.
   *
   * The declared default, and only that. Falling back to "the first State with
   * a clip" would make the entry point an accident of manifest order, which is
   * what an explicit default exists to prevent.
   */
  private initialStateId(): string | null {
    const states = this.world.states ?? [];
    return states.find((s) => s.id === this.world.defaultStateId)?.id ?? null;
  }

  /** The manifest changed under a running World — re-seat without restarting it. */
  setWorld(world: World): void {
    const before = this.clip;
    this.world = world;
    for (const parameter of world.parameters ?? []) {
      if (!(parameter.name in this.values)) this.values[parameter.name] = defaultValueOf(parameter);
      // A Parameter re-declared under a different type leaves a value of the
      // old shape behind, which a condition then reads through the new type's
      // operators — a transition that silently can never hold, or one that
      // spuriously always does.
      else if (!valueFits(parameter.type, this.values[parameter.name]!)) {
        this.values[parameter.name] = defaultValueOf(parameter);
      }
    }
    // A Parameter that was removed leaves its value behind, where nothing reads
    // it. Keeping it costs nothing, and dropping it mid-run could change what a
    // condition sees between two evaluations of the same transition.

    const still = (world.states ?? []).some((s) => s.id === this.stateId);
    const next = still ? this.stateId : this.initialStateId();
    const nextState = this.stateById(next);

    // Re-seat without restarting when the clip playing is the same one. Every
    // edit reaches here — including one per keystroke while a State is being
    // renamed — and restarting on each of those is a visible stutter that also
    // resets how far through the clip the machine thinks it is.
    // Still playing something this State can play: a set is re-seated by
    // membership, not by identity, or every edit would restart a State whose
    // draw simply moved on.
    const stillPlayable =
      before !== null && (nextState?.clips ?? []).some((c) => samePlayingClip(before, c));
    if (next === this.stateId && stillPlayable && this.sameSchedule(next)) {
      this.emit();
      return;
    }

    this.supersede();
    this.enter(next);
  }

  /**
   * Whether the pass in flight is still pacing against the right wake points.
   *
   * `playThrough` reads them once per turn of the clip, so re-seating without
   * restarting would leave an edited exit time unhonoured until the clip looped
   * — a wait of up to `MAX_CLIP_MS` while the panel showed the new value.
   */
  private sameSchedule(stateId: string | null): boolean {
    const now = this.wakePoints(stateId);
    const was = this.schedule;
    return now.length === was.length && now.every((at, i) => at === was[i]);
  }

  live(): LiveState {
    return {
      worldId: this.world.id,
      stateId: this.stateId,
      clip: this.clip,
      parameters: { ...this.values },
      generation: this.generation,
      fault: this.fault,
    };
  }

  private emit(): void {
    // Silent once stopped. Switching Worlds stops the outgoing runtime, and a
    // wait still unwinding inside it would otherwise broadcast the closed
    // World's clip to clients already showing the new one.
    if (!this.running) return;
    this.opts.onChange(this.live());
  }

  // Every clip issued gets its own generation, including each turn of a loop.
  // That is what makes a report identifiable as stale: the triple it carries
  // names the clip it was issued for and nothing else.
  private bump(): number {
    this.generation += 1;
    return this.generation;
  }

  /**
   * Drop the wait in flight, and resolve its promise.
   *
   * Resolving is not optional. `playThrough` is suspended on that promise, and
   * a clear that only nulled the field left it suspended forever — one leaked
   * coroutine per stop.
   */
  private clearPending(): void {
    const pending = this.pending;
    if (pending?.timer) clearTimeout(pending.timer);
    this.pending = null;
    pending?.resolve();
  }

  /** Abandon whatever is in flight; the generation check downstream does the rest. */
  private supersede(): number {
    this.clearPending();
    return this.bump();
  }

  /**
   * How long to wait on a clip.
   *
   * Clamped, because `setTimeout` truncates its delay to 32 bits: a manifest
   * claiming 2^31 ms does not produce a long wait, it produces a 1ms one, and
   * the machine then advances a thousand times a second.
   */
  private durationOf(clip: ClipRef | null): number {
    const ms = clip?.durationMs;
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return DEFAULT_CLIP_MS;
    return Math.min(Math.max(ms, MIN_CLIP_MS), MAX_CLIP_MS);
  }

  private stateById(id: string | null): WorldState | undefined {
    if (!id) return undefined;
    return (this.world.states ?? []).find((s) => s.id === id);
  }

  /**
   * Wait `ms`, or until something resolves the wait early.
   *
   * The timer is the authority. `step()` and a matching clip-end report resolve
   * it early, which is what makes a test deterministic and what lets a browser
   * slightly ahead of the recorded duration resync — neither is what makes the
   * machine advance.
   */
  private wait(generation: number, ms: number, final: boolean): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending?.generation !== generation) return;
        this.clearPending();
      }, Math.max(ms, 0));
      timer.unref?.();
      this.pending = { generation, resolve, timer, final };
    });
  }

  /**
   * The points during this State's clip at which the machine must wake.
   *
   * Every distinct exit time among the transitions that could be taken, in
   * order. A transition with an exit time of 0.75 is offered three seconds into
   * a four-second clip — and again on the next loop, which is why the set is
   * recomputed each time round.
   */
  private wakePoints(stateId: string | null): number[] {
    const fractions = new Set<number>();
    for (const t of liveTransitions(this.world, stateId)) {
      if (t.hasExitTime !== true) continue;
      const at = exitFraction(t);
      if (at < 1) fractions.add(at);
    }
    return [...fractions].sort((a, b) => a - b);
  }

  /**
   * Choose the clip an owner plays next, and remember it.
   *
   * `usable` is not consulted here: it resolves a real path and is async, and
   * `enter` is not. A member that turns out to be unplayable faults on the
   * usability check the same way a single clip always did — the difference is
   * that a set with a usable sibling gets to play it, which `usableDraw` does
   * on the paths that can await.
   */
  private draw(ownerId: string, clips: ClipRef[] | undefined): ClipRef | null {
    const picked = drawFrom(clips, this.lastPlayed.get(ownerId) ?? null, { random: this.opts.random });
    if (picked) this.lastPlayed.set(ownerId, picked.path);
    return picked;
  }

  /**
   * The same draw, but skipping members that will not resolve.
   *
   * A moved file should cost the author one member of a set, not the State — so
   * a broken member is passed over and only a set with nothing playable in it
   * faults.
   */
  private async usableDraw(ownerId: string, clips: ClipRef[] | undefined): Promise<ClipRef | null> {
    const candidates = [...(clips ?? [])];
    const usable: ClipRef[] = [];
    for (const clip of candidates) if (await this.usable(clip)) usable.push(clip);
    if (usable.length === 0) return null;
    // A member that was drawn and then found unplayable never played, so it
    // must not be what the next draw avoids — otherwise one broken file makes a
    // two-member set alternate instead of settling on the one that works.
    const picked = drawFrom(usable, this.lastPlayed.get(ownerId) ?? null, { random: this.opts.random });
    if (picked) this.lastPlayed.set(ownerId, picked.path);
    return picked;
  }

  /** Settle on a State and run its clip. */
  private enter(stateId: string | null, drawn?: ClipRef | null): void {
    const state = this.stateById(stateId);
    this.stateId = state?.id ?? null;
    // `take` already drew and proved a member playable; drawing again here
    // would discard that work and could land on the broken sibling it skipped.
    this.clip = drawn !== undefined ? drawn : state ? this.draw(state.id, state.clips) : null;
    // Cleared here rather than only on a successful transition: a fault says
    // the machine is stopped, and it is about to play. Leaving it set kept the
    // banner up over a clip that had started again — the message outliving what
    // it described.
    this.fault = null;
    // Bumped before the emit: a client reports back the generation it was told,
    // so the number in the broadcast has to be the one the clip about to play
    // was issued under.
    const generation = this.bump();
    this.emit();
    void this.playThrough(generation).catch((err: unknown) => {
      console.error(`world runtime error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * One turn of the current State's clip.
   *
   * Sleeps to each wake point in turn, evaluating there, and finally to the
   * end. If nothing was satisfied by then the clip loops and the cycle repeats,
   * which is what makes an exit time below 1 fire on every loop.
   *
   * A State with no clip never wakes at all: there is nothing to end, so the
   * only way out is a Parameter change.
   */
  private async playThrough(generation: number): Promise<void> {
    if (!this.running) return;
    // The draw in `enter` is synchronous, and proving a clip playable is not —
    // it resolves a real path. So the check happens here, once, on the way in:
    // a member that will not resolve is passed over for a sibling, and only a
    // set with nothing playable in it faults.
    // Only when there is a sibling to prefer. The check exists to choose
    // between members, so a State holding one clip skips it — and keeps the
    // timing it has always had, where the wait is armed before anything awaits.
    const set = this.stateById(this.stateId)?.clips ?? [];
    if (this.clip && set.length > 1 && !(await this.usable(this.clip))) {
      if (!this.running || this.generation !== generation) return;
      const state = this.stateById(this.stateId);
      const replacement = await this.usableDraw(this.stateId ?? "", state?.clips);
      if (!this.running || this.generation !== generation) return;
      if (replacement === null) {
        this.faulted(generation, "Nothing this State holds could be played.");
        return;
      }
      this.clip = replacement;
      this.emit();
    }
    if (!this.clip) return;
    const total = this.durationOf(this.clip);
    let elapsed = 0;
    this.schedule = this.wakePoints(this.stateId);

    for (const fraction of this.schedule) {
      const at = total * fraction;
      await this.wait(generation, at - elapsed, false);
      if (!this.running || this.generation !== generation) return;
      elapsed = at;
      // Conditions on a transition with an exit time are checked only once that
      // point is reached — Unity's rule, and the reason the wake exists.
      if (this.onTrigger("exit-time", fraction)) return;
    }

    await this.wait(generation, total - elapsed, true);
    if (!this.running || this.generation !== generation) return;
    if (this.onTrigger("clip-end", 1)) return;

    // Nothing was satisfied, so the clip plays again.
    this.enter(this.stateId);
  }

  /**
   * Set a Parameter and evaluate.
   *
   * The same path the graph and an agent both take — there is no second entry
   * point that could behave differently.
   */
  setParameter(name: string, value: ParameterValue): boolean {
    const parameter = (this.world.parameters ?? []).find((p) => p.name === name);
    if (!parameter || !valueFits(parameter.type, value)) return false;
    this.values[name] = value;
    // Emitted even when nothing is satisfied. A value the author set and the
    // machine did not act on is still a value they need to see — without this
    // the control they just moved snaps back to what the last broadcast said.
    if (!this.onTrigger("parameter", 0)) this.emit();
    return true;
  }

  parameters(): Record<string, ParameterValue> {
    return { ...this.values };
  }

  /**
   * A watching browser's clip-end report.
   *
   * Discarded unless every part of the triple matches what is actually playing.
   * Two open tabs, or one tab reloading mid-clip, would otherwise advance the
   * machine twice.
   */
  reportClipEnd(worldId: string, stateId: string, generation: number): boolean {
    if (worldId !== this.world.id) return false;
    if ((this.stateId ?? "") !== stateId) return false;
    if (!this.pending || this.pending.generation !== generation) return false;
    // A mid-clip wake is not the end of the clip. Resolving one from a report
    // would skip the rest of the clip and fire an exit-time transition early.
    if (!this.pending.final) return false;
    const pending = this.pending;
    this.clearPending();
    pending.resolve();
    return true;
  }

  /**
   * Resolve the current wait now.
   *
   * A test seam, so a suite need not wait out real durations. Deliberately not
   * the only path exercised — a seam every test uses leaves the production
   * trigger, the timer, entirely uncovered.
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

  /**
   * The first transition this trigger can take, if any.
   *
   * Any State first, then the current State's own in their stored order, muted
   * ones skipped and solo honoured — all of that is `liveTransitions`. What is
   * decided here is *when* each is offered: a transition that waits is offered
   * at its exit time, one that does not is offered on a Parameter change.
   */
  private eligible(trigger: Trigger, fraction: number): Transition | undefined {
    return liveTransitions(this.world, this.stateId).find((t) => {
      const waits = t.hasExitTime === true;
      // A transition that does not wait is offered at every evaluation: a
      // Parameter change, and the end of the clip. Offering it only on a
      // Parameter change left an unconditional one unable to fire at all.
      if (!waits) return trigger !== "exit-time" && conditionsHold(t, this.values);
      const at = exitFraction(t);
      // Part way through, only what is due exactly here; at the end, everything
      // whose exit time is the end.
      const due = trigger === "clip-end" ? at >= 1 : at === fraction;
      return due && conditionsHold(t, this.values);
    });
  }

  /** Returns true when a transition was taken, so the caller stops its cycle. */
  private onTrigger(trigger: Trigger, fraction: number): boolean {
    if (!this.running) return false;
    const transition = this.eligible(trigger, fraction);
    if (!transition) return false;
    // The generation is claimed here, before `take()` awaits anything. Claiming
    // it after the destination check would leave a window in which two triggers
    // produce two live transitions.
    const generation = this.supersede();
    void this.take(transition, generation).catch((err: unknown) => {
      console.error(`world runtime error: ${err instanceof Error ? err.message : String(err)}`);
    });
    return true;
  }

  /**
   * Take one transition.
   *
   * A transition plays nothing — clips live on States. What this does is check
   * the destination can actually play, consume any Triggers the transition
   * read, and enter.
   */
  private async take(transition: Transition, claimed: number): Promise<void> {
    const destination = this.stateById(transition.to);
    if (!destination) {
      this.faulted(claimed, "That transition leads to a State this World no longer has.");
      return;
    }

    // Resolves real paths on disk, so the machine can be triggered again while
    // it is in flight — hence the check after it. A set is drawn from here so a
    // broken member costs its own member rather than the whole State.
    const arriving = await this.usableDraw(destination.id, destination.clips);
    if (arriving === null && (destination.clips ?? []).length > 0) {
      this.faulted(claimed, "The clip waiting at the other end could not be played.");
      return;
    }
    if (!this.running || this.generation !== claimed) return;

    // Re-checked after the await, not only before it: `usable()` touches the
    // filesystem, and a Parameter set while it was in flight can have made this
    // transition's conditions untrue. Taking it anyway acts on a world that no
    // longer exists.
    if (!conditionsHold(transition, this.values)) {
      this.enter(this.stateId);
      return;
    }

    // Re-resolved against the World as it is now, not as it was before the
    // await: a re-seat that changed nothing about the current clip does not
    // bump the generation, so the guard above cannot see a State deleted while
    // the check was in flight.
    if (!this.stateById(transition.to)) {
      this.faulted(claimed, "That transition leads to a State this World no longer has.");
      return;
    }

    this.consumeTriggers(transition);
    this.enter(transition.to, arriving);
  }

  /**
   * Reset every Trigger this transition's conditions read.
   *
   * That reset is the whole of what makes a Trigger different from a Bool: it
   * fires once and clears itself, so a one-shot action needs no second
   * transition to put the flag back.
   */
  private consumeTriggers(transition: Transition): void {
    const types = new Map((this.world.parameters ?? []).map((p: Parameter) => [p.name, p.type]));
    for (const clause of transition.conditions ?? []) {
      if (types.get(clause.parameter) !== "trigger") continue;
      // Only a Trigger this transition needed *set*. Any other satisfied clause
      // naming a Trigger required it down already, so clearing it was a no-op
      // rather than a bug — this states the rule instead of relying on that.
      if (clause.op === "is" && clause.value === true) this.values[clause.parameter] = false;
    }
  }

  private async usable(clip: ClipRef | null): Promise<boolean> {
    // A State with no clip is legal — it holds silently. Only an assigned clip
    // that will not resolve is a fault.
    if (!clip) return true;
    if (!this.opts.clipUsable) return true;
    return this.opts.clipUsable(clip);
  }

  /**
   * A transition that cannot be taken says so and rests.
   *
   * It does not leave the previous clip looping as though nothing happened: a
   * World that keeps playing while the destination's clip is missing hides the
   * very thing the author needs to see.
   */
  private faulted(claimed: number, reason: string): void {
    // A check that lost its race must not fault the transition that replaced it.
    if (!this.running || this.generation !== claimed) return;
    this.clearPending();
    this.bump();
    this.fault = reason;
    this.clip = null;
    this.emit();
  }
}
