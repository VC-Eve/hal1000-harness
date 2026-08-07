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

  it("answers malformed WS frames with bad_message and stays usable", async () => {
    const ws = new WebSocket(`ws://localhost:${app.port}/ws`);
    await new Promise((r) => ws.once("open", r));
    const messages: Record<string, unknown>[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    ws.send("this is not json");
    await new Promise((r) => setTimeout(r, 200));
    expect(messages.some((m) => m.type === "error" && m.code === "bad_message")).toBe(true);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("rejects WS connections from foreign browser origins", async () => {
    const ws = new WebSocket(`ws://localhost:${app.port}/ws`, { headers: { origin: "https://evil.example" } });
    const outcome = await new Promise<string>((resolve) => {
      ws.once("open", () => resolve("open"));
      ws.once("error", () => resolve("rejected"));
    });
    expect(outcome).toBe("rejected");
  });

  it("rejects a loopback origin on a different port", async () => {
    // The vector `add-monitor` opened: a page served from any other local port
    // could otherwise connect and schedule a shell command.
    for (const origin of [`http://localhost:3000`, `http://127.0.0.1:8080`, `http://localhost:${app.port + 1}`]) {
      const ws = new WebSocket(`ws://localhost:${app.port}/ws`, { headers: { origin } });
      const outcome = await new Promise<string>((resolve) => {
        ws.once("open", () => resolve("open"));
        ws.once("error", () => resolve("rejected"));
      });
      expect(outcome, `origin ${origin} should be refused`).toBe("rejected");
    }
  });

  it("accepts HAL's own origin", async () => {
    for (const origin of [`http://localhost:${app.port}`, `http://127.0.0.1:${app.port}`]) {
      const ws = new WebSocket(`ws://localhost:${app.port}/ws`, { headers: { origin } });
      const outcome = await new Promise<string>((resolve) => {
        ws.once("open", () => resolve("open"));
        ws.once("error", () => resolve("rejected"));
      });
      expect(outcome, `origin ${origin} should be accepted`).toBe("open");
      ws.close();
    }
  });

  it("accepts a request with no Origin, so agents keep protocol access", async () => {
    // Not a browser. A local process already has execution, so refusing it
    // would cost agent-native parity while closing nothing.
    const ws = new WebSocket(`ws://localhost:${app.port}/ws`);
    const outcome = await new Promise<string>((resolve) => {
      ws.once("open", () => resolve("open"));
      ws.once("error", () => resolve("rejected"));
    });
    expect(outcome).toBe("open");
    ws.close();
  });

  it("accepts an explicitly configured dev origin", async () => {
    process.env.HAL_DEV_ORIGIN = "http://localhost:4321";
    try {
      const ws = new WebSocket(`ws://localhost:${app.port}/ws`, { headers: { origin: "http://localhost:4321" } });
      const outcome = await new Promise<string>((resolve) => {
        ws.once("open", () => resolve("open"));
        ws.once("error", () => resolve("rejected"));
      });
      expect(outcome).toBe("open");
      ws.close();
    } finally {
      delete process.env.HAL_DEV_ORIGIN;
    }
  });
});
