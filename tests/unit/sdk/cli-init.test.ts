import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  scaffoldInstrumentation,
  scaffoldNextConfig,
  scaffoldEnvLocal,
  scaffoldGitignore,
  addCoverageMapEnv,
} from "../../../packages/sdk/src/cli/scaffolder.js";
import { runInit } from "../../../packages/sdk/src/cli/init.js";

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
    expect(result).toBe(true);
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
    expect(result).toBe(true);
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
    expect(result).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, "next.config.mjs"), "utf-8");
    expect(content).toContain("withGlasstraceConfig");
  });

  it("error case: returns false when no next.config.* found", async () => {
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toBe(false);
  });

  it("does not duplicate wrapper if already present", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.js"),
      'const { withGlasstraceConfig } = require("@glasstrace/sdk");\nmodule.exports = withGlasstraceConfig({});\n',
    );
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toBe(false);
  });

  it("handles ESM export without trailing semicolon", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      "const nextConfig = {};\nexport default nextConfig\n",
    );
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toBe(true);
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
    expect(result).toBe(true);
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
    expect(result).toBe(true);
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
    expect(result).toBe(true);
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
    expect(result).toBe(true);
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
    expect(result).toBe(true);
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
    expect(result).toBe(false);
  });

  it("CJS: returns false when module.exports has no equals sign", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.js"),
      "module.exports\n",
    );
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toBe(false);
    // File should not be modified
    expect(fs.existsSync(path.join(tmpDir, "next.config.js"))).toBe(true);
  });

  it("CJS: returns false when expression after module.exports = is empty", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.js"),
      "module.exports = ;\n",
    );
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toBe(false);
  });

  it("ESM: returns false when export default has no expression", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      "export default\n",
    );
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toBe(false);
  });

  it("ESM: returns false when no export default found", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      "const config = {};\n",
    );
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toBe(false);
  });

  it("CJS: returns false when no module.exports found", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.js"),
      "const config = {};\n",
    );
    const result = await scaffoldNextConfig(tmpDir);
    expect(result).toBe(false);
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
