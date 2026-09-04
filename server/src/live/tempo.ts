import { promises as fs } from "node:fs";
import path from "node:path";
import MusicTempo from "music-tempo";
import type { Playlist, PlaylistTrack } from "../../../shared/src/audio.js";
import { MAX_BPM, MIN_BPM, usableBpm } from "../../../shared/src/audio.js";
import { setTrackBpm, setTrackUnplayable } from "../storage/audio.js";
import type { AudioStore } from "../storage/audio.js";
import { withDeadline } from "../deadline.js";

/**
 * Measuring a track's tempo, and saying which octave the measurement is in.
 *
 * The requirement this exists for (origin R31) is not "detect a BPM". It is
 * that a detector may only be used **if** it covers 60–200 and reports which
 * octave it chose, because the library is drum & bass, dub and breaks — the
 * material where a detector that quietly returns 87 for a 174 BPM track
 * produces a plausible number that halves every tempo condition in the World.
 *
 * So the shape here is deliberate: `music-tempo` is asked for **beats**, not for
 * a tempo, and the tempo is derived from those beats by `reconcileOctave`
 * below. That is what makes "reports which octave it chose" literally true here
 * rather than delegated to a library that does not answer the question. The
 * library's own `tempo` string is never read.
 *
 * **What is not established in this file.** Nothing here is evidence that the
 * measurement is *right* on real drum & bass. There is no music in this repo,
 * and a synthetic click track is the easiest signal a beat tracker will ever
 * see — measuring against one measures the generator, which is the failure
 * docs/solutions/a-measurement-on-synthetic-variants-measures-your-own-transform.md
 * records costing this project a shipped feature already. `scripts/tempo-report.ts`
 * is the harness that answers R31 against a real folder; until somebody runs it
 * on real material, R31 is unmet and the fallback the origin document names —
 * ship no detector — is still the live alternative.
 */

/**
 * How long a whole measurement gets before the track is left unmeasured.
 *
 * Decode *and* analysis, under one bound, because the caller's question is the
 * same for both: a stalled network drive and a pathological onset stream are
 * indistinguishable from here, and a bound on only the first half would let the
 * second half hold a worker forever.
 */
export const MEASURE_DEADLINE_MS = 90_000;

/**
 * How many tracks are decoded at once.
 *
 * Twenty FLACs decoding at once is not a plan: each one holds its decoded PCM
 * and then a plain JS array of it — `music-tempo` calls `concat`, which no typed
 * array has — so a decode's peak is tens of megabytes and twenty of them is the
 * server's whole heap. Two rather than one, so a slow disk does not idle the CPU.
 */
export const MAX_CONCURRENT_MEASUREMENTS = 2;

/**
 * The analysis rate the decoded audio is decimated towards.
 *
 * Onset detection at a hundred frames a second needs nothing above this, and
 * decimating by four turns a six-minute track's 16M samples into 4M — the
 * difference between a quarter-gigabyte spike and a manageable one, and a
 * 2048-point FFT into a 512-point one at the same window duration.
 */
const ANALYSIS_HZ = 11_025;

/** The onset frame rate `music-tempo` assumes: `timeStep` 0.01s, hop 441 at 44100. */
const FRAMES_PER_SECOND = 100;

/** The FFT window, in seconds. 46ms is what a 2048-point window is at 44100. */
const WINDOW_SECONDS = 0.046;

/** How close an interval must be to a candidate's period to count as that candidate's. */
const OCTAVE_TOLERANCE = 0.04;

/**
 * How many inter-beat intervals a reading needs before it means anything.
 *
 * A handful of beats from a passage the tracker half-followed will still produce
 * a cluster and a tidy-looking weight, from almost no evidence. Below this the
 * answer is "unmeasured", which is a state the index already has.
 */
const MIN_INTERVALS = 8;

// ---------------------------------------------------------------------------
// Octave reconciliation
//
// Pure arithmetic over inter-beat intervals, so it is testable without audio —
// and a test of it is a test of the arithmetic, never a claim about music.
// ---------------------------------------------------------------------------

/** One tempo the intervals could be describing, and how much of them support it. */
export interface TempoCandidate {
  bpm: number;
  /** The share of intervals within tolerance of this candidate's period, 0..1. */
  weight: number;
  /**
   * Which octave this is, as a multiple of the tracker's own reading: 1, 2 or
   * 0.5. Carried rather than derived from `bpm / tracked`, which the mean
   * refinement below leaves a percent off a clean 2.00 — and an octave label
   * that reads 1.99 is a label nobody can compare against.
   */
  multiple: number;
}

