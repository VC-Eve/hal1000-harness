import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { WebSocket } from "ws";
import { tmpDir } from "../tmp.js";
import { waitFor } from "../wait.js";
import { WorldService, type WorldHub } from "../../src/live/service.js";
import { WorldStore } from "../../src/storage/worlds.js";
import type { World } from "../../../shared/src/types.js";
import { AudioStore } from "../../src/storage/audio.js";
import { audioMime } from "../../src/live/audio.js";
import { importTrack, listAudioFolder } from "../../src/live/audio-library.js";
import { readAudioTags } from "../../src/live/audio-tags.js";
import type {
  AudioLibraryMessage,
  ClientMessage,
  PlaylistMessage,
  PlaylistResultMessage,
  ServerMessage,
} from "../../../shared/src/types.js";

/**
 * Browsing for audio, and bringing it in.
 *
 * The fixtures are built byte by byte rather than checked in: a real FLAC is
 * megabytes of audio to assert something about eight bytes of header, and a
 * checked-in one could not be re-tagged per test. Nothing here decodes, so the
 * bytes after the header do not have to be music.
 */

class FakeHub implements WorldHub {
  readonly broadcasts: ServerMessage[] = [];
  readonly sent: { client: WebSocket; msg: ServerMessage }[] = [];
  private readonly handlers: ((msg: ClientMessage, c: WebSocket) => void)[] = [];
  private readonly greeters: ((c: WebSocket) => void)[] = [];
  private readonly closers: ((c: WebSocket) => void)[] = [];

  broadcast(msg: ServerMessage): void {
    this.broadcasts.push(msg);
  }
  onMessage(h: (msg: ClientMessage, c: WebSocket) => void): void {
    this.handlers.push(h);
  }
  onConnection(g: (c: WebSocket) => void): void {
    this.greeters.push(g);
  }
  onClose(c: (client: WebSocket) => void): void {
    this.closers.push(c);
  }
  sendTo(client: WebSocket, msg: ServerMessage): void {
    this.sent.push({ client, msg });
  }
  readonly client = { id: "one" } as unknown as WebSocket;
  readonly other = { id: "two" } as unknown as WebSocket;

