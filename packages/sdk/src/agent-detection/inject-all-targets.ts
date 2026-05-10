import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DetectedAgent } from "./detect.js";
import {
  generateInfoSection,
  generateInfoSectionForCursorMdc,
  generateInfoSectionForCursorrulesLegacy,
} from "./configs.js";
import { findMarkerBoundaries } from "./inject.js";

/**
 * Wave 18 multi-target write dispatcher.
 *
 * Per DISC-1782 (P1 design_correction, 2026-05-09): the SDK's
 * agent-instruction injection writes the Glasstrace MCP managed
 * section to deprecated/wrong/missing filenames for nearly every
 * supported agent except Claude Code, and never writes to the
 * cross-tool `AGENTS.md` standard governed by the Agentic AI
 * Foundation under the Linux Foundation. Wave 18 corrects this by
 * routing every detected agent through this multi-target helper,
 * which writes to:
 *
 *   - Claude Code:  CLAUDE.md (primary)         + AGENTS.md (companion)
 *   - Codex CLI:    AGENTS.md (sole — `codex.md` retired)
 *   - Gemini CLI:   GEMINI.md (primary)         + AGENTS.md (companion)
 *   - Cursor:       .cursor/rules/glasstrace.mdc (canonical)
 *                   + .cursorrules (transitional fallback, unconditional)
 *                   + AGENTS.md (companion)
 *   - Windsurf:     .windsurf/rules/glasstrace.md (workspace-rules)
 *                   + AGENTS.md (companion — Windsurf reads both)
 *   - Generic:      AGENTS.md (sole, universal cross-tool fallback)
 *
 * AGENTS.md is deduplicated across multi-agent detection: a project
 * with both `.claude/` and `.cursor/` markers will detect TWO agents
 * (Claude Code + Cursor) but produce ONE AGENTS.md write, not two.
 *
 * **Failure semantics: fail-loud-per-target, non-atomic, all error
 * classes.** If write-to-target-N fails for any reason — permission
 * denied (EACCES/EPERM), read-only filesystem (EROFS), disk full
 * (ENOSPC), path too long (ENAMETOOLONG, common on Windows with
 * deeply nested project paths), I/O error, etc. — log a per-target
 * stderr warning naming the target path and the error kind, and
 * CONTINUE to the remaining targets. This is the broadened
 * fail-loud policy from the wave's 350-pass adversarial review
 * (finding 350-O8) — the prior `isPermissionError` path covered only
 * permission-class errors. Atomic rollback across targets is
 * explicitly OUT OF SCOPE for Wave 18 (track via closeout-gate).
 *
 * **Silent on success.** Successful writes produce no stdout/stderr
 * output. Only failures emit warnings. The SDK runs at user-runtime
 * load and verbose per-write logging would constitute log spam
 * across the user base.
 *
 * **Marker contract preserved.** All targets use the SDK-050 /
 * DISC-1592 / DISC-1602 marker contract for idempotent in-place
 * replacement on re-runs. Markdown-family destinations (CLAUDE.md,
 * AGENTS.md, GEMINI.md, .windsurf/rules/glasstrace.md, the body of
 * .cursor/rules/glasstrace.mdc) use HTML comment markers; the legacy
 * .cursorrules destination uses hash-prefix markers preserved from
 * the SDK-050 contract for backward-compat with already-rendered
 * managed sections.
 *
 * @param agents - All detected agents (typically the result of
 *   `detectAgents()`). The helper iterates each, dispatches to its
 *   per-agent target set, and dedupes AGENTS.md across the iteration.
 * @param endpoint - The Glasstrace MCP endpoint URL (currently
 *   validated for non-emptiness; not inlined in the body).
 * @param sdkVersion - The SDK semver string for the marker stamp.
 * @param projectRoot - The project root, used to compute companion
 *   AGENTS.md path when the per-agent rule didn't already point at it.
 */
