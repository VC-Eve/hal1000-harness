import type http from "node:http";

// Who may drive this server from a browser.
//
// Shared by the WS hub and the camera preview route. It lives in its own module
// because the two surfaces enforcing the same rule from two copies is how they
// drift — and the copy that lags is the one that leaks. The WS hub gained this
// check when `add-monitor` made the protocol capable of running shell commands;
// the preview route needs it because it serves live video of the user.
//
// This narrows the window; it does not shut it. The complete fix is a per-boot
// token — see docs/residual-review-findings/feat-ambient-log-monitors.md.

// Vite's default dev port. Trusted only while the core is running under its own
// `dev` script — `npm run dev:server` sets npm_lifecycle_event to "dev", and
// `npm start` sets it to "start", so production never trusts it.
export const VITE_DEV_ORIGIN = "http://localhost:5173";

function boundPort(server: http.Server): string | null {
  // Read per request rather than at construction: by the time anything connects
  // the server is always listening and its port is known.
  const address = server.address();
  return typeof address === "object" && address ? String(address.port) : null;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * Whether a browser Origin may drive this server.
 *
 * A request with no Origin is not a browser, and a local process already has
 * execution, so refusing it would cost agent-native access (AGENTS.md) while
 * closing nothing.
 */
export function allowsOrigin(server: http.Server, origin?: string): boolean {
  if (!origin) return true;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(url.hostname)) return false;

  // Explicit override for a non-standard dev setup.
  const configured = process.env.HAL_DEV_ORIGIN;
  if (configured && origin === configured) return true;
  if (process.env.npm_lifecycle_event === "dev" && origin === VITE_DEV_ORIGIN) return true;

  const port = boundPort(server);
  return port !== null && url.port === port;
}

/**
 * Whether the Host header names this server on loopback.
 *
 * Binding to 127.0.0.1 does not stop a remote page from reaching the server:
 * DNS rebinding points an attacker-controlled hostname at 127.0.0.1, and the
 * browser then sends that hostname as Host. Checking it is what makes the
 * loopback bind mean what it appears to mean.
 */
export function allowsHost(server: http.Server, host?: string): boolean {
  if (!host) return false;

  let url: URL;
  try {
    url = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(url.hostname)) return false;

  const port = boundPort(server);
  // A hostless port (":9000") or a default-port URL leaves url.port empty; the
  // bound port is the authority either way.
  return port !== null && (url.port === port || url.port === "");
}