  dispatch(msg: ClientMessage, client: WebSocket = this.client): void {
    for (const h of this.handlers) h(msg, client);
  }
  sentTo<T extends ServerMessage["type"]>(
    client: WebSocket,
    type: T,
  ): Extract<ServerMessage, { type: T }>[] {
    return this.sent
      .filter((entry) => entry.client === client && entry.msg.type === type)
      .map((entry) => entry.msg as Extract<ServerMessage, { type: T }>);
  }
  last<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    for (let i = this.broadcasts.length - 1; i >= 0; i -= 1) {
      const msg = this.broadcasts[i]!;
      if (msg.type === type) return msg as Extract<ServerMessage, { type: T }>;
    }
    return undefined;
  }
  results(): PlaylistResultMessage[] {
    return this.broadcasts.filter((m): m is PlaylistResultMessage => m.type === "playlist-result");
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A FLAC header: STREAMINFO with a real length, then the comments given. */
function flacBytes(comments: string[], seconds = 3): Buffer {
  const streaminfo = Buffer.alloc(34);
  const sampleRate = 44100n;
  const channels = 1n;
  const bits = 15n; // 16-bit, stored as bits-1
  const totalSamples = BigInt(Math.round(44100 * seconds));
  streaminfo.writeBigUInt64BE(
    (sampleRate << 44n) | (channels << 41n) | (bits << 36n) | totalSamples,
    10,
  );

  const vendor = Buffer.from("test", "utf8");
  const entries = comments.map((text) => {
    const body = Buffer.from(text, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(body.length, 0);
    return Buffer.concat([length, body]);
  });
  const vendorLength = Buffer.alloc(4);
  vendorLength.writeUInt32LE(vendor.length, 0);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(entries.length, 0);
  const comment = Buffer.concat([vendorLength, vendor, count, ...entries]);

  return Buffer.concat([
    Buffer.from("fLaC", "latin1"),
    blockHeader(0, streaminfo.length, false),
    streaminfo,
    blockHeader(4, comment.length, true),
    comment,
    Buffer.alloc(64), // stand-in for audio frames
  ]);
}

function blockHeader(type: number, size: number, last: boolean): Buffer {
  const head = Buffer.alloc(4);
  head[0] = (last ? 0x80 : 0) | type;
  head.writeUIntBE(size, 1, 3);
  return head;
}

// One MPEG1 Layer III frame at 128kbps, 44.1kHz, stereo, no padding: the shape
// almost every MP3 in a library is made of. `0xff 0xfb` is the sync plus MPEG1
// plus Layer III, `0x90` is bitrate index 9 and sample-rate index 0, and the
// last byte's top two bits are the stereo channel mode — which is what puts a
// Xing header 32 bytes into the frame rather than 17.
const FRAME_HEADER = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
const FRAME_BYTES = Math.floor(((1152 / 8) * 128_000) / 44_100); // 417
/** What one of those frames is worth in milliseconds, by its own arithmetic. */
const FRAME_MS = (1152 * 1000) / 44_100;

/** `count` identical frames of silence. */
function mpegFrames(count: number): Buffer {
  const frame = Buffer.concat([FRAME_HEADER, Buffer.alloc(FRAME_BYTES - 4)]);
  return Buffer.concat(Array.from({ length: count }, () => frame));
}

/**
 * A first frame carrying a Xing header that states a frame count.
 *
 * The count is what a variable-bitrate file is measured by: its first frame's
 * bitrate says nothing about the rest of the encode, so the byte arithmetic
 * would be wrong by whatever the encoder varied.
 */
function xingFrame(frames: number): Buffer {
  const frame = Buffer.alloc(FRAME_BYTES);
  FRAME_HEADER.copy(frame, 0);
  // Four bytes of header, then the side information a stereo MPEG1 frame has.
  const at = 4 + 32;
  frame.write("Xing", at, "latin1");
  frame.writeUInt32BE(0x01, at + 4); // the flag that says a frame count follows
  frame.writeUInt32BE(frames, at + 8);
  return frame;
}

/** An MP3 with an ID3v2.3 tag carrying one TBPM frame, or none. */
function mp3Bytes(bpmTag?: string, audio: Buffer = Buffer.alloc(32)): Buffer {
  const frames: Buffer[] = [];
  if (bpmTag !== undefined) {
    const body = Buffer.concat([Buffer.from([0x00]), Buffer.from(bpmTag, "latin1")]);
    const head = Buffer.alloc(10);
    head.write("TBPM", 0, "latin1");
    head.writeUInt32BE(body.length, 4);
    frames.push(head, body);
  }
  const payload = Buffer.concat([...frames, Buffer.alloc(16)]);
  const header = Buffer.alloc(10);
  header.write("ID3", 0, "latin1");
  header[3] = 3;
  // Syncsafe: seven bits a byte.
  header[6] = (payload.length >> 21) & 0x7f;
  header[7] = (payload.length >> 14) & 0x7f;
  header[8] = (payload.length >> 7) & 0x7f;
  header[9] = payload.length & 0x7f;
  return Buffer.concat([header, payload, audio]);
}

let dir: string;
let source: string;
let hub: FakeHub;
let audio: AudioStore;
let service: WorldService | null;

beforeEach(async () => {
  dir = await tmpDir("audio-import");
  source = path.join(dir, "source");
  await fs.mkdir(source, { recursive: true });
  hub = new FakeHub();
  audio = new AudioStore(dir);
  service = new WorldService(hub, new WorldStore(dir), audio);
});

afterEach(() => {
  vi.restoreAllMocks();
  service?.stop();
  service = null;
});

async function write(name: string, bytes: Buffer): Promise<string> {
  const file = path.join(source, name);
  await fs.writeFile(file, bytes);
  return file;
}

/** The one result the last dispatched action broadcast. */
function lastResult(): PlaylistResultMessage {
  const results = hub.results();
  return results[results.length - 1]!;
}

/**
 * Send a playlist action and wait for the result it answers with.
 *
 * A condition rather than a duration: the handler is fire-and-forget, so the
 * dispatch returns before any of its work has happened, and a fixed wait here
 * is the flake `server/test/wait.ts` was written about.
 */
async function act(msg: ClientMessage, client: WebSocket = hub.client): Promise<void> {
  const before = hub.results().length;
  hub.dispatch(msg, client);
  await waitFor(() => hub.results().length > before, `a result for ${msg.type}`);
}

/** Browse, and wait for the listing that socket is answered with. */
async function browse(folder: string | undefined, client: WebSocket = hub.client): Promise<void> {
  const before = hub.sentTo(client, "audio-library").length;
  hub.dispatch({ type: "browse-audio", ...(folder === undefined ? {} : { path: folder }) }, client);
  await waitFor(
    () => hub.sentTo(client, "audio-library").length > before,
    "a listing for the socket that asked",
  );
}

describe("the extension gate", () => {
  it("names flac and mp3 and refuses everything else", () => {
    expect(audioMime("mix.flac")).toBe("audio/flac");
    expect(audioMime("MIX.FLAC")).toBe("audio/flac");
    expect(audioMime("mix.mp3")).toBe("audio/mpeg");
    expect(audioMime("mix.mp4")).toBeNull();
    expect(audioMime("mix.wav")).toBeNull();
    expect(audioMime("notes.txt")).toBeNull();
  });
});

describe("listing a folder", () => {
  it("offers audio and nothing else", async () => {
    await write("one.flac", flacBytes([]));
    await write("two.mp3", mp3Bytes());
    await write("clip.mp4", Buffer.alloc(8));
    await write("notes.txt", Buffer.from("hello"));
    await fs.mkdir(path.join(source, "album"), { recursive: true });

    const listing = await listAudioFolder(source);
    expect(listing.error).toBeUndefined();
    expect(listing.tracks.map((t) => t.name)).toEqual(["one.flac", "two.mp3"]);
    expect(listing.folders.map((f) => f.name)).toEqual(["album"]);
    expect(listing.tracks[0]!.sizeBytes).toBeGreaterThan(0);
  });

  it("reports an unreadable folder rather than throwing", async () => {
    const listing = await listAudioFolder(path.join(dir, "nowhere-at-all"));
    expect(listing.error).toBeTruthy();
    expect(listing.tracks).toEqual([]);
  });

  it("answers the socket that asked and disturbs no one else", async () => {
    await write("one.flac", flacBytes([]));
    await browse(source, hub.client);
    await browse(path.join(dir, "nowhere-at-all"), hub.other);

    const mine = hub.sentTo(hub.client, "audio-library");
    const theirs = hub.sentTo(hub.other, "audio-library");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.listing.tracks.map((t) => t.name)).toEqual(["one.flac"]);
    // The other client's failed browse is answered to the other client only,
    // and nothing about either browse is broadcast — a listing sent to everyone
    // replaces the folder another tab is looking at.
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.listing.error).toBeTruthy();
    expect(hub.broadcasts.some((m) => m.type === "audio-library")).toBe(false);
  });

  it("does not remember a folder it could not read", async () => {
    await write("one.flac", flacBytes([]));
    await browse(source);
    await browse(path.join(dir, "nowhere-at-all"));
    await browse(undefined);

    const listings = hub.sentTo(hub.client, "audio-library") as AudioLibraryMessage[];
    expect(listings[2]!.listing.folder).toBe(path.resolve(source));
  });
});

