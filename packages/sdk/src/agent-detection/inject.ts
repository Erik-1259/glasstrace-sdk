import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { DetectedAgent } from "./detect.js";

/** HTML comment markers used in markdown files (.md). */
const HTML_START = "<!-- glasstrace:mcp:start -->";
const HTML_END = "<!-- glasstrace:mcp:end -->";

/** Hash-prefixed markers used in plain text files (.cursorrules). */
const HASH_START = "# glasstrace:mcp:start";
const HASH_END = "# glasstrace:mcp:end";

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
 * Searches for both HTML comment and hash-prefixed marker formats,
 * since an existing file might use either convention.
 *
 * @returns The start and end indices (line-level) and the matched markers,
 *          or null if no complete marker pair is found.
 */
function findMarkerBoundaries(
  lines: string[],
): { startIdx: number; endIdx: number } | null {
  let startIdx = -1;
  let endIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === HTML_START || trimmed === HASH_START) {
      startIdx = i;
    } else if (trimmed === HTML_END || trimmed === HASH_END) {
      if (startIdx !== -1) {
        endIdx = i;
        break;
      }
    }
  }

  if (startIdx === -1 || endIdx === -1) {
    return null;
  }

  return { startIdx, endIdx };
}

/**
 * Injects an informational section into an agent's instruction file.
 *
 * Uses marker comments to enable idempotent updates:
 * - If the file contains marker pairs, replaces content between them.
 * - If the file exists but has no markers, appends the section.
 * - If the file does not exist, creates it with the section content.
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
