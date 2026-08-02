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

export interface HttpOptions {
  uiDist: string | null;
}

export function createHttpServer(opts: HttpOptions): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, app: "hal1000", version: HAL_VERSION }));
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