export async function injectAllTargets(
  agents: DetectedAgent[],
  endpoint: string,
  sdkVersion: string,
  projectRoot: string,
): Promise<void> {
  // Track AGENTS.md paths we've already written to so multi-agent
  // detection doesn't write the same file twice. Keyed by absolute
  // path string (already resolved by `detect.ts`).
  const writtenAgentsMd = new Set<string>();

  for (const agent of agents) {
    const targets = computeTargets(agent, projectRoot);

    for (const target of targets) {
      // Skip a duplicate AGENTS.md if another agent in the same
      // detection already wrote to it.
      if (target.isAgentsMdCompanion) {
        if (writtenAgentsMd.has(target.path)) {
          continue;
        }
        writtenAgentsMd.add(target.path);
      }

      // For cursor-mdc, emit the YAML frontmatter ONLY when creating
      // the file from scratch — appending it verbatim to an existing
      // mdc that has no markers would produce a duplicate `---` block
      // mid-file and corrupt the rule shape (Codex P2 review of v4).
      // The marker contract anchors on the managed-section markers
      // alone; user-customized frontmatter above the managed section
      // is preserved across re-renders. The managed section itself
      // (markers + body, no frontmatter) is identical across all
      // three file states (create / append / in-place replace), so
      // the frontmatter is a "create-only prefix" handed to the write
      // helper separately.
      let createContent: string;
      let managedSectionOnly: string;
      if (target.kind === "cursor-mdc") {
        createContent = generateInfoSectionForCursorMdc(endpoint, sdkVersion);
        // Same body but without the frontmatter wrapper — used when
        // appending to an existing mdc that already has its own
        // frontmatter.
        managedSectionOnly = generateInfoSection(agent, endpoint, sdkVersion);
      } else if (target.kind === "cursorrules-legacy") {
        createContent = generateInfoSectionForCursorrulesLegacy(
          endpoint,
          sdkVersion,
        );
        managedSectionOnly = createContent;
      } else {
        createContent = generateInfoSection(agent, endpoint, sdkVersion);
        managedSectionOnly = createContent;
      }

      if (managedSectionOnly === "") continue;

      await writeManagedSectionToTarget(
        target.path,
        createContent,
        managedSectionOnly,
      );
    }
  }
}

interface WriteTarget {
  path: string;
  /**
   * Discriminator the dispatcher uses to pick the right rendering:
   * - "primary": render via `generateInfoSection(agent, ...)` using
   *   the agent's existing per-agent format dispatch.
   * - "agents-md-companion": same content as primary (htmlMarkers)
   *   but written to a different file; rendered via the agent's own
   *   dispatch (the configs.ts switch routes Markdown-family agents
   *   to htmlMarkers, which is correct for AGENTS.md too).
   * - "cursor-mdc": render via `generateInfoSectionForCursorMdc` to
   *   prepend YAML frontmatter.
   * - "cursorrules-legacy": render via
   *   `generateInfoSectionForCursorrulesLegacy` with hash-prefix
   *   markers preserved from the SDK-050 contract.
   */
  kind: "primary" | "agents-md-companion" | "cursor-mdc" | "cursorrules-legacy";
  isAgentsMdCompanion: boolean;
}

/**
 * Derive the agent's `foundDir` (the directory `detectAgents` resolved
 * the marker in, after walking up to the git root for monorepo
 * support) from `agent.infoFilePath`. The companion AGENTS.md write
 * AND the Cursor `.cursorrules` transitional fallback MUST resolve
 * against this foundDir, not against `projectRoot` — for monorepos
 * where the SDK is initialized in a subdirectory but the agent
 * markers live at the git root, `projectRoot` is the wrong parent
 * (Codex P2 review of v6).
 *
 * Returns null when `agent.infoFilePath` is null (defensive — Wave 18
 * AGENT_RULES wires every agent to a non-null `infoFilePath`, so in
 * practice this never returns null).
 */
function foundDirFromAgent(agent: DetectedAgent): string | null {
  if (agent.infoFilePath === null) return null;
  switch (agent.name) {
    case "claude":
    case "codex":
    case "gemini":
    case "generic":
      // infoFilePath is `<foundDir>/<canonical-filename>` — one
      // dirname call gets to foundDir.
      return dirname(agent.infoFilePath);
    case "cursor":
      // infoFilePath is `<foundDir>/.cursor/rules/glasstrace.mdc` —
      // three dirname calls strip `.cursor/rules/glasstrace.mdc`.
      return dirname(dirname(dirname(agent.infoFilePath)));
    case "windsurf":
      // infoFilePath is `<foundDir>/.windsurf/rules/glasstrace.md` —
      // three dirname calls strip `.windsurf/rules/glasstrace.md`.
      return dirname(dirname(dirname(agent.infoFilePath)));
  }
}

