import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  scaffoldInstrumentation,
  scaffoldNextConfig,
  scaffoldEnvLocal,
  scaffoldGitignore,
  scaffoldMcpMarker,
  addCoverageMapEnv,
} from "../../../packages/sdk/src/cli/scaffolder.js";
import { runInit, meetsNodeVersion } from "../../../packages/sdk/src/cli/init.js";

let tmpDir: string;

function createTmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glasstrace-cli-test-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "test-project" }));
  return dir;
}

beforeEach(() => {
  tmpDir = createTmpProject();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("scaffoldInstrumentation", () => {
  it("creates instrumentation.ts with registerGlasstrace call", async () => {
    const result = await scaffoldInstrumentation(tmpDir, false);
    expect(result).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, "instrumentation.ts"), "utf-8");
    expect(content).toContain("registerGlasstrace");
    expect(content).toContain("import");
  });

  it("includes Prisma initialization order comment", async () => {
    await scaffoldInstrumentation(tmpDir, false);
    const content = fs.readFileSync(path.join(tmpDir, "instrumentation.ts"), "utf-8");
    expect(content.toLowerCase()).toContain("prisma");
  });

  it("returns false when file exists and force is false", async () => {
    fs.writeFileSync(path.join(tmpDir, "instrumentation.ts"), "existing content");
    const result = await scaffoldInstrumentation(tmpDir, false);
    expect(result).toBe(false);
    // Original content should be unchanged
    const content = fs.readFileSync(path.join(tmpDir, "instrumentation.ts"), "utf-8");
    expect(content).toBe("existing content");
  });

  it("overwrites when force is true", async () => {
    fs.writeFileSync(path.join(tmpDir, "instrumentation.ts"), "existing content");
    const result = await scaffoldInstrumentation(tmpDir, true);
    expect(result).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, "instrumentation.ts"), "utf-8");
    expect(content).toContain("registerGlasstrace");
  });
});

