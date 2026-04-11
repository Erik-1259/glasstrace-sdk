import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  wrapExport,
  wrapCJSExport,
  identityFingerprint,
  scaffoldNextConfig,
  injectRegisterGlasstrace,
  hasRegisterGlasstraceCall,
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
    expect(result).toEqual({ modified: true });

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
    expect(result).toEqual({ modified: true });

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
    expect(result).toEqual({ modified: false, reason: "already-wrapped" });

    // File should not have been modified
    const content = fs.readFileSync(path.join(dir, "next.config.ts"), "utf-8");
    expect(content).toBe(alreadyWrapped);
  });

  it("returns null when no next.config file exists", async () => {
    const dir = createTmpDir();
    const result = await scaffoldNextConfig(dir);
    expect(result).toBeNull();
  });

  it("returns empty-file reason for an empty config file without throwing", async () => {
    const dir = createTmpDir();
    fs.writeFileSync(path.join(dir, "next.config.ts"), "");

    const result = await scaffoldNextConfig(dir);
    expect(result).toEqual({ modified: false, reason: "empty-file" });

    // File should remain empty (not modified)
    const content = fs.readFileSync(path.join(dir, "next.config.ts"), "utf-8");
    expect(content).toBe("");
  });

  it("returns empty-file reason for a whitespace-only config file", async () => {
    const dir = createTmpDir();
    fs.writeFileSync(path.join(dir, "next.config.js"), "  \n\n  ");

    const result = await scaffoldNextConfig(dir);
    expect(result).toEqual({ modified: false, reason: "empty-file" });
  });
});

// ---------------------------------------------------------------------------
// injectRegisterGlasstrace
// ---------------------------------------------------------------------------