function computeTargets(
  agent: DetectedAgent,
  projectRoot: string,
): WriteTarget[] {
  const targets: WriteTarget[] = [];

  // Resolve the companion AGENTS.md (and Cursor `.cursorrules`
  // transitional fallback) against the agent's foundDir — the
  // directory `detectAgents` walked up to. Falls back to projectRoot
  // only when foundDir cannot be derived (defensive; should not
  // happen in Wave 18). Codex P2 review of v6.
  const foundDir = foundDirFromAgent(agent) ?? projectRoot;

  switch (agent.name) {
    case "claude": {
      // Primary: CLAUDE.md (per-agent canonical for Claude Code).
      // Companion: AGENTS.md (cross-tool universal write).
      if (agent.infoFilePath) {
        targets.push({
          path: agent.infoFilePath,
          kind: "primary",
          isAgentsMdCompanion: false,
        });
      }
      targets.push({
        path: join(foundDir, "AGENTS.md"),
        kind: "agents-md-companion",
        isAgentsMdCompanion: true,
      });
      return targets;
    }

    case "codex": {
      // For Codex, the per-agent canonical IS AGENTS.md (set in
      // detect.ts AGENT_RULES). No separate companion needed —
      // dedup logic ensures we don't double-write.
      if (agent.infoFilePath) {
        targets.push({
          path: agent.infoFilePath,
          kind: "primary",
          isAgentsMdCompanion: true,
        });
      }
      return targets;
    }

    case "gemini": {
      // Primary: GEMINI.md (default Gemini context.fileName).
      // Companion: AGENTS.md (Gemini supports it via opt-in).
      if (agent.infoFilePath) {
        targets.push({
          path: agent.infoFilePath,
          kind: "primary",
          isAgentsMdCompanion: false,
        });
      }
      targets.push({
        path: join(foundDir, "AGENTS.md"),
        kind: "agents-md-companion",
        isAgentsMdCompanion: true,
      });
      return targets;
    }

    case "cursor": {
      // Primary: .cursor/rules/glasstrace.mdc (canonical 2026 format).
      // Transitional: .cursorrules (legacy, written unconditionally
      //   per Codex P2 review of DISC-1782 v3 — mixed-version Cursor
      //   scenarios may have Agent mode reading legacy rules
      //   inconsistently, so a conditional fallback is too narrow).
      // Companion: AGENTS.md (Cursor reads it as cross-tool standard).
      if (agent.infoFilePath) {
        targets.push({
          path: agent.infoFilePath,
          kind: "cursor-mdc",
          isAgentsMdCompanion: false,
        });
        // .cursorrules sits at foundDir — same parent as the
        // .cursor/rules/ subtree.
        targets.push({
          path: join(foundDir, ".cursorrules"),
          kind: "cursorrules-legacy",
          isAgentsMdCompanion: false,
        });
      }
      targets.push({
        path: join(foundDir, "AGENTS.md"),
        kind: "agents-md-companion",
        isAgentsMdCompanion: true,
      });
      return targets;
    }

    case "windsurf": {
      // Primary: .windsurf/rules/glasstrace.md (active workspace-rules).
      // Companion: AGENTS.md (cross-tool parallel mechanism Windsurf
      //   also reads — NOT a replacement for workspace-rules, per
      //   windsurf.com/university docs).
      if (agent.infoFilePath) {
        targets.push({
          path: agent.infoFilePath,
          kind: "primary",
          isAgentsMdCompanion: false,
        });
      }
      targets.push({
        path: join(foundDir, "AGENTS.md"),
        kind: "agents-md-companion",
        isAgentsMdCompanion: true,
      });
      return targets;
    }

    case "generic": {
      // For generic, the infoFilePath set in detect.ts IS AGENTS.md.
      // Mark as companion so multi-agent dedup applies.
      if (agent.infoFilePath) {
        targets.push({
          path: agent.infoFilePath,
          kind: "primary",
          isAgentsMdCompanion: true,
        });
      }
      return targets;
    }

    default: {
      const _exhaustive: never = agent.name;
      throw new Error(`Unknown agent: ${_exhaustive}`);
    }
  }
}