describe("scaffoldNextConfig", () => {
  it("detects next.config.js and wraps with withGlasstraceConfig", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.js"),
      "const nextConfig = {};\nmodule.exports = nextConfig;\n",
    );
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toEqual({ modified: true });
    // CJS .js is wrapped in-place (no rename to .mjs)
    const content = fs.readFileSync(path.join(tmpDir, "next.config.js"), "utf-8");
    expect(content).toContain("withGlasstraceConfig");
    expect(content).toContain("@glasstrace/sdk");
    // File should NOT be renamed
    expect(fs.existsSync(path.join(tmpDir, "next.config.js"))).toBe(true);
  });

  it("CJS .js uses require() and wraps module.exports in place", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.js"),
      "const nextConfig = {};\nmodule.exports = nextConfig;\n",
    );
    await scaffoldNextConfig(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, "next.config.js"), "utf-8");
    // Should use CJS require, not ESM import
    expect(content).toContain('const { withGlasstraceConfig } = require("@glasstrace/sdk")');
    expect(content).not.toContain("import ");
    // Should wrap module.exports, not convert to export default
    expect(content).toContain("module.exports = withGlasstraceConfig(nextConfig)");
    expect(content).not.toContain("export default");
    // Should NOT have createRequire shim (no longer needed)
    expect(content).not.toContain("createRequire");
  });

  it("CJS wrapping preserves existing require() calls in preamble", async () => {
    const original = `const withBundleAnalyzer = require("@next/bundle-analyzer")({ enabled: true });
const nextConfig = { reactStrictMode: true };
module.exports = withBundleAnalyzer(nextConfig);
`;
    fs.writeFileSync(path.join(tmpDir, "next.config.js"), original);
    await scaffoldNextConfig(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, "next.config.js"), "utf-8");
    // Original require() call should be preserved in the preamble
    expect(content).toContain('require("@next/bundle-analyzer")');
    expect(content).toContain("withGlasstraceConfig");
    expect(content).toContain("module.exports = withGlasstraceConfig(withBundleAnalyzer(nextConfig))");
  });

  it("detects next.config.ts", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      "const nextConfig = {};\nexport default nextConfig;\n",
    );
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toEqual({ modified: true });
    const content = fs.readFileSync(path.join(tmpDir, "next.config.ts"), "utf-8");
    expect(content).toContain("withGlasstraceConfig");
  });

  it("generates syntactically correct wrapped config (ESM)", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      "const nextConfig = {};\nexport default nextConfig;\n",
    );
    await scaffoldNextConfig(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, "next.config.ts"), "utf-8");
    // Should produce: export default withGlasstraceConfig(nextConfig);
    expect(content).toContain("withGlasstraceConfig(nextConfig)");
    // Should not have double semicolons or broken syntax
    expect(content).not.toContain(";;");
    expect(content).not.toContain("nextConfig;\n)");
  });

  it("generates syntactically correct wrapped config (CJS in place)", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.js"),
      "const nextConfig = {};\nmodule.exports = nextConfig;\n",
    );
    await scaffoldNextConfig(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, "next.config.js"), "utf-8");
    expect(content).toContain("module.exports = withGlasstraceConfig(nextConfig)");
    expect(content).not.toContain(";;");
  });

  it("detects next.config.mjs", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.mjs"),
      "const nextConfig = {};\nexport default nextConfig;\n",
    );
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toEqual({ modified: true });
    const content = fs.readFileSync(path.join(tmpDir, "next.config.mjs"), "utf-8");
    expect(content).toContain("withGlasstraceConfig");
  });

  it("returns null when no next.config.* found", async () => {
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toBeNull();
  });

  it("does not duplicate wrapper if already present", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.js"),
      'const { withGlasstraceConfig } = require("@glasstrace/sdk");\nmodule.exports = withGlasstraceConfig({});\n',
    );
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toEqual({ modified: false, reason: "already-wrapped" });
  });

  it("handles ESM export without trailing semicolon", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      "const nextConfig = {};\nexport default nextConfig\n",
    );
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toEqual({ modified: true });
    const content = fs.readFileSync(path.join(tmpDir, "next.config.ts"), "utf-8");
    expect(content).toContain("withGlasstraceConfig(nextConfig)");
    // Must not produce broken syntax like withGlasstraceConfig(nextConfig;)
    expect(content).not.toContain("nextConfig;)");
  });

  it("handles CJS export without trailing semicolon", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.js"),
      "const nextConfig = {};\nmodule.exports = nextConfig\n",
    );
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toEqual({ modified: true });
    const content = fs.readFileSync(path.join(tmpDir, "next.config.js"), "utf-8");
    expect(content).toContain("module.exports = withGlasstraceConfig(nextConfig)");
    expect(content).not.toContain("nextConfig;)");
  });

  it("handles multiline ESM object literal export", async () => {
    const original = `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  images: {
    domains: ["example.com"],
  },
};

export default nextConfig;
`;
    fs.writeFileSync(path.join(tmpDir, "next.config.ts"), original);
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toEqual({ modified: true });
    const content = fs.readFileSync(path.join(tmpDir, "next.config.ts"), "utf-8");
    expect(content).toContain("export default withGlasstraceConfig(nextConfig);");
    // Original config declarations should be preserved
    expect(content).toContain("reactStrictMode: true");
  });

  it("handles multiline CJS object literal export", async () => {
    const original = `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

module.exports = nextConfig;
`;
    fs.writeFileSync(path.join(tmpDir, "next.config.js"), original);
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toEqual({ modified: true });
    const content = fs.readFileSync(path.join(tmpDir, "next.config.js"), "utf-8");
    expect(content).toContain("module.exports = withGlasstraceConfig(nextConfig)");
    expect(content).toContain("reactStrictMode: true");
    expect(content).toContain('require("@glasstrace/sdk")');
  });

  it("handles inline object literal export (ESM)", async () => {
    const original = `export default {
  reactStrictMode: true,
  images: {
    domains: ["example.com"],
  },
};
`;
    fs.writeFileSync(path.join(tmpDir, "next.config.mjs"), original);
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toEqual({ modified: true });
    const content = fs.readFileSync(path.join(tmpDir, "next.config.mjs"), "utf-8");
    expect(content).toContain("withGlasstraceConfig({");
    expect(content).toContain("reactStrictMode: true");
    expect(content).toContain("});");
  });

  it("handles inline object literal export (CJS)", async () => {
    const original = `module.exports = {
  reactStrictMode: true,
};
`;
    fs.writeFileSync(path.join(tmpDir, "next.config.js"), original);
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toEqual({ modified: true });
    const content = fs.readFileSync(path.join(tmpDir, "next.config.js"), "utf-8");
    expect(content).toContain("module.exports = withGlasstraceConfig({");
    expect(content).toContain("reactStrictMode: true");
    expect(content).toContain('require("@glasstrace/sdk")');
  });

  it("does not double-wrap an already-wrapped config", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.js"),
      'const { withGlasstraceConfig } = require("@glasstrace/sdk");\nmodule.exports = withGlasstraceConfig({});\n',
    );
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toEqual({ modified: false, reason: "already-wrapped" });
  });

  it("CJS: returns no-export reason when module.exports has no equals sign", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.js"),
      "module.exports\n",
    );
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toEqual({ modified: false, reason: "no-export" });
    // File should not be modified
    expect(fs.existsSync(path.join(tmpDir, "next.config.js"))).toBe(true);
  });

  it("CJS: returns no-export reason when expression after module.exports = is empty", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.js"),
      "module.exports = ;\n",
    );
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toEqual({ modified: false, reason: "no-export" });
  });

  it("ESM: returns no-export reason when export default has no expression", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      "export default\n",
    );
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toEqual({ modified: false, reason: "no-export" });
  });

  it("ESM: returns no-export reason when no export default found", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      "const config = {};\n",
    );
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toEqual({ modified: false, reason: "no-export" });
  });

  it("CJS: returns no-export reason when no module.exports found", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.js"),
      "const config = {};\n",
    );
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toEqual({ modified: false, reason: "no-export" });
  });

  it("handles ESM export with trailing whitespace", async () => {
    // Verify the scaffolder handles trailing whitespace after the expression
    const original = "const nextConfig = {};\nexport default nextConfig  ;  \n";
    fs.writeFileSync(path.join(tmpDir, "next.config.ts"), original);
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toEqual({ modified: true });
    const content = fs.readFileSync(path.join(tmpDir, "next.config.ts"), "utf-8");
    expect(content).toContain("withGlasstraceConfig");
  });

  it("returns empty-file reason for empty config file", async () => {
    fs.writeFileSync(path.join(tmpDir, "next.config.ts"), "");
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toEqual({ modified: false, reason: "empty-file" });
  });
});

