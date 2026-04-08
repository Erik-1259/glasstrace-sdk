/**
 * Manual error capture API.
 *
 * Provides a simple function for developers to manually record errors
 * as span events, independent of the `consoleErrors` config flag.
 */

import * as otelApi from "@opentelemetry/api";
import { maybeShowMcpNudge } from "./nudge/error-nudge.js";

/**
 * Records an error as a span event on the currently active OTel span.
 *
 * Works regardless of the `consoleErrors` configuration — this is an
 * explicit, opt-in API for manual error reporting. If no span is active
 * or OTel is not available, the call is silently ignored.
 *
 * On the first captured error, may display a one-time diagnostic nudge
 * to stderr if the MCP connection marker is absent (dev environments only).
 *
 * @param error - The error to capture. Accepts `Error` objects, strings, or any value.
 *
 * @example
 * ```ts
 * import { captureError } from "@glasstrace/sdk";
 *
 * try {
 *   await riskyOperation();
 * } catch (err) {
 *   captureError(err);
 *   // handle error normally...
 * }
 * ```
 */
export function captureError(error: unknown): void {
  try {
    const span = otelApi.trace.getSpan(otelApi.context.active());
    if (!span) return;

    const attributes: Record<string, string> = {
      "error.message": String(error),
    };

    if (error instanceof Error) {
      attributes["error.type"] = error.constructor.name;
    }

    span.addEvent("glasstrace.error", attributes);

    // Show one-time MCP connection nudge on first captured error
    maybeShowMcpNudge(String(error));
  } catch {
    // Silently ignore failures
  }
}

/**
 * Eagerly loads the OTel API module. Previously required for async resolution;
 * now a no-op since OTel is statically imported. Retained for test compatibility.
 *
 * @internal
 */
export async function _preloadOtelApi(): Promise<void> {
  // No-op: OTel API is now statically imported and always available.
}

/**
 * Resets internal state. For testing only.
 * @internal
 */
export function _resetCaptureErrorForTesting(): void {
  // No-op: OTel API is now statically imported and always available.
  // Kept for backward compatibility with existing tests.
}
