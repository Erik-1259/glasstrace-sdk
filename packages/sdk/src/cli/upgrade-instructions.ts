#!/usr/bin/env node
import { isAbsolute, join, relative } from "node:path";
import { MCP_ENDPOINT } from "../mcp-runtime.js";
import { detectAgents } from "../agent-detection/detect.js";
import { hasManagedSection } from "../agent-detection/inject.js";
import { injectAllTargets } from "../agent-detection/inject-all-targets.js";
import type { DetectedAgent } from "../agent-detection/detect.js";

/**
 * Per-agent legacy destinations that may carry a pre-Wave-18 managed
 * section. Used by the upgrade-instructions opted-in gate to detect
 * users who installed via an older SDK and need their managed section
 * migrated to the Wave 18 canonical destinations.
 */
function legacyDestinationsForAgent(
  name: DetectedAgent["name"],
  projectRoot: string,
): string[] {
  switch (name) {
    case "codex":
      return [join(projectRoot, "codex.md")];
    case "cursor":
      return [join(projectRoot, ".cursorrules")];
    case "windsurf":
      return [join(projectRoot, ".windsurfrules")];
    case "claude":
    case "gemini":
    case "generic":
      return [];
  }
}

/**
 * Returns true if any of the candidate file paths contains a managed
 * section. Walks each candidate via `hasManagedSection`; aggregates
 * the result.
 */
async function anyHasManagedSection(paths: string[]): Promise<boolean> {
  for (const p of paths) {
    if (await hasManagedSection(p)) {
      return true;
    }
  }
  return false;
}

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
 * normal in-tree files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`,
 * `.cursor/rules/glasstrace.mdc`, `.windsurf/rules/glasstrace.md`, plus
 * legacy `.cursorrules` / `codex.md` / `.windsurfrules`) while
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
      // Detected agent with no canonical infoFilePath — nothing to
      // refresh. (Pre-Wave-18 this branch covered Gemini / Windsurf /
      // generic which had `infoFilePath: null`; Wave 18 wires all six
      // agents to a non-null canonical destination, so in practice
      // this guard is now defensive.)
      continue;
    }

    const displayPath = formatPathForOutput(
      agent.infoFilePath,
      options.projectRoot,
    );

    // Wave 18: refresh-gate semantics broadened.
    //
    // The pre-Wave-18 logic refused to inject when the canonical
    // `agent.infoFilePath` had no managed section (preserving opt-out
    // for users who deleted CLAUDE.md content). After Wave 18 the
    // canonical destinations changed (Codex `codex.md` → `AGENTS.md`;
    // Cursor `.cursorrules` → `.cursor/rules/glasstrace.mdc`; etc.),
    // so the new canonical file usually does NOT have a managed
    // section yet for legacy users — but the LEGACY file does, and
    // those users intend to migrate. Check both: the canonical 2026
    // destination AND the agent's known legacy destinations. If
    // either has a managed section the user has opted in; refresh
    // proceeds. If neither has one, the user opted out; skip.
    const legacyDestinations = legacyDestinationsForAgent(
      agent.name,
      options.projectRoot,
    );
    let optedIn: boolean;
    try {
      optedIn = await anyHasManagedSection([
        agent.infoFilePath,
        ...legacyDestinations,
      ]);
    } catch (err) {
      warnings.push(
        `Could not inspect ${displayPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    if (!optedIn) {
      // No managed section in any known destination — user opted out
      // (or never installed). Refusing to inject prevents
      // `upgrade-instructions` from adding a Glasstrace block to a
      // project that doesn't want one.
      skipped.push(displayPath);
      continue;
    }
  }

  // Wave 18: refresh via `injectAllTargets` (multi-target dispatcher).
  // Detected agents that survive the per-agent opted-in gate above
  // will have their full Wave 18 destination set written here. The
  // gate above only filtered the loop into `skipped` for agents with
  // no managed section anywhere; surviving agents pass through to
  // this single hoisted dispatch which writes to canonical 2026
  // destinations + AGENTS.md companion + Cursor `.cursorrules`
  // transitional fallback, deduplicating AGENTS.md across agents.
  const optedInAgents = agents.filter(
    (a) => a.infoFilePath !== null && !skipped.includes(
      formatPathForOutput(a.infoFilePath, options.projectRoot),
    ),
  );
  if (optedInAgents.length > 0) {
    try {
      await injectAllTargets(
        optedInAgents,
        MCP_ENDPOINT,
        sdkVersion,
        options.projectRoot,
      );
      for (const a of optedInAgents) {
        if (a.infoFilePath !== null) {
          refreshed.push(formatPathForOutput(a.infoFilePath, options.projectRoot));
        }
      }
    } catch (err) {
      errors.push(
        `Failed to refresh agent-instruction files: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const exitCode = errors.length === 0 ? 0 : 1;
  return { exitCode, refreshed, skipped, warnings, errors };
}