/** What a measurement concluded, and what it concluded it *against*. */
export interface TempoReading {
  /** The tempo chosen. Always inside 60–200, because nothing else is usable. */
  bpm: number;
  /**
   * The tempo the beat tracker itself was running at — 60 over its densest
   * inter-beat interval — whether or not that value is in band or was chosen.
   * Reported so "which octave was chosen" is answerable rather than inferred.
   */
  tracked: number;
  /** What `bpm` is as a multiple of `tracked`: 1, 2 (double time) or 0.5 (half). */
  octave: number;
  chosen: TempoCandidate;
  /** The runner-up octave, when there is one in band. Null when there is not. */
  alternative: TempoCandidate | null;
  /** Every in-band candidate, strongest first. */
  candidates: TempoCandidate[];
  /** How many inter-beat intervals the reading rests on. */
  intervals: number;
}

/**
 * The interval the most other intervals cluster around, and how many.
 *
 * The histogram, done without bins. Binning splits a cluster that straddles an
 * edge and then reports the wrong peak with full confidence, so each observed
 * interval is instead asked how many of the others sit within
 * `OCTAVE_TOLERANCE` of it, and the busiest wins. Quadratic in the number of
 * beats, which is a few hundred for a track — the cost of a bin edge is worse
 * than the cost of the loop.
 *
 * The median will not do here, and that is not a detail: a beat stream that
 * half-follows a break is genuinely bimodal — a mass at the half-time period and
 * a mass at the real one — and the median of two clusters lands in the empty gap
 * between them. Fed 50 intervals at 0.69s and 50 at 0.34s it answers 0.52s,
 * which is 116 BPM: a tempo nothing in the recording is playing, arrived at
 * confidently. That is the whole failure this function exists to prevent,
 * reproduced by the function itself.
 *
 * Ties go to the shortest interval, which is arbitrary but deterministic; a set
 * genuinely split down the middle has no right answer, and the candidates that
 * come back carry equal weights so the report says so.
 */
function densestPeriod(sorted: readonly number[]): number {
  let best = sorted[0]!;
  let bestCount = -1;
  for (const candidate of sorted) {
    let count = 0;
    for (const value of sorted) {
      if (Math.abs(value - candidate) <= candidate * OCTAVE_TOLERANCE) count += 1;
    }
    // Strictly greater, so the first — shortest — of an equal pair is kept.
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
}

/**
 * Decide which octave a set of inter-beat intervals is in.
 *
 * The intervals are in seconds. The densest cluster is taken as the tracker's
 * period; the three candidates are that period, half of it (double time) and
 * twice it (half time), and each one's weight is the share of intervals sitting
 * within `OCTAVE_TOLERANCE` of it. Direct mass only — no credit for integer
 * multiples, which would let a candidate borrow its own harmonics' evidence and
 * make every weight comparison meaningless.
 *
 * Candidates outside 60–200 are dropped before any comparison, through
 * `usableBpm` rather than a second range check written here, so a non-finite
 * period fails closed exactly as it does everywhere else in this feature.
 *
 * Ties go to the tracker's own reading: the candidate order is
 * [tracked, double, half] and the sort is stable, so a competing octave has to
 * *beat* the tracker rather than merely match it. A detector that flipped on a
 * tie would be less predictable than one that never flipped at all.
 *
 * **What this does and does not do.** It reports. A file whose beats come back
 * cleanly at one period has all its mass in one candidate and no evidence for
 * any other, so the other octave is named with a weight of zero rather than
 * argued for — which is what origin R31 asks for ("reports which octave it
 * chose") and is not the same as being able to correct a tracker that latched
 * an octave low. Whether it latches low on real drum & bass is what
 * `scripts/tempo-report.ts` exists to find out.
 */
export function reconcileOctave(intervals: readonly number[]): TempoReading | null {
  const usable = intervals
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (usable.length < MIN_INTERVALS) return null;

  const period = densestPeriod(usable);
  const tracked = 60 / period;
  if (!Number.isFinite(tracked)) return null;

  const weigh = (multiple: number): TempoCandidate | null => {
    const candidatePeriod = period / multiple;
    const coarse = usableBpm(60 / candidatePeriod);
    if (coarse === null) return null;
    const near = usable.filter(
      (value) => Math.abs(value - candidatePeriod) <= candidatePeriod * OCTAVE_TOLERANCE,
    );
    // Averaging the intervals that support the candidate, rather than reporting
    // the cluster centre itself, is worth a whole BPM at the top of the band. Beat times
    // come back quantised to the analyser's 10ms frame, so at 174 BPM — a
    // 344.8ms period — every interval snaps to 340 or 350 and the median alone
    // reads 171.4. The mean of a hundred of them recovers the fraction the
    // quantisation threw away. Only the supporting intervals contribute, so a
    // dropped beat sitting at twice the period cannot drag the answer.
    const mean = near.length >= 3 ? near.reduce((a, b) => a + b, 0) / near.length : 0;
    const bpm = usableBpm(60 / mean) ?? coarse;
    return { bpm, weight: near.length / usable.length, multiple };
  };

  // Order matters — it is the tie-break. `Array.prototype.sort` is stable.
  const candidates = [weigh(1), weigh(2), weigh(0.5)]
    .filter((candidate): candidate is TempoCandidate => candidate !== null)
    .sort((a, b) => b.weight - a.weight);

  const chosen = candidates[0];
  if (!chosen) return null;

  return {
    bpm: chosen.bpm,
    tracked,
    octave: chosen.multiple,
    chosen,
    alternative: candidates[1] ?? null,
    candidates,
    intervals: usable.length,
  };
}

// ---------------------------------------------------------------------------
// Decoding, and the analysis time axis
// ---------------------------------------------------------------------------

/** Mono PCM and the rate it is at. What the analyser takes. */
export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
}

