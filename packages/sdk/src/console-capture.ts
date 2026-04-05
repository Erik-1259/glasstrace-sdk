/**
 * Console error/warn capture module.
 *
 * When enabled, monkey-patches `console.error` and `console.warn` to record
 * their output as OTel span events on the currently active span. SDK-internal
 * log messages (prefixed with "[glasstrace]") are never captured.
 */

/**
 * Module-level flag to suppress capture of SDK-internal log messages.
 * Set to `true` before calling `console.warn`/`console.error` from SDK code,
 * then reset to `false` immediately after.
 */
export let isGlasstraceLog = false;

/** Saved reference to the original `console.error`. */
let originalError: typeof console.error | null = null;

/** Saved reference to the original `console.warn`. */
let originalWarn: typeof console.warn | null = null;

/** Whether the console capture is currently installed. */
let installed = false;

/** Cached OTel API module reference, resolved at install time. */
let otelApi: typeof import("@opentelemetry/api") | null = null;

/**
 * Formats console arguments into a single string for span event attributes.
 * Mirrors the behavior of `console.log` argument concatenation.
 */
function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.stack ?? arg.message;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

/**
 * Returns `true` if the first argument is a string starting with "[glasstrace]".
 * Used to skip capture of SDK-internal log messages without requiring every
 * call site to set the `isGlasstraceLog` flag.
 */
function isSdkMessage(args: unknown[]): boolean {
  return typeof args[0] === "string" && args[0].startsWith("[glasstrace]");
}

/**
 * Installs console capture by replacing `console.error` and `console.warn`
 * with wrappers that record span events on the active OTel span.
 *
 * Must be called after OTel is configured so the API module is available.
 * Safe to call multiple times; subsequent calls are no-ops.
 */
export async function installConsoleCapture(): Promise<void> {
  if (installed) return;

  // Resolve OTel API once at install time. If unavailable, the wrappers
  // will simply call through to the original console methods.
  try {
    otelApi = await import("@opentelemetry/api");
  } catch {
    otelApi = null;
  }

  originalError = console.error;
  originalWarn = console.warn;
  installed = true;

  console.error = (...args: unknown[]) => {
    // Always call the original first to preserve developer experience
    originalError!.apply(console, args);

    // Skip SDK-internal messages and flagged messages
    if (isGlasstraceLog || isSdkMessage(args)) return;

    if (otelApi) {
      const span = otelApi.trace.getSpan(otelApi.context.active());
      if (span) {
        span.addEvent("console.error", {
          "console.message": formatArgs(args),
        });
      }
    }
  };

  console.warn = (...args: unknown[]) => {
    originalWarn!.apply(console, args);

    if (isGlasstraceLog || isSdkMessage(args)) return;

    if (otelApi) {
      const span = otelApi.trace.getSpan(otelApi.context.active());
      if (span) {
        span.addEvent("console.warn", {
          "console.message": formatArgs(args),
        });
      }
    }
  };
}

/**
 * Restores the original `console.error` and `console.warn` methods.
 * Primarily intended for use in tests.
 */
export function uninstallConsoleCapture(): void {
  if (!installed) return;

  if (originalError) console.error = originalError;
  if (originalWarn) console.warn = originalWarn;

  originalError = null;
  originalWarn = null;
  otelApi = null;
  installed = false;
}

/**
 * Logs a message from SDK-internal code without triggering console capture.
 *
 * Use this helper in new SDK code instead of bare `console.warn(...)` calls
 * to prevent SDK log messages from being recorded as user-facing span events.
 *
 * @param level - The console log level to use.
 * @param message - The message to log.
 */
export function sdkLog(level: "warn" | "info" | "error", message: string): void {
  isGlasstraceLog = true;
  try {
    console[level](message);
  } finally {
    isGlasstraceLog = false;
  }
}
