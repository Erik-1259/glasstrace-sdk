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
import { runInit, meetsNodeVersion, rollbackSteps } from "../../../packages/sdk/src/cli/init.js";

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
    const result = await scaffoldInstrumentation(tmpDir);
    expect(result.action).toBe("created");
    const content = fs.readFileSync(path.join(tmpDir, "instrumentation.ts"), "utf-8");
    expect(content).toContain("registerGlasstrace");
    expect(content).toContain("import");
  });

  it("includes Prisma initialization order comment", async () => {
    await scaffoldInstrumentation(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, "instrumentation.ts"), "utf-8");
    expect(content.toLowerCase()).toContain("prisma");
  });

  it("returns already-registered when file contains registerGlasstrace() call", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "instrumentation.ts"),
      'import { registerGlasstrace } from "@glasstrace/sdk";\nexport async function register() { registerGlasstrace(); }\n',
    );
    const result = await scaffoldInstrumentation(tmpDir);
    expect(result.action).toBe("already-registered");
  });

  it("appends register() when file exists but has no register function (DISC-493 Issue 1)", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "instrumentation.ts"),
      "// custom content without register function\n",
    );
    const result = await scaffoldInstrumentation(tmpDir, { force: true });
    expect(result.action).toBe("appended");
    // Original content must be preserved; a new register() is appended.
    const content = fs.readFileSync(path.join(tmpDir, "instrumentation.ts"), "utf-8");
    expect(content).toContain("// custom content without register function");
    expect(content).toContain("registerGlasstrace");
    expect(content).toContain("export async function register()");
    expect(content).toContain('import { registerGlasstrace } from "@glasstrace/sdk"');
  });

  it("scaffoldInstrumentation uses a module-level import (callers pass absolute projectRoot)", async () => {
    // Sanity check that force:true bypasses the prompt for fresh creates too.
    const result = await scaffoldInstrumentation(tmpDir, { force: true });
    expect(result.action).toBe("created");
    expect(result.layout).toBe("root");
    expect(result.filePath).toBe(path.join(tmpDir, "instrumentation.ts"));
  });

  it("injects registerGlasstrace into existing instrumentation.ts with Prisma", async () => {
    const prismaContent = `import { PrismaInstrumentation } from "@prisma/instrumentation";

export function register() {
  const prisma = new PrismaInstrumentation();
}
`;
    fs.writeFileSync(path.join(tmpDir, "instrumentation.ts"), prismaContent);
    const result = await scaffoldInstrumentation(tmpDir, { force: true });
    expect(result.action).toBe("injected");
    const content = fs.readFileSync(path.join(tmpDir, "instrumentation.ts"), "utf-8");
    expect(content).toContain("registerGlasstrace()");
    expect(content).toContain('import { registerGlasstrace } from "@glasstrace/sdk"');
    // Prisma code should be preserved
    expect(content).toContain("PrismaInstrumentation");
  });

  it("injects registerGlasstrace into existing instrumentation.ts with Sentry", async () => {
    const sentryContent = `import * as Sentry from "@sentry/nextjs";

export async function register() {
  Sentry.init({
    dsn: "https://example@sentry.io/123",
  });
}
`;
    fs.writeFileSync(path.join(tmpDir, "instrumentation.ts"), sentryContent);
    const result = await scaffoldInstrumentation(tmpDir, { force: true });
    expect(result.action).toBe("injected");
    const content = fs.readFileSync(path.join(tmpDir, "instrumentation.ts"), "utf-8");
    expect(content).toContain("registerGlasstrace()");
    // Sentry code should be preserved
    expect(content).toContain("Sentry.init");
  });

  it("preserves existing file content when injecting", async () => {
    const existing = `// Custom header comment
import { something } from "some-lib";

export function register() {
  something();
  console.log("registered");
}
`;
    fs.writeFileSync(path.join(tmpDir, "instrumentation.ts"), existing);
    const result = await scaffoldInstrumentation(tmpDir, { force: true });
    expect(result.action).toBe("injected");
    const content = fs.readFileSync(path.join(tmpDir, "instrumentation.ts"), "utf-8");
    // All original code should be preserved
    expect(content).toContain("Custom header comment");
    expect(content).toContain('import { something } from "some-lib"');
    expect(content).toContain("something()");
    expect(content).toContain('console.log("registered")');
    // registerGlasstrace should appear before existing statements
    const glasstraceIdx = content.indexOf("registerGlasstrace()");
    const somethingIdx = content.indexOf("something()");
    expect(glasstraceIdx).toBeLessThan(somethingIdx);
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

// ---------------------------------------------------------------------------
// DISC-493 Issue 1 — src/ layout detection and conflict handling
// ---------------------------------------------------------------------------

describe("runInit — DISC-493 Issue 1 src/ layout", () => {
  beforeEach(() => {
    if (!fs.existsSync(path.join(tmpDir, "next.config.ts"))) {
      fs.writeFileSync(path.join(tmpDir, "next.config.ts"), "export default {};\n");
    }
  });

  it("creates src/instrumentation.ts when the project uses the src/ layout", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"));
    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, "src", "instrumentation.ts"))).toBe(true);
    // Root must NOT be created — that would be the DISC-493 silent failure
    expect(fs.existsSync(path.join(tmpDir, "instrumentation.ts"))).toBe(false);
    expect(result.summary.some((s: string) => s.includes("src/instrumentation.ts") || s.includes("src\\instrumentation.ts"))).toBe(true);
  });

  it("creates root instrumentation.ts when the project does not use src/ layout", async () => {
    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, "instrumentation.ts"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "src", "instrumentation.ts"))).toBe(false);
  });

  it("merges registerGlasstrace into existing src/instrumentation.ts without overwriting", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(
      path.join(tmpDir, "src", "instrumentation.ts"),
      'import * as Sentry from "@sentry/nextjs";\n\nexport async function register() {\n  Sentry.init({ dsn: "https://example@sentry.io/123" });\n}\n',
    );
    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });
    expect(result.exitCode).toBe(0);
    const content = fs.readFileSync(path.join(tmpDir, "src", "instrumentation.ts"), "utf-8");
    expect(content).toContain("Sentry.init");
    expect(content).toContain("registerGlasstrace");
    // A competing root file MUST NOT have been created
    expect(fs.existsSync(path.join(tmpDir, "instrumentation.ts"))).toBe(false);
  });

  it("appends a register() function when src/instrumentation.ts has none", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(
      path.join(tmpDir, "src", "instrumentation.ts"),
      'import * as Sentry from "@sentry/nextjs";\n',
    );
    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });
    expect(result.exitCode).toBe(0);
    const content = fs.readFileSync(path.join(tmpDir, "src", "instrumentation.ts"), "utf-8");
    expect(content).toContain("export async function register()");
    expect(content).toContain("registerGlasstrace()");
    expect(content).toContain("Sentry");
    expect(result.summary.some((s: string) => s.includes("Appended register()"))).toBe(true);
  });

  it("emits an error and writes nothing when both root and src/ files exist", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"));
    const rootBefore = "export async function register() { /* user A */ }\n";
    const srcBefore = "export async function register() { /* user B */ }\n";
    fs.writeFileSync(path.join(tmpDir, "instrumentation.ts"), rootBefore);
    fs.writeFileSync(path.join(tmpDir, "src", "instrumentation.ts"), srcBefore);

    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e: string) => /undefined|both.*exist/i.test(e))).toBe(true);
    // Neither file may be mutated
    expect(fs.readFileSync(path.join(tmpDir, "instrumentation.ts"), "utf-8")).toBe(rootBefore);
    expect(fs.readFileSync(path.join(tmpDir, "src", "instrumentation.ts"), "utf-8")).toBe(srcBefore);
  });

  it("is idempotent under the src/ layout", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"));

    const first = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });
    expect(first.exitCode).toBe(0);
    const firstContent = fs.readFileSync(path.join(tmpDir, "src", "instrumentation.ts"), "utf-8");

    const second = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });
    expect(second.exitCode).toBe(0);
    const secondContent = fs.readFileSync(path.join(tmpDir, "src", "instrumentation.ts"), "utf-8");

    expect(secondContent).toBe(firstContent);
    // registerGlasstrace must appear exactly once — no duplication across runs
    const callCount = secondContent.match(/registerGlasstrace\s*\(\s*\)/g)?.length ?? 0;
    expect(callCount).toBe(1);
  });

  it("rolls back the correct file under the src/ layout when a later step fails", async () => {
    // src/ layout with a later step failure — the scaffolder should have
    // written src/instrumentation.ts, and rollback must delete THAT file
    // rather than attempting to clean up a nonexistent root file.
    fs.mkdirSync(path.join(tmpDir, "src"));
    // Force .env.local failure to trigger rollback after the instrumentation step
    fs.mkdirSync(path.join(tmpDir, ".env.local"));

    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.errors.some((e: string) => e.includes(".env.local"))).toBe(true);
    // src/instrumentation.ts should have been rolled back (init-created file deleted)
    expect(fs.existsSync(path.join(tmpDir, "src", "instrumentation.ts"))).toBe(false);
    // Root instrumentation must not exist either
    expect(fs.existsSync(path.join(tmpDir, "instrumentation.ts"))).toBe(false);
  });
});

