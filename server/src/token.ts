// The per-boot handshake token.
//
// Binding to loopback governs reachability, not trust, and the Origin allowlist
// only narrows the window — `docs/solutions/loopback-binding-is-not-an-origin-check.md`
// and `docs/residual-review-findings/feat-ambient-log-monitors.md` record both
// limits, and the token is the fix all three deferring features owed. What made
// it worth building now: profile text describes named third parties who never
// agreed to be described, which is not the data class the earlier deferrals were
// weighed against.
//
// Per boot rather than persistent. A token that outlives the process is a
// credential to manage; one that dies with it needs no revocation, and the only
// cost is that a client must re-read it after a restart — which it does anyway,
// because the socket dropped.
//
// Written to the data dir because agent-native parity (AGENTS.md) means a
// protocol client must be able to connect without a browser. A token that only
// ever reached the served HTML would close the hub to exactly the callers the
// no-Origin rule was written to keep open.

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const TOKEN_FILE = "ws-token";

export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Mint this boot's token and leave it where a local client can read it.
 *
 * The write is not atomic-through-`storage/atomic.ts` on purpose: this is not
 * user data, a partial read simply fails the handshake, and the next boot
 * overwrites it regardless. What does matter is that it lands before anything
 * can connect, which is why `startApp` awaits this before `listen`.
 */
export async function writeToken(dataDir: string, token: string): Promise<void> {
  await fs.writeFile(path.join(dataDir, TOKEN_FILE), token, "utf8");
}

export function tokenPath(dataDir: string): string {
  return path.join(dataDir, TOKEN_FILE);
}

/**
 * Constant-time compare.
 *
 * The token is local and an attacker who can time this can usually read the
 * file anyway, so this is cheap insurance rather than a load-bearing defence.
 * `timingSafeEqual` throws on a length mismatch, hence the guard.
 */
export function tokenMatches(expected: string, offered: unknown): boolean {
  if (typeof offered !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(offered, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