/**
 * Write the managed section to a single target file with broadened
 * fail-loud-per-target semantics.
 *
 * Mirrors the create-or-replace logic in `inject.ts`'s
 * `injectInfoSection` but catches ALL write errors (not just
 * `EACCES`/`EPERM`/`EROFS`) and logs a per-error-class qualifier so
 * the user can distinguish permission failures from disk-full / path-
 * too-long / I/O failures.
 *
 * Accepts two content strings to handle the cursor-mdc case cleanly
 * (Codex P2 review of v4):
 *
 *   - `createContent` — used ONLY when the target file does not
 *     already exist. For cursor-mdc this includes the YAML
 *     frontmatter wrapper (`--- ... ---`) ABOVE the managed section.
 *   - `managedSectionOnly` — used when the target file already
 *     exists, regardless of whether it carries existing markers.
 *     For cursor-mdc this is the managed section without the
 *     frontmatter, so appending it to an existing `.mdc` (which
 *     already has its own frontmatter) does NOT produce a duplicate
 *     `--- ... ---` block mid-file.
 *
 * For non-mdc targets the two strings are identical (the body
 * IS the full content).
 */
async function writeManagedSectionToTarget(
  filePath: string,
  createContent: string,
  managedSectionOnly: string,
): Promise<void> {
  let existingContent: string | null = null;
  try {
    existingContent = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      emitTargetWarning(filePath, "read", err);
      return;
    }
  }

  // File does not exist — create with the full content (frontmatter
  // wrapper for cursor-mdc, or the managed section alone for other
  // targets).
  if (existingContent === null) {
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, createContent, "utf-8");
    } catch (err: unknown) {
      emitTargetWarning(filePath, "write", err);
      return;
    }
    return;
  }

  // File exists — check for markers. For both branches below we use
  // `managedSectionOnly` (NOT `createContent`) so we don't inject a
  // second YAML frontmatter block into a cursor-mdc file that
  // already has one. The user's existing frontmatter is preserved.
  const lines = existingContent.split("\n");
  const boundaries = findMarkerBoundaries(lines);

  let newContent: string;
  if (boundaries !== null) {
    const before = lines.slice(0, boundaries.startIdx);
    const after = lines.slice(boundaries.endIdx + 1);
    const contentWithoutTrailingNewline = managedSectionOnly.endsWith("\n")
      ? managedSectionOnly.slice(0, -1)
      : managedSectionOnly;
    newContent = [...before, contentWithoutTrailingNewline, ...after].join(
      "\n",
    );
  } else {
    const separator = existingContent.endsWith("\n") ? "\n" : "\n\n";
    newContent = existingContent + separator + managedSectionOnly;
  }

  try {
    await writeFile(filePath, newContent, "utf-8");
  } catch (err: unknown) {
    emitTargetWarning(filePath, "write", err);
  }
}

/**
 * Emit a per-target stderr warning with an error-class qualifier so
 * users can distinguish failure modes (permission vs disk-full vs
 * path-too-long etc.). No-op when stderr is unavailable (e.g., a
 * non-Node runtime, though the SDK is Node-only).
 */
function emitTargetWarning(
  filePath: string,
  op: "read" | "write",
  err: unknown,
): void {
  const code = (err as NodeJS.ErrnoException).code;
  let qualifier: string;
  switch (code) {
    case "EACCES":
    case "EPERM":
      qualifier = "permission denied";
      break;
    case "EROFS":
      qualifier = "filesystem read-only";
      break;
    case "ENOSPC":
      qualifier = "disk full";
      break;
    case "ENAMETOOLONG":
      qualifier = "path too long";
      break;
    case "ENOTDIR":
      qualifier = "not a directory";
      break;
    case "EISDIR":
      qualifier = "is a directory";
      break;
    default:
      qualifier = "I/O error";
      break;
  }
  try {
    process.stderr.write(
      `Warning: cannot ${op} info file ${filePath}: ${qualifier}\n`,
    );
  } catch {
    // stderr unavailable — silently swallow per the SDK-050
    // never-throw-from-instrumentation invariant.
  }
}
