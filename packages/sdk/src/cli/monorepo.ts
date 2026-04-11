import * as fs from "node:fs";
import * as path from "node:path";
import { NEXT_CONFIG_NAMES } from "./constants.js";

/** Result of classifying the project root directory. */
export interface ProjectClassification {
  /** The directory to scaffold into (may differ from cwd for monorepos). */
  projectRoot: string;
  /** Whether this was auto-resolved from a monorepo root. */
  isMonorepo: boolean;
  /** If monorepo, the relative path from cwd to the resolved app. */
  appRelativePath?: string;
}

/**
 * Classifies the current directory and resolves the target project root.
 *
 * Classification logic:
 * 1. If the directory contains a Next.js config file, it is a Next.js app
 *    directory. Returns it directly.
 * 1b. If no config file exists but package.json lists "next" as a dependency,
 *     it is still a Next.js app (config files are optional since Next.js 12).
 * 2. If the directory contains monorepo markers (pnpm-workspace.yaml,
 *    turbo.json, lerna.json, or a workspaces field in package.json),
 *    scans workspace packages for Next.js apps.
 * 3. Otherwise, fails with a user-facing error.
 *
 * @param cwd - The current working directory
 * @returns The resolved project classification
 * @throws Error with a user-facing message if the location is invalid
 */
export function resolveProjectRoot(cwd: string): ProjectClassification {
  // Step 1: Check if cwd is a Next.js app directory (config file)
  if (hasNextConfig(cwd)) {
    return { projectRoot: cwd, isMonorepo: false };
  }

  // Step 1b: Check if cwd has "next" as a dependency (config is optional)
  if (hasNextDependency(cwd)) {
    return { projectRoot: cwd, isMonorepo: false };
  }

  // Step 2: Check for monorepo markers
  if (isMonorepoRoot(cwd)) {
    // findNextJsApps throws if no workspace globs are found (e.g., turbo.json
    // exists but no pnpm-workspace.yaml or workspaces in package.json)
    const apps = findNextJsApps(cwd);

    if (apps.length === 0) {
      throw new Error(
        "This is a monorepo but no Next.js apps were found in workspace packages.",
      );
    }

    if (apps.length === 1) {
      const appDir = apps[0];
      const relativePath = path.relative(cwd, appDir);
      return {
        projectRoot: appDir,
        isMonorepo: true,
        appRelativePath: relativePath,
      };
    }

    // Multiple apps found — cannot auto-resolve
    const appList = apps
      .map((app) => `  - ${path.relative(cwd, app)}`)
      .join("\n");
    throw new Error(
      `Found multiple Next.js apps:\n${appList}\nRun init from the specific app directory you want to instrument.`,
    );
  }

  // Step 3: Neither Next.js app nor monorepo
  throw new Error(
    "No Next.js project found in the current directory.\n" +
      "Run this command from your Next.js app directory, or from a monorepo root.",
  );
}

/**
 * Checks whether the given directory contains a Next.js config file.
 */
function hasNextConfig(dir: string): boolean {
  return NEXT_CONFIG_NAMES.some((name) =>
    fs.existsSync(path.join(dir, name)),
  );
}

/**
 * Checks whether the given directory's package.json lists "next" as a
 * dependency or devDependency. This handles the case where a Next.js app
 * has no explicit config file (config files are optional since Next.js 12).
 */
function hasNextDependency(dir: string): boolean {
  const packageJsonPath = path.join(dir, "package.json");
  if (!fs.existsSync(packageJsonPath)) return false;

  try {
    const content = fs.readFileSync(packageJsonPath, "utf-8");
    const pkg = JSON.parse(content) as Record<string, unknown>;
    const deps = pkg["dependencies"];
    const devDeps = pkg["devDependencies"];

    if (typeof deps === "object" && deps !== null && "next" in deps) return true;
    if (typeof devDeps === "object" && devDeps !== null && "next" in devDeps) return true;
  } catch {
    // Invalid JSON — not a Next.js indicator
  }

  return false;
}

/**
 * Detects monorepo markers in the given directory.
 *
 * Checks for:
 * - pnpm-workspace.yaml
 * - turbo.json
 * - lerna.json
 * - "workspaces" field in package.json
 */
