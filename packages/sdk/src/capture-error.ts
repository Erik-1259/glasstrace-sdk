/**
 * Manual error capture API.
 *
 * Provides a simple function for developers to manually record errors
 * as span events, independent of the `consoleErrors` config flag.
 */

/** Lazily cached OTel API module reference. */
let otelApi: typeof import("@opentelemetry/api") | null = null;

/** Whether we've already attempted to load OTel. */
let otelLoadAttempted = false;

/** Promise for the in-flight OTel load, if any. */
let otelLoadPromise: Promise<void> | null = null;

/**
 * Eagerly loads the OTel API module. Call this during SDK initialization
 * so that `captureError` can resolve spans synchronously.
 *
 * @internal
 */
export async function _preloadOtelApi(): Promise<void> {
  if (otelLoadAttempted) return;
  otelLoadAttempted = true;
  try {
    otelApi = await import("@opentelemetry/api");
  } catch {
    otelApi = null;
  }
}

/**
 * Records an error as a span event on the currently active OTel span.
 *
 * Works regardless of the `consoleErrors` configuration — this is an
 * explicit, opt-in API for manual error reporting. If no span is active
 * or OTel is not available, the call is silently ignored.
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
  // Fast path: OTel already loaded and available
  if (otelApi) {
    recordError(otelApi, error);
    return;
  }

  // OTel not yet available — either not attempted or still loading.
  // Queue the error to be recorded once the import resolves.
  // The span context may be lost across the async boundary, but this
  // is best-effort for calls that arrive before OTel is ready.
  if (!otelLoadAttempted) {
    otelLoadPromise ??= _preloadOtelApi();
  }
  if (otelLoadPromise) {
    void otelLoadPromise.then(() => {
      if (otelApi) {
        recordError(otelApi, error);
      }
    });
  }
}

/**
 * Adds an error event to the active span using the provided OTel API.
 */
function recordError(api: typeof import("@opentelemetry/api"), error: unknown): void {
  try {
    const span = api.trace.getSpan(api.context.active());
    if (!span) return;

    const attributes: Record<string, string> = {
      "error.message": String(error),
    };

    if (error instanceof Error) {
      attributes["error.type"] = error.constructor.name;
    }

    span.addEvent("glasstrace.error", attributes);
  } catch {
    // Silently ignore failures
  }
}

/**
 * Resets internal state. For testing only.
 * @internal
 */
export function _resetCaptureErrorForTesting(): void {
  otelApi = null;
  otelLoadAttempted = false;
  otelLoadPromise = null;
}
