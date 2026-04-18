import { resolveConfig, isProductionDisabled } from "../env-detection.js";

/**
 * Module-level flag ensuring the MCP-connection nudge fires at most once
 * per process.
 */
let hasFired = false;

/**
 * Module-level flag ensuring the Server Action nudge fires at most once
 * per process (DISC-1253).
 */
let hasFiredServerAction = false;

/**
 * Strips control characters (except space) from a string to prevent
 * terminal escape sequence injection via error summaries written to stderr.
 */
function sanitize(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\x00-\x1f\x7f]/g, "");
}

/**
 * Checks whether the MCP marker file exists using synchronous filesystem
 * APIs. Returns `false` when `node:fs` or `node:path` cannot be resolved
 * (non-Node environments) or on any I/O error.
 */
function markerFileExists(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    const markerPath = path.join(process.cwd(), ".glasstrace", "mcp-connected");
    return fs.existsSync(markerPath);
  } catch {
    // node:fs/node:path unavailable, permission denied, ENOENT from
    // cwd(), or other error — treat as not connected
    return false;
  }
}

/**
 * Shows a one-time stderr nudge when the SDK captures its first error
 * and the MCP connection marker file is absent.
 *
 * The nudge is suppressed when:
 * - It has already fired in this process
 * - The `.glasstrace/mcp-connected` marker file exists at the project root
 * - The environment is detected as production (and force-enable is off)
 *
 * Uses `process.stderr.write()` instead of `console.error()` to avoid
 * being captured by OpenTelemetry console instrumentation.
 */
export function maybeShowMcpNudge(errorSummary: string): void {
  if (hasFired) {
    return;
  }

  // Production check — suppress silently, but remember the decision
  // so subsequent calls fast-exit via hasFired without re-running I/O.
  const config = resolveConfig();
  if (isProductionDisabled(config)) {
    hasFired = true;
    return;
  }

  // Check for MCP connection marker file.
  if (markerFileExists()) {
    hasFired = true;
    return;
  }

  // Fire the nudge exactly once
  hasFired = true;

  const safe = sanitize(errorSummary);
  process.stderr.write(
    `[glasstrace] Error captured: ${safe}\n` +
      `  Debug with AI: ask your agent "What's the latest Glasstrace error?"\n` +
      `  Not connected? Run: npx glasstrace mcp add\n`,
  );
}

/**
 * Shows a one-time stderr nudge when the SDK detects a Next.js Server
 * Action trace whose originating request had no Glasstrace browser
 * extension correlation header (`x-gt-cid`) — meaning the extension was
 * not active for that request and the specific Server Action identifier
 * could not be captured (DISC-1253).
 *
 * The nudge is suppressed when:
 * - It has already fired in this process
 * - The environment is detected as production (and force-enable is off)
 * - `GLASSTRACE_SUPPRESS_ACTION_NUDGE=1` is set
 *
 * Routes through `process.stderr.write()` — identical transport to the
 * existing MCP nudge — so it is not captured by OpenTelemetry console
 * instrumentation and plays nicely with existing error-nudge tests.
 */
export function maybeShowServerActionNudge(): void {
  if (hasFiredServerAction) {
    return;
  }

  // User opt-out takes precedence over every other check so we never
  // re-run I/O when silenced.
  if (process.env.GLASSTRACE_SUPPRESS_ACTION_NUDGE === "1") {
    hasFiredServerAction = true;
    return;
  }

  // Production check — suppress silently, but remember the decision so
  // subsequent calls fast-exit via hasFiredServerAction without re-running
  // resolveConfig.
  const config = resolveConfig();
  if (isProductionDisabled(config)) {
    hasFiredServerAction = true;
    return;
  }

  hasFiredServerAction = true;

  process.stderr.write(
    `[glasstrace] Detected a Next.js Server Action trace. Install the ` +
      `Glasstrace browser extension to capture the Server Action identifier ` +
      `for precise action-level debugging. https://glasstrace.dev/ext\n`,
  );
}

/**
 * Test-only hook: resets both nudge guards so independent tests can
 * reload module state without relying on `vi.resetModules()` side effects.
 * Kept internal — not exported from the SDK barrel.
 */
export function __resetNudgeStateForTests(): void {
  hasFired = false;
  hasFiredServerAction = false;
}
