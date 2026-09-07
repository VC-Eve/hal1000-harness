// The speech protocol: who may speak, what is being said, and where the audio is.
//
// **Anyone admitted may speak; only the audio authority sounds it.** That
// asymmetry is deliberate and load-bearing. An agent connection declares
// `observe` and is refused the audio grant by construction, so gating `speak` on
// the grant would mean an agent could never give the character a line — which is
// most of the reason the message is on the protocol rather than in the UI.
//
// What *is* checked before a line is synthesised is whether anybody could hear
// it (R11). Not `authority !== null`, which accepts a tab that has never been
// clicked: the browser will not play an unmuted element without a user gesture,
// so that tab would produce subtitles under silence. `AudioService.canSound()`
// answers the real question.
//
// A supersede **dequeues**. Discarding late results alone would leave a new
// line queued behind the old one's remaining sentences on a worker that runs one
// at a time — the audition loop stalling on exactly the impatient interaction it
// exists for.

import type { WebSocket } from "ws";
import type { ClientMessage, ServerMessage, Utterance } from "../../../shared/src/types.js";
import { cleanPreset, type VoicePreset } from "../../../shared/src/voices.js";
import { VoiceStore } from "../storage/voices.js";
import { phonemesFor, toUtterances } from "./phonemes.js";
import { KOKORO_MODEL, ensureModels, modelPath, voiceModelsDir, voiceReadiness } from "./models.js";
import { Synthesiser } from "./synth.js";
import { blend, readVoicePack, styleRow, type VoicePack } from "./vectors.js";
import { toWav } from "./wav.js";
import { KOKORO_VOICES } from "./models.js";
import { readFileSync } from "node:fs";

/** The hub, structurally, so a test can fake it. */
export interface SpeechHub {
  broadcast(msg: ServerMessage): void;
  onMessage(handler: (msg: ClientMessage, client: WebSocket) => void): void;
  onConnection(greet: (client: WebSocket) => void): void;
  onClose(closed: (client: WebSocket) => void): void;
  sendTo(client: WebSocket, msg: ServerMessage): void;
}

/**
 * The one thing speech asks of the audio side.
 *
 * Deliberately one predicate rather than a reference to `AudioService`: the two
 * subsystems share a loudspeaker and nothing else, and a wider seam would invite
 * speech to start reading the transport.
 */
export interface SoundSide {
  /** Whether some client is attending, cleared to sound, and not refusing to. */
  canSound(): boolean;
}

/** The longest line that will be accepted (R12). */
export const MAX_SPEECH_CHARACTERS = 2000;

interface Rendered {
  wav: Buffer;
  durationMs: number;
}

export class SpeechService {
  private utterance: Utterance | null = null;
  private generation = 0;
  private audio = new Map<number, Rendered[]>();
  private pack: VoicePack | null = null;
  private packRead = false;
  private synth: Synthesiser | null = null;
  /**
   * The generation still being synthesised, or 0.
   *
   * A client can outrun the renderer: the first sentence plays and finishes
   * while the second is still being synthesised, so the client reports an index
   * past the last *rendered* sentence. Without this, that report read as "the
   * line is over" and cleared the utterance mid-line — which then made the
   * render loop dereference a null utterance on its next iteration.
   */
  private rendering = 0;