export type Decoder = (file: string) => Promise<DecodedAudio>;
/** Beat times, in seconds. */
export type Analyser = (audio: DecodedAudio) => number[];

/**
 * Decode a track to mono PCM, decimated towards `ANALYSIS_HZ`.
 *
 * The decoders are imported dynamically because each carries a WASM binary that
 * every boot would otherwise instantiate to serve a feature most sessions never
 * touch. Both are pure WASM with no native binary and no second runtime, which
 * is the constraint origin R30 sets and the reason this family was chosen over
 * anything that shells out.
 *
 * Rejects rather than returning a sentinel when the file yields no samples: the
 * caller distinguishes "will not decode" from "took too long", and a zero-length
 * result is the first of those.
 */
export async function decodeToMono(file: string): Promise<DecodedAudio> {
  const bytes = await fs.readFile(file);
  const extension = path.extname(file).toLowerCase();

  let channelData: Float32Array[];
  let sampleRate: number;
  if (extension === ".flac") {
    const { FLACDecoder } = await import("@wasm-audio-decoders/flac");
    const decoder = new FLACDecoder();
    try {
      await decoder.ready;
      const decoded = await decoder.decodeFile(bytes);
      channelData = decoded.channelData;
      sampleRate = decoded.sampleRate;
    } finally {
      decoder.free();
    }
  } else {
    const { MPEGDecoder } = await import("mpg123-decoder");
    const decoder = new MPEGDecoder();
    try {
      await decoder.ready;
      const decoded = await decoder.decode(bytes);
      channelData = decoded.channelData;
      sampleRate = decoded.sampleRate;
    } finally {
      decoder.free();
    }
  }

  // Nothing decoded is the only decode failure this can see. Both decoders
  // report per-frame errors and carry on, and *some* errors are ordinary — a
  // trailing tag, junk after the last frame — so refusing on any error at all
  // would quietly stop measuring a large share of a real library. The residual
  // is the other direction and is real: 200KB of random bytes named `.mp3`
  // decodes to noise and reconciles to a confident-looking tempo. It is a file
  // that will not play either, and the transport marks it unplayable when it
  // tries; but a partially-corrupt MP3 measured here does get a number that
  // nothing downstream distinguishes from a measured one.
  const first = channelData[0];
  if (!first || first.length === 0) throw new Error("no audio decoded");
  if (!(Number.isFinite(sampleRate) && sampleRate > 0)) throw new Error("no sample rate decoded");

  // Whole factors only. A fractional resample would need a filter to be honest,
  // and averaging `factor` neighbours is already the crude low-pass that keeps
  // decimation from folding cymbals down onto the beat.
  const factor = Math.max(1, Math.floor(sampleRate / ANALYSIS_HZ));
  const length = Math.floor(first.length / factor);
  const samples = new Float32Array(length);
  const channels = channelData.length;
  for (let out = 0; out < length; out += 1) {
    let sum = 0;
    for (let n = 0; n < factor; n += 1) {
      const index = out * factor + n;
      for (let c = 0; c < channels; c += 1) sum += channelData[c]![index] ?? 0;
    }
    samples[out] = sum / (factor * channels);
  }
  return { samples, sampleRate: sampleRate / factor };
}

