import { SessionIdSchema } from "@glasstrace/protocol";
import type { SessionId } from "@glasstrace/protocol";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

/**
 * Lazy-loaded hash function. Uses Node.js `node:crypto` when available,
 * falling back to a deterministic non-cryptographic hash (FNV-1a) in
 * environments where `node:crypto` cannot be resolved (Edge Runtime,
 * browser bundles).
 *
 * Session IDs are identifiers, not security-sensitive values, so a
 * non-cryptographic hash is acceptable as a fallback.
 */
let hashFn: ((input: string) => string) | null = null;

/**
 * FNV-1a hash producing an 8-character hex string.
 * Used as a fallback when `node:crypto` is unavailable.
 * Not cryptographically secure, but deterministic and fast.
 */
function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
    hash >>>= 0; // keep unsigned 32-bit
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Returns a hash function, resolving `node:crypto` on first call.
 * Thread-safe: worst case two calls both resolve — same result either way.
 */
function getHashFn(): (input: string) => string {
  if (hashFn) return hashFn;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    hashFn = (input: string) =>
      createHash("sha256").update(input).digest("hex").slice(0, 16);
  } catch {
    // node:crypto unavailable — use FNV-1a fallback.
    // Pad to 16 chars by double-hashing the first and second halves.
    hashFn = (input: string) => {
      const h1 = fnv1aHash(input);
      const h2 = fnv1aHash(input + "\0");
      return (h1 + h2).slice(0, 16);
    };
  }

  return hashFn;
}

/** Cached at module load to avoid reading process.env on every span. */
let cachedGlasstraceEnv: string | undefined = process.env.GLASSTRACE_ENV;
let cachedPort: string = process.env.PORT ?? "3000";

/**
 * Re-reads cached environment variables. For testing only.
 */
export function _resetEnvCacheForTesting(): void {
  cachedGlasstraceEnv = process.env.GLASSTRACE_ENV;
  cachedPort = process.env.PORT ?? "3000";
}

/**
 * Resets the lazy-loaded hash function. For testing only.
 * @internal
 */
export function _resetHashFnForTesting(): void {
  hashFn = null;
}

/**
 * Forces the fallback (FNV-1a) hash function. For testing only.
 * @internal
 */
export function _useFallbackHashForTesting(): void {
  hashFn = (input: string) => {
    const h1 = fnv1aHash(input);
    const h2 = fnv1aHash(input + "\0");
    return (h1 + h2).slice(0, 16);
  };
}

/**
 * Derives a deterministic session ID from the given inputs.
 * Uses SHA-256 (truncated to 16 hex chars) when `node:crypto` is available,
 * or a deterministic FNV-1a hash as a fallback in non-Node environments.
 *
 * @param apiKey - The project's API key (or anonymous placeholder).
 * @param origin - The origin string identifying the deployment environment.
 * @param date - UTC date as YYYY-MM-DD.
 * @param windowIndex - Zero-based index of the 4-hour activity window within the day.
 * @returns A 16-character hex SessionId.
 */
export function deriveSessionId(
  apiKey: string,
  origin: string,
  date: string,
  windowIndex: number,
): SessionId {
  const input = JSON.stringify([apiKey, origin, date, windowIndex]);
  const hash = getHashFn()(input);
  return SessionIdSchema.parse(hash);
}

/**
 * Returns the origin string for the current process.
 * If GLASSTRACE_ENV is set, returns that value.
 * Otherwise returns `localhost:{PORT}` (PORT defaults to 3000).
 *
 * @returns The origin string used as a session derivation input.
 */
export function getOrigin(): string {
  if (cachedGlasstraceEnv) {
    return cachedGlasstraceEnv;
  }
  return `localhost:${cachedPort}`;
}

/**
 * Returns the current UTC date as a YYYY-MM-DD string.
 *
 * @returns The UTC date formatted as "YYYY-MM-DD".
 */
export function getDateString(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Tracks the current session state with 4-hour window tracking.
 * Instantiated once by the orchestrator.
 */
export class SessionManager {
  private windowIndex: number = 0;
  private lastActivityTimestamp: number = 0;
  private lastDate: string = "";
  private lastApiKey: string = "";
  private currentSessionId: SessionId | null = null;

  /**
   * Returns the current session ID, deriving a new one if:
   * - More than 4 hours have elapsed since last activity
   * - The UTC date has changed (resets window index to 0)
   * - The API key has changed (e.g., deferred anonymous key swap)
   * - This is the first call
   *
   * @param apiKey - The project's API key used in session derivation.
   * @returns The current or newly derived SessionId.
   */
  getSessionId(apiKey: string): SessionId {
    const now = Date.now();
    const currentDate = getDateString();
    const origin = getOrigin();

    const elapsed = now - this.lastActivityTimestamp;
    const dateChanged = currentDate !== this.lastDate;
    const apiKeyChanged = apiKey !== this.lastApiKey;

    if (dateChanged) {
      // New UTC day: reset window index
      this.windowIndex = 0;
      this.lastDate = currentDate;
      this.lastApiKey = apiKey;
      this.currentSessionId = deriveSessionId(apiKey, origin, currentDate, this.windowIndex);
    } else if (apiKeyChanged) {
      // API key changed (e.g., anonymous key resolved): re-derive with same window
      this.lastApiKey = apiKey;
      this.currentSessionId = deriveSessionId(apiKey, origin, currentDate, this.windowIndex);
    } else if (this.currentSessionId === null || elapsed > FOUR_HOURS_MS) {
      // First call or gap exceeding 4 hours: increment window
      if (this.currentSessionId !== null) {
        this.windowIndex++;
      }
      this.lastApiKey = apiKey;
      this.currentSessionId = deriveSessionId(apiKey, origin, currentDate, this.windowIndex);
      this.lastDate = currentDate;
    }

    this.lastActivityTimestamp = now;
    return this.currentSessionId;
  }
}
