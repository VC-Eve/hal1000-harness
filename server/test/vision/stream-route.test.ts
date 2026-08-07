import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type http from "node:http";
import { createHttpServer, type FrameSource } from "../../src/http.js";

let server: http.Server;
let port: number;
let camera: FrameSource | null = null;

// A frame source under the test's control: push() is the ffmpeg stream
// delivering a frame, without ffmpeg.
function fakeSource(): FrameSource & { push(jpeg: Buffer): void } {
  const listeners = new Set<(jpeg: Buffer) => void>();
  let latest: Buffer | null = null;
  return {
    running: true,
    grab: () => latest,
    onFrame(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push(jpeg) {
      latest = jpeg;
      for (const listener of listeners) listener(jpeg);
    },
  };
}

beforeAll(async () => {
  server = createHttpServer({ uiDist: null, camera: () => camera });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});

afterAll(async () => {
  // A never-ending response keeps its socket open, so close() alone would hang.
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("the live camera route", () => {
  it("refuses to stream while Vision is off", async () => {
    camera = null;
    const res = await fetch(`http://127.0.0.1:${port}/api/vision/stream`);

    // 503, not 404: the route exists — the camera is simply not held, because
    // a preview must not open a device the user has not switched on.
    expect(res.status).toBe(503);
    await res.text();
  });

  it("streams frames as multipart while Vision is watching", async () => {
    const source = fakeSource();
    camera = source;
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/vision/stream`, { signal: controller.signal });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("multipart/x-mixed-replace");

    const reader = res.body!.getReader();
    source.push(Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]));
    const { value } = await reader.read();
    const text = Buffer.from(value!).toString("latin1");

    expect(text).toContain("--halframe");
    expect(text).toContain("content-type: image/jpeg");

    controller.abort();
    await reader.cancel().catch(() => {});
  });

  it("sends the frame it already has before waiting for the next one", async () => {
    const source = fakeSource();
    // A viewer arriving between frames should not stare at nothing until the
    // next one lands — at six frames a second that is still a visible stall.
    source.push(Buffer.from([0xff, 0xd8, 0xaa, 0xff, 0xd9]));
    camera = source;

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/vision/stream`, { signal: controller.signal });
    const reader = res.body!.getReader();
    const { value } = await reader.read();

    expect(Buffer.from(value!).toString("latin1")).toContain("content-type: image/jpeg");

    controller.abort();
    await reader.cancel().catch(() => {});
  });
});
