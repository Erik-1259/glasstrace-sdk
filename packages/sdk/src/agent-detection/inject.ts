import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { DetectedAgent } from "./detect.js";

/**
 * HTML start-marker regex used in markdown files (.md). Matches both
 * legacy unstamped markers (pre-SDK-050) and stamped markers (SDK-050+).
 *
 * Two shapes:
 *   - Legacy: `<!-- glasstrace:mcp:start -->`
 *   - Stamped: `<!-- glasstrace:mcp:start v=1.4.0 -->`
 *
 * The optional `v=<semver>` capture group is the SDK-050 version stamp
 * (DISC-1592 Required Semantics Item 1). Recognising the legacy form is
 * load-bearing for the SDK-050 backward-compatibility constraint: an
 * upgrading user's first re-render must replace the existing block in
 * place rather than appending a duplicate. Subsequent re-renders write
 * the stamped form.
 *
 * The stamp character class
 * `[^\s>]+` deliberately excludes whitespace and `>` so a hand-edited
 * malformed marker cannot terminate the comment early or smuggle a
 * line break into the file. The end marker (`...mcp:end`) is unstamped.
 */
const HTML_START_RE =
  /^<!--\s*glasstrace:mcp:start(?:\s+v=([^\s>]+))?\s*-->$/;
const HTML_END = "<!-- glasstrace:mcp:end -->";

/**
 * Hash-prefixed start-marker regex used in plain text files (e.g.
 * `.cursorrules`). Same legacy/stamped shape model as the HTML form,
 * with the constraint that the captured stamp is non-whitespace
 * (`\S+`) — the line ends at end-of-line, so there is no closing
 * delimiter to escape.
 */
const HASH_START_RE = /^#\s*glasstrace:mcp:start(?:\s+v=(\S+))?$/;
const HASH_END = "# glasstrace:mcp:end";

/**
 * Parsed start marker — its kind (HTML vs hash) and, when present, the
 * `v=<sdkVersion>` stamp. `stamp === null` means the marker matched the
 * legacy unstamped form (pre-SDK-050).
 */
export interface ParsedStartMarker {
  kind: "html" | "hash";
  stamp: string | null;
}

/**
 * Parses a single line as a Glasstrace start marker.
 *
 * Accepts both legacy unstamped markers (pre-SDK-050) and stamped
 * markers (SDK-050+). Returns `null` if the line is not a start
 * marker. Trims whitespace before matching so leading/trailing spaces
 * in user-edited files do not defeat detection.
 *
 * Exported so the upgrade-notice module (which checks the start
 * marker line directly) can share the regex, keeping a single source
 * of truth for the marker shape.
 */
export function parseStartMarkerLine(
  line: string,
): ParsedStartMarker | null {
  const trimmed = line.trim();
  const html = HTML_START_RE.exec(trimmed);
  if (html !== null) {
    return { kind: "html", stamp: html[1] ?? null };
  }
  const hash = HASH_START_RE.exec(trimmed);
  if (hash !== null) {
    return { kind: "hash", stamp: hash[1] ?? null };
  }
  return null;
}

function isEndMarker(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === HTML_END || trimmed === HASH_END;
}

/**
 * Public alias for {@link isEndMarker}, used by the upgrade-notice
 * module to confirm that a stamped start marker has a matching end
 * before classifying the file as having a managed section. Exported
 * only for cross-module reuse within `agent-detection/`; not part of
 * the public SDK surface.
 */
export function isEndMarkerLine(line: string): boolean {
  return isEndMarker(line);
}

/**
 * Determines whether an error is a filesystem permission or read-only error.
 * Covers EACCES (permission denied), EPERM (operation not permitted), and
 * EROFS (read-only filesystem) to handle containerized/mounted environments.
 */
function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM" || code === "EROFS";
}

/**
 * Writes MCP configuration content to an agent's config file path.
 *
 * Creates parent directories as needed and sets file permissions to 0o600
 * (owner read/write only) since config files may contain auth tokens.
 *
 * Fails gracefully: logs a warning to stderr on permission errors instead
 * of throwing.
 *
 * @param agent - The detected agent whose config path to write to.
 * @param content - The full configuration file content.
 * @param projectRoot - The project root (reserved for future use).
 */