describe("runInit — CLI flow", () => {
  // runInit requires a Next.js config to pass monorepo classification
  beforeEach(() => {
    if (!fs.existsSync(path.join(tmpDir, "next.config.ts"))) {
      fs.writeFileSync(path.join(tmpDir, "next.config.ts"), "export default {};\n");
    }
  });

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

  it("error case: exits with code 1 when no package.json and no next.config", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "glasstrace-cli-empty-"));
    try {
      const result = await runInit({
        projectRoot: emptyDir,
        yes: true,
        coverageMap: false,
      });
      expect(result.exitCode).toBe(1);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e: string) => e.includes("No Next.js project found"))).toBe(true);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("error case: exits with code 1 when next.config exists but no package.json", async () => {
    const noPackageDir = fs.mkdtempSync(path.join(os.tmpdir(), "glasstrace-cli-nopkg-"));
    try {
      fs.writeFileSync(path.join(noPackageDir, "next.config.ts"), "export default {};\n");
      const result = await runInit({
        projectRoot: noPackageDir,
        yes: true,
        coverageMap: false,
      });
      expect(result.exitCode).toBe(1);
      expect(result.errors.some((e: string) => e.includes("No package.json found"))).toBe(true);
    } finally {
      fs.rmSync(noPackageDir, { recursive: true, force: true });
    }
  });

  it("non-interactive mode appends register() when instrumentation.ts has no register function", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "instrumentation.ts"),
      "// custom content without register()",
    );
    fs.writeFileSync(path.join(tmpDir, ".env.local"), "GLASSTRACE_API_KEY=my-key\n");
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), ".glasstrace/\n");

    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });
    expect(result.exitCode).toBe(0);
    // The scaffolder now appends a register() function rather than leaving
    // the file untouched — DISC-493 Issue 1.
    const instrumentationContent = fs.readFileSync(path.join(tmpDir, "instrumentation.ts"), "utf-8");
    expect(instrumentationContent).toContain("// custom content without register()");
    expect(instrumentationContent).toContain("export async function register()");
    expect(instrumentationContent).toContain("registerGlasstrace()");
    // Summary should mention the append, not a warning.
    expect(result.summary.some((s: string) => s.includes("Appended register()"))).toBe(true);
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
  // runInit requires a Next.js config to pass monorepo classification
  beforeEach(() => {
    if (!fs.existsSync(path.join(tmpDir, "next.config.ts"))) {
      fs.writeFileSync(path.join(tmpDir, "next.config.ts"), "export default {};\n");
    }
  });

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

