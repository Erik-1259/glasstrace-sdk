import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  resolveProjectRoot,
  isMonorepoRoot,
  findNextJsApps,
  parsePnpmWorkspaceYaml,
} from "../../../../packages/sdk/src/cli/monorepo.js";

let tmpDir: string;

/** Creates a temporary directory for each test. */
function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "glasstrace-monorepo-test-"));
}

/** Creates a minimal package.json in the given directory. */
function writePackageJson(dir: string, content: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "test", ...content }, null, 2),
  );
}

/** Creates a Next.js config file in the given directory. */
function writeNextConfig(dir: string, name = "next.config.ts"): void {
  fs.writeFileSync(path.join(dir, name), "export default {};\n");
}

/** Creates a pnpm-workspace.yaml in the given directory. */
function writePnpmWorkspace(dir: string, content: string): void {
  fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), content);
}

beforeEach(() => {
  tmpDir = createTmpDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveProjectRoot
// ---------------------------------------------------------------------------

describe("resolveProjectRoot", () => {
  it("returns cwd when it contains next.config.ts", () => {
    writePackageJson(tmpDir);
    writeNextConfig(tmpDir, "next.config.ts");

    const result = resolveProjectRoot(tmpDir);

    expect(result.projectRoot).toBe(tmpDir);
    expect(result.isMonorepo).toBe(false);
    expect(result.appRelativePath).toBeUndefined();
  });

  it("returns cwd when it contains next.config.js", () => {
    writePackageJson(tmpDir);
    writeNextConfig(tmpDir, "next.config.js");

    const result = resolveProjectRoot(tmpDir);

    expect(result.projectRoot).toBe(tmpDir);
    expect(result.isMonorepo).toBe(false);
  });

  it("returns cwd when it contains next.config.mjs", () => {
    writePackageJson(tmpDir);
    writeNextConfig(tmpDir, "next.config.mjs");

    const result = resolveProjectRoot(tmpDir);

    expect(result.projectRoot).toBe(tmpDir);
    expect(result.isMonorepo).toBe(false);
  });

  it("resolves single Next.js app from pnpm monorepo", () => {
    writePackageJson(tmpDir);
    writePnpmWorkspace(tmpDir, 'packages:\n  - "apps/*"\n');

    const appDir = path.join(tmpDir, "apps", "web");
    fs.mkdirSync(appDir, { recursive: true });
    writePackageJson(appDir, { name: "web" });
    writeNextConfig(appDir);

    const result = resolveProjectRoot(tmpDir);

    expect(result.projectRoot).toBe(appDir);
    expect(result.isMonorepo).toBe(true);
    expect(result.appRelativePath).toBe(path.join("apps", "web"));
  });

  it("resolves single Next.js app from npm workspaces monorepo", () => {
    writePackageJson(tmpDir, { workspaces: ["packages/*"] });

    const appDir = path.join(tmpDir, "packages", "my-app");
    fs.mkdirSync(appDir, { recursive: true });
    writePackageJson(appDir, { name: "my-app" });
    writeNextConfig(appDir, "next.config.js");

    const result = resolveProjectRoot(tmpDir);

    expect(result.projectRoot).toBe(appDir);
    expect(result.isMonorepo).toBe(true);
    expect(result.appRelativePath).toBe(path.join("packages", "my-app"));
  });

  it("returns cwd when package.json has next dependency but no config file", () => {
    writePackageJson(tmpDir, { dependencies: { next: "^14.0.0", react: "^18.0.0" } });

    const result = resolveProjectRoot(tmpDir);

    expect(result.projectRoot).toBe(tmpDir);
    expect(result.isMonorepo).toBe(false);
  });

  it("returns cwd when package.json has next as devDependency but no config file", () => {
    writePackageJson(tmpDir, { devDependencies: { next: "^14.0.0" } });

    const result = resolveProjectRoot(tmpDir);

    expect(result.projectRoot).toBe(tmpDir);
    expect(result.isMonorepo).toBe(false);
  });

  it("throws when monorepo has multiple Next.js apps", () => {
    writePackageJson(tmpDir, { workspaces: ["apps/*"] });

    const webDir = path.join(tmpDir, "apps", "web");
    const docsDir = path.join(tmpDir, "apps", "docs");
    fs.mkdirSync(webDir, { recursive: true });
    fs.mkdirSync(docsDir, { recursive: true });
    writePackageJson(webDir, { name: "web" });
    writePackageJson(docsDir, { name: "docs" });
    writeNextConfig(webDir);
    writeNextConfig(docsDir);

    expect(() => resolveProjectRoot(tmpDir)).toThrow("Found multiple Next.js apps");
    expect(() => resolveProjectRoot(tmpDir)).toThrow(path.join("apps", "web"));
    expect(() => resolveProjectRoot(tmpDir)).toThrow(path.join("apps", "docs"));
    expect(() => resolveProjectRoot(tmpDir)).toThrow("Run init from the specific app directory");
  });

  it("throws when monorepo has no Next.js apps", () => {
    writePackageJson(tmpDir, { workspaces: ["packages/*"] });

    const libDir = path.join(tmpDir, "packages", "lib");
    fs.mkdirSync(libDir, { recursive: true });
    writePackageJson(libDir, { name: "lib" });

    expect(() => resolveProjectRoot(tmpDir)).toThrow(
      "no Next.js apps were found in workspace packages",
    );
  });

  it("throws specific error when monorepo has no workspace config (turbo.json only)", () => {
    writePackageJson(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "turbo.json"), "{}");

    expect(() => resolveProjectRoot(tmpDir)).toThrow(
      "no workspace configuration found",
    );
    expect(() => resolveProjectRoot(tmpDir)).toThrow(
      "pnpm-workspace.yaml",
    );
  });

  it("throws when directory is neither Next.js app nor monorepo", () => {
    writePackageJson(tmpDir);

    expect(() => resolveProjectRoot(tmpDir)).toThrow("No Next.js project found");
    expect(() => resolveProjectRoot(tmpDir)).toThrow(
      "Run this command from your Next.js app directory",
    );
  });

  it("prefers Next.js app detection over monorepo detection", () => {
    // A directory that has both a next.config and monorepo markers
    // should be treated as a Next.js app (e.g., monorepo root that is also the app)
    writePackageJson(tmpDir, { workspaces: ["packages/*"] });
    writeNextConfig(tmpDir);

    const result = resolveProjectRoot(tmpDir);

    expect(result.projectRoot).toBe(tmpDir);
    expect(result.isMonorepo).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isMonorepoRoot
// ---------------------------------------------------------------------------

describe("isMonorepoRoot", () => {
  it("detects pnpm-workspace.yaml", () => {
    writePnpmWorkspace(tmpDir, "packages:\n  - packages/*\n");
    expect(isMonorepoRoot(tmpDir)).toBe(true);
  });

  it("detects turbo.json", () => {
    fs.writeFileSync(path.join(tmpDir, "turbo.json"), "{}");
    expect(isMonorepoRoot(tmpDir)).toBe(true);
  });

  it("detects lerna.json", () => {
    fs.writeFileSync(
      path.join(tmpDir, "lerna.json"),
      JSON.stringify({ packages: ["packages/*"] }),
    );
    expect(isMonorepoRoot(tmpDir)).toBe(true);
  });

  it("detects package.json workspaces array", () => {
    writePackageJson(tmpDir, { workspaces: ["packages/*"] });
    expect(isMonorepoRoot(tmpDir)).toBe(true);
  });

  it("detects package.json workspaces object form", () => {
    writePackageJson(tmpDir, {
      workspaces: { packages: ["apps/*"] },
    });
    expect(isMonorepoRoot(tmpDir)).toBe(true);
  });

  it("returns false for plain project", () => {
    writePackageJson(tmpDir);
    expect(isMonorepoRoot(tmpDir)).toBe(false);
  });

  it("returns false for empty directory", () => {
    expect(isMonorepoRoot(tmpDir)).toBe(false);
  });

  it("handles invalid package.json gracefully", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), "not json");
    expect(isMonorepoRoot(tmpDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findNextJsApps
// ---------------------------------------------------------------------------

describe("findNextJsApps", () => {
  it("finds app from pnpm workspace glob", () => {
    writePnpmWorkspace(tmpDir, 'packages:\n  - "apps/*"\n');
    writePackageJson(tmpDir);

    const appDir = path.join(tmpDir, "apps", "web");
    fs.mkdirSync(appDir, { recursive: true });
    writePackageJson(appDir, { name: "web" });
    writeNextConfig(appDir);

    const apps = findNextJsApps(tmpDir);
    expect(apps).toEqual([appDir]);
  });

  it("finds app from package.json workspaces", () => {
    writePackageJson(tmpDir, { workspaces: ["apps/*"] });

    const appDir = path.join(tmpDir, "apps", "web");
    fs.mkdirSync(appDir, { recursive: true });
    writePackageJson(appDir, { name: "web" });
    writeNextConfig(appDir, "next.config.js");

    const apps = findNextJsApps(tmpDir);
    expect(apps).toEqual([appDir]);
  });

  it("finds app from package.json workspaces object form", () => {
    writePackageJson(tmpDir, {
      workspaces: { packages: ["apps/*"] },
    });

    const appDir = path.join(tmpDir, "apps", "dashboard");
    fs.mkdirSync(appDir, { recursive: true });
    writePackageJson(appDir, { name: "dashboard" });
    writeNextConfig(appDir, "next.config.mjs");

    const apps = findNextJsApps(tmpDir);
    expect(apps).toEqual([appDir]);
  });

  it("finds app from lerna packages", () => {
    fs.writeFileSync(
      path.join(tmpDir, "lerna.json"),
      JSON.stringify({ packages: ["packages/*"] }),
    );
    writePackageJson(tmpDir);

    const appDir = path.join(tmpDir, "packages", "frontend");
    fs.mkdirSync(appDir, { recursive: true });
    writePackageJson(appDir, { name: "frontend" });
    writeNextConfig(appDir);

    const apps = findNextJsApps(tmpDir);
    expect(apps).toEqual([appDir]);
  });

  it("finds app via next dependency when no config file exists", () => {
    writePackageJson(tmpDir, { workspaces: ["apps/*"] });

    const appDir = path.join(tmpDir, "apps", "web");
    fs.mkdirSync(appDir, { recursive: true });
    writePackageJson(appDir, { name: "web", dependencies: { next: "^14.0.0" } });

    const apps = findNextJsApps(tmpDir);
    expect(apps).toEqual([appDir]);
  });

  it("excludes directories matching pnpm negation patterns", () => {
    writePnpmWorkspace(tmpDir, 'packages:\n  - "apps/*"\n  - "!apps/internal"\n');
    writePackageJson(tmpDir);

    const webDir = path.join(tmpDir, "apps", "web");
    const internalDir = path.join(tmpDir, "apps", "internal");
    fs.mkdirSync(webDir, { recursive: true });
    fs.mkdirSync(internalDir, { recursive: true });
    writePackageJson(webDir, { name: "web" });
    writePackageJson(internalDir, { name: "internal" });
    writeNextConfig(webDir);
    writeNextConfig(internalDir);

    const apps = findNextJsApps(tmpDir);
    expect(apps).toEqual([webDir]);
    expect(apps).not.toContain(internalDir);
  });

  it("returns empty array when no workspace dirs have next.config or next dependency", () => {
    writePackageJson(tmpDir, { workspaces: ["packages/*"] });

    const libDir = path.join(tmpDir, "packages", "lib");
    fs.mkdirSync(libDir, { recursive: true });
    writePackageJson(libDir, { name: "lib" });

    const apps = findNextJsApps(tmpDir);
    expect(apps).toEqual([]);
  });

  it("throws when monorepo marker exists but no workspace globs found", () => {
    writePackageJson(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "turbo.json"), "{}");

    expect(() => findNextJsApps(tmpDir)).toThrow(
      "no workspace configuration found",
    );
  });

  it("returns multiple apps when found", () => {
    writePackageJson(tmpDir, { workspaces: ["apps/*"] });

    const webDir = path.join(tmpDir, "apps", "web");
    const docsDir = path.join(tmpDir, "apps", "docs");
    fs.mkdirSync(webDir, { recursive: true });
    fs.mkdirSync(docsDir, { recursive: true });
    writePackageJson(webDir, { name: "web" });
    writePackageJson(docsDir, { name: "docs" });
    writeNextConfig(webDir);
    writeNextConfig(docsDir);

    const apps = findNextJsApps(tmpDir);
    expect(apps).toHaveLength(2);
    expect(apps).toContain(webDir);
    expect(apps).toContain(docsDir);
  });

  it("deduplicates apps found via multiple config sources", () => {
    // Both pnpm-workspace.yaml and package.json reference the same glob
    writePackageJson(tmpDir, { workspaces: ["apps/*"] });
    writePnpmWorkspace(tmpDir, "packages:\n  - apps/*\n");

    const appDir = path.join(tmpDir, "apps", "web");
    fs.mkdirSync(appDir, { recursive: true });
    writePackageJson(appDir, { name: "web" });
    writeNextConfig(appDir);

    const apps = findNextJsApps(tmpDir);
    expect(apps).toEqual([appDir]);
  });

  it("handles literal workspace path (no glob)", () => {
    writePackageJson(tmpDir, { workspaces: ["apps/web"] });

    const appDir = path.join(tmpDir, "apps", "web");
    fs.mkdirSync(appDir, { recursive: true });
    writePackageJson(appDir, { name: "web" });
    writeNextConfig(appDir);

    const apps = findNextJsApps(tmpDir);
    expect(apps).toEqual([appDir]);
  });

  it("skips nonexistent workspace directories", () => {
    writePackageJson(tmpDir, { workspaces: ["nonexistent/*"] });

    const apps = findNextJsApps(tmpDir);
    expect(apps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parsePnpmWorkspaceYaml
// ---------------------------------------------------------------------------

describe("parsePnpmWorkspaceYaml", () => {
  it("parses double-quoted entries", () => {
    const yaml = 'packages:\n  - "apps/*"\n  - "packages/*"\n';
    const result = parsePnpmWorkspaceYaml(yaml);
    expect(result.includeGlobs).toEqual(["apps/*", "packages/*"]);
    expect(result.negationPatterns).toEqual([]);
  });

  it("parses single-quoted entries", () => {
    const yaml = "packages:\n  - 'apps/*'\n";
    const result = parsePnpmWorkspaceYaml(yaml);
    expect(result.includeGlobs).toEqual(["apps/*"]);
    expect(result.negationPatterns).toEqual([]);
  });

  it("parses unquoted entries", () => {
    const yaml = "packages:\n  - apps/*\n  - packages/*\n";
    const result = parsePnpmWorkspaceYaml(yaml);
    expect(result.includeGlobs).toEqual(["apps/*", "packages/*"]);
    expect(result.negationPatterns).toEqual([]);
  });

  it("handles mixed quoted and unquoted entries", () => {
    const yaml = 'packages:\n  - "apps/*"\n  - packages/*\n';
    const result = parsePnpmWorkspaceYaml(yaml);
    expect(result.includeGlobs).toEqual(["apps/*", "packages/*"]);
    expect(result.negationPatterns).toEqual([]);
  });

  it("separates negation patterns from include globs", () => {
    const yaml = 'packages:\n  - "apps/*"\n  - "!apps/internal"\n';
    const result = parsePnpmWorkspaceYaml(yaml);
    expect(result.includeGlobs).toEqual(["apps/*"]);
    expect(result.negationPatterns).toEqual(["apps/internal"]);
  });

  it("returns empty arrays for empty content", () => {
    const result = parsePnpmWorkspaceYaml("");
    expect(result.includeGlobs).toEqual([]);
    expect(result.negationPatterns).toEqual([]);
  });

  it("returns empty arrays when no packages key exists", () => {
    const yaml = "other:\n  - something\n";
    const result = parsePnpmWorkspaceYaml(yaml);
    expect(result.includeGlobs).toEqual([]);
    expect(result.negationPatterns).toEqual([]);
  });

  it("stops at the next top-level key", () => {
    const yaml = "packages:\n  - apps/*\ncatalog:\n  - something\n";
    const result = parsePnpmWorkspaceYaml(yaml);
    expect(result.includeGlobs).toEqual(["apps/*"]);
    expect(result.negationPatterns).toEqual([]);
  });

  it("handles trailing whitespace in values", () => {
    const yaml = "packages:\n  - apps/*   \n";
    const result = parsePnpmWorkspaceYaml(yaml);
    expect(result.includeGlobs).toEqual(["apps/*"]);
    expect(result.negationPatterns).toEqual([]);
  });

  it("handles multiple negation patterns", () => {
    const yaml = 'packages:\n  - "apps/*"\n  - "!apps/internal"\n  - "!apps/test"\n';
    const result = parsePnpmWorkspaceYaml(yaml);
    expect(result.includeGlobs).toEqual(["apps/*"]);
    expect(result.negationPatterns).toEqual(["apps/internal", "apps/test"]);
  });
});

// ---------------------------------------------------------------------------
// Integration with runInit
// ---------------------------------------------------------------------------

describe("runInit — monorepo integration", () => {
  // Lazy-import runInit to avoid pulling in heavy dependencies at module level
  async function loadRunInit() {
    const mod = await import("../../../../packages/sdk/src/cli/init.js");
    return mod.runInit;
  }

  it("auto-resolves single Next.js app from monorepo root", async () => {
    const runInit = await loadRunInit();

    // Set up monorepo structure
    writePackageJson(tmpDir, { workspaces: ["apps/*"] });
    const appDir = path.join(tmpDir, "apps", "web");
    fs.mkdirSync(appDir, { recursive: true });
    writePackageJson(appDir, { name: "web" });
    writeNextConfig(appDir);

    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });

    expect(result.exitCode).toBe(0);
    // Summary should mention auto-resolution
    expect(result.summary.some((s: string) => s.includes("Found Next.js app"))).toBe(true);
    expect(result.summary.some((s: string) => s.includes(path.join("apps", "web")))).toBe(true);
    // Scaffolding should have happened in the app directory, not the root
    expect(fs.existsSync(path.join(appDir, "instrumentation.ts"))).toBe(true);
    expect(fs.existsSync(path.join(appDir, ".env.local"))).toBe(true);
  });

  it("fails with error when monorepo has no Next.js apps", async () => {
    const runInit = await loadRunInit();

    writePackageJson(tmpDir, { workspaces: ["packages/*"] });
    const libDir = path.join(tmpDir, "packages", "lib");
    fs.mkdirSync(libDir, { recursive: true });
    writePackageJson(libDir, { name: "lib" });

    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.errors.some((e: string) => e.includes("no Next.js apps"))).toBe(true);
  });

  it("fails with error when directory is neither Next.js nor monorepo", async () => {
    const runInit = await loadRunInit();

    writePackageJson(tmpDir);

    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.errors.some((e: string) => e.includes("No Next.js project found"))).toBe(true);
  });
});
