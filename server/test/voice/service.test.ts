import type { WebSocket } from "ws";
import { beforeEach, describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage } from "../../../shared/src/types.js";
import { MAX_SPEECH_CHARACTERS, SpeechService } from "../../src/voice/service.js";
import { SHIPPED_PRESET, VoiceStore } from "../../src/storage/voices.js";
import { tmpDir } from "../tmp.js";
import { waitFor } from "../wait.js";

/**
 * A hub that records. `client` stands for a socket without being one — nothing
 * here calls a socket method, only compares identity.
 */
function hub() {
  const sent: { client: unknown; msg: ServerMessage }[] = [];
  const broadcasts: ServerMessage[] = [];
  let handler: ((msg: ClientMessage, client: WebSocket) => void) | null = null;
  let greeter: ((client: WebSocket) => void) | null = null;
  return {
    sent,
    broadcasts,
    deliver(msg: ClientMessage, client: unknown = {}) {
      handler?.(msg, client as WebSocket);
    },
    greetTo(client: unknown) {
      greeter?.(client as WebSocket);
    },
    broadcast(msg: ServerMessage) {
      broadcasts.push(msg);
    },
    onMessage(h: (msg: ClientMessage, client: WebSocket) => void) {
      handler = h;
    },
    onConnection(g: (client: WebSocket) => void) {
      greeter = g;
    },
    sendTo(client: WebSocket, msg: ServerMessage) {
      sent.push({ client, msg });
    },
  };
}

const errors = (h: ReturnType<typeof hub>) =>
  h.broadcasts.filter((m): m is Extract<ServerMessage, { type: "error" }> => m.type === "error");

let dir: string;
let store: VoiceStore;

beforeEach(async () => {
  dir = await tmpDir("speech");
  store = new VoiceStore(dir);
});

const service = (h: ReturnType<typeof hub>, canSound = true) =>
  new SpeechService(h, store, { canSound: () => canSound }, dir);

describe("greeting", () => {
  it("tells a new client what voices exist and what is being said", async () => {
    const h = hub();
    service(h);
    const client = {};
    h.greetTo(client);
    await waitFor(() => h.sent.length >= 2, "the greeting");

    const types = h.sent.filter((s) => s.client === client).map((s) => s.msg.type);
    expect(types).toContain("voices");
    expect(types).toContain("speech-state");
  });

  it("offers the shipped preset before anything has been saved", async () => {
    const h = hub();
    service(h);
    h.greetTo({});
    await waitFor(() => h.sent.some((s) => s.msg.type === "voices"), "the voices message");
    const voices = h.sent.find((s) => s.msg.type === "voices")!.msg as Extract<
      ServerMessage,
      { type: "voices" }
    >;
    expect(voices.presets.map((p) => p.id)).toContain(SHIPPED_PRESET.id);
    // No pack on a test machine, so a save would be refused and the editor must
    // be able to say so rather than failing at save time.
    expect(voices.available).toBe(false);
  });
});

describe("speak", () => {
  it("Covers AE1. refuses when nothing is listening, before spending a synthesis", async () => {
    const h = hub();
    service(h, false);
    h.deliver({ type: "speak", text: "Hello, Dave.", voice: { id: SHIPPED_PRESET.id } });
    await waitFor(() => errors(h).length > 0, "a refusal");

    expect(errors(h)[0]!.code).toBe("speech_refused");
    expect(errors(h)[0]!.message).toMatch(/nothing would be heard/i);
    // No utterance was broadcast: nothing is being said, so no subtitle is drawn.
    expect(h.broadcasts.some((m) => m.type === "speech-state" && m.utterance !== null)).toBe(false);
  });

  it("refuses an empty line", async () => {
    const h = hub();
    service(h);
    h.deliver({ type: "speak", text: "   ", voice: { id: SHIPPED_PRESET.id } });
    await waitFor(() => errors(h).length > 0, "a refusal");
    expect(errors(h)[0]!.message).toMatch(/nothing to say/i);
  });

  it("refuses a line past the bound, and names the bound", async () => {
    const h = hub();
    service(h);
    h.deliver({
      type: "speak",
      text: "a".repeat(MAX_SPEECH_CHARACTERS + 1),
      voice: { id: SHIPPED_PRESET.id },
    });
    await waitFor(() => errors(h).length > 0, "a refusal");
    expect(errors(h)[0]!.message).toContain(String(MAX_SPEECH_CHARACTERS));
  });

  it("refuses a voice that does not exist", async () => {
    const h = hub();
    service(h);
    h.deliver({ type: "speak", text: "Hello.", voice: { id: "nobody" } });
    await waitFor(() => errors(h).length > 0, "a refusal");
    expect(errors(h)[0]!.message).toMatch(/no voice by that name/i);
  });

  it("refuses when the model files are not there", async () => {
    // A test machine has no models, so this is the ordinary path here — and it
    // must be a stated reason rather than a hang or a silent nothing.
    const h = hub();
    service(h);
    h.deliver({ type: "speak", text: "Hello.", voice: { id: SHIPPED_PRESET.id } });
    await waitFor(() => errors(h).length > 0, "a refusal");
    expect(errors(h)[0]!.message).toMatch(/model files are not ready/i);
  });

  it("Covers AE2. accepts a speak from any admitted socket, not only the authority", async () => {
    // The asymmetry that makes an agent able to give the character a line: an
    // `observe` connection is refused the audio grant by construction, so
    // gating this on the grant would make R7 unsatisfiable. The refusal below
    // is about missing models, never about who asked.
    const h = hub();
    service(h);
    h.deliver({ type: "speak", text: "Hello.", voice: { id: SHIPPED_PRESET.id } }, { observer: true });
    await waitFor(() => errors(h).length > 0, "a refusal");
    expect(errors(h)[0]!.message).not.toMatch(/authority|permission|not allowed/i);
  });
});