describe("reading a tag", () => {
  it("keeps a tempo inside the range", async () => {
    const file = await write("dnb.flac", flacBytes(["BPM=174"]));
    expect(await readAudioTags(file)).toMatchObject({ bpm: 174 });
  });

  it("ignores a tempo outside the range, with a reason", async () => {
    const file = await write("fast.flac", flacBytes(["BPM=740"]));
    const tags = await readAudioTags(file);
    expect(tags.bpm).toBeNull();
    expect(tags.ignored).toContain("740");
  });

  it("ignores a tag that is not a number at all", async () => {
    const file = await write("odd.flac", flacBytes(["BPM=allegro"]));
    const tags = await readAudioTags(file);
    // `Number("allegro")` is NaN, and `typeof NaN === "number"` — nothing
    // downstream would have objected to it.
    expect(tags.bpm).toBeNull();
    expect(Number.isNaN(tags.bpm as unknown as number)).toBe(false);
    expect(tags.ignored).toBeTruthy();
  });

  it("says nothing about a file with no tag", async () => {
    const file = await write("plain.flac", flacBytes([]));
    const tags = await readAudioTags(file);
    expect(tags.bpm).toBeNull();
    expect(tags.ignored).toBeUndefined();
  });

  it("reads an ID3v2 TBPM frame", async () => {
    expect(await readAudioTags(await write("a.mp3", mp3Bytes("174")))).toMatchObject({ bpm: 174 });
    const wild = await readAudioTags(await write("b.mp3", mp3Bytes("740")));
    expect(wild.bpm).toBeNull();
    expect(wild.ignored).toContain("740");
    expect((await readAudioTags(await write("c.mp3", mp3Bytes()))).ignored).toBeUndefined();
  });

  it("takes a FLAC length from the container", async () => {
    expect((await readAudioTags(await write("len.flac", flacBytes([], 4)))).durationMs).toBe(4000);
  });

  it("measures a constant-bitrate MP3 from its own frames", async () => {
    // A hundred frames of 128kbps stereo: 2.61 seconds of silence, and the only
    // thing standing between an MP3 and thirty seconds of the transport's
    // unmeasured grace on every play.
    const file = await write("cbr.mp3", mp3Bytes("174", mpegFrames(100)));
    const tags = await readAudioTags(file);
    expect(tags.bpm).toBe(174);
    expect(tags.durationMs).toBeGreaterThan(100 * FRAME_MS - 100);
    expect(tags.durationMs).toBeLessThan(100 * FRAME_MS + 100);
  });

  it("prefers the frame count a Xing header states", async () => {
    // The byte arithmetic would call this file a fifth of a second long: it
    // holds two frames. The header says a thousand, which is what a variable
    // bitrate encode writes there, and that is the number to believe.
    const file = await write("vbr.mp3", mp3Bytes(undefined, Buffer.concat([xingFrame(1_000), mpegFrames(1)])));
    expect((await readAudioTags(file)).durationMs).toBe(Math.round(1_000 * FRAME_MS));
  });

  it("reports no length at all for bytes that do not read as frames", async () => {
    // Every byte is a sync candidate and none of them parses — bitrate index 15
    // is forbidden. Zero is the answer, not a number computed from junk: a wrong
    // length silently becomes the transport's clock, where "not known" is a
    // state it already handles.
    const file = await write("junk-frames.mp3", mp3Bytes(undefined, Buffer.alloc(2_048, 0xff)));
    expect((await readAudioTags(file)).durationMs).toBe(0);
  });

  it("measures an MP3 carrying no ID3v2 tag at all", async () => {
    const file = await write("bare.mp3", mpegFrames(50));
    const tags = await readAudioTags(file);
    expect(tags.bpm).toBeNull();
    expect(tags.durationMs).toBeGreaterThan(50 * FRAME_MS - 100);
  });

  it("does not count an ID3v1 tag at the end of the file as audio", async () => {
    // 128 bytes of text is about eight seconds at this bitrate — small, and
    // exactly the size a `remaining lt 5` condition lives inside.
    const tail = Buffer.alloc(128);
    tail.write("TAG", 0, "latin1");
    const withTag = await readAudioTags(
      await write("v1.mp3", Buffer.concat([mpegFrames(100), tail])),
    );
    const without = await readAudioTags(await write("v1-none.mp3", mpegFrames(100)));
    expect(withTag.durationMs).toBe(without.durationMs);
  });

  it("says nothing about a file it cannot make sense of", async () => {
    const file = await write("junk.mp3", Buffer.from("not audio at all"));
    expect(await readAudioTags(file)).toEqual({ bpm: null, durationMs: 0 });
  });
});