describe("scaffoldEnvLocal", () => {
  it("creates .env.local with commented GLASSTRACE_API_KEY", async () => {
    const result = await scaffoldEnvLocal(tmpDir);
    expect(result).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, ".env.local"), "utf-8");
    expect(content).toContain("# GLASSTRACE_API_KEY=your_key_here");
  });

  it("appends to existing .env.local if key not present", async () => {
    fs.writeFileSync(path.join(tmpDir, ".env.local"), "OTHER_KEY=value\n");
    const result = await scaffoldEnvLocal(tmpDir);
    expect(result).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, ".env.local"), "utf-8");
    expect(content).toContain("OTHER_KEY=value");
    expect(content).toContain("# GLASSTRACE_API_KEY=your_key_here");
  });

  it("does not false-positive on similarly named keys", async () => {
    fs.writeFileSync(path.join(tmpDir, ".env.local"), "GLASSTRACE_API_KEY_OLD=abc\n");
    const result = await scaffoldEnvLocal(tmpDir);
    expect(result).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, ".env.local"), "utf-8");
    expect(content).toContain("# GLASSTRACE_API_KEY=your_key_here");
    expect(content).toContain("GLASSTRACE_API_KEY_OLD=abc");
  });

  it("does not duplicate when commented key already exists", async () => {
    fs.writeFileSync(path.join(tmpDir, ".env.local"), "# GLASSTRACE_API_KEY=your_key_here\n");
    const result = await scaffoldEnvLocal(tmpDir);
    expect(result).toBe(false);
  });

  it("does not add duplicate GLASSTRACE_API_KEY", async () => {
    fs.writeFileSync(path.join(tmpDir, ".env.local"), "GLASSTRACE_API_KEY=gt_dev_123\n");
    const result = await scaffoldEnvLocal(tmpDir);
    expect(result).toBe(false);
    const content = fs.readFileSync(path.join(tmpDir, ".env.local"), "utf-8");
    // Should only have one occurrence
    const matches = content.match(/GLASSTRACE_API_KEY/g);
    expect(matches?.length).toBe(1);
  });
});