export async function writeMcpConfig(
  agent: DetectedAgent,
  content: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  projectRoot: string,
): Promise<void> {
  if (agent.mcpConfigPath === null) {
    return;
  }

  const configPath = agent.mcpConfigPath;
  const parentDir = dirname(configPath);

  try {
    await mkdir(parentDir, { recursive: true });
  } catch (err: unknown) {
    if (isPermissionError(err)) {
      process.stderr.write(
        `Warning: cannot create directory ${parentDir}: permission denied\n`,
      );
      return;
    }
    throw err;
  }

  try {
    await writeFile(configPath, content, { mode: 0o600 });
  } catch (err: unknown) {
    if (isPermissionError(err)) {
      process.stderr.write(
        `Warning: cannot write config file ${configPath}: permission denied\n`,
      );
      return;
    }
    throw err;
  }

  // Ensure permissions are set even if the file already existed
  // (writeFile mode only applies to newly created files on some platforms)
  try {
    await chmod(configPath, 0o600);
  } catch {
    // Best-effort; the writeFile mode should have handled this
  }
}

/**
 * Finds existing marker boundaries in file content.
 *
 * Recognises both the legacy unstamped marker form (pre-SDK-050) and
 * the stamped form (SDK-050+) for both HTML-comment and hash-prefix
 * conventions. Returns the start and end line indices, or `null` if no
 * complete marker pair is found. The `v=<sdkVersion>` stamp itself is
 * only inspected by the upgrade-notice module via
 * {@link parseStartMarkerLine}; in-place replacement only needs the
 * line indices.
 *
 * When multiple start markers appear before the first end marker
 * (e.g. a quoted example of the marker shape earlier in the file
 * followed by the real managed block), the boundary anchors to the
 * MOST RECENT start preceding the end. This matches the pre-SDK-050
 * behaviour of `findMarkerBoundaries` and avoids the "swallow the
 * user's example into the replacement" failure mode that anchoring
 * to the FIRST start would produce.
 */
function findMarkerBoundaries(
  lines: string[],
): { startIdx: number; endIdx: number } | null {
  let startIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (parseStartMarkerLine(lines[i]) !== null) {
      // Track the most recent start so a quoted/example marker earlier
      // in the file does not capture the replacement window.
      startIdx = i;
    } else if (startIdx !== -1 && isEndMarker(lines[i])) {
      return { startIdx, endIdx: i };
    }
  }

  return null;
}

/**
 * Injects an informational section into an agent's instruction file.
 *
 * Uses marker comments to enable idempotent updates:
 * - If the file contains marker pairs, replaces content between them.
 * - If the file exists but has no markers, appends the section.
 * - If the file does not exist, creates it with the section content.
 *
 * The boundary detector recognises both legacy unstamped markers
 * (pre-SDK-050) and stamped markers, so an upgrading user's first
 * re-render replaces the existing block in place rather than
 * appending a duplicate (DISC-1592 / SDK-050 backward-compatibility
 * constraint). Subsequent re-renders write the stamped form.
 *
 * Fails gracefully: logs a warning to stderr on read-only files instead
 * of throwing.
 *
 * @param agent - The detected agent whose info file to update.
 * @param content - The section content (including markers).
 * @param projectRoot - The project root (reserved for future use).
 */
