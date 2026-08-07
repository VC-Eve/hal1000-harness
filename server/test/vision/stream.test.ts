import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

// node:child_process exports are non-configurable under ESM, so spyOn cannot
// replace spawn — the module has to be mocked before it is imported.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { CameraStream } = await import("../../src/vision/stream.js");

// A fake ffmpeg. Real spawning is not the point here — the process lifecycle
// around it is, and that is what went wrong: a superseded child scheduling a
// restart, a dead child's last frame outliving it, and a half-written JPEG
// spliced onto the next process's first one.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill() {
    this.killed = true;
    // Real processes report their exit asynchronously, well after kill()
    // returns. Synchronous close would hide every bug in this file.
    setTimeout(() => this.emit("close", 0), 0);
  }
}

let spawned: FakeChild[] = [];

const jpeg = (marker: number) => Buffer.from([0xff, 0xd8, marker, 0xff, 0xd9]);

beforeEach(() => {
  spawned = [];
  spawnMock.mockImplementation(() => {
    const fake = new FakeChild();
    spawned.push(fake);
    return fake;
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  spawnMock.mockReset();
});

const flush = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("CameraStream frame parsing", () => {
  it("splits whole JPEGs out of the byte stream", async () => {
    const stream = new CameraStream();
    const seen: Buffer[] = [];
    stream.onFrame((f) => seen.push(f));
    stream.start(null);

    spawned[0]!.stdout.emit("data", Buffer.concat([jpeg(1), jpeg(2)]));

    expect(seen).toHaveLength(2);
    expect(seen[1]![2]).toBe(2);
    stream.stop();
  });

  it("reassembles a frame delivered across several chunks", async () => {
    const stream = new CameraStream();
    const seen: Buffer[] = [];
    stream.onFrame((f) => seen.push(f));
    stream.start(null);

    const whole = jpeg(7);
    for (const byte of whole) spawned[0]!.stdout.emit("data", Buffer.from([byte]));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.equals(whole)).toBe(true);
    stream.stop();
  });
});

describe("CameraStream process lifecycle", () => {
  it("does not restart on behalf of a child that start() already replaced", async () => {
    const stream = new CameraStream();
    stream.start("camera-a");
    expect(spawned).toHaveLength(1);

    // Changing device kills the first child and spawns a second immediately.
    stream.start("camera-b");
    expect(spawned).toHaveLength(2);

    // The killed child's close arrives late. It must not arm a restart — doing
    // so spawns a third ffmpeg beside the live one, and both hold a device that
    // only one process can open.
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(spawned).toHaveLength(2);
    stream.stop();
  });

  it("ignores output from a superseded child", async () => {
    const stream = new CameraStream();
    const seen: Buffer[] = [];
    stream.onFrame((f) => seen.push(f));
    stream.start("camera-a");
    const first = spawned[0]!;

    stream.start("camera-b");
    // Trailing bytes from the old process must not enter the new one's parser.
    first.stdout.emit("data", jpeg(9));

    expect(seen).toHaveLength(0);
    stream.stop();
  });

  it("drops the last frame when the camera dies, rather than serving it as current", async () => {
    const stream = new CameraStream();
    stream.start(null);
    spawned[0]!.stdout.emit("data", jpeg(1));
    expect(stream.grab()).not.toBeNull();

    spawned[0]!.emit("close", 1);

    // A retained frame here is how HAL ends up narrating a scene that is no
    // longer in front of the camera.
    expect(stream.grab()).toBeNull();
    stream.stop();
  });

  it("starts each process on a clean frame boundary", async () => {
    const stream = new CameraStream();
    const seen: Buffer[] = [];
    stream.onFrame((f) => seen.push(f));
    stream.start(null);

    // Half a JPEG, then the process dies.
    spawned[0]!.stdout.emit("data", Buffer.from([0xff, 0xd8, 0x11]));
    spawned[0]!.emit("close", 1);

    await vi.advanceTimersByTimeAsync(6_000);
    expect(spawned).toHaveLength(2);

    spawned[1]!.stdout.emit("data", jpeg(3));

    // One clean frame, not one corrupt splice of the two processes' bytes.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.equals(jpeg(3))).toBe(true);
    stream.stop();
  });

  it("keeps its backoff when start() is called again for the same device", async () => {
    const stream = new CameraStream();
    stream.start(null);
    spawned[0]!.emit("close", 1);

    // The service ticks every 2s and calls start() each time. That must not
    // cancel the pending 5s restart and respawn immediately.
    await vi.advanceTimersByTimeAsync(2_000);
    stream.start(null);
    await vi.advanceTimersByTimeAsync(2_000);
    stream.start(null);
    expect(spawned).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(spawned).toHaveLength(2);
    stream.stop();
  });

  it("stops for good, cancelling any pending restart", async () => {
    const stream = new CameraStream();
    stream.start(null);
    spawned[0]!.emit("close", 1);

    stream.stop();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(spawned).toHaveLength(1);
    expect(stream.running).toBe(false);
  });
});
