// The HTTP surface. Two routes, no framework — `server/` runs on `ws` and
// nothing else, and one endpoint plus a health check does not earn a
// dependency.

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { RecogniserConfig } from "./config.js";
import { FrameError } from "./frame.js";
import { BusyError, Pipeline } from "./pipeline.js";

// `/health` names the service. A liveness probe answers "is something
// listening", never "is this mine" —
// `docs/solutions/diagnosing-a-process-that-isnt-your-code.md` records four
// instances of that lesson, most recently a probe satisfied by a previous
// run's process still holding the port, which then screenshotted a stale build
// and wrote PNGs that looked exactly like proof. A caller that gets a 200 from
// something else on 8100 must be able to tell.
export const SERVICE_ID = "hal1000-recogniser";

export interface Running {
  port: number;
  close(): Promise<void>;
}

export function createServer(config: RecogniserConfig, pipeline: Pipeline): http.Server {
  return http.createServer((req, res) => {
    handle(req, res, config, pipeline).catch((err: unknown) => {
      // Fire-and-forget handlers must catch; an unhandled rejection here takes
      // the whole sidecar down and HAL sees "unreachable" for a bad frame.
      if (!res.headersSent) send(res, 500, { error: (err as Error).message });
    });
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: RecogniserConfig,
  pipeline: Pipeline,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    const states = pipeline.states();
    send(res, 200, {
      service: SERVICE_ID,
      version: 1,
      detector: states.detector,
      embedder: states.embedder,
    });
    return;
  }

  if (url.pathname === "/detect") {
    if (req.method !== "POST") {
      send(res, 405, { error: "POST a JPEG frame to /detect." });
      return;
    }
    const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "image/jpeg") {
      send(res, 415, { error: "Frames must be sent as image/jpeg." });
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(req, config.maxFrameBytes);
    } catch (err) {
      if (err instanceof PayloadTooLarge) {
        // The response has to reach the client before the socket goes. An
        // earlier version destroyed the request as soon as the limit tripped,
        // and the caller saw a hang-up — indistinguishable from a recogniser
        // that is not running, which is precisely the confusion
        // `captioner.ts` takes trouble to avoid between slow and missing.
        send(res, 413, { error: err.message, condition: "frame-too-large" }, true);
        res.on("finish", () => req.destroy());
        return;
      }
      send(res, 400, { error: (err as Error).message });
      return;
    }

    try {
      send(res, 200, await pipeline.detect(body));
    } catch (err) {
      if (err instanceof BusyError) {
        // Distinct from unreachable and distinct from broken: the process is
        // healthy and already working. `captioner.ts` draws the same line
        // between a model that is slow and a model that is missing.
        send(res, 503, { error: err.message, condition: "busy" });
        return;
      }
      if (err instanceof FrameError) {
        send(res, 400, { error: err.message, condition: "undecodable-frame" });
        return;
      }
      send(res, 500, { error: (err as Error).message });
    }
    return;
  }

  send(res, 404, { error: `No route for ${req.method} ${url.pathname}.` });
}

class PayloadTooLarge extends Error {}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let stopped = false;
    req.on("data", (chunk: Buffer) => {
      if (stopped) return;
      size += chunk.length;
      // Rejected before decode, so an oversized body cannot exhaust memory
      // ahead of the JPEG header being read. Accumulation stops here; the
      // socket is closed by the handler once the 413 has been written.
      if (size > limit) {
        stopped = true;
        chunks.length = 0;
        reject(new PayloadTooLarge(`A frame may not exceed ${limit} bytes.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!stopped) resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (!stopped) reject(err);
    });
  });
}

function send(res: http.ServerResponse, status: number, body: unknown, close = false): void {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload)),
  };
  if (close) headers["connection"] = "close";
  res.writeHead(status, headers);
  res.end(payload);
}

export function listen(server: http.Server, config: RecogniserConfig): Promise<Running> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.removeListener("error", reject);
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}