/**
 * Beat times in seconds, from `music-tempo`.
 *
 * Two things here are not decoration.
 *
 * **The hop is derived from the rate.** `music-tempo` hard-codes `hopSize` 441
 * against a `timeStep` of 0.01, which is 44100 written twice; hand it 11025 Hz
 * audio unchanged and every time it reports is four times too long. Passing
 * `hopSize = rate / 100` puts the frame rate back where `timeStep` says it is.
 *
 * **What is left over is corrected, not ignored.** `rate / 100` is 110.25 at
 * 11025 Hz and a hop is a whole number of samples, so the real frame is
 * 110/11025 = 9.977ms against the 10ms the library assumes — a 0.23% bias, which
 * turns 174 into 173.6 and would otherwise sit in every measured tempo forever.
 * `scale` converts the library's time axis back to real seconds, and the same
 * factor converts the 60–200 BPM window into the library's units on the way in.
 */
export function beatsOf(audio: DecodedAudio): number[] {
  const rate = audio.sampleRate;
  const hopSize = Math.max(1, Math.round(rate / FRAMES_PER_SECOND));
  const scale = (hopSize / rate) * FRAMES_PER_SECOND;

  // A power of two at roughly the window duration a 2048-point window is at
  // 44100 — `music-tempo` throws on anything else.
  const wanted = Math.max(256, rate * WINDOW_SECONDS);
  const bufferSize = 2 ** Math.round(Math.log2(wanted));

  const mt = new MusicTempo(Array.from(audio.samples), {
    hopSize,
    bufferSize,
    // The band origin R31 names, expressed in the library's own time units.
    maxBeatInterval: 60 / MIN_BPM / scale,
    minBeatInterval: 60 / MAX_BPM / scale,
  });
  const beats = Array.isArray(mt.beats) ? mt.beats : [];
  return beats.map((beat) => beat * scale);
}

/** The inter-beat intervals of a beat list. */
export function intervalsOf(beats: readonly number[]): number[] {
  const out: number[] = [];
  for (let n = 1; n < beats.length; n += 1) out.push(beats[n]! - beats[n - 1]!);
  return out;
}

/** How a measurement ended. Four outcomes, because the callers answer them differently. */
export type Measurement =
  | { outcome: "measured"; reading: TempoReading }
  | { outcome: "unmeasured" }
  | { outcome: "undecodable" }
  | { outcome: "timeout" };

/**
 * Measure one file end to end, or say which way it failed.
 *
 * `withDeadline` returns its fallback for a rejection as well as for a timeout,
 * deliberately — so a caller that needs to tell the two apart has to make the
 * rejection stop being one *before* the race. That is what the `catch` on the
 * work is for: a decoder that refuses resolves to `undecodable`, and only a
 * genuine overrun reaches the fallback. Collapsing them would mark every slow
 * FLAC unplayable, which is the opposite of what a timeout means.
 */