describe("importing", () => {
  it("copies a file in and names it relative to the store", async () => {
    const file = await write("track one.flac", flacBytes(["BPM=174"]));
    const result = await importTrack(audio.tracksDir(), file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `safeSegment`'s rule, not this file's: the space is not a character a
    // path can be trusted to carry, so it becomes an underscore.
    expect(result.track.path).toBe("tracks/track_one.flac");
    expect(result.track.bpm).toBe(174);
    expect(result.track.bpmSource).toBe("measured");
    expect(result.track.durationMs).toBe(3000);
    await expect(fs.stat(path.join(audio.tracksDir(), "track_one.flac"))).resolves.toBeTruthy();
  });

  it("refuses a file that is not audio", async () => {
    const file = await write("clip.mp4", Buffer.alloc(8));
    expect(await importTrack(audio.tracksDir(), file)).toMatchObject({ ok: false });
    expect(await importTrack(audio.tracksDir(), "")).toMatchObject({ ok: false });
    expect(await importTrack(audio.tracksDir(), path.join(source, "gone.flac"))).toMatchObject({
      ok: false,
    });
  });

  it("gives two files of the same name two store paths", async () => {
    const first = await write("mix.flac", flacBytes([]));
    await fs.mkdir(path.join(source, "second"), { recursive: true });
    const second = path.join(source, "second", "mix.flac");
    await fs.writeFile(second, flacBytes(["BPM=174"]));

    const a = await importTrack(audio.tracksDir(), first);
    const b = await importTrack(audio.tracksDir(), second);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.track.path).toBe("tracks/mix.flac");
    expect(b.track.path).toBe("tracks/mix-2.flac");
    // Two files, not one overwritten: the second still has its own tag.
    expect(b.track.bpm).toBe(174);
  });

  it("never has the bytes visible under the track name until they are all there", async () => {
    const file = await write("mix.flac", flacBytes([]));
    const real = fs.copyFile.bind(fs);
    let during: string[] = [];
    vi.spyOn(fs, "copyFile").mockImplementation(async (from, to, mode) => {
      await real(from, to, mode);
      // The moment the copy has finished and the rename has not happened yet —
      // which stands in for every moment during a real 40MB copy.
      during = await fs.readdir(audio.tracksDir());
    });

    expect(await importTrack(audio.tracksDir(), file)).toMatchObject({ ok: true });
    expect(during).toHaveLength(1);
    // Whatever the bytes are under while they are arriving, it is not a name
    // the track route would serve or the store would hand out.
    expect(audioMime(during[0]!)).toBeNull();
    expect(during[0]).not.toBe("mix.flac");
    expect(await fs.readdir(audio.tracksDir())).toEqual(["mix.flac"]);
  });

  it("leaves nothing behind when the rename fails", async () => {
    const file = await write("mix.flac", flacBytes([]));
    const rename = vi
      .spyOn(fs, "rename")
      .mockRejectedValue(Object.assign(new Error("no"), { code: "EIO" }));

    const result = await importTrack(audio.tracksDir(), file);
    expect(result.ok).toBe(false);
    // Not retried: EIO is not one of the codes a Windows file lock produces.
    expect(rename).toHaveBeenCalledTimes(1);
    // No partial file under the track name, and no temp left behind either.
    expect(await fs.readdir(audio.tracksDir())).toEqual([]);
  });

  it("retries a rename the way a Windows file lock needs", async () => {
    const file = await write("mix.flac", flacBytes([]));
    const real = fs.rename.bind(fs);
    let calls = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("held"), { code: "EBUSY" });
      return real(from, to);
    });

    expect(await importTrack(audio.tracksDir(), file)).toMatchObject({ ok: true });
    expect(calls).toBe(2);
    expect(await fs.readdir(audio.tracksDir())).toEqual(["mix.flac"]);
  });
});