export function isMonorepoRoot(dir: string): boolean {
  // Check for standalone monorepo marker files
  if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return true;
  if (fs.existsSync(path.join(dir, "turbo.json"))) return true;
  if (fs.existsSync(path.join(dir, "lerna.json"))) return true;

  // Check for "workspaces" field in package.json
  const packageJsonPath = path.join(dir, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      const content = fs.readFileSync(packageJsonPath, "utf-8");
      const pkg = JSON.parse(content) as Record<string, unknown>;
      if (pkg["workspaces"] !== undefined) return true;
    } catch {
      // Invalid JSON — not a monorepo indicator
    }
  }

  return false;
}

/**
 * Finds Next.js apps in workspace packages.
 *
 * Parses workspace globs from:
 * - pnpm-workspace.yaml (packages array)
 * - package.json workspaces field (string[] or { packages: string[] })
 * - lerna.json packages field (string[])
 *
 * Expands the workspace globs using filesystem traversal and returns
 * absolute paths of directories that contain a Next.js config file or
 * have "next" as a dependency in package.json.
 *
 * @param monorepoRoot - Absolute path to the monorepo root directory
 * @returns Sorted array of absolute paths to Next.js app directories
 */
export function findNextJsApps(monorepoRoot: string): string[] {
  const { includeGlobs, negationPatterns } = collectWorkspaceGlobs(monorepoRoot);

  if (includeGlobs.length === 0) {
    throw new Error(
      "Monorepo detected but no workspace configuration found.\n" +
        'Add a "workspaces" field to package.json or create pnpm-workspace.yaml.',
    );
  }

  const workspaceDirs = expandGlobs(monorepoRoot, includeGlobs);

  // Apply negation patterns: filter out directories matching any exclusion
  const excludedDirs = expandGlobs(monorepoRoot, negationPatterns);
  const excludedSet = new Set(excludedDirs);

  // Deduplicate and filter for Next.js apps
  const seen = new Set<string>();
  const nextApps: string[] = [];

  for (const dir of workspaceDirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (excludedSet.has(dir)) continue;
    if (hasNextConfig(dir) || hasNextDependency(dir)) {
      nextApps.push(dir);
    }
  }

  return nextApps.sort();
}

/** Workspace globs split into include and negation patterns. */
export interface WorkspaceGlobs {
  includeGlobs: string[];
  negationPatterns: string[];
}

/**
 * Collects workspace globs from all supported monorepo config sources.
 * Returns deduplicated include globs and negation patterns separately.
 */
function collectWorkspaceGlobs(root: string): WorkspaceGlobs {
  const globs: string[] = [];
  const negations: string[] = [];

  // 1. pnpm-workspace.yaml
  const pnpmPath = path.join(root, "pnpm-workspace.yaml");
  if (fs.existsSync(pnpmPath)) {
    const content = fs.readFileSync(pnpmPath, "utf-8");
    const parsed = parsePnpmWorkspaceYaml(content);
    globs.push(...parsed.includeGlobs);
    negations.push(...parsed.negationPatterns);
  }

  // 2. package.json workspaces
  const packageJsonPath = path.join(root, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      const content = fs.readFileSync(packageJsonPath, "utf-8");
      const pkg = JSON.parse(content) as Record<string, unknown>;
      globs.push(...parsePackageJsonWorkspaces(pkg));
    } catch {
      // Invalid JSON — skip
    }
  }

  // 3. lerna.json packages
  const lernaPath = path.join(root, "lerna.json");
  if (fs.existsSync(lernaPath)) {
    try {
      const content = fs.readFileSync(lernaPath, "utf-8");
      const lerna = JSON.parse(content) as Record<string, unknown>;
      const packages = lerna["packages"];
      if (Array.isArray(packages)) {
        for (const pkg of packages) {
          if (typeof pkg === "string") {
            globs.push(pkg);
          }
        }
      }
    } catch {
      // Invalid JSON — skip
    }
  }

  // Deduplicate
  return {
    includeGlobs: [...new Set(globs)],
    negationPatterns: [...new Set(negations)],
  };
}

/**
 * Parses pnpm-workspace.yaml to extract workspace package globs.
 *
 * The format is simple enough to parse with string processing:
 * ```yaml
 * packages:
 *   - "apps/*"
 *   - packages/*
 *   - '!packages/internal'
 * ```
 *
 * Handles both quoted and unquoted values. Negation patterns (lines
 * starting with !) are returned separately so callers can apply them
 * as exclusions after expanding include globs.
 *
 * @internal Exported for unit testing only.
 */