export async function measureFile(
  file: string,
  options: { deadlineMs?: number; decode?: Decoder; analyse?: Analyser } = {},
): Promise<Measurement> {
  const decode = options.decode ?? decodeToMono;
  const analyse = options.analyse ?? beatsOf;
  const work: Promise<Measurement> = (async () => {
    const audio = await decode(file);
    const reading = reconcileOctave(intervalsOf(analyse(audio)));
    return reading ? { outcome: "measured" as const, reading } : { outcome: "unmeasured" as const };
  })().catch((): Measurement => ({ outcome: "undecodable" }));

  return withDeadline<Measurement>(work, options.deadlineMs ?? MEASURE_DEADLINE_MS, {
    outcome: "timeout",
  });
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export interface TempoDetectorOptions {
  /**
   * Whether detection runs at all.
   *
   * Defaults to on for a caller that constructs one deliberately — a test, or
   * the measurement harness. The *application* passes `detectionEnabled()`,
   * which is off unless the operator has turned it on, because origin R31 says
   * a detector is used only once it is known to cover 60-200 BPM and to name
   * its octave on the material this exists for, and that has not been measured.
   * Shipping it on by default would be the situation R31 was written to prevent.
   */
  enabled?: boolean;
  concurrency?: number;
  deadlineMs?: number;
  decode?: Decoder;
  analyse?: Analyser;
  /** Told about every job that reached a conclusion, so a caller can broadcast. */
  onResult?: (result: TempoJobResult) => void;
}

export interface TempoJobResult {
  playlistId: string;
  trackPath: string;
  outcome: Measurement["outcome"] | "abandoned";
  /** The whole reconciliation, not just the number — origin R31's other half. */
  reading?: TempoReading;
  /** The index after the write, when there was one. */
  playlist?: Playlist;
}

interface Job {
  playlistId: string;
  trackPath: string;
  generation: number;
}

/**
 * Whether a track is one detection has anything to say about.
 *
 * A hand-set tempo wins over both tag and detection (origin R32), so a track
 * carrying one is not queued and — asked again on the way out — not written over
 * by a result that was already in flight when the edit landed.
 */
export function needsTempo(track: PlaylistTrack | undefined | null): boolean {
  if (!track || track.unplayable === true) return false;
  if (track.bpmSource === "set") return false;
  return usableBpm(track.bpm) === null;
}

/**
 * Tempo detection, queued per track and bounded in concurrency.
 *
 * Import never waits on this (origin R33): a track is in the index, playable and
 * orderable, before a job for it is ever created, and its tempo arrives later or
 * not at all.
 *
 * Two things can go stale while a decode runs, and each is checked rather than
 * assumed. A **playlist** can be deleted, which `forget` records by bumping a
 * generation the job carries. A **track** can be removed from a playlist that is
 * still there, which no counter can see, so the index is re-read and the path
 * looked up again before anything is written. Leaving that to the store's own
 * refusal — `setTrackBpm` returns null for a path it does not hold — would be
 * *nearly* right, and would still take the playlist's write lock and re-read its
 * file once for every dead job.
 */
/**
 * Whether the application should measure tempo at all.
 *
 * Off unless `HAL_TEMPO_DETECTION` is set to `1` or `true`. The mechanism below
 * is finished and tested; what has *not* happened is the measurement origin R31
 * makes the condition of using it — a run against real drum & bass, dub and
 * breaks, checking that the tracker does not latch an octave low. Reconciliation
 * reports the octave it chose; it does not rescue a tracker that chose wrong.
 *
 * `npm run tempo:report -- "<folder>"` is that measurement. Turn this on when
 * its numbers say the bar is met, and take R31's other branch if they do not.
 */
export function detectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.HAL_TEMPO_DETECTION ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

export class TempoDetector {
  private readonly queue: Job[] = [];
  private readonly generations = new Map<string, number>();
  private running = 0;

  constructor(
    private readonly store: AudioStore,
    private readonly options: TempoDetectorOptions = {},
  ) {}

  private get concurrency(): number {
    const asked = this.options.concurrency ?? MAX_CONCURRENT_MEASUREMENTS;
    // An acceptance, so a `NaN` from a hand-edited setting cannot become an
    // unbounded pool.
    return asked >= 1 ? Math.floor(asked) : 1;
  }

  /** How many jobs are waiting, and how many are in flight. For a caller reporting. */
  pending(): number {
    return this.queue.length;
  }

  active(): number {
    return this.running;
  }

  /** Whether everything queued has finished. The condition a test waits on. */
  idle(): boolean {
    return this.queue.length === 0 && this.running === 0;
  }

  /**
   * Queue every track of a playlist that has no tempo yet.
   *
   * The caller hands over what it just added rather than the whole index, so a
   * second import does not re-queue the first one's twenty tracks.
   */
  /**
   * Whether this detector will do anything.
   *
   * One gate rather than a check at each entry point: `measureAll` is the only
   * caller today and a second one would otherwise have to remember.
   */
  private get enabled(): boolean {
    return this.options.enabled !== false;
  }

  measureAll(playlistId: string, tracks: readonly PlaylistTrack[]): void {
    if (!this.enabled) return;
    for (const track of tracks) {
      if (needsTempo(track)) this.measure(playlistId, track.path);
    }
  }

  measure(playlistId: string, trackPath: string): void {
    if (typeof playlistId !== "string" || typeof trackPath !== "string") return;
    const generation = this.generations.get(playlistId) ?? 0;
    this.queue.push({ playlistId, trackPath, generation });
    this.pump();
  }

  /**
   * Abandon everything queued for a playlist.
   *
   * Called when a playlist is deleted. The generation is bumped rather than the
   * queue filtered, because a job already decoding cannot be taken out of a list
   * — it has to find out on its way back that nobody is waiting for it.
   */
  forget(playlistId: string): void {
    this.generations.set(playlistId, (this.generations.get(playlistId) ?? 0) + 1);
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running += 1;
      // Fire and forget, so the `.catch` is not optional: an unhandled rejection
      // here takes the process down with it.
      this.run(job)
        .catch(() => {})
        .finally(() => {
          this.running -= 1;
          this.pump();
        });
    }
  }

  /**
   * The track this job is still for, or null because nobody wants it any more.
   *
   * Asked twice — once before the decode, so a job queued behind nineteen others
   * for a playlist since deleted costs nothing, and once before the write, which
   * is the check that actually holds: everything interesting happens during the
   * decode.
   */
  private async wanted(job: Job): Promise<PlaylistTrack | null> {
    if ((this.generations.get(job.playlistId) ?? 0) !== job.generation) return null;
    const playlist = await this.store.load(job.playlistId).catch(() => null);
    if (!playlist) return null;
    const track = playlist.tracks.find((entry) => entry.path === job.trackPath);
    return needsTempo(track) ? (track ?? null) : null;
  }

  private report(result: TempoJobResult): void {
    try {
      this.options.onResult?.(result);
    } catch {
      // A listener that throws must not fail the job or stall the queue.
    }
  }

  private async run(job: Job): Promise<void> {
    if (!(await this.wanted(job))) {
      this.report({ ...job, outcome: "abandoned" });
      return;
    }

    const resolved = await this.store.resolveTrack(job.trackPath);
    if (!resolved.ok) {
      // The file the index names is not in the store. Marked rather than
      // ignored: R14 keeps the entry and its ordering exactly as they are, and
      // says out loud that it will not play.
      const marked = await this.mark(job);
      this.report({ ...job, outcome: "undecodable", ...(marked ? { playlist: marked } : {}) });
      return;
    }

    const measurement = await measureFile(resolved.file, {
      deadlineMs: this.options.deadlineMs,
      decode: this.options.decode,
      analyse: this.options.analyse,
    });

    if (measurement.outcome === "timeout") {
      // Unmeasured, **not** unplayable. `server/src/deadline.ts` has every
      // caller answer its own question, and the question here was "what is its
      // tempo", not "will it play" — a decode that ran long on a sleeping
      // external drive says nothing about whether a browser can play the file.
      this.report({ ...job, outcome: "timeout" });
      return;
    }

    if (measurement.outcome === "undecodable") {
      const marked = await this.mark(job);
      this.report({ ...job, outcome: "undecodable", ...(marked ? { playlist: marked } : {}) });
      return;
    }

    if (measurement.outcome === "unmeasured") {
      this.report({ ...job, outcome: "unmeasured" });
      return;
    }

    // Re-asked after the decode, which is the whole point: the track or its
    // playlist can have gone, or somebody can have typed a tempo in, during the
    // seconds this took.
    if (!(await this.wanted(job))) {
      this.report({ ...job, outcome: "abandoned" });
      return;
    }

    const written = await this.store
      .update(job.playlistId, (playlist) =>
        setTrackBpm(playlist, job.trackPath, measurement.reading.bpm, "measured"),
      )
      .catch(() => null);

    this.report({
      ...job,
      outcome: "measured",
      reading: measurement.reading,
      ...(written?.ok ? { playlist: written.playlist } : {}),
    });
  }

  private async mark(job: Job): Promise<Playlist | undefined> {
    if (!(await this.wanted(job))) return undefined;
    const written = await this.store
      .update(job.playlistId, (playlist) => setTrackUnplayable(playlist, job.trackPath, true))
      .catch(() => null);
    return written?.ok ? written.playlist : undefined;
  }
}
