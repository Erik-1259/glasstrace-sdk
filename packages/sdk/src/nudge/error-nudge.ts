import { resolveConfig, isProductionDisabled } from "../env-detection.js";

/**
 * Module-level flag ensuring the nudge fires at most once per process.
 */
let hasFired = false;

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