describe("a commit over the protocol", () => {
  async function playlist(): Promise<string> {
    await act({ type: "create-playlist", name: "Set" });
    expect(lastResult()).toMatchObject({ action: "create-playlist", ok: true });
    return "set";
  }

  it("adds a whole selection in the order it was given", async () => {
    const id = await playlist();
    const files = [
      await write("c.flac", flacBytes(["BPM=174"])),
      await write("a.flac", flacBytes([])),
      await write("b.mp3", mp3Bytes("140")),
    ];
    await act({ type: "import-tracks", playlistId: id, sourcePaths: files });

    const result = lastResult();
    expect(result).toMatchObject({ action: "import-tracks", playlistId: id, ok: true });
    const index = hub.last("playlist") as PlaylistMessage;
    expect(index.playlist.tracks.map((t) => t.name)).toEqual(["c.flac", "a.flac", "b.mp3"]);
    // Store-relative, forward-slashed, and nothing absolute anywhere in it.
    expect(index.playlist.tracks.map((t) => t.path)).toEqual([
      "tracks/c.flac",
      "tracks/a.flac",
      "tracks/b.mp3",
    ]);
    expect(JSON.stringify(index.playlist)).not.toContain(source.replace(/\\/g, "\\\\"));
    expect(index.playlist.tracks[0]!.bpm).toBe(174);
    expect(index.playlist.tracks[1]!.bpm).toBeUndefined();
    expect(index.playlist.tracks[2]!.bpm).toBe(140);
    // And it is on disk, not only on the wire.
    const stored = await audio.load(id);
    expect(stored?.tracks).toHaveLength(3);
  });

  it("says which tags it ignored while importing the tracks anyway", async () => {
    const id = await playlist();
    const files = [
      await write("wild.flac", flacBytes(["BPM=740"])),
      await write("good.flac", flacBytes(["BPM=174"])),
    ];
    await act({ type: "import-tracks", playlistId: id, sourcePaths: files });

    const result = lastResult();
    expect(result.ok).toBe(true);
    expect(result.notes).toHaveLength(1);
    expect(result.notes?.[0]).toContain("wild.flac");
    expect(result.notes?.[0]).toContain("740");
    const index = hub.last("playlist") as PlaylistMessage;
    expect(index.playlist.tracks).toHaveLength(2);
    // Ignored means not yet known, never zero (origin R34).
    expect(index.playlist.tracks[0]!.bpm).toBeUndefined();
    expect(index.playlist.tracks[1]!.bpm).toBe(174);
  });

  it("keeps the files that copied and names the one that did not", async () => {
    const id = await playlist();
    const files = [
      await write("good.flac", flacBytes([])),
      path.join(source, "gone.flac"),
    ];
    await act({ type: "import-tracks", playlistId: id, sourcePaths: files });

    const result = lastResult();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("gone.flac");
    expect((await audio.load(id))?.tracks.map((t) => t.path)).toEqual(["tracks/good.flac"]);
  });

  it("leaves no entry and no partial file when the copy is interrupted", async () => {
    const id = await playlist();
    const file = await write("mix.flac", flacBytes([]));
    vi.spyOn(fs, "rename").mockRejectedValue(Object.assign(new Error("no"), { code: "EIO" }));

    await act({ type: "import-tracks", playlistId: id, sourcePaths: [file] });

    expect(lastResult()).toMatchObject({ action: "import-tracks", ok: false });
    expect((await audio.load(id))?.tracks).toEqual([]);
    // Nothing half-copied is observable in the store, under the track name or
    // under the temp one.
    expect(await fs.readdir(audio.tracksDir()).catch(() => [])).toEqual([]);
  });

  it("refuses a commit naming no playlist, no files, or a playlist that has gone", async () => {
    const file = await write("mix.flac", flacBytes([]));
    await act({ type: "import-tracks", playlistId: "", sourcePaths: [file] });
    expect(lastResult().ok).toBe(false);

    await act({ type: "import-tracks", playlistId: "set", sourcePaths: [] });
    expect(lastResult().ok).toBe(false);

    await act({ type: "import-tracks", playlistId: "no-such-list", sourcePaths: [file] });
    expect(lastResult()).toMatchObject({ ok: false, playlistId: "no-such-list" });
    // Refused before a byte is copied: a commit for a playlist that is not
    // there must not leave files in the store nothing names.
    expect(await fs.readdir(audio.tracksDir()).catch(() => [])).toEqual([]);
  });
});

