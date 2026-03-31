import { createHash } from "node:crypto";
import { SessionIdSchema } from "@glasstrace/protocol";
import type { SessionId } from "@glasstrace/protocol";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

/**
 * Derives a deterministic session ID from the given inputs using SHA-256.
 * The hash is truncated to 16 hex characters and parsed through SessionIdSchema.
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
  const hash = createHash("sha256").update(input).digest("hex").slice(0, 16);
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
  if (process.env.GLASSTRACE_ENV) {
    return process.env.GLASSTRACE_ENV;
  }
  const port = process.env.PORT ?? "3000";
  return `localhost:${port}`;
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
