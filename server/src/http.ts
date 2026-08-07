import http from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { HAL_VERSION } from "../../shared/src/types.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// What the live-preview route needs from the camera. Kept structural so http.ts
// does not depend on the vision module, and so a test can drive it with an
// object literal.
export interface FrameSource {
  onFrame(listener: (jpeg: Buffer) => void): () => void;
  grab(): Buffer | null;
  running: boolean;
}

export interface HttpOptions {
  uiDist: string | null;
  // Absent until Vision is wired in, and null while Vision is off — a preview
  // must not open a camera that the user has not switched on.
  camera?: () => FrameSource | null;
}

const BOUNDARY = "halframe";

// multipart/x-mixed-replace: the oldest trick on the web and the only one an
// <img> can consume with no script at all. The response never ends; each frame
// is another part.
function streamCamera(source: FrameSource, req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    "content-type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    "cache-control": "no-store, no-cache, must-revalidate",
    pragma: "no-cache",
    connection: "close",
  });
  // Node holds the head until the first body write. Without this a viewer that
  // connects between frames gets no response at all until one arrives, which at
  // a slow frame rate reads as a broken image.
  res.flushHeaders();

  const write = (jpeg: Buffer) => {
    // Drop frames rather than queue them when the socket is behind: a preview
    // that buffers is a preview that drifts further from live every second.
    if (res.writableEnded || res.writableLength > 1_000_000) return;
    res.write(`--${BOUNDARY}\r\ncontent-type: image/jpeg\r\ncontent-length: ${jpeg.length}\r\n\r\n`);
    res.write(jpeg);
    res.write("\r\n");
  };

  const first = source.grab();
  if (first) write(first);

  const off = source.onFrame(write);
  const done = () => {
    off();
    if (!res.writableEnded) res.end();
  };
  req.on("close", done);
  req.on("error", done);
  res.on("error", done);
}

export function createHttpServer(opts: HttpOptions): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, app: "hal1000", version: HAL_VERSION }));
      return;
    }

    if (url.pathname === "/api/vision/stream") {
      const source = opts.camera?.() ?? null;
      if (!source) {
        // 503 rather than 404: the route exists, the camera is simply not being
        // held right now because Vision is off.
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "vision is not watching" }));
        return;
      }
      streamCamera(source, req, res);
      return;
    }

    if (opts.uiDist) {
      const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = path.normalize(path.join(opts.uiDist, rel));
      if (file.startsWith(path.normalize(opts.uiDist))) {
        try {
          const body = await fs.readFile(file);
          res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
          res.end(body);
          return;
        } catch {
          // SPA fallback: unknown paths get index.html so client routing works.
          try {
            const index = await fs.readFile(path.join(opts.uiDist, "index.html"));
            res.writeHead(200, { "content-type": MIME[".html"] });
            res.end(index);
            return;
          } catch {
            // fall through to 404
          }
        }
      }
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
}