describe("a hand-set tempo, and what an edit costs the Worlds that play it", () => {
  async function playlist(names: string[]): Promise<string> {
    await act({ type: "create-playlist", name: "Set" });
    const files: string[] = [];
    for (const name of names) files.push(await write(name, flacBytes([])));
    await act({ type: "import-tracks", playlistId: "set", sourcePaths: files });
    expect(lastResult()).toMatchObject({ action: "import-tracks", ok: true });
    return "set";
  }

  /** A World that exits on a playlist position, and says it plays this playlist. */
  async function worldOnTrack(name: string, value: number): Promise<string> {
    const store = new WorldStore(dir);
    const created = await store.create(name);
    const id = created.world.id;
    await store.mutate(id, (w: World) => ({
      ...w,
      playlistId: "set",
      states: [
        { id: "a", name: "a", clips: [], x: 0, y: 0 },
        { id: "b", name: "b", clips: [], x: 1, y: 0 },
      ],
      defaultStateId: "a",
      transitions: [
        {
          id: "t1",
          from: "a",
          to: "b",
          clips: [],
          conditions: [{ parameter: "audio.track", op: "eq", value }],
          hasExitTime: false,
          exitTime: 0,
          order: 0,
        },
      ],
    }));
    return id;
  }

  async function impactAfter(msg: ClientMessage) {
    const before = hub.broadcasts.filter((m) => m.type === "playlist-impact").length;
    hub.dispatch(msg, hub.client);
    await waitFor(
      () => hub.broadcasts.filter((m) => m.type === "playlist-impact").length > before,
      `an impact report for ${msg.type}`,
    );
    return hub.last("playlist-impact")!;
  }

  it("refuses 740 with its reason and writes nothing", async () => {
    const id = await playlist(["one.flac"]);
    await act({ type: "set-track-bpm", playlistId: id, path: "tracks/one.flac", bpm: 740 });
    const result = lastResult();
    expect(result).toMatchObject({ action: "set-track-bpm", ok: false });
    expect(result.error).toContain("60");
    expect(result.error).toContain("200");
    // Refused, not clamped: a clamp would pace a World against 200 BPM nobody
    // asked for.
    expect((await audio.load(id))?.tracks[0]!.bpm).toBeUndefined();
  });

  it("takes 174 and records it as the author's rather than as a measurement", async () => {
    const id = await playlist(["one.flac"]);
    await act({ type: "set-track-bpm", playlistId: id, path: "tracks/one.flac", bpm: 174 });
    expect(lastResult()).toMatchObject({ action: "set-track-bpm", ok: true });
    expect((await audio.load(id))?.tracks[0]).toMatchObject({ bpm: 174, bpmSource: "set" });
  });

  it("clears a tempo back to not-yet-known rather than to zero", async () => {
    const id = await playlist(["one.flac"]);
    await act({ type: "set-track-bpm", playlistId: id, path: "tracks/one.flac", bpm: 174 });
    await act({ type: "set-track-bpm", playlistId: id, path: "tracks/one.flac", bpm: null });
    const entry = (await audio.load(id))?.tracks[0]!;
    // Zero is the value that satisfies every below-threshold condition an
    // author writes, so "nobody knows" must not be stored as one.
    expect(entry.bpm).toBeUndefined();
    expect(entry.bpmSource).toBeUndefined();
  });

  it("covers AE13: names every World a removal stranded, and the conditions", async () => {
    const id = await playlist(["one.flac", "two.flac", "three.flac", "four.flac"]);
    const b = await worldOnTrack("DJ Booth", 4);
    const c = await worldOnTrack("Closing", 3);

    await impactAfter({ type: "remove-track", playlistId: id, path: "tracks/four.flac" });
    const report = await impactAfter({ type: "remove-track", playlistId: id, path: "tracks/three.flac" });

    expect(report.playlistId).toBe(id);
    expect(report.action).toBe("remove-track");
    expect(report.impacts.map((i) => i.worldId).sort()).toEqual([b, c].sort());
    const booth = report.impacts.find((i) => i.worldId === b)!;
    expect(booth.worldName).toBe("DJ Booth");
    expect(booth.conditions).toEqual([
      { transitionId: "t1", parameter: "audio.track", op: "eq", value: 4 },
    ]);
  });

  it("says nothing about a World that names a different playlist", async () => {
    const id = await playlist(["one.flac", "two.flac"]);
    // The same stranded condition, on a World that plays something else. Only
    // the playlist reference tells the two cases apart, so a World with nothing
    // to report would prove nothing about the filter.
    const elsewhere = await worldOnTrack("Elsewhere", 4);
    const store = new WorldStore(dir);
    await store.mutate(elsewhere, (w: World) => ({ ...w, playlistId: "other-set" }));

    const report = await impactAfter({ type: "remove-track", playlistId: id, path: "tracks/two.flac" });
    expect(report.impacts).toEqual([]);
  });

  it("reports a reorder as having moved what every position names", async () => {
    const id = await playlist(["one.flac", "two.flac", "three.flac"]);
    const b = await worldOnTrack("DJ Booth", 2);

    const report = await impactAfter({
      type: "reorder-playlist",
      playlistId: id,
      order: ["tracks/three.flac", "tracks/one.flac", "tracks/two.flac"],
    });
    // Nothing became unsatisfiable — position 2 still exists — and the
    // condition now points at a different track, which is the half of R17 an
    // unreachability check alone would answer with silence.
    expect(report.action).toBe("reorder-playlist");
    expect(report.impacts.map((i) => i.worldId)).toEqual([b]);
    expect(report.impacts[0]!.conditions).toEqual([
      { transitionId: "t1", parameter: "audio.track", op: "eq", value: 2 },
    ]);
  });
});