// --- Rollback tests ---

describe("rollbackSteps", () => {
  it("reverses instrumentation step — deletes init-created file", async () => {
    // Simulate what scaffoldInstrumentation("created") produces
    const instrContent = [
      'import { registerGlasstrace } from "@glasstrace/sdk";',
      "",
      "export async function register() {",
      "  // Glasstrace must be registered before Prisma instrumentation",
      "  // to ensure all ORM spans are captured correctly.",
      "  // If you use @prisma/instrumentation, import it after this call.",
      "  registerGlasstrace();",
      "}",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(tmpDir, "instrumentation.ts"), instrContent);

    await rollbackSteps(["instrumentation"], tmpDir);

    expect(fs.existsSync(path.join(tmpDir, "instrumentation.ts"))).toBe(false);
  });

  it("reverses instrumentation step — removes injected call from existing file", async () => {
    // Simulate what scaffoldInstrumentation("injected") produces when
    // user already had their own code in the register function
    const content = [
      'import { registerGlasstrace } from "@glasstrace/sdk";',
      'import { something } from "some-lib";',
      "",
      "export function register() {",
      "  registerGlasstrace();",
      "  something();",
      "}",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(tmpDir, "instrumentation.ts"), content);

    await rollbackSteps(["instrumentation"], tmpDir);

    const result = fs.readFileSync(path.join(tmpDir, "instrumentation.ts"), "utf-8");
    expect(result).not.toContain("registerGlasstrace");
    expect(result).not.toContain("@glasstrace/sdk");
    expect(result).toContain("something()");
  });

  it("reverses instrumentation step — restores original content when originalInstrumentationContent provided", async () => {
    // Simulate an injected file where the user already had their own imports
    const originalContent = [
      'import { something } from "some-lib";',
      "",
      "export function register() {",
      "  something();",
      "}",
      "",
    ].join("\n");
    // The file on disk has been modified by scaffoldInstrumentation
    const injectedContent = [
      'import { registerGlasstrace } from "@glasstrace/sdk";',
      'import { something } from "some-lib";',
      "",
      "export function register() {",
      "  registerGlasstrace();",
      "  something();",
      "}",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(tmpDir, "instrumentation.ts"), injectedContent);

    // Pass originalInstrumentationContent to restore exact pre-init state
    await rollbackSteps(["instrumentation"], tmpDir, {
      originalInstrumentationContent: originalContent,
    });

    const result = fs.readFileSync(path.join(tmpDir, "instrumentation.ts"), "utf-8");
    expect(result).toBe(originalContent);
    expect(result).not.toContain("registerGlasstrace");
    expect(result).not.toContain("@glasstrace/sdk");
    expect(result).toContain("something()");
  });

  it("reverses next-config step — unwraps ESM withGlasstraceConfig", async () => {
    const content = [
      'import { withGlasstraceConfig } from "@glasstrace/sdk";',
      "",
      "const nextConfig = {};",
      "export default withGlasstraceConfig(nextConfig);",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(tmpDir, "next.config.ts"), content);

    await rollbackSteps(["next-config"], tmpDir);

    const result = fs.readFileSync(path.join(tmpDir, "next.config.ts"), "utf-8");
    expect(result).not.toContain("withGlasstraceConfig");
    expect(result).not.toContain("@glasstrace/sdk");
    expect(result).toContain("export default nextConfig;");
  });

  it("reverses next-config step — unwraps CJS withGlasstraceConfig", async () => {
    const content = [
      'const { withGlasstraceConfig } = require("@glasstrace/sdk");',
      "",
      "const nextConfig = {};",
      "module.exports = withGlasstraceConfig(nextConfig);",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(tmpDir, "next.config.js"), content);

    await rollbackSteps(["next-config"], tmpDir);

    const result = fs.readFileSync(path.join(tmpDir, "next.config.js"), "utf-8");
    expect(result).not.toContain("withGlasstraceConfig");
    expect(result).not.toContain("@glasstrace/sdk");
    expect(result).toContain("module.exports = nextConfig;");
  });

  it("reverses env-local step — removes only GLASSTRACE_API_KEY lines", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".env.local"),
      "OTHER_KEY=value\n# GLASSTRACE_API_KEY=your_key_here\n",
    );

    await rollbackSteps(["env-local"], tmpDir);

    const result = fs.readFileSync(path.join(tmpDir, ".env.local"), "utf-8");
    expect(result).toContain("OTHER_KEY=value");
    expect(result).not.toContain("GLASSTRACE_API_KEY");
  });

  it("reverses env-local step — preserves pre-existing GLASSTRACE_COVERAGE_MAP", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".env.local"),
      "GLASSTRACE_COVERAGE_MAP=true\n# GLASSTRACE_API_KEY=your_key_here\n",
    );

    await rollbackSteps(["env-local"], tmpDir);

    const result = fs.readFileSync(path.join(tmpDir, ".env.local"), "utf-8");
    expect(result).toContain("GLASSTRACE_COVERAGE_MAP=true");
    expect(result).not.toContain("GLASSTRACE_API_KEY");
  });

  it("reverses env-local step — deletes file when only GLASSTRACE entries remain", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".env.local"),
      "# GLASSTRACE_API_KEY=your_key_here\n",
    );

    await rollbackSteps(["env-local"], tmpDir);

    expect(fs.existsSync(path.join(tmpDir, ".env.local"))).toBe(false);
  });

  it("reverses gitignore step — removes .glasstrace/ line", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".gitignore"),
      "node_modules/\n.glasstrace/\n",
    );

    await rollbackSteps(["gitignore"], tmpDir);

    const result = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf-8");
    expect(result).toContain("node_modules/");
    expect(result).not.toContain(".glasstrace/");
  });

  it("reverses multiple steps in reverse order", async () => {
    // Set up: instrumentation (init-created) + env-local + gitignore
    const instrContent = [
      'import { registerGlasstrace } from "@glasstrace/sdk";',
      "",
      "export async function register() {",
      "  registerGlasstrace();",
      "}",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(tmpDir, "instrumentation.ts"), instrContent);
    fs.writeFileSync(
      path.join(tmpDir, ".env.local"),
      "# GLASSTRACE_API_KEY=your_key_here\n",
    );
    fs.writeFileSync(
      path.join(tmpDir, ".gitignore"),
      "node_modules/\n.glasstrace/\n",
    );

    await rollbackSteps(
      ["instrumentation", "env-local", "gitignore"],
      tmpDir,
    );

    expect(fs.existsSync(path.join(tmpDir, "instrumentation.ts"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".env.local"))).toBe(false);
    const gitignore = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf-8");
    expect(gitignore).not.toContain(".glasstrace/");
  });

  it("is best-effort — continues when individual rollback steps fail", async () => {
    // Make instrumentation.ts a directory so the rollback for it fails,
    // but gitignore rollback should still succeed
    fs.mkdirSync(path.join(tmpDir, "instrumentation.ts"));
    fs.writeFileSync(
      path.join(tmpDir, ".gitignore"),
      "node_modules/\n.glasstrace/\n",
    );

    // Should not throw even though instrumentation rollback fails
    await rollbackSteps(["instrumentation", "gitignore"], tmpDir);

    // Gitignore should still be cleaned up
    const gitignore = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf-8");
    expect(gitignore).not.toContain(".glasstrace/");
    // The directory is still there (rollback failed for this step)
    expect(fs.existsSync(path.join(tmpDir, "instrumentation.ts"))).toBe(true);
  });

  it("handles empty steps array", async () => {
    // Should not throw
    await rollbackSteps([], tmpDir);
  });
});

