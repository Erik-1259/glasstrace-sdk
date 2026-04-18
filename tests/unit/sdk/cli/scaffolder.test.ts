import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  wrapExport,
  wrapCJSExport,
  identityFingerprint,
  scaffoldNextConfig,
  scaffoldInstrumentation,
  injectRegisterGlasstrace,
  hasRegisterGlasstraceCall,
  resolveInstrumentationTarget,
  appendRegisterFunction,
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

  it("produces properly spaced import braces when extending an existing import", () => {
    const input = `import { withGlasstraceConfig } from "@glasstrace/sdk";

export function register() {
  console.log("hello");
}
`;
    const result = injectRegisterGlasstrace(input);
    expect(result.injected).toBe(true);
    const importLines = result.content.split("\n").filter((l) => l.includes("@glasstrace/sdk"));
    expect(importLines).toHaveLength(1);
    // Must have spaces after { and before }
    expect(importLines[0]).toMatch(/^import \{ .+ \} from/);
    // Must not have {foo (no space after brace)
    expect(importLines[0]).not.toMatch(/\{[^ ]/);
    // Must not have foo} (no space before brace)
    expect(importLines[0]).not.toMatch(/[^ ]\}/);
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

// ---------------------------------------------------------------------------
// resolveInstrumentationTarget (DISC-493 Issue 1)
// ---------------------------------------------------------------------------

describe("resolveInstrumentationTarget", () => {
  it("targets root when the project has no src/ directory", () => {
    const dir = createTmpDir();
    const result = resolveInstrumentationTarget(dir);
    expect(result.conflict).toBe(false);
    expect(result.layout).toBe("root");
    expect(result.target).toBe(path.join(dir, "instrumentation.ts"));
    expect(result.existing).toEqual([]);
  });

  it("targets src/ when the project has a src/ directory and no instrumentation yet", () => {
    const dir = createTmpDir();
    fs.mkdirSync(path.join(dir, "src"));
    const result = resolveInstrumentationTarget(dir);
    expect(result.conflict).toBe(false);
    expect(result.layout).toBe("src");
    expect(result.target).toBe(path.join(dir, "src", "instrumentation.ts"));
    expect(result.existing).toEqual([]);
  });

  it("prefers existing src/instrumentation.ts over a src/ directory guess", () => {
    const dir = createTmpDir();
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "instrumentation.ts"), "export async function register() {}\n");
    const result = resolveInstrumentationTarget(dir);
    expect(result.conflict).toBe(false);
    expect(result.layout).toBe("src");
    expect(result.target).toBe(path.join(dir, "src", "instrumentation.ts"));
    expect(result.existing).toEqual([path.join(dir, "src", "instrumentation.ts")]);
  });

  it("prefers existing root instrumentation.ts when no src/ variant exists", () => {
    const dir = createTmpDir();
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "instrumentation.ts"), "export async function register() {}\n");
    const result = resolveInstrumentationTarget(dir);
    // src/ exists but the user already committed to root — honour that
    expect(result.conflict).toBe(false);
    expect(result.layout).toBe("root");
    expect(result.target).toBe(path.join(dir, "instrumentation.ts"));
  });

  it("detects conflict when both root and src/ instrumentation files exist", () => {
    const dir = createTmpDir();
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "instrumentation.ts"), "export async function register() {}\n");
    fs.writeFileSync(path.join(dir, "src", "instrumentation.ts"), "export async function register() {}\n");
    const result = resolveInstrumentationTarget(dir);
    expect(result.conflict).toBe(true);
    expect(result.target).toBeNull();
    expect(result.layout).toBeNull();
    expect(result.existing).toContain(path.join(dir, "instrumentation.ts"));
    expect(result.existing).toContain(path.join(dir, "src", "instrumentation.ts"));
  });

  it("detects .js and .mjs instrumentation variants", () => {
    const dir = createTmpDir();
    fs.writeFileSync(path.join(dir, "instrumentation.mjs"), "export async function register() {}\n");
    const result = resolveInstrumentationTarget(dir);
    expect(result.conflict).toBe(false);
    expect(result.layout).toBe("root");
    expect(result.target).toBe(path.join(dir, "instrumentation.mjs"));
  });

  it("ignores a src/ path that is a file rather than a directory", () => {
    const dir = createTmpDir();
    // A file literally named `src` should not trigger src/-layout detection
    fs.writeFileSync(path.join(dir, "src"), "");
    const result = resolveInstrumentationTarget(dir);
    expect(result.conflict).toBe(false);
    expect(result.layout).toBe("root");
  });
});