  constructor(
    private readonly hub: SpeechHub,
    private readonly store: VoiceStore,
    private readonly sound: SoundSide,
    private readonly dataRoot: string,
  ) {
    // Catch everything: an escaped rejection from a fire-and-forget handler
    // would crash the process, and both of these have real throw paths behind
    // them — `phonemize` rejecting inside `toUtterances`, and `writeJsonAtomic`
    // rejecting after its rename retries are exhausted. `WorldService` does the
    // same at its own hub wiring, for the same reason.
    hub.onMessage((msg, client) => {
      this.handle(msg, client).catch((err: unknown) => {
        console.error(`speech handler error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    hub.onConnection((client) => {
      this.greet(client).catch((err: unknown) => {
        console.error(`speech greeting error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    // A line is only ever finished by the client that is sounding it reporting
    // its last sentence. If that client goes away mid-line the report never
    // arrives, and the utterance used to stay live forever: Speak stayed
    // disabled, the music stayed ducked under silence, and a reopened tab was
    // greeted with the stale line and replayed it from the start.
    // Reads the global condition rather than the closing client's, and so
    // depends on `WorldService`'s closer having already run for the same close —
    // it is registered first, in `app.ts`. See the note there. The known cost of
    // asking globally is recorded as a residual: with two tabs attending, the
    // one holding the grant closing can answer "no" transiently during the
    // handover and cut a line the survivor would have picked up.
    hub.onClose(() => {
      if (this.utterance && !this.sound.canSound()) this.silence();
    });
  }

  async greet(client: WebSocket): Promise<void> {
    this.hub.sendTo(client, await this.voicesMessage());
    this.hub.sendTo(client, { type: "speech-state", utterance: this.utterance });
  }

  /** The current utterance's audio for one sentence, or null. */
  audioFor(generation: number, index: number): Buffer | null {
    if (generation !== this.generation) return null; // a URL must not outlive its line
    return this.audio.get(generation)?.[index]?.wav ?? null;
  }

  get current(): Utterance | null {
    return this.utterance;
  }

  async stop(): Promise<void> {
    await this.synth?.stop();
    this.synth = null;
  }

  private async handle(msg: ClientMessage, client: WebSocket): Promise<void> {
    switch (msg.type) {
      case "speak":
        await this.speak(msg.text, msg.voice);
        return;
      case "stop-speaking":
        this.silence();
        return;
      case "report-speech-sentence":
        this.advance(msg.generation, msg.index);
        return;
      case "save-voice-preset": {
        const result = await this.store.save(msg.preset, this.stockNames());
        if (!result.ok) this.hub.sendTo(client, { type: "error", code: "voice_refused", message: result.error });
        this.hub.broadcast(await this.voicesMessage());
        return;
      }
      case "delete-voice-preset": {
        const result = await this.store.remove(msg.id);
        if (!result.ok) this.hub.sendTo(client, { type: "error", code: "voice_refused", message: result.error });
        this.hub.broadcast(await this.voicesMessage());
        return;
      }
      case "phonemes-for": {
        // Answered to the asker alone. Every other client is looking at its own
        // sample text and would be told about somebody else's.
        //
        // Bounded like `speak` is. Phonemisation holds a process-wide queue (the
        // eSpeak global-state lock), so an unbounded readout would stall every
        // other caller — and a preview longer than a speakable line means nothing.
        const text = typeof msg.text === "string" ? msg.text : "";
        if (text.length > MAX_SPEECH_CHARACTERS) {
          this.hub.sendTo(client, { type: "phonemes", text, ipa: null });
          return;
        }
        const ipa = text.trim().length === 0 ? null : await phonemesFor(text);
        this.hub.sendTo(client, { type: "phonemes", text, ipa });
        return;
      }
      default:
        return;
    }
  }

  private async voicesMessage(): Promise<ServerMessage> {
    const stock = this.stockNames();
    return {
      type: "voices",
      presets: await this.store.list(),
      stock: stock ?? [],
      available: stock !== null,
    };
  }

  /**
   * The voice pack, read once.
   *
   * Read lazily and remembered, including the failure: a missing pack is the
   * ordinary state before the models are fetched, and re-reading 28MB on every
   * greeting to rediscover that would be a cost paid for nothing.
   */
  private stockNames(): string[] | null {
    if (!this.packRead) {
      this.packRead = true;
      try {
        const file = modelPath(voiceModelsDir(this.dataRoot), KOKORO_VOICES);
        // Synchronous on purpose: this happens once, and every caller of it is
        // answering a message that cannot proceed without the answer.
        this.pack = readVoicePack(readFileSync(file));
      } catch {
        this.pack = null;
      }
    }
    return this.pack?.names ?? null;
  }

  /**
   * Move the subtitle to the sentence the sounding client has actually started.
   *
   * Refused for any generation but the current one, the way a stale clip-end
   * report is: a report for a line that has been replaced must not move the
   * subtitle of the line that replaced it.
   *
   * An index past the last sentence means the utterance is finished, and the
   * state goes to null rather than resting on the final subtitle — otherwise the
   * last line of a speech would stay on the projector indefinitely.
   */
  private advance(generation: number, index: number): void {
    if (!this.utterance || generation !== this.generation) return;
    if (!Number.isInteger(index) || index < 0) return;
    if (index >= this.utterance.sentences.length) {
      if (this.rendering === generation) {
        // More is coming. Hold on the last sentence that exists rather than
        // ending the line: the render loop broadcasts again as each one lands,
        // and the client resumes from there.
        return;
      }
      this.utterance = null;
      this.audio.clear();
      this.broadcastState();
      return;
    }
    this.utterance = { ...this.utterance, current: index };
    this.broadcastState();
  }

  private silence(): void {
    this.generation += 1;
    this.utterance = null;
    this.audio.clear();
    this.synth?.dropQueued(() => true);
    this.hub.broadcast({ type: "speech-state", utterance: null });
  }

  private async speak(text: string, voice: { id: string } | { preset: VoicePreset }): Promise<void> {
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (trimmed.length === 0) return this.refuse("There is nothing to say.");
    if (trimmed.length > MAX_SPEECH_CHARACTERS) {
      return this.refuse(
        `That is ${trimmed.length} characters and the limit is ${MAX_SPEECH_CHARACTERS}.`,
      );
    }
    // Checked before a line is synthesised, not at render time: with nothing
    // attending there is no point spending the work, and accepting silently
    // would draw subtitles nobody could hear.
    if (!this.sound.canSound()) {
      return this.refuse("Nothing is listening, so nothing would be heard.");
    }

    // Claimed here, before any await. Two speaks run concurrently — the handler
    // is fire-and-forget — and both `store.get` and `toUtterances` await, the
    // latter behind the process-wide phonemiser queue. Claiming after those made
    // supersede resolve in *completion* order: a long line issued first could
    // take a later generation than a short line issued after it, and wipe the
    // newer line while it was already sounding.
    this.generation += 1;
    const generation = this.generation;
    const superseded = () => generation !== this.generation;

    const preset = "id" in voice ? await this.store.get(voice.id) : cleanPreset(voice.preset);
    if (superseded()) return;
    if (!preset) return this.refuseClaimed("There is no voice by that name.");

    const models = voiceModelsDir(this.dataRoot);
    if (voiceReadiness(models) !== "ok") {
      // Start the fetch the readiness leg reports on. Nothing called
      // `ensureModels` before this line, so the whole fetch-on-first-use path
      // was dead: the models never arrived on their own, `fetching` was
      // unreachable, and the editor's "still downloading" state could not occur.
      // Fire-and-forget with a catch — it reports through readiness and is
      // documented never to throw, but an unhandled rejection here would take
      // the process down.
      void ensureModels(models).catch(() => undefined);
      return this.refuseClaimed(
        voiceReadiness(models) === "fetching"
          ? "The voice model is downloading. This happens once."
          : "The synthesiser's model files are not ready.",
      );
    }

    const pack = this.pack ?? (this.stockNames() ? this.pack : null);
    if (!pack) return this.refuseClaimed("The voice pack could not be read.");
    const vector = blend(pack, preset.mix);
    if (!vector)
      return this.refuseClaimed("That voice names a stock voice this pack does not carry.");

    // Checked before the phonemiser rather than only after it. Phonemisation
    // holds a process-wide serialised eSpeak lock, so N presses of Speak run all
    // N to completion in order and the newest line cannot start until the ones
    // it already replaced have finished. The accepted "no rate limit" residual
    // is bounded by supersede dequeuing the synth queue; that bound did not
    // cover this leg.
    if (superseded()) return;
    const units = await toUtterances(trimmed);
    if (superseded()) return;
    if (units.length === 0) return this.refuseClaimed("There is nothing to say.");

    // The supersede: the old line's queued sentences are dropped here rather
    // than when their results arrive.
    this.synth?.dropQueued(() => true);
    this.audio.clear();

    this.utterance = {
      generation,
      text: trimmed,
      voiceId: "id" in voice ? preset.id : null,
      sentences: [],
      current: -1,
    };

    const synth = this.ensureSynth();
    const rendered: Rendered[] = [];
    this.rendering = generation;
    try {
      for (const unit of units) {
        if (generation !== this.generation) return; // superseded mid-render
        const row = styleRow(vector, unit.tokens.length);
        if (!row) continue;
        try {
          const result = await synth.render(unit.tokens, row, preset.speed);
          if (generation !== this.generation) return; // a late result for a replaced line
          // Read back rather than closed over: `this.utterance` is reachable by
          // `advance` and `silence` across every await above, and pushing into a
          // stale or null one is how this loop used to throw.
          const held: Utterance | null = this.utterance;
          if (!held || held.generation !== generation) return;

          rendered.push({ wav: toWav(result.samples), durationMs: result.durationMs });
          this.utterance = {
            ...held,
            sentences: [...held.sentences, { text: unit.text, durationMs: result.durationMs }],
          };
          this.audio.set(generation, rendered);
          // Broadcast per sentence rather than once at the end, so the first
          // words can begin while the rest is still being rendered.
          this.broadcastState();
        } catch (err: unknown) {
          if (generation !== this.generation) return;
          // A failure on the first sentence used to leave a phantom utterance:
          // state set, nothing broadcast, nothing audible, and no way to clear it.
          this.utterance = null;
          this.audio.clear();
          this.broadcastState();
          this.refuse(err instanceof Error ? err.message : "The synthesiser could not say that.");
          return;
        }
      }
    } finally {
      // Only the generation that set it clears it — a supersede has already
      // moved `rendering` on to its own line.
      if (this.rendering === generation) this.rendering = 0;
    }
  }

  private ensureSynth(): Synthesiser {
    this.synth ??= new Synthesiser({
      model: modelPath(voiceModelsDir(this.dataRoot), KOKORO_MODEL),
    });
    return this.synth;
  }

  private broadcastState(): void {
    this.hub.broadcast({ type: "speech-state", utterance: this.utterance });
  }

  /**
   * Say why a line will not be spoken.
   *
   * Broadcast rather than sent to the asker, because the asker may be an agent
   * that will never render it while the operator is the one who needs to know
   * the character stayed silent. `code` groups these so a client can style them
   * together without matching on prose.
   */
  private refuse(message: string): void {
    this.hub.broadcast({ type: "error", code: "speech_refused", message });
  }

  /**
   * Refuse a line that was already claimed a generation.
   *
   * Past the claim there is no way back to the line that was sounding: its audio
   * URLs are keyed by generation and now 404, and its `report-speech-sentence`
   * is refused by `advance` for the same reason. Leaving it in `this.utterance`
   * stranded it — the projector held a subtitle nobody could hear, the music
   * stayed ducked under silence, Speak stayed disabled because the client sees a
   * line in progress, and every new connection was greeted with the dead one.
   * Only Stop recovered. The claim superseded that line whether or not this one
   * goes on to say anything, so end it here.
   */
  private refuseClaimed(message: string): void {
    if (this.utterance) {
      this.utterance = null;
      this.audio.clear();
      this.broadcastState();
    }
    this.refuse(message);
  }
}
