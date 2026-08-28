import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertWorkspaceLockfile,
  workspaceLockfileViolations,
} from "../../scripts/check-workspace-lockfile.mjs";
import { versionPackages } from "../../scripts/version-packages.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../..");
const temporaryRoots: string[] = [];

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "glasstrace-workspace-lock-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "packages/sdk"), { recursive: true });
  mkdirSync(join(root, "packages/protocol"), { recursive: true });
  writeJson(join(root, "package.json"), {
    name: "fixture",
    private: true,
    workspaces: ["packages/*"],
  });
  writeJson(join(root, "packages/sdk/package.json"), {
    name: "@glasstrace/sdk",
    version: "1.2.3",
  });
  writeJson(join(root, "packages/protocol/package.json"), {
    name: "@glasstrace/protocol",
    version: "0.4.5",
  });
  const lockfile = {
    lockfileVersion: 3,
    name: "fixture",
    packages: {
      "": { name: "fixture", workspaces: ["packages/*"] },
      "node_modules/@glasstrace/protocol": {
        link: true,
        resolved: "packages/protocol",
      },
      "node_modules/@glasstrace/sdk": {
        link: true,
        resolved: "packages/sdk",
      },
      "packages/protocol": {
        name: "@glasstrace/protocol",
        version: "0.4.5",
      },
      "packages/sdk": { name: "@glasstrace/sdk", version: "1.2.3" },
    },
    requires: true,
  };
  writeJson(join(root, "package-lock.json"), lockfile);
  return { lockfile, root };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("workspace package-lock invariant", () => {
  it("passes for the synchronized repository and complete fixture", () => {
    expect(() => assertWorkspaceLockfile(repositoryRoot)).not.toThrow();
    const { root } = fixture();
    expect(workspaceLockfileViolations(root)).toEqual([]);
  });

  it("reports stale versions, missing workspace entries, and broken links", () => {
    const { lockfile, root } = fixture();
    lockfile.packages["packages/sdk"].version = "1.2.2";
    delete lockfile.packages["packages/protocol"];
    lockfile.packages["node_modules/@glasstrace/sdk"].resolved =
      "packages/attacker";
    writeJson(join(root, "package-lock.json"), lockfile);

    expect(workspaceLockfileViolations(root)).toEqual([
      "packages/protocol: workspace entry is missing from package-lock.json",
      "packages/sdk: package.json is 1.2.3 but package-lock.json is 1.2.2",
      "packages/sdk: package-lock.json link node_modules/@glasstrace/sdk does not resolve to the workspace",
    ]);
  });

  it("fails closed for unsupported globs and malformed workspace metadata", () => {
    const { root } = fixture();
    writeJson(join(root, "package.json"), {
      name: "fixture",
      private: true,
      workspaces: ["packages/**"],
    });
    expect(() => workspaceLockfileViolations(root)).toThrow(
      "Unsupported workspace pattern",
    );

    writeJson(join(root, "package.json"), {
      name: "fixture",
      private: true,
    });
    expect(() => workspaceLockfileViolations(root)).toThrow(
      "must declare npm workspaces",
    );

    writeJson(join(root, "package.json"), {
      name: "fixture",
      private: true,
      workspaces: ["packages/*"],
    });
    writeJson(join(root, "packages/sdk/package.json"), {
      name: "@glasstrace/sdk",
    });
    expect(workspaceLockfileViolations(root)).toContain(
      "packages/sdk: package version is missing",
    );
  });

  it("runs Changesets before the deterministic npm lock refresh and invariant", () => {
    const { root } = fixture();
    const calls: { args: string[]; command: string; cwd: string }[] = [];

    versionPackages(root, (command, args, cwd) => {
      calls.push({ args, command, cwd });
    });

    expect(calls).toEqual([
      {
        args: [join(root, "node_modules/@changesets/cli/bin.js"), "version"],
        command: process.execPath,
        cwd: root,
      },
      {
        args: [
          "install",
          "--package-lock-only",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
        command: process.platform === "win32" ? "npm.cmd" : "npm",
        cwd: root,
      },
    ]);

    const packageJson = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    );
    expect(packageJson.scripts).toMatchObject({
      "check:workspace-lock": "node scripts/check-workspace-lockfile.mjs",
      "version-packages": "node scripts/version-packages.mjs",
    });
  });

  it("routes canary snapshot versioning through lock refresh before the invariant", () => {
    const { lockfile, root } = fixture();
    const calls: { args: string[]; command: string }[] = [];

    versionPackages(
      root,
      (command, args) => {
        calls.push({ args, command });
        if (calls.length === 1) {
          writeJson(join(root, "packages/sdk/package.json"), {
            name: "@glasstrace/sdk",
            version: "0.0.0-canary-20260827210000",
          });
          expect(workspaceLockfileViolations(root)).toContain(
            "packages/sdk: package.json is 0.0.0-canary-20260827210000 but package-lock.json is 1.2.3",
          );
          return;
        }
        lockfile.packages["packages/sdk"].version =
          "0.0.0-canary-20260827210000";
        writeJson(join(root, "package-lock.json"), lockfile);
      },
      ["--snapshot", "canary"],
    );

    expect(calls).toEqual([
      {
        args: [
          join(root, "node_modules/@changesets/cli/bin.js"),
          "version",
          "--snapshot",
          "canary",
        ],
        command: process.execPath,
      },
      {
        args: [
          "install",
          "--package-lock-only",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
        command: process.platform === "win32" ? "npm.cmd" : "npm",
      },
    ]);
    expect(workspaceLockfileViolations(root)).toEqual([]);
  });

  it("rejects every versioning argument shape except the exact canary snapshot", () => {
    const { root } = fixture();
    const runner = () => {
      throw new Error("invalid arguments must fail before a command runs");
    };

    for (const args of [
      ["--snapshot"],
      ["--snapshot", "beta"],
      ["--snapshot", "canary", "--tag", "next"],
      ["--help"],
    ]) {
      expect(() => versionPackages(root, runner, args)).toThrow(
        "accepts only no arguments or exactly --snapshot canary",
      );
    }
  });
});
