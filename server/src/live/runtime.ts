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
 * The longest a crossing may hold the machine.
 *
 * Much shorter than a clip's ceiling, because the two cost different things: a
 * long clip merely plays for a long time, while a long *bridge* evaluates
 * nothing for its whole length — no Parameter, no Any State, no exit time. A
 * duration that was mismeasured or hostile would otherwise freeze the World,
 * and survive a restart because it lives in the manifest.
 */
export const MAX_BRIDGE_MS = 30_000;

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
  /** When it was armed, so a re-timed wait can subtract what already ran. */
  armed: number;
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
type Trigger = "parameter" | "arrival" | "exit-time" | "clip-end";

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
  /**
   * The transition being crossed, while a bridge plays.
   *
   * Its presence is the whole of the uninterruptible rule: while it is set,
   * nothing is evaluated — no exit-time wake is scheduled, `setParameter`
   * records without acting, and Any State is not consulted. Anything less makes
   * "uninterruptible" a claim rather than a property, and a report or a
   * transition resolves a wait it was not about.
   */
  private crossing: { transition: Transition; to: string; clip: ClipRef } | null = null;
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

    // A crossing is not seated on a State, so the checks below cannot speak
    // about it. Left alone unless the transition it is crossing, or the clip it
    // drew, is no longer what it was — otherwise every unrelated keystroke
    // would truncate a walk.
    if (this.crossing) {
      const now = (world.transitions ?? []).find((t) => t.id === this.crossing!.transition.id);
      const member = (now?.clips ?? []).find((c) => c.path === this.crossing!.clip.path);
      if (now && member && now.to === this.crossing.to) {
        const remeasured = member.durationMs !== this.crossing.clip.durationMs;
        this.crossing = { transition: now, to: now.to, clip: member };
        this.emit();
        // A clip imported moments ago carries no duration, so its first crossing
        // is paced by the default until a watching browser measures it. That
        // correction arrives mid-walk, and the wait already running was armed
        // against the old number — so the walk is re-timed here rather than
        // abandoned. Superseding instead would put the character back where the
        // walk started, which is what this branch used to do.
        if (remeasured) this.rearmCrossing();
        return;
      }
      this.crossing = null;
      this.supersede();
      // The same fallback the ordinary path uses. Re-entering a source State
      // that has just been deleted left the machine seated nowhere, with no
      // clip and no fault — silently dead until an unrelated edit.
      const stillHere = (world.states ?? []).some((s) => s.id === this.stateId);
      const next = stillHere ? this.stateId : this.initialStateId();
      if (next === null) {
        // Neither the State it left nor a default to fall back on. Entering
        // null here would seat the machine nowhere with no clip and no fault —
        // silently dead, which is exactly what this branch was added to stop.
        this.faulted(this.generation, "The crossing ended with nowhere to go back to.");
        return;
      }
      this.enter(next);
      return;
    }

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
    // `null` against an empty set is "still playing nothing", which is as much
    // a match as two identical clips — without it every keystroke of a rename
    // superseded a State that holds no clip at all.
    const stillPlayable =
      before === null
        ? (nextState?.clips ?? []).length === 0
        : (nextState?.clips ?? []).some((c) => samePlayingClip(before, c));
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
      transitionId: this.crossing?.transition.id ?? null,
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
      this.pending = { generation, resolve, timer, final, armed: Date.now() };
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
    return drawFrom(clips, this.lastPlayed.get(ownerId) ?? null, { random: this.opts.random });
  }

  /**
   * Remember what an owner actually played.
   *
   * Separate from the draw, and called only where a clip is committed to.
   * Recording at draw time marked members that never reached the screen — a
   * transition abandoned after its conditions changed, or a member found
   * unplayable — and the next real draw then avoided a clip nobody had seen
   * while allowing an immediate repeat of one they had.
   */
  private commitDraw(ownerId: string, clip: ClipRef | null): void {
    if (clip) this.lastPlayed.set(ownerId, clip.path);
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
    // Resolved together rather than one after another: each is an independent
    // filesystem read, and a set of ten was ten sequential round trips on a
    // path that runs on every transition.
    const verdicts = await Promise.all(candidates.map((clip) => this.usable(clip)));
    const usable = candidates.filter((_, i) => verdicts[i]);
    if (usable.length === 0) return null;
    return drawFrom(usable, this.lastPlayed.get(ownerId) ?? null, { random: this.opts.random });
  }

  /** Settle on a State and run its clip. */
  private enter(stateId: string | null, drawn?: ClipRef | null): void {
    const state = this.stateById(stateId);
    this.stateId = state?.id ?? null;
    // `take` already drew and proved a member playable; drawing again here
    // would discard that work and could land on the broken sibling it skipped.
    this.clip = drawn !== undefined ? drawn : state ? this.draw(state.id, state.clips) : null;
    if (state) this.commitDraw(state.id, this.clip);
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
    // Cleared before the usability check awaits. It described the State just
    // left until the wake points were recomputed below, and a `setWorld` landing
    // in that gap compared against the wrong set and superseded a clip that had
    // only just started.
    this.schedule = [];
    // The draw in `enter` is synchronous, and proving a clip playable is not —
    // it resolves a real path. So the check happens here, once, on the way in:
    // a member that will not resolve is passed over for a sibling, and only a
    // set with nothing playable in it faults.
    // Every set, not only one with a sibling to prefer. Gating this on size
    // left a State holding a single missing clip looping a black frame forever
    // with no fault, because nothing else checks it on the way in.
    const proved = this.clip ? await this.usable(this.clip) : true;
    // Checked on both outcomes, not only the failing one. A pass superseded
    // during that await used to fall straight through and install its wait over
    // a live one, orphaning the pending the newer pass was sleeping on.
    if (!this.running || this.generation !== generation) return;
    if (this.clip && !proved) {
      const state = this.stateById(this.stateId);
      const replacement = await this.usableDraw(this.stateId ?? "", state?.clips);
      if (!this.running || this.generation !== generation) return;
      if (replacement === null) {
        this.faulted(generation, "Nothing this State holds could be played.");
        return;
      }
      this.clip = replacement;
      this.commitDraw(this.stateId ?? "", replacement);
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
    // Recorded while a bridge crosses, but not acted on: the value is what the
    // author set and they should see it, and the machine honours it when it
    // lands and evaluates the destination.
    if (this.crossing) {
      this.emit();
      return true;
    }
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
    // Never during a crossing. The triple a client is told while a bridge plays
    // is the source State and the claimed generation — exactly what this method
    // accepts — so a client echoing its own broadcast, or a `<video>` that
    // fails instantly on the bridge file, would land the crossing early. That
    // would make "uninterruptible" a claim rather than a property. The server's
    // timer is the authority here, and a bridge is short.
    if (this.crossing) return false;
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
    // A bridge is uninterruptible, and that has to mean nothing at all is
    // considered — otherwise Any State is a way around it.
    if (this.crossing) return false;
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
   * A transition with no clips plays nothing and the machine cuts straight to
   * the destination. One with clips hands off to `cross`, which plays a bridge
   * first. Either way this is where the destination is proved playable.
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

    if ((transition.clips ?? []).length === 0) {
      this.consumeTriggers(transition);
      this.enter(transition.to, arriving);
      return;
    }

    await this.cross(transition, claimed);
  }

  /**
   * Play a transition's clip, then land.
   *
   * The Triggers are consumed on arrival rather than on departure. Nothing is
   * evaluated while the bridge plays, so a Trigger held through it cannot be
   * read twice — and if the crossing faults, the flag is still armed and the
   * move can be driven again instead of being spent on a State never reached.
   */
  private async cross(transition: Transition, claimed: number): Promise<void> {
    const bridge = await this.usableDraw(transition.id, transition.clips);
    if (!this.running || this.generation !== claimed) return;
    if (bridge === null) {
      this.faulted(claimed, "Nothing this transition holds could be played.");
      return;
    }

    const mine = { transition, to: transition.to, clip: bridge };
    this.crossing = mine;
    this.clip = bridge;
    this.emit();

    try {
      await this.wait(claimed, this.bridgeMs(bridge), true);
      if (!this.running || this.generation !== claimed) return;

      // Checked here rather than when the crossing began: an edit made while it
      // played is exactly the case a multi-second bridge makes ordinary.
      const destination = this.stateById(transition.to);
      if (!destination) {
        this.faulted(claimed, "That transition leads to a State this World no longer has.");
        return;
      }

      // Re-verified rather than trusted. It was proved playable before the
      // bridge, which was seconds ago — long enough for the file to be moved,
      // and long enough that entering on that stale proof would broadcast a
      // clip the route now refuses, with no fault to explain the black frame.
      const landing = await this.usableDraw(destination.id, destination.clips);
      if (!this.running || this.generation !== claimed) return;
      if (landing === null && (destination.clips ?? []).length > 0) {
        this.faulted(claimed, "Nothing waiting at the other end could be played.");
        return;
      }

      // Consumed against the transition as it is *now*, not the snapshot the
      // crossing began with: a condition edited mid-bridge would otherwise
      // clear a Trigger the transition no longer reads, or miss one it does.
      // Last, after every await, so nothing can spend a Trigger on a landing
      // that then does not happen.
      this.consumeTriggers(this.world.transitions?.find((t) => t.id === transition.id) ?? transition);
      this.commitDraw(destination.id, landing);
      // Cleared immediately before entering, not after: `enter` broadcasts, and
      // a broadcast that still named the crossing would tell every client the
      // machine was in transit at the moment it arrived.
      // Committed here rather than when the bridge began: a crossing cut short
      // never reached the screen, and remembering it made the retry draw the
      // other member — the start of one walk, a snap back, then a different walk.
      this.commitDraw(transition.id, mine.clip);
      this.crossing = null;
      this.enter(destination.id, landing);
      // Evaluated once, here, because a value set while the bridge was crossing
      // was recorded and deliberately not acted on — this is the "honoured the
      // moment it lands" half of that bargain. Only from a landing, and only
      // once: evaluating inside `enter` itself would chain, and the machine
      // takes one transition per evaluation.
      this.onTrigger("arrival", 0);
    } finally {
      // Only if it is still *this* crossing. A pass superseded during the
      // landing's awaits resumes long after another crossing may have started,
      // and clearing that one would leave a live bridge unguarded — evaluable,
      // and reportable by any client, which is the whole thing this flag exists
      // to prevent.
      if (this.crossing === mine) this.crossing = null;
    }
  }

  /**
   * Re-time the wait a crossing is already running against.
   *
   * The clip is unchanged and the destination is unchanged; only how long it
   * runs has been corrected. Resolving the pending wait lets `cross` continue
   * from where it was, so the walk finishes and lands rather than restarting.
   */
  private rearmCrossing(): void {
    const pending = this.pending;
    if (!pending || !this.crossing) return;
    // The timer is replaced, not the wait. `clearPending` *resolves* what it
    // clears, which would finish the bridge the instant the measurement landed
    // — so the promise `cross` is sitting on is kept and only its alarm moves.
    if (pending.timer) clearTimeout(pending.timer);
    const played = Date.now() - pending.armed;
    const left = Math.max(this.bridgeMs(this.crossing.clip) - played, 0);
    const timer = setTimeout(() => {
      if (this.pending?.generation !== pending.generation) return;
      this.clearPending();
    }, left);
    timer.unref?.();
    // `armed` keeps its original value, so a second correction still subtracts
    // everything that has played rather than only the latest stretch.
    this.pending = { ...pending, timer };
  }

  /**
   * How long to hold a crossing.
   *
   * A bridge's own ceiling, far below a clip's. Nothing is evaluated while a
   * crossing runs, so a duration that would merely make a State's clip long —
   * a bad measurement, or a hostile report, persisted in the manifest — would
   * instead freeze the entire machine for that long, across restarts.
   */
  private bridgeMs(clip: ClipRef): number {
    return Math.min(this.durationOf(clip), MAX_BRIDGE_MS);
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
    this.crossing = null;
    this.clearPending();
    this.bump();
    this.fault = reason;
    this.clip = null;
    this.emit();
  }
}