describe("injectRegisterGlasstrace", () => {
  it("injects into export async function register() { ... }", () => {
    const input = `export async function register() {
  console.log("hello");
}
`;
    const result = injectRegisterGlasstrace(input);
    expect(result.injected).toBe(true);
    expect(result.content).toContain('import { registerGlasstrace } from "@glasstrace/sdk"');
    expect(result.content).toContain("registerGlasstrace()");
  });

  it("injects into export function register() (no async)", () => {
    const input = `export function register() {
  console.log("hello");
}
`;
    const result = injectRegisterGlasstrace(input);
    expect(result.injected).toBe(true);
    expect(result.content).toContain("registerGlasstrace()");
  });

  it("preserves existing imports and code", () => {
    const input = `import * as Sentry from "@sentry/nextjs";

export async function register() {
  Sentry.init({
    dsn: "https://example@sentry.io/123",
  });
}
`;
    const result = injectRegisterGlasstrace(input);
    expect(result.injected).toBe(true);
    expect(result.content).toContain('@sentry/nextjs"');
    expect(result.content).toContain("Sentry.init(");
    // registerGlasstrace should appear before Sentry.init
    const glasstraceIdx = result.content.indexOf("registerGlasstrace()");
    const sentryIdx = result.content.indexOf("Sentry.init(");
    expect(glasstraceIdx).toBeLessThan(sentryIdx);
  });

  it("returns injected=false when registerGlasstrace() call already present", () => {
    const input = `import { registerGlasstrace } from "@glasstrace/sdk";

export async function register() {
  registerGlasstrace();
}
`;
    const result = injectRegisterGlasstrace(input);
    expect(result.injected).toBe(false);
    expect(result.content).toBe(input);
  });

  it("does not treat registerGlasstrace in a comment as already registered", () => {
    const input = `// TODO: call registerGlasstrace later

export function register() {
  console.log("hello");
}
`;
    const result = injectRegisterGlasstrace(input);
    expect(result.injected).toBe(true);
    expect(result.content).toContain("registerGlasstrace()");
  });

  it("injects when registerGlasstrace is imported but not called", () => {
    const input = `import { registerGlasstrace } from "@glasstrace/sdk";

export function register() {
  console.log("imported but not called");
}
`;
    const result = injectRegisterGlasstrace(input);
    expect(result.injected).toBe(true);
    // Should not add a duplicate import line
    const importLines = result.content.split("\n").filter((l) => l.includes("@glasstrace/sdk"));
    expect(importLines).toHaveLength(1);
    // Should inject the call
    expect(result.content).toContain("registerGlasstrace()");
  });

  it("returns injected=false when no register() function found", () => {
    const input = `// This file has no register function
console.log("hello");
`;
    const result = injectRegisterGlasstrace(input);
    expect(result.injected).toBe(false);
    expect(result.content).toBe(input);
  });

  it("handles empty register() function body", () => {
    const input = `export function register() {
}
`;
    const result = injectRegisterGlasstrace(input);
    expect(result.injected).toBe(true);
    expect(result.content).toContain("registerGlasstrace()");
  });

  it("handles register() with Prisma instrumentation", () => {
    const input = `import { PrismaInstrumentation } from "@prisma/instrumentation";

export function register() {
  const prisma = new PrismaInstrumentation();
}
`;
    const result = injectRegisterGlasstrace(input);
    expect(result.injected).toBe(true);
    expect(result.content).toContain("registerGlasstrace()");
    expect(result.content).toContain("PrismaInstrumentation");
    // registerGlasstrace should appear before Prisma
    const glasstraceIdx = result.content.indexOf("registerGlasstrace()");
    const prismaIdx = result.content.indexOf("new PrismaInstrumentation()");
    expect(glasstraceIdx).toBeLessThan(prismaIdx);
  });

  it("detects indentation from existing code", () => {
    const input = `export function register() {
    // 4-space indented
    doSomething();
}
`;
    const result = injectRegisterGlasstrace(input);
    expect(result.injected).toBe(true);
    // The injected code should use the same 4-space indentation
    expect(result.content).toContain("    registerGlasstrace()");
    expect(result.content).toContain("    // Glasstrace must be registered");
  });

  it("detects indentation correctly when function body starts with blank line", () => {
    const input = `export function register() {

  doSomething();
}
`;
    const result = injectRegisterGlasstrace(input);
    expect(result.injected).toBe(true);
    // Should detect 2-space indent from the first non-blank line, not capture
    // the blank line's newline as part of the indent
    expect(result.content).toContain("  registerGlasstrace()");
    expect(result.content).toContain("  // Glasstrace must be registered");
  });

  it("does not duplicate import when @glasstrace/sdk already imported", () => {
    const input = `import { withGlasstraceConfig } from "@glasstrace/sdk";

export function register() {
  console.log("hello");
}
`;
    const result = injectRegisterGlasstrace(input);
    expect(result.injected).toBe(true);
    // Should NOT add a second import line — only one @glasstrace/sdk import
    const importLines = result.content.split("\n").filter((l) => l.includes("@glasstrace/sdk"));
    expect(importLines).toHaveLength(1);
    // The existing import should now include registerGlasstrace
    expect(importLines[0]).toContain("withGlasstraceConfig");
    expect(importLines[0]).toContain("registerGlasstrace");
    // Should still add the registerGlasstrace() call in the function body
    expect(result.content).toContain("registerGlasstrace()");
  });

  it("handles register() with parameters", () => {
    const input = `export function register(options: unknown) {
  console.log(options);
}
`;
    const result = injectRegisterGlasstrace(input);
    expect(result.injected).toBe(true);
    expect(result.content).toContain("registerGlasstrace()");
  });

  it("does not match non-exported register functions", () => {
    const input = `function register() {
  console.log("not exported");
}
`;
    const result = injectRegisterGlasstrace(input);
    expect(result.injected).toBe(false);
  });

  it("does not produce duplicate import specifier when registerGlasstrace already imported but not called", () => {
    const input = `import { registerGlasstrace } from "@glasstrace/sdk";
export function register() {
  // forgot to call it
}
`;
    const result = injectRegisterGlasstrace(input);
    expect(result.injected).toBe(true);
    // Must not produce `import { registerGlasstrace, registerGlasstrace }`
    const importLines = result.content.split("\n").filter((l) => l.includes("@glasstrace/sdk"));
    expect(importLines).toHaveLength(1);
    // Count occurrences of "registerGlasstrace" in the import line — should be exactly 1
    const specifierMatches = importLines[0].match(/registerGlasstrace/g);
    expect(specifierMatches).toHaveLength(1);
    // Should inject the call
    expect(result.content).toContain("registerGlasstrace();");
  });

  it("does not treat commented-out registerGlasstrace() as a real call", () => {
    const input = `import { registerGlasstrace } from "@glasstrace/sdk";

export function register() {
  // registerGlasstrace()
  console.log("oops, it's commented out");
}
`;
    const result = injectRegisterGlasstrace(input);
    expect(result.injected).toBe(true);
    // Should inject a real call
    const lines = result.content.split("\n");
    const callLines = lines.filter((l) => {
      const uncommented = l.replace(/\/\/.*$/, "");
      return /\bregisterGlasstrace\s*\(/.test(uncommented);
    });
    expect(callLines.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// hasRegisterGlasstraceCall
// ---------------------------------------------------------------------------

describe("hasRegisterGlasstraceCall", () => {
  it("returns true for a plain registerGlasstrace() call", () => {
    expect(hasRegisterGlasstraceCall("  registerGlasstrace();\n")).toBe(true);
  });

  it("returns true for registerGlasstrace with spaces before parens", () => {
    expect(hasRegisterGlasstraceCall("  registerGlasstrace ();\n")).toBe(true);
  });

  it("returns false for a commented-out call", () => {
    expect(hasRegisterGlasstraceCall("  // registerGlasstrace();\n")).toBe(false);
  });

  it("returns false for registerGlasstrace in an import (no parens)", () => {
    expect(
      hasRegisterGlasstraceCall('import { registerGlasstrace } from "@glasstrace/sdk";\n'),
    ).toBe(false);
  });

  it("returns false for empty content", () => {
    expect(hasRegisterGlasstraceCall("")).toBe(false);
  });

  it("detects a real call even when a commented-out call exists on another line", () => {
    const content = [
      "  // registerGlasstrace()",
      "  registerGlasstrace();",
    ].join("\n");
    expect(hasRegisterGlasstraceCall(content)).toBe(true);
  });
});
