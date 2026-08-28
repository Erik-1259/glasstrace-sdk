import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";
import { assertWorkspaceLockfile } from "./check-workspace-lockfile.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const outcome =
      result.signal === null
        ? `exited with status ${String(result.status)}`
        : `was terminated by signal ${result.signal}`;
    throw new Error(
      `${command} ${args.join(" ")} ${outcome}`,
    );
  }
}

/**
 * Changesets updates workspace manifests and changelogs. npm then owns the
 * corresponding lock metadata refresh, using the repository's declared npm
 * version in CI. The final invariant prevents a green Version Packages PR
 * from carrying stale workspace versions in package-lock.json.
 */
function assertVersionArguments(versionArguments) {
  if (
    !Array.isArray(versionArguments) ||
    !(
      versionArguments.length === 0 ||
      (versionArguments.length === 2 &&
        versionArguments[0] === "--snapshot" &&
        versionArguments[1] === "canary")
    )
  ) {
    throw new Error(
      "version-packages accepts only no arguments or exactly --snapshot canary.",
    );
  }
  return versionArguments;
}

export function versionPackages(
  root = REPO_ROOT,
  runner = run,
  versionArguments = [],
) {
  const safeVersionArguments = assertVersionArguments(versionArguments);
  runner(
    process.execPath,
    [
      join(root, "node_modules/@changesets/cli/bin.js"),
      "version",
      ...safeVersionArguments,
    ],
    root,
  );
  runner(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    root,
  );
  assertWorkspaceLockfile(root);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    versionPackages(REPO_ROOT, run, process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
