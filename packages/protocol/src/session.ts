/**
 * Session ID derivation — part of the public Glasstrace wire contract.
 *
 * Deriving the session ID is deterministic: given the same inputs,
 * every runtime that implements this module produces the same
 * 16-character hex identifier. That determinism is the contract — it
 * lets independent clients (SDK, browser extension, server tooling)
 * agree on the same session without coordination.
 *
 * This module is pure: it has no module-level state and no
 * runtime-dependent branches. It is safe to import from Node 20+,
 * modern browsers, Vercel Edge, and Cloudflare Workers. The SHA-256
 * implementation is pure JavaScript; no `node:crypto`, no Web Crypto,
 * no bundler-specific shims.
 */

import { SessionIdSchema } from "./ids.js";
import type { SessionId } from "./ids.js";
import { sha256Hex } from "./sha256.js";

/**
 * Derives a deterministic session ID from the inputs that define a
 * Glasstrace session. The output is a 16-character lowercase hex
 * string validated through {@link SessionIdSchema}.
 *
 * This function is part of the Glasstrace wire contract: any consumer
 * (SDK, browser extension, server tooling) that calls it with the same
 * arguments receives the same `SessionId`. That property is what lets
 * independent clients agree on a session without coordination.
 *
 * Uses a pure-JavaScript SHA-256 so the output is identical across
 * every runtime this package supports (Node 20+, modern browsers,
 * Vercel Edge, Cloudflare Workers).
 *
 * Security note: the session ID is an **identifier**, not a secret or
 * an authentication token. It is never used for authorization.
 *
 * @param apiKey - The project's API key (or anonymous placeholder).
 * @param origin - The origin string identifying the deployment
 *   environment (for example `localhost:3000` or `production`).
 * @param date - UTC date as `YYYY-MM-DD`.
 * @param windowIndex - Zero-based index of the 4-hour activity window
 *   within the day.
 * @returns A 16-character hex {@link SessionId}.
 *
 * @drift-check ../glasstrace-product/docs/product-spec.md §4.5 Session Lifecycle
 */
export function deriveSessionId(
  apiKey: string,
  origin: string,
  date: string,
  windowIndex: number,
): SessionId {
  const input = JSON.stringify([apiKey, origin, date, windowIndex]);
  const digest = sha256Hex(input).slice(0, 16);
  return SessionIdSchema.parse(digest);
}
