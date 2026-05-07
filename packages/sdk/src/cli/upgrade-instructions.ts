#!/usr/bin/env node
import { isAbsolute, relative } from "node:path";
import { MCP_ENDPOINT } from "../mcp-runtime.js";
import { detectAgents } from "../agent-detection/detect.js";
import { generateInfoSection } from "../agent-detection/configs.js";
import {
  hasManagedSection,
  injectInfoSection,
} from "../agent-detection/inject.js";

// Declare the tsup-injected SDK version literal. Replaced at build time
// via `define` in tsup.config.ts. Falls back to "0.0.0-dev" when
// running tests under vitest (no tsup build step).
declare const __SDK_VERSION__: string;

/**
 * Options for {@link runUpgradeInstructions}. The CLI entry point in
 * `init.ts` wires `process.cwd()` through `resolveProjectRoot()` so
 * monorepo roots resolve to the active app directory; tests pass an
 * explicit `projectRoot` for isolation.
 */
export interface UpgradeInstructionsOptions {
  projectRoot: string;
}

/**
 * Result of running the upgrade-instructions command. Returned to the
 * CLI entry point so it can render output without forcing the core
 * logic to call `process.stderr.write` / `process.exit`.
 */
export interface UpgradeInstructionsResult {
  exitCode: number;
  /**
   * Files whose managed Glasstrace section was refreshed in place.
   * Reported as paths relative to {@link UpgradeInstructionsOptions.projectRoot}
   * so the CLI output stays portable across machines and developer
   * homes; an absolute path is returned only when the detected file
   * lives outside the resolved project root (e.g. Windsurf's global
   * config under `$HOME/.codeium/`), where a relative form would be
   * misleading.
   */
  refreshed: string[];
  /**
   * Files inspected that did not contain a managed section, and were
   * therefore left untouched. Reported so the user can verify the
   * command did not accidentally append a block to a hand-written
   * instruction file. Same path-shape rule as
   * {@link UpgradeInstructionsResult.refreshed}.
   */
  skipped: string[];
  /**
   * Soft warnings (e.g. permission errors handled internally by
   * `injectInfoSection`). One line per issue.
   */
  warnings: string[];
  /**
   * Hard errors that prevented the command from completing.
   */
  errors: string[];
}

/**
 * Refreshes the managed Glasstrace MCP section in every detected agent
 * instruction file in the project (DISC-1592 / SDK-050 §Required
 * Semantics Item 2). Idempotent and safe to re-run; the helper only
 * touches files that already contain a marker pair, so a hand-written
 * `CLAUDE.md` without a Glasstrace block is left alone.
 *
 * Multi-file projects are handled in a single run (DISC-1592 §Multi-file
 * projects): the same `detectAgents()` call that scaffolds files at
 * `init` time enumerates every detected agent, and this function
 * refreshes every file with a managed section in one pass.
 *
 * The replace-in-place behaviour works for both legacy unstamped
 * markers (pre-SDK-050) and SDK-050+ stamped markers — see
 * `findMarkerBoundaries` in `inject.ts`.
 *
 * @param options - Project root to operate on. The CLI entry point
 *   resolves monorepo roots before calling this function.
 */
/**
 * Renders an absolute file path in a form suitable for CLI output:
 * relative to `projectRoot` when the file lives inside the tree, or
 * the original absolute path otherwise. Keeps output portable for
 * normal in-tree files (`CLAUDE.md`, `.cursorrules`, `codex.md`) while
 * preserving full paths for out-of-tree targets like Windsurf's
 * global config (`$HOME/.codeium/windsurf/mcp_config.json`), where a
 * relative form (e.g. `../../../../home/.../mcp_config.json`) would
 * be harder to read than the absolute path.
 */
function formatPathForOutput(filePath: string, projectRoot: string): string {
  const rel = relative(projectRoot, filePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return filePath;
  }
  return rel;
}

export async function runUpgradeInstructions(
  options: UpgradeInstructionsOptions,
): Promise<UpgradeInstructionsResult> {
  const refreshed: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  let agents;
  try {
    agents = await detectAgents(options.projectRoot);
  } catch (err) {
    errors.push(
      `Failed to detect agents: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { exitCode: 1, refreshed, skipped, warnings, errors };
  }

  const sdkVersion =
    typeof __SDK_VERSION__ === "string" ? __SDK_VERSION__ : "0.0.0-dev";

  for (const agent of agents) {
    if (agent.infoFilePath === null) {
      // Generic / gemini / windsurf, or detected agent whose info
      // file does not exist on disk — nothing to refresh.
      continue;
    }

    const displayPath = formatPathForOutput(
      agent.infoFilePath,
      options.projectRoot,
    );

    let containsSection: boolean;
    try {
      containsSection = await hasManagedSection(agent.infoFilePath);
    } catch (err) {
      // hasManagedSection swallows read errors and returns false, so
      // this branch is defensive against a future refactor.
      warnings.push(
        `Could not inspect ${displayPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    if (!containsSection) {
      // The agent was detected (marker file present) but the
      // instruction file has no Glasstrace managed section. Refusing
      // to inject prevents `upgrade-instructions` from accidentally
      // adding a Glasstrace block to a project that opted out.
      skipped.push(displayPath);
      continue;
    }

    const content = generateInfoSection(agent, MCP_ENDPOINT, sdkVersion);
    if (content === "") {
      // Defensive — agents whose `infoFilePath` is non-null currently
      // always render content. Belt-and-braces guard against a future
      // mismatch.
      continue;
    }

    try {
      await injectInfoSection(agent, content, options.projectRoot);
      refreshed.push(displayPath);
    } catch (err) {
      errors.push(
        `Failed to refresh ${displayPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const exitCode = errors.length === 0 ? 0 : 1;
  return { exitCode, refreshed, skipped, warnings, errors };
}