describe("addCoverageMapEnv", () => {
  it("updates GLASSTRACE_COVERAGE_MAP=false to true", async () => {
    fs.writeFileSync(path.join(tmpDir, ".env.local"), "GLASSTRACE_COVERAGE_MAP=false\n");
    const result = await addCoverageMapEnv(tmpDir);
    expect(result).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, ".env.local"), "utf-8");
    expect(content).toContain("GLASSTRACE_COVERAGE_MAP=true");
    expect(content).not.toContain("GLASSTRACE_COVERAGE_MAP=false");
  });

  it("returns false when already set to true", async () => {
    fs.writeFileSync(path.join(tmpDir, ".env.local"), "GLASSTRACE_COVERAGE_MAP=true\n");
    const result = await addCoverageMapEnv(tmpDir);
    expect(result).toBe(false);
  });

  it("creates the env var when file exists without it", async () => {
    fs.writeFileSync(path.join(tmpDir, ".env.local"), "OTHER_KEY=value\n");
    const result = await addCoverageMapEnv(tmpDir);
    expect(result).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, ".env.local"), "utf-8");
    expect(content).toContain("GLASSTRACE_COVERAGE_MAP=true");
  });

  it("creates the file when it does not exist", async () => {
    const result = await addCoverageMapEnv(tmpDir);
    expect(result).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, ".env.local"), "utf-8");
    expect(content).toContain("GLASSTRACE_COVERAGE_MAP=true");
  });
});

describe("scaffoldGitignore", () => {
  it("creates .gitignore with .glasstrace/", async () => {
    // Remove any existing .gitignore
    const gitignorePath = path.join(tmpDir, ".gitignore");
    if (fs.existsSync(gitignorePath)) {
      fs.unlinkSync(gitignorePath);
    }
    const result = await scaffoldGitignore(tmpDir);
    expect(result).toBe(true);
    const content = fs.readFileSync(gitignorePath, "utf-8");
    expect(content).toContain(".glasstrace/");
  });

  it("appends to existing .gitignore", async () => {
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "node_modules/\n");
    const result = await scaffoldGitignore(tmpDir);
    expect(result).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf-8");
    expect(content).toContain("node_modules/");
    expect(content).toContain(".glasstrace/");
  });

  it("does not add duplicate .glasstrace/ entry", async () => {
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), ".glasstrace/\n");
    const result = await scaffoldGitignore(tmpDir);
    expect(result).toBe(false);
    const content = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf-8");
    const matches = content.match(/\.glasstrace\//g);
    expect(matches?.length).toBe(1);
  });
});

