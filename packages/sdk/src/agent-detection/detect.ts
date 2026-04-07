import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { constants } from "node:fs";

/**
 * Describes an AI coding agent detected in a project.
 */
export interface DetectedAgent {
  name: "claude" | "codex" | "gemini" | "cursor" | "windsurf" | "generic";
  mcpConfigPath: string | null;
  infoFilePath: string | null;
  cliAvailable: boolean;
  registrationCommand: string | null;
}

type AgentName = DetectedAgent["name"];

interface AgentRule {
  name: AgentName;
  /** Paths relative to a search directory that indicate this agent is present. */
  markers: string[];
  /** Function to compute the MCP config path given the directory where markers were found. */
  mcpConfigPath: (markerDir: string) => string;
  /** Function to compute the info file path, or null. */
  infoFilePath: (markerDir: string) => string | null;
  /** CLI binary name to check in PATH, or null if no CLI exists. */
  cliBinary: string | null;
  /** Registration command template, or null. */
  registrationCommand: string | null;
}

const AGENT_RULES: AgentRule[] = [
  {
    name: "claude",
    markers: [".claude", "CLAUDE.md"],
    mcpConfigPath: (dir) => join(dir, ".mcp.json"),
    infoFilePath: (dir) => join(dir, "CLAUDE.md"),
    cliBinary: "claude",
    registrationCommand: "npx glasstrace mcp add --agent claude",
  },
  {
    name: "codex",
    markers: ["codex.md", ".codex"],
    mcpConfigPath: (dir) => join(dir, ".codex", "config.toml"),
    infoFilePath: (dir) => join(dir, "codex.md"),
    cliBinary: "codex",
    registrationCommand: "npx glasstrace mcp add --agent codex",
  },
  {
    name: "gemini",
    markers: [".gemini"],
    mcpConfigPath: (dir) => join(dir, ".gemini", "settings.json"),
    infoFilePath: () => null,
    cliBinary: "gemini",
    registrationCommand: "npx glasstrace mcp add --agent gemini",
  },
  {
    name: "cursor",
    markers: [".cursor", ".cursorrules"],
    mcpConfigPath: (dir) => join(dir, ".cursor", "mcp.json"),
    infoFilePath: (dir) => join(dir, ".cursorrules"),
    cliBinary: null,
    registrationCommand: "npx glasstrace mcp add --agent cursor",
  },
  {
    name: "windsurf",
    markers: [".windsurfrules", ".windsurf"],
    mcpConfigPath: () =>
      join(homedir(), ".codeium", "windsurf", "mcp_config.json"),
    infoFilePath: (dir) => join(dir, ".windsurfrules"),
    cliBinary: null,
    registrationCommand: "npx glasstrace mcp add --agent windsurf",
  },
];

/**
 * Checks whether a path exists and is accessible, following symlinks.
 * Returns false on permission errors or missing paths.
 *
 * @param mode - The access mode to check (defaults to R_OK for marker detection).
 */
async function pathExists(
  path: string,
  mode: number = constants.R_OK,
): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds the git root directory by walking up from the given path.
 * Returns the starting directory if no `.git` is found.
 */
async function findGitRoot(startDir: string): Promise<string> {
  let current = resolve(startDir);

  while (true) {
    if (await pathExists(join(current, ".git"), constants.F_OK)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      // Reached filesystem root without finding .git
      break;
    }
    current = parent;
  }

  return resolve(startDir);
}

/**
 * Returns true if a CLI binary is available on PATH.
 * Uses `which` on Unix and `where` on Windows, via execFile (no shell injection).
 */
function isCliAvailable(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    const command = process.platform === "win32" ? "where" : "which";
    execFile(command, [binary], (error) => {
      resolve(error === null);
    });
  });
}

/**
 * Detects AI coding agents present in a project by scanning for marker
 * files and directories. Walks up from projectRoot to the git root to
 * support monorepo layouts.
 *
 * Always includes a "generic" fallback entry.
 *
 * @param projectRoot - Absolute or relative path to the project directory.
 * @returns Array of detected agents, with generic always last.
 * @throws If projectRoot does not exist or is not a directory.
 */
export async function detectAgents(
  projectRoot: string,
): Promise<DetectedAgent[]> {
  const resolvedRoot = resolve(projectRoot);

  // Validate projectRoot exists and is a directory
  let rootStat;
  try {
    rootStat = await stat(resolvedRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      `projectRoot does not exist: ${resolvedRoot}` +
        (code ? ` (${code})` : ""),
    );
  }

  if (!rootStat.isDirectory()) {
    throw new Error(`projectRoot is not a directory: ${resolvedRoot}`);
  }

  const gitRoot = await findGitRoot(resolvedRoot);

  // Collect unique directories to search: projectRoot and every ancestor up to gitRoot
  const searchDirs: string[] = [];
  let current = resolvedRoot;
  while (true) {
    searchDirs.push(current);
    if (current === gitRoot) {
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  const detected: DetectedAgent[] = [];
  const seenAgents = new Set<AgentName>();

  for (const rule of AGENT_RULES) {
    let foundDir: string | null = null;

    // Check each search directory for markers
    for (const dir of searchDirs) {
      let markerFound = false;
      for (const marker of rule.markers) {
        if (await pathExists(join(dir, marker))) {
          markerFound = true;
          break;
        }
      }
      if (markerFound) {
        foundDir = dir;
        break;
      }
    }

    if (foundDir === null) {
      continue;
    }

    if (seenAgents.has(rule.name)) {
      continue;
    }
    seenAgents.add(rule.name);

    // Determine info file path — only include if the file actually exists
    let infoFilePath = rule.infoFilePath(foundDir);
    if (infoFilePath !== null && !(await pathExists(infoFilePath))) {
      infoFilePath = null;
    }

    const cliAvailable = rule.cliBinary
      ? await isCliAvailable(rule.cliBinary)
      : false;

    detected.push({
      name: rule.name,
      mcpConfigPath: rule.mcpConfigPath(foundDir),
      infoFilePath,
      cliAvailable,
      registrationCommand: rule.registrationCommand,
    });
  }

  // Always include generic fallback
  detected.push({
    name: "generic",
    mcpConfigPath: join(resolvedRoot, ".glasstrace", "mcp.json"),
    infoFilePath: null,
    cliAvailable: false,
    registrationCommand: null,
  });

  return detected;
}
