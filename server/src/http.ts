import http from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { HAL_VERSION } from "../../shared/src/types.js";
import { allowsHost, allowsOrigin } from "./origin.js";

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
  // This boot's WS handshake token, stamped into the served index.html.
  wsToken?: string;
}

// Where the token reaches the browser.
//
// Stamped into the HTML this server serves, rather than offered from a route.
// A route guarded by the same origin predicate as the hub would hand the token
// to anything that already passes that predicate, which is the entire set of
// callers the handshake exists to add a second gate for — it would buy nothing.
// Serving it inside the document means only a page this server actually served
// can read it.
//
// Under `npm run dev:ui` the document comes from Vite, not from here, so the
// UI falls back to `/api/ws-token`. That route exists only while the core runs
// under its own dev script — the same condition that already trusts the Vite
// origin, so it widens nothing that is not already open in dev and does not
// exist at all in production.
const TOKEN_GLOBAL = "__HAL_WS_TOKEN__";

function isDevScript(): boolean {
  return process.env.npm_lifecycle_event === "dev";
}

/**
 * Never let a browser keep the document.
 *
 * The bundle is content-hashed and can be cached forever; index.html now
 * carries this boot's handshake token, which makes it the one file that must
 * always come from the server. A cached copy holds a token from a previous boot
 * — or, if it predates the handshake, none at all — and the only symptom is a
 * socket that connects and is immediately closed, with the cause invisible.
 */
function htmlHeaders(isHtml: boolean): Record<string, string> {
  return isHtml ? { "cache-control": "no-store, must-revalidate" } : {};
}

function stampToken(html: string, token: string): string {
  const tag = `<script>window.${TOKEN_GLOBAL}=${JSON.stringify(token)};</script>`;
  // Before the bundle runs, so the client never races the value it needs to
  // connect. Appending is the fallback for a document with no </head> at all.
  return html.includes("</head>") ? html.replace("</head>", `${tag}</head>`) : `${tag}${html}`;
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
  // Named so the request handler can ask the server for its own bound port when
  // checking Host and Origin. Assigned before any request can arrive.
  const server: http.Server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, app: "hal1000", version: HAL_VERSION }));
      return;
    }

    if (url.pathname === "/api/vision/stream") {
      // Binding to loopback is not by itself a defence for this route. DNS
      // rebinding points an attacker-controlled hostname at 127.0.0.1, and any
      // page the user visits can then embed this URL in an <img> and watch the
      // camera. The WS hub already refuses foreign origins for exactly this
      // threat; live video earns at least the same guard, so both call the same
      // predicate rather than keeping two copies that can drift.
      const host = req.headers.host;
      const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
      if (!server || !allowsHost(server, host) || !allowsOrigin(server, origin)) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }

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

    if (url.pathname === "/api/ws-token") {
      // Dev only — see the note beside `stampToken`. In production the token
      // travels inside the document and this route does not answer at all.
      if (!isDevScript() || !opts.wsToken) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const host = req.headers.host;
      const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
      if (!server || !allowsHost(server, host) || !allowsOrigin(server, origin)) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ token: opts.wsToken }));
      return;
    }

    if (opts.uiDist) {
      const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = path.normalize(path.join(opts.uiDist, rel));
      const isHtml = path.extname(file) === ".html";
      if (file.startsWith(path.normalize(opts.uiDist))) {
        try {
          const body = await fs.readFile(file);
          res.writeHead(200, {
            "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
            ...htmlHeaders(isHtml),
          });
          // Only HTML is stamped. Doing this by extension rather than by path
          // keeps the SPA fallback below and the direct hit on the same rule.
          res.end(isHtml && opts.wsToken ? stampToken(body.toString("utf8"), opts.wsToken) : body);
          return;
        } catch {
          // SPA fallback: unknown paths get index.html so client routing works.
          try {
            const index = await fs.readFile(path.join(opts.uiDist, "index.html"), "utf8");
            res.writeHead(200, { "content-type": MIME[".html"], ...htmlHeaders(true) });
            res.end(opts.wsToken ? stampToken(index, opts.wsToken) : index);
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
  return server;
}