// ---------------------------------------------------------------------------
// appendRegisterFunction
// ---------------------------------------------------------------------------

describe("appendRegisterFunction", () => {
  it("appends an import and a register() function to an empty file", () => {
    const result = appendRegisterFunction("");
    expect(result).toContain('import { registerGlasstrace } from "@glasstrace/sdk"');
    expect(result).toContain("export async function register()");
    expect(result).toContain("registerGlasstrace()");
  });

  it("preserves existing content when appending", () => {
    const existing =
      'import * as Sentry from "@sentry/nextjs";\n' +
      'Sentry.init({ dsn: "https://example@sentry.io/123" });\n';
    const result = appendRegisterFunction(existing);
    expect(result).toContain("Sentry.init");
    expect(result).toContain('import * as Sentry from "@sentry/nextjs"');
    expect(result).toContain("export async function register()");
    expect(result).toContain("registerGlasstrace()");
  });

  it("does not add a duplicate import when @glasstrace/sdk is already imported", () => {
    const existing =
      'import { withGlasstraceConfig } from "@glasstrace/sdk";\n';
    const result = appendRegisterFunction(existing);
    const matches = result.match(/@glasstrace\/sdk/g);
    expect(matches?.length).toBe(1);
    // The existing specifier is preserved and registerGlasstrace is added
    expect(result).toContain("withGlasstraceConfig");
    expect(result).toContain("registerGlasstrace");
  });

  it("adds a separate import when the existing glasstrace import is namespaced", () => {
    const existing = 'import * as sdk from "@glasstrace/sdk";\n';
    const result = appendRegisterFunction(existing);
    // We can't safely rewrite a namespace import — add a destructured one
    expect(result).toContain('import { registerGlasstrace } from "@glasstrace/sdk"');
    expect(result).toContain('import * as sdk from "@glasstrace/sdk"');
  });
});

// ---------------------------------------------------------------------------
// scaffoldInstrumentation — src/ layout + merge behavior (DISC-493 Issue 1)
// ---------------------------------------------------------------------------

describe("scaffoldInstrumentation — src/ layout detection", () => {
  it("writes to src/instrumentation.ts when src/ exists", async () => {
    const dir = createTmpDir();
    fs.mkdirSync(path.join(dir, "src"));
    const result = await scaffoldInstrumentation(dir, { force: true });
    expect(result.action).toBe("created");
    expect(result.layout).toBe("src");
    expect(fs.existsSync(path.join(dir, "src", "instrumentation.ts"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "instrumentation.ts"))).toBe(false);
  });

  it("writes to root instrumentation.ts when src/ is absent", async () => {
    const dir = createTmpDir();
    const result = await scaffoldInstrumentation(dir, { force: true });
    expect(result.action).toBe("created");
    expect(result.layout).toBe("root");
    expect(fs.existsSync(path.join(dir, "instrumentation.ts"))).toBe(true);
  });

  it("appends to existing src/instrumentation.ts without a register() function", async () => {
    const dir = createTmpDir();
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(
      path.join(dir, "src", "instrumentation.ts"),
      'import * as Sentry from "@sentry/nextjs";\n',
    );
    const result = await scaffoldInstrumentation(dir, { force: true });
    expect(result.action).toBe("appended");
    expect(result.layout).toBe("src");
    const content = fs.readFileSync(path.join(dir, "src", "instrumentation.ts"), "utf-8");
    expect(content).toContain("Sentry");
    expect(content).toContain("registerGlasstrace()");
    expect(content).toContain("export async function register()");
  });

  it("injects into existing register() function in src/instrumentation.ts", async () => {
    const dir = createTmpDir();
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(
      path.join(dir, "src", "instrumentation.ts"),
      'import * as Sentry from "@sentry/nextjs";\n\nexport async function register() {\n  Sentry.init({ dsn: "https://example@sentry.io/123" });\n}\n',
    );
    const result = await scaffoldInstrumentation(dir, { force: true });
    expect(result.action).toBe("injected");
    expect(result.layout).toBe("src");
    const content = fs.readFileSync(path.join(dir, "src", "instrumentation.ts"), "utf-8");
    expect(content).toContain("registerGlasstrace()");
    expect(content).toContain("Sentry.init");
    // registerGlasstrace must appear before Sentry.init so the OTel
    // provider is claimed first (DISC-493 Issue 4 context).
    expect(content.indexOf("registerGlasstrace()")).toBeLessThan(
      content.indexOf("Sentry.init"),
    );
  });

  it("is idempotent when src/instrumentation.ts already registers glasstrace", async () => {
    const dir = createTmpDir();
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(
      path.join(dir, "src", "instrumentation.ts"),
      'import { registerGlasstrace } from "@glasstrace/sdk";\nexport async function register() { registerGlasstrace(); }\n',
    );
    const result = await scaffoldInstrumentation(dir, { force: true });
    expect(result.action).toBe("already-registered");
    expect(result.layout).toBe("src");
  });

  it("returns conflict when both root and src/ instrumentation files exist", async () => {
    const dir = createTmpDir();
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "instrumentation.ts"), "export async function register() {}\n");
    fs.writeFileSync(
      path.join(dir, "src", "instrumentation.ts"),
      "export async function register() {}\n",
    );
    const result = await scaffoldInstrumentation(dir, { force: true });
    expect(result.action).toBe("conflict");
    // Must not have written a third file or mutated either existing one
    const rootContent = fs.readFileSync(path.join(dir, "instrumentation.ts"), "utf-8");
    const srcContent = fs.readFileSync(path.join(dir, "src", "instrumentation.ts"), "utf-8");
    expect(rootContent).toBe("export async function register() {}\n");
    expect(srcContent).toBe("export async function register() {}\n");
    // The conflict result points at src/ as the recommended merge target
    expect(result.filePath).toBe(path.join(dir, "src", "instrumentation.ts"));
    expect(result.conflictingPath).toBe(path.join(dir, "instrumentation.ts"));
  });
});