export async function injectInfoSection(
  agent: DetectedAgent,
  content: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  projectRoot: string,
): Promise<void> {
  if (agent.infoFilePath === null) {
    return;
  }

  // Empty content means nothing to inject (e.g., agents without info sections)
  if (content === "") {
    return;
  }

  const filePath = agent.infoFilePath;

  let existingContent: string | null = null;
  try {
    existingContent = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      if (isPermissionError(err)) {
        process.stderr.write(
          `Warning: cannot read info file ${filePath}: permission denied\n`,
        );
        return;
      }
      throw err;
    }
  }

  // File does not exist — create with section content
  if (existingContent === null) {
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf-8");
    } catch (err: unknown) {
      if (isPermissionError(err)) {
        process.stderr.write(
          `Warning: cannot write info file ${filePath}: permission denied\n`,
        );
        return;
      }
      throw err;
    }
    return;
  }

  // File exists — check for markers
  const lines = existingContent.split("\n");
  const boundaries = findMarkerBoundaries(lines);

  let newContent: string;
  if (boundaries !== null) {
    // Replace everything from start marker through end marker (inclusive)
    const before = lines.slice(0, boundaries.startIdx);
    const after = lines.slice(boundaries.endIdx + 1);
    // content already includes markers and trailing newline
    const contentWithoutTrailingNewline = content.endsWith("\n")
      ? content.slice(0, -1)
      : content;
    newContent = [...before, contentWithoutTrailingNewline, ...after].join("\n");
  } else {
    // No markers found — append with a blank line separator
    const separator = existingContent.endsWith("\n") ? "\n" : "\n\n";
    newContent = existingContent + separator + content;
  }

  try {
    await writeFile(filePath, newContent, "utf-8");
  } catch (err: unknown) {
    if (isPermissionError(err)) {
      process.stderr.write(
        `Warning: cannot write info file ${filePath}: permission denied\n`,
      );
      return;
    }
    throw err;
  }
}

/**
 * Returns true when the file at `filePath` contains a complete
 * Glasstrace managed section (marker pair). Matches both legacy
 * unstamped markers and SDK-050+ stamped markers. Used by the
 * upgrade-instructions CLI to decide which detected agent files
 * actually have a managed section to refresh.
 *
 * Best-effort: returns false on any read error rather than throwing.
 */
export async function hasManagedSection(filePath: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return false;
  }
  return findMarkerBoundaries(content.split("\n")) !== null;
}

/**
 * Ensures that the given paths are listed in the project's `.gitignore`.
 *
 * Only adds entries for paths that are not already present. Creates the
 * `.gitignore` file if it does not exist. Skips absolute paths (e.g.,
 * Windsurf's global config) since those are outside the project tree.
 *
 * Fails gracefully: logs a warning to stderr on permission errors.
 *
 * @param paths - Relative paths to ensure are gitignored.
 * @param projectRoot - The project root directory.
 */
export async function updateGitignore(
  paths: string[],
  projectRoot: string,
): Promise<void> {
  const gitignorePath = join(projectRoot, ".gitignore");

  // Filter out absolute paths — they reference locations outside the project
  // Uses isAbsolute() to handle both POSIX and Windows path formats
  const relativePaths = paths.filter((p) => !isAbsolute(p));

  if (relativePaths.length === 0) {
    return;
  }

  let existingContent = "";
  try {
    existingContent = await readFile(gitignorePath, "utf-8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      if (isPermissionError(err)) {
        process.stderr.write(
          `Warning: cannot read .gitignore: permission denied\n`,
        );
        return;
      }
      throw err;
    }
  }

  // Parse existing entries, trimming whitespace for comparison
  const existingLines = existingContent
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const existingSet = new Set(existingLines);

  // Normalize entries: trim whitespace, convert backslashes to forward slashes
  // (git ignore patterns use / as separator; backslash is an escape character),
  // drop empties, and deduplicate against existing entries.
  const toAdd = relativePaths
    .map((p) => p.trim().replace(/\\/g, "/"))
    .filter((p) => p !== "" && !existingSet.has(p));

  if (toAdd.length === 0) {
    return;
  }

  // Ensure file ends with newline before appending
  let updatedContent = existingContent;
  if (updatedContent.length > 0 && !updatedContent.endsWith("\n")) {
    updatedContent += "\n";
  }

  updatedContent += toAdd.join("\n") + "\n";

  try {
    await writeFile(gitignorePath, updatedContent, "utf-8");
  } catch (err: unknown) {
    if (isPermissionError(err)) {
      process.stderr.write(
        `Warning: cannot write .gitignore: permission denied\n`,
      );
      return;
    }
    throw err;
  }
}
