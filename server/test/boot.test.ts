import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { startApp, type App } from "../src/app.js";

describe("boot", () => {
  let app: App;

  beforeAll(async () => {
    process.env.HAL_DATA_DIR = `${process.env.TEMP ?? "/tmp"}/hal1000-test-${process.pid}`;
    app = await startApp(0);
  });

  afterAll(async () => {
    await app.close();
  });

  it("serves /api/health", async () => {
    const res = await fetch(`http://localhost:${app.port}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; app: string };
    expect(body.ok).toBe(true);
    expect(body.app).toBe("hal1000");
  });

  it("accepts a WS connection and sends a typed hello", async () => {
    const ws = new WebSocket(`ws://localhost:${app.port}/ws`);
    const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.once("message", (raw) => resolve(JSON.parse(String(raw))));
      ws.once("error", reject);
    });
    expect(hello.type).toBe("hello");
    expect(hello.app).toBe("hal1000");
    ws.close();
  });

  it("fails with a clear error when the port is taken", async () => {
    await expect(startApp(app.port)).rejects.toThrow(/already in use/);
  });
});
