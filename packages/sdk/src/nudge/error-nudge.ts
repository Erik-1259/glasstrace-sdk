import { existsSync } from "node:fs";
import { join } from "node:path";
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

  // Production check — suppress silently
  const config = resolveConfig();
  if (isProductionDisabled(config)) {
    return;
  }

  // Check for MCP connection marker file.
  // Guard process.cwd() — it throws ENOENT if the working directory has been removed.
  let markerExists = false;
  try {
    const markerPath = join(process.cwd(), ".glasstrace", "mcp-connected");
    markerExists = existsSync(markerPath);
  } catch {
    // Permission denied, ENOENT from cwd(), or other filesystem error — treat as not connected
    markerExists = false;
  }

  if (markerExists) {
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
