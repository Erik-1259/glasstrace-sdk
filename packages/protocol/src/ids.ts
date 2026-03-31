/**
 * Branded ID types and factory functions for the Glasstrace SDK.
 *
 * These types use Zod's `.brand()` for nominal typing — a plain string
 * won't satisfy a branded type without going through the schema first.
 */

import { z } from "zod";

/**
 * Generate a hex string from random bytes.
 *
 * Uses the Web Crypto API (globalThis.crypto) instead of Node's
 * `Buffer` or `crypto.randomBytes()` so this module works in every
 * JavaScript runtime: Node 20+, browsers, Vercel Edge, and
 * Cloudflare Workers.
 */
function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// --- Branded ID Schemas ---

/** Developer API key: `gt_dev_` + 48 hex chars. */
export const DevApiKeySchema = z
  .string()
  .regex(/^gt_dev_[a-f0-9]{48}$/)
  .brand<"DevApiKey">();
export type DevApiKey = z.infer<typeof DevApiKeySchema>;

/** Anonymous API key: `gt_anon_` + 48 hex chars. */
export const AnonApiKeySchema = z
  .string()
  .regex(/^gt_anon_[a-f0-9]{48}$/)
  .brand<"AnonApiKey">();
export type AnonApiKey = z.infer<typeof AnonApiKeySchema>;

/** Session ID: 16 hex chars (deterministic, derived from API key + time window). */
export const SessionIdSchema = z
  .string()
  .regex(/^[a-f0-9]{16}$/)
  .brand<"SessionId">();
export type SessionId = z.infer<typeof SessionIdSchema>;

/** Build hash: 1-128 chars, alphanumeric + `.` `_` `+` `-`. */
export const BuildHashSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._+\-]+$/)
  // Prevent path traversal — build hashes are used in storage paths
  .refine((value) => value !== "." && value !== ".." && !value.includes(".."), {
    message: "Build hash must not be '.' or '..' and must not contain '..'",
  })
  .brand<"BuildHash">();
export type BuildHash = z.infer<typeof BuildHashSchema>;

// --- Factory Functions ---

/** Generate a new anonymous API key. */
export function createAnonApiKey(): AnonApiKey {
  return AnonApiKeySchema.parse(`gt_anon_${randomHex(24)}`);
}

/** Parse and brand a build hash string. */
export function createBuildHash(hash: string): BuildHash {
  return BuildHashSchema.parse(hash);
}