describe("scaffoldInstrumentation — merge prompt", () => {
  it("skips the write when the prompt returns false (no --force)", async () => {
    const dir = createTmpDir();
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(
      path.join(dir, "src", "instrumentation.ts"),
      'import * as Sentry from "@sentry/nextjs";\n',
    );
    let promptCalls = 0;
    const result = await scaffoldInstrumentation(dir, {
      prompt: async () => {
        promptCalls++;
        return false;
      },
    });
    expect(promptCalls).toBe(1);
    expect(result.action).toBe("skipped");
    // File should be unchanged
    const content = fs.readFileSync(path.join(dir, "src", "instrumentation.ts"), "utf-8");
    expect(content).toBe('import * as Sentry from "@sentry/nextjs";\n');
    expect(content).not.toContain("registerGlasstrace");
  });

  it("honors --force (no prompt) when merging into an existing file", async () => {
    const dir = createTmpDir();
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(
      path.join(dir, "src", "instrumentation.ts"),
      'import * as Sentry from "@sentry/nextjs";\n',
    );
    let promptCalls = 0;
    const result = await scaffoldInstrumentation(dir, {
      force: true,
      prompt: async () => {
        promptCalls++;
        return false; // Would say no, but --force must bypass the prompt
      },
    });
    expect(promptCalls).toBe(0);
    expect(result.action).toBe("appended");
    const content = fs.readFileSync(path.join(dir, "src", "instrumentation.ts"), "utf-8");
    expect(content).toContain("registerGlasstrace()");
  });

  it("does not prompt when creating a fresh file (no existing content to preserve)", async () => {
    const dir = createTmpDir();
    fs.mkdirSync(path.join(dir, "src"));
    let promptCalls = 0;
    const result = await scaffoldInstrumentation(dir, {
      prompt: async () => {
        promptCalls++;
        return false;
      },
    });
    expect(promptCalls).toBe(0);
    expect(result.action).toBe("created");
  });

  it("does not prompt when the file is already registered", async () => {
    const dir = createTmpDir();
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(
      path.join(dir, "src", "instrumentation.ts"),
      'import { registerGlasstrace } from "@glasstrace/sdk";\nexport async function register() { registerGlasstrace(); }\n',
    );
    let promptCalls = 0;
    const result = await scaffoldInstrumentation(dir, {
      prompt: async () => {
        promptCalls++;
        return false;
      },
    });
    expect(promptCalls).toBe(0);
    expect(result.action).toBe("already-registered");
  });
});