export function parsePnpmWorkspaceYaml(content: string): WorkspaceGlobs {
  const lines = content.split("\n");
  const includeGlobs: string[] = [];
  const negationPatterns: string[] = [];
  let inPackages = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    // Detect the `packages:` key
    if (/^packages\s*:/.test(trimmed)) {
      inPackages = true;
      continue;
    }

    // Stop when we hit another top-level key (no leading whitespace before key)
    if (inPackages && trimmed.length > 0 && !trimmed.startsWith("-") && !rawLine.startsWith(" ") && !rawLine.startsWith("\t")) {
      inPackages = false;
      continue;
    }

    if (!inPackages) continue;

    // Parse list items: `  - "glob"` or `  - glob` or `  - 'glob'`
    const itemMatch = /^\s*-\s+(.+)$/.exec(rawLine);
    if (!itemMatch) continue;

    // Strip surrounding quotes (single or double)
    const value = itemMatch[1].trim().replace(/^["']|["']$/g, "");

    // Skip empty values
    if (value.length === 0) continue;

    // Collect negation patterns separately (strip the leading !)
    if (value.startsWith("!")) {
      negationPatterns.push(value.slice(1));
      continue;
    }

    includeGlobs.push(value);
  }

  return { includeGlobs, negationPatterns };
}

/**
 * Extracts workspace globs from a parsed package.json object.
 *
 * Handles both forms:
 * - `"workspaces": ["packages/*", "apps/*"]`
 * - `"workspaces": { "packages": ["packages/*", "apps/*"] }`
 */
function parsePackageJsonWorkspaces(pkg: Record<string, unknown>): string[] {
  const workspaces = pkg["workspaces"];
  if (workspaces === undefined || workspaces === null) return [];

  // Array form: string[]
  if (Array.isArray(workspaces)) {
    return workspaces.filter((w): w is string => typeof w === "string");
  }

  // Object form: { packages: string[] }
  if (typeof workspaces === "object") {
    const obj = workspaces as Record<string, unknown>;
    const packages = obj["packages"];
    if (Array.isArray(packages)) {
      return packages.filter((p): p is string => typeof p === "string");
    }
  }

  return [];
}

/**
 * Expands workspace globs into actual directory paths.
 *
 * Supports:
 * - `packages/*` — matches one level of directories under packages/
 * - `apps/*` — matches one level of directories under apps/
 * - `packages/foo` — matches a specific directory (literal path)
 * - `packages/**` — recursively walks for directories with package.json
 *
 * @param root - The monorepo root directory
 * @param globs - Workspace glob patterns to expand
 * @returns Array of absolute paths to matched directories
 */
function expandGlobs(root: string, globs: string[]): string[] {
  const dirs: string[] = [];

  for (const glob of globs) {
    // Remove trailing slash if present
    const cleanGlob = glob.replace(/\/+$/, "");

    if (cleanGlob.includes("**")) {
      // Recursive glob — walk the directory tree
      const prefix = cleanGlob.split("**")[0].replace(/\/+$/, "");
      const baseDir = path.join(root, prefix);
      if (fs.existsSync(baseDir)) {
        dirs.push(...walkDirectories(baseDir));
      }
    } else if (cleanGlob.includes("*")) {
      // Single-level wildcard — expand one directory level
      const parts = cleanGlob.split("*");
      // For "packages/*", parts = ["packages/", ""]
      const baseDir = path.join(root, parts[0].replace(/\/+$/, ""));
      const suffix = parts.slice(1).join("*"); // Anything after the wildcard

      if (!fs.existsSync(baseDir)) continue;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(baseDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // If there is a suffix pattern, the entry name must end with it
        if (suffix && !entry.name.endsWith(suffix)) continue;
        dirs.push(path.join(baseDir, entry.name));
      }
    } else {
      // Literal path — no wildcards
      const targetDir = path.join(root, cleanGlob);
      if (fs.existsSync(targetDir) && fs.statSync(targetDir).isDirectory()) {
        dirs.push(targetDir);
      }
    }
  }

  return dirs;
}

/**
 * Recursively walks a directory tree and returns all subdirectories
 * that contain a package.json (indicating they are workspace packages).
 * Skips node_modules and hidden directories.
 */
function walkDirectories(baseDir: string): string[] {
  const result: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip node_modules and hidden directories
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;

    const fullPath = path.join(baseDir, entry.name);

    // A workspace package should have a package.json
    if (fs.existsSync(path.join(fullPath, "package.json"))) {
      result.push(fullPath);
    }

    // Continue recursing for nested workspaces
    result.push(...walkDirectories(fullPath));
  }

  return result;
}
