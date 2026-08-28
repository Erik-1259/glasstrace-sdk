import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function workspacePatterns(manifest) {
  if (Array.isArray(manifest.workspaces)) return manifest.workspaces;
  if (
    manifest.workspaces !== null &&
    typeof manifest.workspaces === "object" &&
    Array.isArray(manifest.workspaces.packages)
  ) {
    return manifest.workspaces.packages;
  }
  throw new Error("Root package.json must declare npm workspaces.");
}

function toLockPath(root, directory) {
  return relative(root, directory).split(sep).join("/");
}

/**
 * Expand the deliberately small subset of workspace syntax used by this repo.
 * Failing on an unfamiliar glob is safer than silently omitting a workspace
 * from the release invariant.
 */
export function findWorkspaceDirectories(root, manifest) {
  const directories = new Set();

  for (const pattern of workspacePatterns(manifest)) {
    if (typeof pattern !== "string" || pattern.trim() === "") {
      throw new Error("Workspace patterns must be non-empty strings.");
    }

    if (!pattern.includes("*")) {
      const directory = resolve(root, pattern);
      if (!existsSync(join(directory, "package.json"))) {
        throw new Error(`Workspace ${pattern} has no package.json.`);
      }
      directories.add(directory);
      continue;
    }

    if (!pattern.endsWith("/*") || pattern.slice(0, -2).includes("*")) {
      throw new Error(`Unsupported workspace pattern: ${pattern}`);
    }

    const parent = resolve(root, pattern.slice(0, -2));
    if (!existsSync(parent) || !statSync(parent).isDirectory()) {
      throw new Error(`Workspace directory does not exist: ${pattern}`);
    }
    for (const entry of readdirSync(parent).sort()) {
      const directory = join(parent, entry);
      if (
        statSync(directory).isDirectory() &&
        existsSync(join(directory, "package.json"))
      ) {
        directories.add(directory);
      }
    }
  }

  return [...directories].sort();
}

export function workspaceLockfileViolations(root = REPO_ROOT) {
  const manifest = readJson(join(root, "package.json"));
  const lockfile = readJson(join(root, "package-lock.json"));
  if (
    lockfile.packages === null ||
    typeof lockfile.packages !== "object" ||
    Array.isArray(lockfile.packages)
  ) {
    throw new Error("package-lock.json has no packages map.");
  }

  const violations = [];
  for (const directory of findWorkspaceDirectories(root, manifest)) {
    const workspace = readJson(join(directory, "package.json"));
    const lockPath = toLockPath(root, directory);
    const lockWorkspace = lockfile.packages[lockPath];
    const linkPath = `node_modules/${workspace.name}`;
    const lockLink = lockfile.packages[linkPath];

    if (typeof workspace.name !== "string" || workspace.name.trim() === "") {
      violations.push(`${lockPath}: package name is missing`);
    }
    if (
      typeof workspace.version !== "string" ||
      workspace.version.trim() === ""
    ) {
      violations.push(`${lockPath}: package version is missing`);
    }
    if (lockWorkspace === undefined) {
      violations.push(`${lockPath}: workspace entry is missing from package-lock.json`);
    } else if (lockWorkspace.version !== workspace.version) {
      violations.push(
        `${lockPath}: package.json is ${String(workspace.version)} but package-lock.json is ${String(lockWorkspace.version)}`,
      );
    }
    if (
      typeof workspace.name === "string" &&
      (lockLink?.link !== true || lockLink.resolved !== lockPath)
    ) {
      violations.push(
        `${lockPath}: package-lock.json link ${linkPath} does not resolve to the workspace`,
      );
    }
  }

  return violations;
}

export function assertWorkspaceLockfile(root = REPO_ROOT) {
  const violations = workspaceLockfileViolations(root);
  if (violations.length > 0) {
    throw new Error(
      `Workspace package metadata is out of sync with package-lock.json:\n${violations
        .map((violation) => `- ${violation}`)
        .join("\n")}`,
    );
  }
}

function isMainModule() {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}

if (isMainModule()) {
  try {
    assertWorkspaceLockfile();
    process.stdout.write(
      "Workspace package metadata matches package-lock.json.\n",
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