describe("runInit — CLI flow", () => {
  it("scaffolds all files in a project", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.js"),
      "const nextConfig = {};\nmodule.exports = nextConfig;\n",
    );
    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, "instrumentation.ts"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".env.local"))).toBe(true);
    // .gitignore should have been created or modified
    const gitignore = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".glasstrace/");
  });

  it("error case: exits with code 1 when no package.json", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "glasstrace-cli-empty-"));
    try {
      const result = await runInit({
        projectRoot: emptyDir,
        yes: true,
        coverageMap: false,
      });
      expect(result.exitCode).toBe(1);
      expect(result.errors.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("non-interactive mode does not overwrite existing files", async () => {
    fs.writeFileSync(path.join(tmpDir, "instrumentation.ts"), "// custom content");
    fs.writeFileSync(path.join(tmpDir, ".env.local"), "GLASSTRACE_API_KEY=my-key\n");
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), ".glasstrace/\n");

    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });
    expect(result.exitCode).toBe(0);
    // Existing files should be unchanged
    const instrumentationContent = fs.readFileSync(path.join(tmpDir, "instrumentation.ts"), "utf-8");
    expect(instrumentationContent).toBe("// custom content");
  });

  it("returns summary of created/modified files", async () => {
    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("idempotent — running twice does not duplicate entries", async () => {
    await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });
    await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });
    // Check .gitignore has only one .glasstrace/ entry
    const gitignore = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf-8");
    const matches = gitignore.match(/\.glasstrace\//g);
    expect(matches?.length).toBe(1);
    // .env.local should have only one GLASSTRACE_API_KEY
    const envLocal = fs.readFileSync(path.join(tmpDir, ".env.local"), "utf-8");
    const envMatches = envLocal.match(/GLASSTRACE_API_KEY/g);
    expect(envMatches?.length).toBe(1);
  });

  it("error case: prints warning when no next.config.* found", async () => {
    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.warnings.some((w: string) => w.toLowerCase().includes("next.config"))).toBe(true);
  });

  it("adds GLASSTRACE_COVERAGE_MAP=true when coverageMap enabled", async () => {
    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: true,
    });
    expect(result.exitCode).toBe(0);
    const envLocal = fs.readFileSync(path.join(tmpDir, ".env.local"), "utf-8");
    expect(envLocal).toContain("GLASSTRACE_COVERAGE_MAP=true");
  });

  it("error case: import graph failure does not cause fatal exit", async () => {
    // Coverage map enabled, but import graph scan may fail. Should still succeed.
    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: true,
    });
    expect(result.exitCode).toBe(0);
  });
});

// --- MCP auto-configuration tests ---

/** A valid anonymous key matching `gt_anon_` + 48 hex chars. */
const TEST_ANON_KEY = "gt_anon_" + "a".repeat(48);

/** Provisions an anon key file in the .glasstrace directory. */
function provisionAnonKey(projectRoot: string, key: string = TEST_ANON_KEY): void {
  const dir = path.join(projectRoot, ".glasstrace");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "anon_key"), key, "utf-8");
}

/** Creates a Claude agent marker in the project. */
function createClaudeMarker(projectRoot: string): void {
  fs.mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
}

/** Creates a Cursor agent marker in the project. */
function createCursorMarker(projectRoot: string): void {
  fs.mkdirSync(path.join(projectRoot, ".cursor"), { recursive: true });
}

