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
import { KOKORO_MODEL, modelPath, voiceModelsDir, voiceReadiness } from "./models.js";
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

  constructor(
    private readonly hub: SpeechHub,
    private readonly store: VoiceStore,
    private readonly sound: SoundSide,
    private readonly dataRoot: string,
  ) {
    hub.onMessage((msg, client) => {
      void this.handle(msg, client);
    });
    hub.onConnection((client) => {
      void this.greet(client);
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
        const ipa = msg.text.trim().length === 0 ? null : await phonemesFor(msg.text);
        this.hub.sendTo(client, { type: "phonemes", text: msg.text, ipa });
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

    const preset = "id" in voice ? await this.store.get(voice.id) : cleanPreset(voice.preset);
    if (!preset) return this.refuse("There is no voice by that name.");
    if (voiceReadiness(voiceModelsDir(this.dataRoot)) !== "ok") {
      return this.refuse("The synthesiser's model files are not ready.");
    }

    const pack = this.pack ?? (this.stockNames() ? this.pack : null);
    if (!pack) return this.refuse("The voice pack could not be read.");
    const vector = blend(pack, preset.mix);
    if (!vector) return this.refuse("That voice names a stock voice this pack does not carry.");

    const units = await toUtterances(trimmed);
    if (units.length === 0) return this.refuse("There is nothing to say.");

    // The supersede. Everything after this belongs to the new generation, and
    // the old one's queued sentences are dropped here rather than when their
    // results arrive.
    this.generation += 1;
    const generation = this.generation;
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
    for (const unit of units) {
      if (generation !== this.generation) return; // superseded mid-render
      const row = styleRow(vector, unit.tokens.length);
      if (!row) continue;
      try {
        const result = await synth.render(unit.tokens, row, preset.speed);
        if (generation !== this.generation) return; // a late result for a replaced line
        rendered.push({ wav: toWav(result.samples), durationMs: result.durationMs });
        this.utterance.sentences.push({ text: unit.text, durationMs: result.durationMs });
        this.audio.set(generation, rendered);
        // Broadcast per sentence rather than once at the end, so the first words
        // can begin while the rest is still being rendered.
        this.broadcastState();
      } catch (err: unknown) {
        if (generation !== this.generation) return;
        this.refuse(err instanceof Error ? err.message : "The synthesiser could not say that.");
        return;
      }
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
}
