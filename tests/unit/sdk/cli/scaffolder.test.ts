import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  wrapExport,
  wrapCJSExport,
  identityFingerprint,
  scaffoldNextConfig,
} from "../../../../packages/sdk/src/cli/scaffolder.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

function createTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glasstrace-scaffolder-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

// ---------------------------------------------------------------------------
// wrapExport
// ---------------------------------------------------------------------------

describe("wrapExport", () => {
  it("returns wrapped: false when no export default is present", () => {
    const result = wrapExport("const foo = 1;\n");
    expect(result.wrapped).toBe(false);
    expect(result.content).toBe("const foo = 1;\n");
  });

  it("wraps a simple identifier export", () => {
    const input = "const nextConfig = {};\nexport default nextConfig;\n";
    const result = wrapExport(input);
    expect(result.wrapped).toBe(true);
    expect(result.content).toContain("withGlasstraceConfig(nextConfig)");
    expect(result.content).not.toContain("export default nextConfig;");
  });

  it("wraps an object literal export", () => {
    const input = "export default { reactStrictMode: true };\n";
    const result = wrapExport(input);
    expect(result.wrapped).toBe(true);
    expect(result.content).toContain("withGlasstraceConfig({ reactStrictMode: true })");
  });

  it("wraps a multiline object literal with trailing comma", () => {
    const input = [
      "export default {",
      "  reactStrictMode: true,",
      "  swcMinify: true,",
      "};",
    ].join("\n");
    const result = wrapExport(input);
    expect(result.wrapped).toBe(true);
    expect(result.content).toContain("withGlasstraceConfig(");
    expect(result.content).toContain("swcMinify: true,\n}");
  });

  it("handles expression with no trailing semicolon", () => {
    const input = "export default nextConfig";
    const result = wrapExport(input);
    expect(result.wrapped).toBe(true);
    expect(result.content).toContain("withGlasstraceConfig(nextConfig)");
  });

  it("returns wrapped: false for empty export default", () => {
    // export default followed by only whitespace/semicolons
    const input = "export default ;";
    const result = wrapExport(input);
    expect(result.wrapped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// wrapCJSExport
// ---------------------------------------------------------------------------

describe("wrapCJSExport", () => {
  it("returns wrapped: false when no module.exports is present", () => {
    const result = wrapCJSExport("const foo = 1;\n");
    expect(result.wrapped).toBe(false);
    expect(result.content).toBe("const foo = 1;\n");
  });

  it("wraps a simple module.exports assignment", () => {
    const input = "const nextConfig = {};\nmodule.exports = nextConfig;\n";
    const result = wrapCJSExport(input);
    expect(result.wrapped).toBe(true);
    expect(result.content).toContain("module.exports = withGlasstraceConfig(nextConfig)");
  });

  it("wraps a nested call expression", () => {
    const input = "module.exports = withBundleAnalyzer(nextConfig);\n";
    const result = wrapCJSExport(input);
    expect(result.wrapped).toBe(true);
    expect(result.content).toContain(
      "module.exports = withGlasstraceConfig(withBundleAnalyzer(nextConfig))",
    );
  });

  it("handles no trailing semicolon", () => {
    const input = "module.exports = nextConfig";
    const result = wrapCJSExport(input);
    expect(result.wrapped).toBe(true);
    expect(result.content).toContain("withGlasstraceConfig(nextConfig)");
  });

  it("returns wrapped: false when module.exports has no = sign", () => {
    // e.g. module.exports.foo = bar
    const input = "module.exports.foo = bar;\n";
    const result = wrapCJSExport(input);
    // The lastIndexOf finds "module.exports" in "module.exports.foo", but
    // the regex for "= " won't match ".foo = " since it expects the = immediately.
    // Actually let's just check the behavior:
    // After ".foo", afterMarker is ".foo = bar;\n", regex /^\s*=\s*/ won't match ".foo = bar"
    expect(result.wrapped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// identityFingerprint
// ---------------------------------------------------------------------------

describe("identityFingerprint", () => {
  it("is deterministic: same input produces same output", () => {
    const hash1 = identityFingerprint("test-token");
    const hash2 = identityFingerprint("test-token");
    expect(hash1).toBe(hash2);
  });

  it("produces different outputs for different inputs", () => {
    const hash1 = identityFingerprint("token-a");
    const hash2 = identityFingerprint("token-b");
    expect(hash1).not.toBe(hash2);
  });

  it("output format is sha256:<64-char-hex>", () => {
    const hash = identityFingerprint("any-input");
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("does not throw on empty string input", () => {
    const hash = identityFingerprint("");
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// scaffoldNextConfig — filesystem edge cases
// ---------------------------------------------------------------------------

describe("scaffoldNextConfig", () => {
  it("prefers .ts config over .js and .mjs when multiple exist", async () => {
    const dir = createTmpDir();

    // Create all three config files
    fs.writeFileSync(
      path.join(dir, "next.config.ts"),
      "export default { reactStrictMode: true };\n",
    );
    fs.writeFileSync(
      path.join(dir, "next.config.js"),
      "module.exports = { swcMinify: true };\n",
    );
    fs.writeFileSync(
      path.join(dir, "next.config.mjs"),
      "export default { experimental: {} };\n",
    );

    const result = await scaffoldNextConfig(dir);
    expect(result).toBe(true);

    // The .ts file should be the one that was modified
    const tsContent = fs.readFileSync(path.join(dir, "next.config.ts"), "utf-8");
    expect(tsContent).toContain("withGlasstraceConfig");

    // The .js and .mjs files should be untouched
    const jsContent = fs.readFileSync(path.join(dir, "next.config.js"), "utf-8");
    expect(jsContent).not.toContain("withGlasstraceConfig");
    const mjsContent = fs.readFileSync(path.join(dir, "next.config.mjs"), "utf-8");
    expect(mjsContent).not.toContain("withGlasstraceConfig");
  });

  it("wraps CJS config with require()", async () => {
    const dir = createTmpDir();
    fs.writeFileSync(
      path.join(dir, "next.config.js"),
      "const config = {};\nmodule.exports = config;\n",
    );

    const result = await scaffoldNextConfig(dir);
    expect(result).toBe(true);

    const content = fs.readFileSync(path.join(dir, "next.config.js"), "utf-8");
    expect(content).toContain('require("@glasstrace/sdk")');
    expect(content).toContain("withGlasstraceConfig(config)");
  });

  it("skips already-wrapped config (idempotent)", async () => {
    const dir = createTmpDir();
    const alreadyWrapped = [
      'import { withGlasstraceConfig } from "@glasstrace/sdk";',
      "",
      "export default withGlasstraceConfig({ reactStrictMode: true });",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "next.config.ts"), alreadyWrapped);

    const result = await scaffoldNextConfig(dir);
    expect(result).toBe(false);

    // File should not have been modified
    const content = fs.readFileSync(path.join(dir, "next.config.ts"), "utf-8");
    expect(content).toBe(alreadyWrapped);
  });

  it("returns false when no next.config file exists", async () => {
    const dir = createTmpDir();
    const result = await scaffoldNextConfig(dir);
    expect(result).toBe(false);
  });
});