describe("scaffoldMcpMarker", () => {
  it("creates marker file with key hash and timestamp", async () => {
    const result = await scaffoldMcpMarker(tmpDir, TEST_ANON_KEY);
    expect(result).toBe(true);

    const markerPath = path.join(tmpDir, ".glasstrace", "mcp-connected");
    expect(fs.existsSync(markerPath)).toBe(true);

    const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as {
      keyHash: string;
      configuredAt: string;
    };
    const expectedHash = `sha256:${crypto.createHash("sha256").update(TEST_ANON_KEY).digest("hex")}`;
    expect(marker.keyHash).toBe(expectedHash);
    expect(marker.configuredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns false when marker exists with same key hash", async () => {
    await scaffoldMcpMarker(tmpDir, TEST_ANON_KEY);
    const result = await scaffoldMcpMarker(tmpDir, TEST_ANON_KEY);
    expect(result).toBe(false);
  });

  it("returns true when key changes", async () => {
    await scaffoldMcpMarker(tmpDir, TEST_ANON_KEY);
    const differentKey = "gt_anon_" + "b".repeat(48);
    const result = await scaffoldMcpMarker(tmpDir, differentKey);
    expect(result).toBe(true);
  });

  it("sets file permissions to 0o600", async () => {
    await scaffoldMcpMarker(tmpDir, TEST_ANON_KEY);
    const markerPath = path.join(tmpDir, ".glasstrace", "mcp-connected");
    const stats = fs.statSync(markerPath);
    // Check that only owner has read/write (0o600 = 0o100600 with file type bits)
    expect(stats.mode & 0o777).toBe(0o600);
  });
});

describe("runInit — MCP auto-configuration", () => {
  // Tests that exercise the interactive (non-CI) agent detection path need
  // to ensure CI is not set, since GitHub Actions sets CI=true by default.
  let savedCI: string | undefined;
  let savedGHA: string | undefined;

  function enterNonCI(): void {
    savedCI = process.env["CI"];
    savedGHA = process.env["GITHUB_ACTIONS"];
    delete process.env["CI"];
    delete process.env["GITHUB_ACTIONS"];
  }

  function restoreCI(): void {
    if (savedCI === undefined) {
      delete process.env["CI"];
    } else {
      process.env["CI"] = savedCI;
    }
    if (savedGHA === undefined) {
      delete process.env["GITHUB_ACTIONS"];
    } else {
      process.env["GITHUB_ACTIONS"] = savedGHA;
    }
  }

  it("creates MCP config files when agent markers are present", async () => {
    provisionAnonKey(tmpDir);
    createClaudeMarker(tmpDir);

    enterNonCI();
    try {
      const result = await runInit({
        projectRoot: tmpDir,
        yes: true,
        coverageMap: false,
      });

      expect(result.exitCode).toBe(0);
      // Claude's MCP config should be written to .mcp.json
      const mcpConfigPath = path.join(tmpDir, ".mcp.json");
      expect(fs.existsSync(mcpConfigPath)).toBe(true);
      const mcpConfig = fs.readFileSync(mcpConfigPath, "utf-8");
      expect(mcpConfig).toContain("glasstrace");
      expect(mcpConfig).toContain("api.glasstrace.dev/mcp");

      // Summary should mention the configured agent
      expect(result.summary.some((s: string) => s.includes("Claude Code"))).toBe(true);
    } finally {
      restoreCI();
    }
  });

  it("creates anon key and configures MCP on first run (no pre-existing key)", async () => {
    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });

    expect(result.exitCode).toBe(0);
    // No warning about missing key — getOrCreateAnonKey generates one
    expect(result.warnings.some((w: string) => w.includes("anonymous key"))).toBe(false);
    // Anon key file should now exist
    expect(fs.existsSync(path.join(tmpDir, ".glasstrace", "anon_key"))).toBe(true);
    // Marker should exist (MCP was configured)
    expect(fs.existsSync(path.join(tmpDir, ".glasstrace", "mcp-connected"))).toBe(true);
  });

  it("creates only generic config in CI mode", async () => {
    provisionAnonKey(tmpDir);
    createClaudeMarker(tmpDir);

    // Simulate CI by setting env var
    const originalCI = process.env["CI"];
    process.env["CI"] = "true";
    try {
      const result = await runInit({
        projectRoot: tmpDir,
        yes: true,
        coverageMap: false,
      });

      expect(result.exitCode).toBe(0);
      // Generic config should exist
      const genericPath = path.join(tmpDir, ".glasstrace", "mcp.json");
      expect(fs.existsSync(genericPath)).toBe(true);
      // Summary should indicate CI mode
      expect(result.summary.some((s: string) => s.includes("CI mode"))).toBe(true);
      // Agent-specific config should NOT be written (Claude's .mcp.json)
      expect(fs.existsSync(path.join(tmpDir, ".mcp.json"))).toBe(false);
    } finally {
      if (originalCI === undefined) {
        delete process.env["CI"];
      } else {
        process.env["CI"] = originalCI;
      }
    }
  });

  it("treats CI=1 as CI mode", async () => {
    provisionAnonKey(tmpDir);

    const originalCI = process.env["CI"];
    process.env["CI"] = "1";
    try {
      const result = await runInit({
        projectRoot: tmpDir,
        yes: true,
        coverageMap: false,
      });

      expect(result.exitCode).toBe(0);
      expect(result.summary.some((s: string) => s.includes("CI mode"))).toBe(true);
    } finally {
      if (originalCI === undefined) {
        delete process.env["CI"];
      } else {
        process.env["CI"] = originalCI;
      }
    }
  });

  it("creates MCP marker file with correct key hash", async () => {
    provisionAnonKey(tmpDir);

    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });

    expect(result.exitCode).toBe(0);
    const markerPath = path.join(tmpDir, ".glasstrace", "mcp-connected");
    expect(fs.existsSync(markerPath)).toBe(true);

    const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as {
      keyHash: string;
    };
    const expectedHash = `sha256:${crypto.createHash("sha256").update(TEST_ANON_KEY).digest("hex")}`;
    expect(marker.keyHash).toBe(expectedHash);
  });

  it("is idempotent — running twice does not duplicate MCP config", async () => {
    provisionAnonKey(tmpDir);
    createClaudeMarker(tmpDir);

    enterNonCI();
    try {
      await runInit({ projectRoot: tmpDir, yes: true, coverageMap: false });
      const firstContent = fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8");

      await runInit({ projectRoot: tmpDir, yes: true, coverageMap: false });
      const secondContent = fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8");

      // Config content should be identical (not doubled/corrupted)
      expect(secondContent).toBe(firstContent);

      // Gitignore should not have duplicate .mcp.json entries
      const gitignore = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf-8");
      const mcpMatches = gitignore.match(/\.mcp\.json/g);
      expect(mcpMatches?.length).toBe(1);
    } finally {
      restoreCI();
    }
  });

  it("adds MCP config paths to .gitignore", async () => {
    provisionAnonKey(tmpDir);

    await runInit({ projectRoot: tmpDir, yes: true, coverageMap: false });

    const gitignore = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".mcp.json");
    expect(gitignore).toContain(".cursor/mcp.json");
    expect(gitignore).toContain(".gemini/settings.json");
  });

  it("handles multiple agents simultaneously", async () => {
    provisionAnonKey(tmpDir);
    createClaudeMarker(tmpDir);
    createCursorMarker(tmpDir);

    enterNonCI();
    try {
      const result = await runInit({
        projectRoot: tmpDir,
        yes: true,
        coverageMap: false,
      });

      expect(result.exitCode).toBe(0);
      // Both agent configs should exist
      expect(fs.existsSync(path.join(tmpDir, ".mcp.json"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, ".cursor", "mcp.json"))).toBe(true);
      // Summary should list both
      const configuredLine = result.summary.find((s: string) => s.includes("Configured MCP"));
      expect(configuredLine).toBeDefined();
      expect(configuredLine).toContain("Claude Code");
      expect(configuredLine).toContain("Cursor");
    } finally {
      restoreCI();
    }
  });

  it("does not leak anon key in summary output", async () => {
    provisionAnonKey(tmpDir);

    enterNonCI();
    try {
      const result = await runInit({
        projectRoot: tmpDir,
        yes: true,
        coverageMap: false,
      });

      // The key itself should never appear in any output arrays
      const allOutput = [...result.summary, ...result.warnings, ...result.errors].join(" ");
      expect(allOutput).not.toContain(TEST_ANON_KEY);
    } finally {
      restoreCI();
    }
  });

  it("init still succeeds when MCP config write fails for an agent", async () => {
    provisionAnonKey(tmpDir);
    createClaudeMarker(tmpDir);

    // Create .mcp.json as a directory so the file write throws EISDIR
    fs.mkdirSync(path.join(tmpDir, ".mcp.json"));

    enterNonCI();
    try {
      const result = await runInit({
        projectRoot: tmpDir,
        yes: true,
        coverageMap: false,
      });

      // Init should succeed regardless of individual agent write failures
      expect(result.exitCode).toBe(0);
      // The agent name should NOT appear in the configured list since the write failed
      const configuredLine = result.summary.find((s: string) => s.includes("Configured MCP for"));
      if (configuredLine) {
        expect(configuredLine).not.toContain("Claude Code");
      }
    } finally {
      restoreCI();
    }
  });
});

describe("meetsNodeVersion", () => {
  it("returns true when current Node.js major version meets the minimum", () => {
    // The test runner itself is Node >= 20, so this should pass
    expect(meetsNodeVersion(20)).toBe(true);
  });

  it("returns true when minimum is lower than current version", () => {
    expect(meetsNodeVersion(14)).toBe(true);
    expect(meetsNodeVersion(16)).toBe(true);
    expect(meetsNodeVersion(18)).toBe(true);
  });

  it("returns false when minimum exceeds current version", () => {
    // No shipping Node version has major version 999
    expect(meetsNodeVersion(999)).toBe(false);
  });

  it("returns true when minimum is exactly 0", () => {
    expect(meetsNodeVersion(0)).toBe(true);
  });
});