describe("saving voices", () => {
  it("refuses every save while the voice pack cannot be read, and says so to the asker", async () => {
    const h = hub();
    service(h);
    const client = {};
    h.deliver(
      {
        type: "save-voice-preset",
        preset: { id: "mine", label: "Mine", mix: [{ voice: "am_michael", weight: 1 }], speed: 1 },
      },
      client,
    );
    await waitFor(() => h.sent.some((s) => s.msg.type === "error"), "an error to the asker");

    const error = h.sent.find((s) => s.msg.type === "error")!;
    // Sent to the asker, not broadcast: nobody else typed it.
    expect(error.client).toBe(client);
    expect((error.msg as { message: string }).message).toMatch(/not readable/i);
  });

  it("broadcasts the list after a delete so every client agrees", async () => {
    const h = hub();
    service(h);
    h.deliver({ type: "delete-voice-preset", id: "ghost" });
    await waitFor(() => h.broadcasts.some((m) => m.type === "voices"), "the voices broadcast");
    expect(h.broadcasts.some((m) => m.type === "voices")).toBe(true);
  });
});

describe("the phoneme readout", () => {
  it("answers the asker alone", async () => {
    // Every other client is looking at its own sample text and would be told
    // about somebody else's.
    const h = hub();
    service(h);
    const client = {};
    h.deliver({ type: "phonemes-for", text: "I am afraid, Dave." }, client);
    await waitFor(() => h.sent.some((s) => s.msg.type === "phonemes"), "the phoneme readout");

    const reply = h.sent.find((s) => s.msg.type === "phonemes")!;
    expect(reply.client).toBe(client);
    expect(h.broadcasts.some((m) => m.type === "phonemes")).toBe(false);
  });

  it("carries the text it answers for, so a late reply can be discarded", async () => {
    const h = hub();
    service(h);
    h.deliver({ type: "phonemes-for", text: "Open the pod bay doors." });
    await waitFor(() => h.sent.some((s) => s.msg.type === "phonemes"), "the phoneme readout");
    const reply = h.sent.find((s) => s.msg.type === "phonemes")!.msg as Extract<
      ServerMessage,
      { type: "phonemes" }
    >;
    expect(reply.text).toBe("Open the pod bay doors.");
    expect(reply.ipa).toBe("ˈoʊpən ðə pˈɑːd bˈeɪ dˈɔːɹz.");
  });

  it("answers null for nothing", async () => {
    const h = hub();
    service(h);
    h.deliver({ type: "phonemes-for", text: "   " });
    await waitFor(() => h.sent.some((s) => s.msg.type === "phonemes"), "the phoneme readout");
    const reply = h.sent.find((s) => s.msg.type === "phonemes")!.msg as { ipa: string | null };
    expect(reply.ipa).toBeNull();
  });
});

describe("the audio route's guard", () => {
  it("serves nothing for a generation that is not current", async () => {
    // What stops a URL outliving its line: a superseded utterance's audio is
    // refused rather than served stale.
    const h = hub();
    const speech = service(h);
    expect(speech.audioFor(0, 0)).toBeNull();
    expect(speech.audioFor(99, 0)).toBeNull();
  });
});
