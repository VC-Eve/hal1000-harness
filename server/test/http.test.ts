import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import type http from "node:http";
import { createHttpServer } from "../src/http.js";

let server: http.Server;
let port: number;
let uiDist: string;

beforeAll(async () => {
  uiDist = await fs.mkdtemp(path.join(os.tmpdir(), "hal1000-http-"));
  await fs.writeFile(path.join(uiDist, "index.html"), "<html>HAL INDEX</html>");
  await fs.writeFile(path.join(uiDist, "app.js"), "console.log('hal')");
  await fs.writeFile(path.join(os.tmpdir(), "hal1000-http-secret.txt"), "secret");
  server = createHttpServer({ uiDist });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`);

describe("http static serving", () => {
  it("serves known files with the right content type", async () => {
    const res = await get("/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toContain("hal");
  });

  it("serves index.html at the root", async () => {
    const res = await get("/");
    expect(await res.text()).toContain("HAL INDEX");
  });

  it("falls back to index.html for unknown paths (SPA)", async () => {
    const res = await get("/some/client/route");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("HAL INDEX");
  });

  it("never serves files outside the ui dist", async () => {
    const res = await get("/../hal1000-http-secret.txt");
    const body = await res.text();
    expect(body).not.toContain("secret");
  });

  it("health endpoint responds regardless of static config", async () => {
    const res = await get("/api/health");
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
  });
});