describe("runInit — rollback on failure", () => {
  beforeEach(() => {
    if (!fs.existsSync(path.join(tmpDir, "next.config.ts"))) {
      fs.writeFileSync(path.join(tmpDir, "next.config.ts"), "export default {};\n");
    }
  });

  it("rolls back instrumentation when scaffoldEnvLocal fails", async () => {
    // Create .env.local as a directory — causes fs.readFileSync to throw EISDIR
    fs.mkdirSync(path.join(tmpDir, ".env.local"));

    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.errors.some((e: string) => e.includes(".env.local"))).toBe(true);

    // Instrumentation should be rolled back — the init-created file should be deleted
    expect(fs.existsSync(path.join(tmpDir, "instrumentation.ts"))).toBe(false);

    // Next config should be rolled back — unwrapped back to original
    const configContent = fs.readFileSync(path.join(tmpDir, "next.config.ts"), "utf-8");
    expect(configContent).not.toContain("withGlasstraceConfig");
  });

  it("rolls back instrumentation and next-config when scaffoldGitignore fails", async () => {
    // Create .gitignore as a directory — causes fs.readFileSync to throw EISDIR
    fs.mkdirSync(path.join(tmpDir, ".gitignore"));

    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.errors.some((e: string) => e.includes(".gitignore"))).toBe(true);

    // Instrumentation should be rolled back
    expect(fs.existsSync(path.join(tmpDir, "instrumentation.ts"))).toBe(false);

    // Next config should be rolled back
    const configContent = fs.readFileSync(path.join(tmpDir, "next.config.ts"), "utf-8");
    expect(configContent).not.toContain("withGlasstraceConfig");

    // .env.local should be rolled back (GLASSTRACE_API_KEY removed)
    if (fs.existsSync(path.join(tmpDir, ".env.local"))) {
      const envContent = fs.readFileSync(path.join(tmpDir, ".env.local"), "utf-8");
      expect(envContent).not.toContain("GLASSTRACE_API_KEY");
    }
  });

  it("preserves original error when init fails after instrumentation step", async () => {
    // Create .env.local as a directory to trigger the original failure
    // in scaffoldEnvLocal, after instrumentation has already been written.
    fs.mkdirSync(path.join(tmpDir, ".env.local"));

    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });

    expect(result.exitCode).toBe(1);
    // The original error about .env.local should be present
    expect(result.errors.some((e: string) => e.includes(".env.local"))).toBe(true);
  });

  it("does NOT roll back on non-fatal warnings", async () => {
    // Create .mcp.json as a directory so MCP write fails with a warning
    // (not a fatal error) — the init flow continues, and rollback must
    // not fire for warnings alone.
    fs.writeFileSync(path.join(tmpDir, ".env.local"), "GLASSTRACE_API_KEY=my-key\n");
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), ".glasstrace/\n");
    // Create a Claude marker so the init flow actually tries to write .mcp.json
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".mcp.json"));

    // Enter non-CI so agent detection runs (it is the path that emits
    // warnings for failed agent configuration).
    const savedCI = process.env["CI"];
    const savedGHA = process.env["GITHUB_ACTIONS"];
    delete process.env["CI"];
    delete process.env["GITHUB_ACTIONS"];
    let result;
    try {
      result = await runInit({
        projectRoot: tmpDir,
        yes: true,
        coverageMap: false,
      });
    } finally {
      if (savedCI === undefined) delete process.env["CI"];
      else process.env["CI"] = savedCI;
      if (savedGHA === undefined) delete process.env["GITHUB_ACTIONS"];
      else process.env["GITHUB_ACTIONS"] = savedGHA;
    }

    expect(result.exitCode).toBe(0);
    // Warnings were generated but no rollback happened
    expect(result.warnings.length).toBeGreaterThan(0);
    // Files should remain (not rolled back)
    const gitignore = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".glasstrace/");
  });

  it("does not roll back steps that were skipped (already present)", async () => {
    // Pre-configure everything so nothing is actually modified
    fs.writeFileSync(
      path.join(tmpDir, "instrumentation.ts"),
      'import { registerGlasstrace } from "@glasstrace/sdk";\nexport async function register() { registerGlasstrace(); }\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      'import { withGlasstraceConfig } from "@glasstrace/sdk";\nexport default withGlasstraceConfig({});\n',
    );
    fs.writeFileSync(path.join(tmpDir, ".env.local"), "GLASSTRACE_API_KEY=my-key\n");
    // Now make .gitignore a directory to trigger failure
    fs.mkdirSync(path.join(tmpDir, ".gitignore"));

    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });

    expect(result.exitCode).toBe(1);
    // Instrumentation was "already-registered" — should NOT be touched by rollback
    const instrContent = fs.readFileSync(path.join(tmpDir, "instrumentation.ts"), "utf-8");
    expect(instrContent).toContain("registerGlasstrace");
    // Next config was "already-wrapped" — should NOT be touched by rollback
    const configContent = fs.readFileSync(path.join(tmpDir, "next.config.ts"), "utf-8");
    expect(configContent).toContain("withGlasstraceConfig");
  });
});
