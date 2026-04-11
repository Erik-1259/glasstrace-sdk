import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  runUninit,
  unwrapExport,
  unwrapCJSExport,
  removeGlasstraceConfigImport,
  isInitCreatedInstrumentation,
  removeRegisterGlasstrace,
  removeMarkerSection,
  processJsonMcpConfig,
  processTomlMcpConfig,
  findMatchingParen,
} from "../../../../packages/sdk/src/cli/uninit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

function createTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "glasstrace-uninit-test-"),
  );
  tempDirs.push(dir);
  return dir;
}

function createTmpProject(): string {
  const dir = createTmpDir();
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "test-project" }),
  );
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

// ---------------------------------------------------------------------------
// findMatchingParen
// ---------------------------------------------------------------------------

describe("findMatchingParen", () => {
  it("finds matching paren for simple expression", () => {
    expect(findMatchingParen("(abc)", 0)).toBe(4);
  });

  it("handles nested parentheses", () => {
    expect(findMatchingParen("(a(b)c)", 0)).toBe(6);
  });

  it("returns -1 when no matching paren exists", () => {
    expect(findMatchingParen("(abc", 0)).toBe(-1);
  });

  it("finds inner paren match", () => {
    expect(findMatchingParen("(a(b)c)", 2)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// unwrapExport (ESM)
// ---------------------------------------------------------------------------

describe("unwrapExport", () => {
  it("unwraps a simple identifier", () => {
    const input = "export default withGlasstraceConfig(nextConfig);\n";
    const result = unwrapExport(input);
    expect(result.unwrapped).toBe(true);
    expect(result.content).toBe("export default nextConfig;\n");
  });

  it("unwraps an object literal", () => {
    const input =
      "export default withGlasstraceConfig({ reactStrictMode: true });\n";
    const result = unwrapExport(input);
    expect(result.unwrapped).toBe(true);
    expect(result.content).toContain("export default { reactStrictMode: true };\n");
  });

  it("unwraps nested call expressions", () => {
    const input =
      "export default withGlasstraceConfig(withBundleAnalyzer(config));\n";
    const result = unwrapExport(input);
    expect(result.unwrapped).toBe(true);
    expect(result.content).toContain(
      "export default withBundleAnalyzer(config);\n",
    );
  });

  it("unwraps multiline object literal", () => {
    const input = [
      "export default withGlasstraceConfig({",
      "  reactStrictMode: true,",
      "  swcMinify: true,",
      "});",
    ].join("\n");
    const result = unwrapExport(input);
    expect(result.unwrapped).toBe(true);
    expect(result.content).toContain("export default {");
    expect(result.content).toContain("reactStrictMode: true,");
    expect(result.content).not.toContain("withGlasstraceConfig");
  });

  it("returns unwrapped: false when no withGlasstraceConfig is present", () => {
    const input = "export default nextConfig;\n";
    const result = unwrapExport(input);
    expect(result.unwrapped).toBe(false);
    expect(result.content).toBe(input);
  });

  it("preserves preamble content before the export", () => {
    const input = [
      "const config = {};",
      "",
      "export default withGlasstraceConfig(config);",
    ].join("\n");
    const result = unwrapExport(input);
    expect(result.unwrapped).toBe(true);
    expect(result.content).toContain("const config = {};");
    expect(result.content).toContain("export default config;\n");
  });
});

// ---------------------------------------------------------------------------
// unwrapCJSExport (CJS)
// ---------------------------------------------------------------------------

describe("unwrapCJSExport", () => {
  it("unwraps a simple identifier", () => {
    const input = "module.exports = withGlasstraceConfig(nextConfig);\n";
    const result = unwrapCJSExport(input);
    expect(result.unwrapped).toBe(true);
    expect(result.content).toBe("module.exports = nextConfig;\n");
  });

  it("unwraps nested call expressions", () => {
    const input =
      "module.exports = withGlasstraceConfig(withBundleAnalyzer(config));\n";
    const result = unwrapCJSExport(input);
    expect(result.unwrapped).toBe(true);
    expect(result.content).toContain(
      "module.exports = withBundleAnalyzer(config);\n",
    );
  });

  it("returns unwrapped: false when no withGlasstraceConfig wrapper", () => {
    const input = "module.exports = nextConfig;\n";
    const result = unwrapCJSExport(input);
    expect(result.unwrapped).toBe(false);
    expect(result.content).toBe(input);
  });

  it("preserves preamble content", () => {
    const input = [
      "const config = {};",
      "",
      "module.exports = withGlasstraceConfig(config);",
    ].join("\n");
    const result = unwrapCJSExport(input);
    expect(result.unwrapped).toBe(true);
    expect(result.content).toContain("const config = {};");
    expect(result.content).toContain("module.exports = config;\n");
  });
});

// ---------------------------------------------------------------------------
// removeGlasstraceConfigImport
// ---------------------------------------------------------------------------

describe("removeGlasstraceConfigImport", () => {
  it("removes sole ESM import", () => {
    const input =
      'import { withGlasstraceConfig } from "@glasstrace/sdk";\n\nconst x = 1;\n';
    const result = removeGlasstraceConfigImport(input);
    expect(result).not.toContain("withGlasstraceConfig");
    expect(result).toContain("const x = 1;");
  });

  it("removes withGlasstraceConfig from multi-specifier ESM import", () => {
    const input =
      'import { withGlasstraceConfig, registerGlasstrace } from "@glasstrace/sdk";\n';
    const result = removeGlasstraceConfigImport(input);
    expect(result).not.toContain("withGlasstraceConfig");
    expect(result).toContain("registerGlasstrace");
    expect(result).toContain("@glasstrace/sdk");
  });

  it("removes sole CJS require", () => {
    const input =
      'const { withGlasstraceConfig } = require("@glasstrace/sdk");\n\nconst x = 1;\n';
    const result = removeGlasstraceConfigImport(input);
    expect(result).not.toContain("withGlasstraceConfig");
    expect(result).toContain("const x = 1;");
  });

  it("removes withGlasstraceConfig from multi-specifier CJS require", () => {
    const input =
      'const { withGlasstraceConfig, otherThing } = require("@glasstrace/sdk");\n';
    const result = removeGlasstraceConfigImport(input);
    expect(result).not.toContain("withGlasstraceConfig");
    expect(result).toContain("otherThing");
  });

  it("returns content unchanged when no glasstrace import exists", () => {
    const input = 'import { something } from "other-pkg";\n';
    const result = removeGlasstraceConfigImport(input);
    expect(result).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// isInitCreatedInstrumentation
// ---------------------------------------------------------------------------

describe("isInitCreatedInstrumentation", () => {
  it("returns true for the standard init template", () => {
    const content = `import { registerGlasstrace } from "@glasstrace/sdk";

export async function register() {
  // Glasstrace must be registered before Prisma instrumentation
  // to ensure all ORM spans are captured correctly.
  // If you use @prisma/instrumentation, import it after this call.
  registerGlasstrace();
}
`;
    expect(isInitCreatedInstrumentation(content)).toBe(true);
  });

  it("returns false when file has other imports", () => {
    const content = `import { registerGlasstrace } from "@glasstrace/sdk";
import * as Sentry from "@sentry/nextjs";

export async function register() {
  registerGlasstrace();
  Sentry.init({});
}
`;
    expect(isInitCreatedInstrumentation(content)).toBe(false);
  });

  it("returns false when register() has other statements", () => {
    const content = `import { registerGlasstrace } from "@glasstrace/sdk";

export async function register() {
  registerGlasstrace();
  console.log("extra code");
}
`;
    expect(isInitCreatedInstrumentation(content)).toBe(false);
  });

  it("returns false when no register function exists", () => {
    const content = 'import { registerGlasstrace } from "@glasstrace/sdk";\n';
    expect(isInitCreatedInstrumentation(content)).toBe(false);
  });

  it("returns false when file has top-level statements outside register()", () => {
    const content = `import { registerGlasstrace } from "@glasstrace/sdk";

const MY_CONSTANT = "user-defined";

export async function register() {
  registerGlasstrace();
}
`;
    expect(isInitCreatedInstrumentation(content)).toBe(false);
  });

  it("returns false when file has top-level exports after register()", () => {
    const content = `import { registerGlasstrace } from "@glasstrace/sdk";

export async function register() {
  registerGlasstrace();
}

export const config = { runtime: "nodejs" };
`;
    expect(isInitCreatedInstrumentation(content)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// removeRegisterGlasstrace
// ---------------------------------------------------------------------------

describe("removeRegisterGlasstrace", () => {
  it("removes registerGlasstrace call and import, preserves other code", () => {
    const content = `import { registerGlasstrace } from "@glasstrace/sdk";
import * as Sentry from "@sentry/nextjs";

export async function register() {
  // Glasstrace must be registered before other instrumentation
  registerGlasstrace();
  Sentry.init({
    dsn: "https://example@sentry.io/123",
  });
}
`;
    const result = removeRegisterGlasstrace(content);
    expect(result).not.toContain("registerGlasstrace");
    expect(result).not.toContain("@glasstrace/sdk");
    expect(result).toContain("Sentry.init(");
    expect(result).toContain("@sentry/nextjs");
  });

  it("removes multi-line init comment block along with registerGlasstrace call", () => {
    const content = `import { registerGlasstrace } from "@glasstrace/sdk";
import * as Sentry from "@sentry/nextjs";

export async function register() {
  // Glasstrace must be registered before Prisma instrumentation
  // to ensure all ORM spans are captured correctly.
  // If you use @prisma/instrumentation, import it after this call.
  registerGlasstrace();
  Sentry.init({});
}
`;
    const result = removeRegisterGlasstrace(content);
    expect(result).not.toContain("registerGlasstrace");
    expect(result).not.toContain("Glasstrace must be registered");
    expect(result).not.toContain("Prisma instrumentation");
    expect(result).toContain("Sentry.init(");
  });

  it("removes standalone registerGlasstrace call without comment", () => {
    const content = `import { registerGlasstrace } from "@glasstrace/sdk";

export function register() {
  registerGlasstrace();
}
`;
    const result = removeRegisterGlasstrace(content);
    expect(result).not.toContain("registerGlasstrace");
    expect(result).toContain("export function register()");
  });

  it("removes registerGlasstrace from multi-specifier import, preserving other specifiers", () => {
    const content = `import { registerGlasstrace, withGlasstraceConfig } from "@glasstrace/sdk";

export function register() {
  registerGlasstrace();
}
`;
    const result = removeRegisterGlasstrace(content);
    expect(result).not.toContain("registerGlasstrace");
    expect(result).toContain("withGlasstraceConfig");
    expect(result).toContain("@glasstrace/sdk");
  });

  it("removes all registerGlasstrace() calls when multiple exist", () => {
    const content = `import { registerGlasstrace } from "@glasstrace/sdk";

function setup() {
  registerGlasstrace();
}

export function register() {
  registerGlasstrace();
}
`;
    const result = removeRegisterGlasstrace(content);
    expect(result).not.toContain("registerGlasstrace");
    expect(result).toContain("function setup()");
    expect(result).toContain("export function register()");
  });
});

// ---------------------------------------------------------------------------
// removeMarkerSection
// ---------------------------------------------------------------------------

describe("removeMarkerSection", () => {
  it("removes HTML-style marker section", () => {
    const content = [
      "# Project Info",
      "",
      "Some existing content.",
      "",
      "<!-- glasstrace:mcp:start -->",
      "",
      "## Glasstrace MCP Integration",
      "",
      "Some glasstrace content here.",
      "",
      "<!-- glasstrace:mcp:end -->",
    ].join("\n");

    const result = removeMarkerSection(content);
    expect(result.removed).toBe(true);
    expect(result.content).toContain("# Project Info");
    expect(result.content).toContain("Some existing content.");
    expect(result.content).not.toContain("glasstrace:mcp");
    expect(result.content).not.toContain("Glasstrace MCP Integration");
  });

  it("removes hash-style marker section", () => {
    const content = [
      "Some rules here.",
      "",
      "# glasstrace:mcp:start",
      "",
      "## Glasstrace MCP Integration",
      "",
      "# glasstrace:mcp:end",
    ].join("\n");

    const result = removeMarkerSection(content);
    expect(result.removed).toBe(true);
    expect(result.content).toContain("Some rules here.");
    expect(result.content).not.toContain("glasstrace:mcp");
  });

  it("returns removed: false when no markers present", () => {
    const content = "# Just a normal file\n\nNo markers here.\n";
    const result = removeMarkerSection(content);
    expect(result.removed).toBe(false);
    expect(result.content).toBe(content);
  });

  it("returns empty content when file only contains marker section", () => {
    const content = [
      "<!-- glasstrace:mcp:start -->",
      "## Glasstrace MCP Integration",
      "<!-- glasstrace:mcp:end -->",
    ].join("\n");

    const result = removeMarkerSection(content);
    expect(result.removed).toBe(true);
    expect(result.content).toBe("");
  });
});

// ---------------------------------------------------------------------------
// processJsonMcpConfig
// ---------------------------------------------------------------------------

describe("processJsonMcpConfig", () => {
  it("returns 'deleted' when glasstrace is the only server", () => {
    const content = JSON.stringify(
      {
        mcpServers: {
          glasstrace: { url: "https://api.glasstrace.dev/mcp" },
        },
      },
      null,
      2,
    );
    const result = processJsonMcpConfig(content);
    expect(result.action).toBe("deleted");
  });

  it("returns 'removed-key' when other servers exist", () => {
    const content = JSON.stringify(
      {
        mcpServers: {
          glasstrace: { url: "https://api.glasstrace.dev/mcp" },
          other: { url: "https://other.dev/mcp" },
        },
      },
      null,
      2,
    );
    const result = processJsonMcpConfig(content);
    expect(result.action).toBe("removed-key");
    expect(result.content).toBeDefined();

    const parsed = JSON.parse(result.content!) as Record<string, unknown>;
    const servers = parsed["mcpServers"] as Record<string, unknown>;
    expect(servers["glasstrace"]).toBeUndefined();
    expect(servers["other"]).toBeDefined();
  });

  it("returns 'skipped' when no glasstrace server exists", () => {
    const content = JSON.stringify(
      {
        mcpServers: {
          other: { url: "https://other.dev/mcp" },
        },
      },
      null,
      2,
    );
    const result = processJsonMcpConfig(content);
    expect(result.action).toBe("skipped");
  });

  it("returns 'skipped' for invalid JSON", () => {
    const result = processJsonMcpConfig("not json {{{");
    expect(result.action).toBe("skipped");
  });

  it("returns 'skipped' when no mcpServers key exists", () => {
    const content = JSON.stringify({ other: "value" }, null, 2);
    const result = processJsonMcpConfig(content);
    expect(result.action).toBe("skipped");
  });

  it("preserves other top-level keys when glasstrace is the only server", () => {
    const content = JSON.stringify(
      {
        mcpServers: {
          glasstrace: { url: "https://api.glasstrace.dev/mcp" },
        },
        $schema: "https://example.com/schema.json",
        metadata: { version: 1 },
      },
      null,
      2,
    );
    const result = processJsonMcpConfig(content);
    expect(result.action).toBe("removed-key");
    expect(result.content).toBeDefined();

    const parsed = JSON.parse(result.content!) as Record<string, unknown>;
    expect(parsed["mcpServers"]).toBeUndefined();
    expect(parsed["$schema"]).toBe("https://example.com/schema.json");
    expect(parsed["metadata"]).toEqual({ version: 1 });
  });

  it("returns 'deleted' only when mcpServers.glasstrace is the sole data", () => {
    const content = JSON.stringify(
      {
        mcpServers: {
          glasstrace: { url: "https://api.glasstrace.dev/mcp" },
        },
      },
      null,
      2,
    );
    const result = processJsonMcpConfig(content);
    expect(result.action).toBe("deleted");
  });
});

// ---------------------------------------------------------------------------
// processTomlMcpConfig
// ---------------------------------------------------------------------------

describe("processTomlMcpConfig", () => {
  it("returns 'deleted' when glasstrace is the only section", () => {
    const content = [
      "[mcp_servers.glasstrace]",
      'url = "https://api.glasstrace.dev/mcp"',
      'bearer_token_env_var = "GLASSTRACE_API_KEY"',
      "",
    ].join("\n");
    const result = processTomlMcpConfig(content);
    expect(result.action).toBe("deleted");
  });

  it("returns 'removed-section' when other sections exist", () => {
    const content = [
      "[mcp_servers.other]",
      'url = "https://other.dev/mcp"',
      "",
      "[mcp_servers.glasstrace]",
      'url = "https://api.glasstrace.dev/mcp"',
      'bearer_token_env_var = "GLASSTRACE_API_KEY"',
      "",
    ].join("\n");
    const result = processTomlMcpConfig(content);
    expect(result.action).toBe("removed-section");
    expect(result.content).toBeDefined();
    expect(result.content).toContain("[mcp_servers.other]");
    expect(result.content).not.toContain("glasstrace");
  });

  it("returns 'skipped' when no glasstrace section exists", () => {
    const content = [
      "[mcp_servers.other]",
      'url = "https://other.dev/mcp"',
      "",
    ].join("\n");
    const result = processTomlMcpConfig(content);
    expect(result.action).toBe("skipped");
  });
});

// ---------------------------------------------------------------------------
// runUninit — full integration tests
// ---------------------------------------------------------------------------

describe("runUninit", () => {
  it("unwraps ESM next.config.ts and removes import", async () => {
    const dir = createTmpProject();
    const configContent = [
      'import { withGlasstraceConfig } from "@glasstrace/sdk";',
      "",
      "const nextConfig = {};",
      "",
      "export default withGlasstraceConfig(nextConfig);",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "next.config.ts"), configContent);

    const result = await runUninit({ projectRoot: dir, dryRun: false });
    expect(result.exitCode).toBe(0);

    const content = fs.readFileSync(path.join(dir, "next.config.ts"), "utf-8");
    expect(content).not.toContain("withGlasstraceConfig");
    expect(content).not.toContain("@glasstrace/sdk");
    expect(content).toContain("export default nextConfig;");
  });

  it("unwraps CJS next.config.js and removes require", async () => {
    const dir = createTmpProject();
    const configContent = [
      'const { withGlasstraceConfig } = require("@glasstrace/sdk");',
      "",
      "const nextConfig = {};",
      "",
      "module.exports = withGlasstraceConfig(nextConfig);",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "next.config.js"), configContent);

    const result = await runUninit({ projectRoot: dir, dryRun: false });
    expect(result.exitCode).toBe(0);

    const content = fs.readFileSync(path.join(dir, "next.config.js"), "utf-8");
    expect(content).not.toContain("withGlasstraceConfig");
    expect(content).not.toContain("@glasstrace/sdk");
    expect(content).toContain("module.exports = nextConfig;");
  });

  it("unwraps nested withGlasstraceConfig(withBundleAnalyzer(config))", async () => {
    const dir = createTmpProject();
    const configContent = [
      'import { withGlasstraceConfig } from "@glasstrace/sdk";',
      "",
      "export default withGlasstraceConfig(withBundleAnalyzer(config));",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "next.config.ts"), configContent);

    const result = await runUninit({ projectRoot: dir, dryRun: false });
    expect(result.exitCode).toBe(0);

    const content = fs.readFileSync(path.join(dir, "next.config.ts"), "utf-8");
    expect(content).toContain("export default withBundleAnalyzer(config);");
    expect(content).not.toContain("withGlasstraceConfig");
  });

  it("deletes init-created instrumentation.ts", async () => {
    const dir = createTmpProject();
    const instrContent = `import { registerGlasstrace } from "@glasstrace/sdk";

export async function register() {
  // Glasstrace must be registered before Prisma instrumentation
  // to ensure all ORM spans are captured correctly.
  // If you use @prisma/instrumentation, import it after this call.
  registerGlasstrace();
}
`;
    fs.writeFileSync(path.join(dir, "instrumentation.ts"), instrContent);

    const result = await runUninit({ projectRoot: dir, dryRun: false });
    expect(result.exitCode).toBe(0);
    expect(result.summary.some((s) => s.includes("Deleted instrumentation.ts"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "instrumentation.ts"))).toBe(false);
  });

  it("removes registerGlasstrace from instrumentation.ts with other code", async () => {
    const dir = createTmpProject();
    const instrContent = `import { registerGlasstrace } from "@glasstrace/sdk";
import * as Sentry from "@sentry/nextjs";

export async function register() {
  // Glasstrace must be registered before other instrumentation
  registerGlasstrace();
  Sentry.init({
    dsn: "https://example@sentry.io/123",
  });
}
`;
    fs.writeFileSync(path.join(dir, "instrumentation.ts"), instrContent);

    const result = await runUninit({ projectRoot: dir, dryRun: false });
    expect(result.exitCode).toBe(0);

    const content = fs.readFileSync(
      path.join(dir, "instrumentation.ts"),
      "utf-8",
    );
    expect(content).not.toContain("registerGlasstrace");
    expect(content).not.toContain("@glasstrace/sdk");
    expect(content).toContain("Sentry.init(");
  });

  it("removes .glasstrace/ directory", async () => {
    const dir = createTmpProject();
    const glasstraceDir = path.join(dir, ".glasstrace");
    fs.mkdirSync(glasstraceDir);
    fs.writeFileSync(path.join(glasstraceDir, "mcp.json"), "{}");
    fs.writeFileSync(path.join(glasstraceDir, "mcp-connected"), "{}");

    const result = await runUninit({ projectRoot: dir, dryRun: false });
    expect(result.exitCode).toBe(0);
    expect(result.summary.some((s) => s.includes(".glasstrace/"))).toBe(true);
    expect(fs.existsSync(glasstraceDir)).toBe(false);
  });

  it("removes GLASSTRACE entries from .env.local, preserving others", async () => {
    const dir = createTmpProject();
    const envContent = [
      "DATABASE_URL=postgres://localhost/db",
      "# GLASSTRACE_API_KEY=your_key_here",
      "GLASSTRACE_COVERAGE_MAP=true",
      "NEXT_PUBLIC_APP_URL=http://localhost:3000",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, ".env.local"), envContent);

    const result = await runUninit({ projectRoot: dir, dryRun: false });
    expect(result.exitCode).toBe(0);

    const content = fs.readFileSync(path.join(dir, ".env.local"), "utf-8");
    expect(content).not.toContain("GLASSTRACE");
    expect(content).toContain("DATABASE_URL");
    expect(content).toContain("NEXT_PUBLIC_APP_URL");
  });

  it("removes .glasstrace/ line from .gitignore, preserving others", async () => {
    const dir = createTmpProject();
    const gitignoreContent = [
      "node_modules/",
      ".next/",
      ".glasstrace/",
      ".env.local",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, ".gitignore"), gitignoreContent);

    const result = await runUninit({ projectRoot: dir, dryRun: false });
    expect(result.exitCode).toBe(0);

    const content = fs.readFileSync(path.join(dir, ".gitignore"), "utf-8");
    expect(content).not.toContain(".glasstrace/");
    expect(content).toContain("node_modules/");
    expect(content).toContain(".next/");
    expect(content).toContain(".env.local");
  });

  it("in dry run mode, reports what would be done without modifying files", async () => {
    const dir = createTmpProject();

    // Set up artifacts
    fs.writeFileSync(
      path.join(dir, "next.config.ts"),
      [
        'import { withGlasstraceConfig } from "@glasstrace/sdk";',
        "",
        "export default withGlasstraceConfig(nextConfig);",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "instrumentation.ts"),
      `import { registerGlasstrace } from "@glasstrace/sdk";\n\nexport async function register() {\n  registerGlasstrace();\n}\n`,
    );
    fs.mkdirSync(path.join(dir, ".glasstrace"));
    fs.writeFileSync(path.join(dir, ".glasstrace", "mcp.json"), "{}");
    fs.writeFileSync(
      path.join(dir, ".gitignore"),
      ".glasstrace/\nnode_modules/\n",
    );
    fs.writeFileSync(
      path.join(dir, ".env.local"),
      "# GLASSTRACE_API_KEY=key\n",
    );

    const result = await runUninit({ projectRoot: dir, dryRun: true });
    expect(result.exitCode).toBe(0);

    // All summary lines should have [dry run] prefix
    for (const line of result.summary) {
      expect(line).toContain("[dry run]");
    }

    // Verify nothing was actually modified
    expect(fs.existsSync(path.join(dir, "next.config.ts"))).toBe(true);
    const nextConfig = fs.readFileSync(
      path.join(dir, "next.config.ts"),
      "utf-8",
    );
    expect(nextConfig).toContain("withGlasstraceConfig");

    expect(fs.existsSync(path.join(dir, "instrumentation.ts"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".glasstrace"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".env.local"))).toBe(true);
  });

  it("reports nothing to do when no artifacts exist (idempotent)", async () => {
    const dir = createTmpProject();

    const result = await runUninit({ projectRoot: dir, dryRun: false });
    expect(result.exitCode).toBe(0);
    expect(result.summary).toHaveLength(1);
    expect(result.summary[0]).toContain("nothing to do");
    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("removes MCP config entries from JSON files", async () => {
    const dir = createTmpProject();
    const mcpContent = JSON.stringify(
      {
        mcpServers: {
          glasstrace: { url: "https://api.glasstrace.dev/mcp" },
          other: { url: "https://other.dev/mcp" },
        },
      },
      null,
      2,
    );
    fs.writeFileSync(path.join(dir, ".mcp.json"), mcpContent);

    const result = await runUninit({ projectRoot: dir, dryRun: false });
    expect(result.exitCode).toBe(0);

    const content = fs.readFileSync(path.join(dir, ".mcp.json"), "utf-8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const servers = parsed["mcpServers"] as Record<string, unknown>;
    expect(servers["glasstrace"]).toBeUndefined();
    expect(servers["other"]).toBeDefined();
  });

  it("deletes MCP config file when glasstrace is the only server and only key", async () => {
    const dir = createTmpProject();
    const mcpContent = JSON.stringify(
      {
        mcpServers: {
          glasstrace: { url: "https://api.glasstrace.dev/mcp" },
        },
      },
      null,
      2,
    );
    fs.writeFileSync(path.join(dir, ".mcp.json"), mcpContent);

    const result = await runUninit({ projectRoot: dir, dryRun: false });
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(dir, ".mcp.json"))).toBe(false);
  });

  it("preserves MCP config file when it has other top-level keys", async () => {
    const dir = createTmpProject();
    const mcpContent = JSON.stringify(
      {
        mcpServers: {
          glasstrace: { url: "https://api.glasstrace.dev/mcp" },
        },
        $schema: "https://example.com/mcp-schema.json",
      },
      null,
      2,
    );
    fs.writeFileSync(path.join(dir, ".mcp.json"), mcpContent);

    const result = await runUninit({ projectRoot: dir, dryRun: false });
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(dir, ".mcp.json"))).toBe(true);

    const content = fs.readFileSync(path.join(dir, ".mcp.json"), "utf-8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    expect(parsed["mcpServers"]).toBeUndefined();
    expect(parsed["$schema"]).toBe("https://example.com/mcp-schema.json");
  });

  it("removes glasstrace marker section from agent info files", async () => {
    const dir = createTmpProject();
    const claudeContent = [
      "# My Project",
      "",
      "Some project-specific instructions.",
      "",
      "<!-- glasstrace:mcp:start -->",
      "",
      "## Glasstrace MCP Integration",
      "",
      "Glasstrace is configured as an MCP server.",
      "",
      "<!-- glasstrace:mcp:end -->",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), claudeContent);

    const result = await runUninit({ projectRoot: dir, dryRun: false });
    expect(result.exitCode).toBe(0);

    const content = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("# My Project");
    expect(content).toContain("Some project-specific instructions.");
    expect(content).not.toContain("glasstrace:mcp");
    expect(content).not.toContain("Glasstrace MCP Integration");
  });

  it("removes MCP gitignore entries alongside .glasstrace/", async () => {
    const dir = createTmpProject();
    const gitignoreContent = [
      "node_modules/",
      ".next/",
      ".glasstrace/",
      ".mcp.json",
      ".cursor/mcp.json",
      ".gemini/settings.json",
      ".codex/config.toml",
      ".env.local",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, ".gitignore"), gitignoreContent);

    const result = await runUninit({ projectRoot: dir, dryRun: false });
    expect(result.exitCode).toBe(0);

    const content = fs.readFileSync(path.join(dir, ".gitignore"), "utf-8");
    expect(content).not.toContain(".glasstrace/");
    expect(content).not.toContain(".mcp.json");
    expect(content).not.toContain(".cursor/mcp.json");
    expect(content).not.toContain(".gemini/settings.json");
    expect(content).not.toContain(".codex/config.toml");
    expect(content).toContain("node_modules/");
    expect(content).toContain(".next/");
    expect(content).toContain(".env.local");
  });

  it("handles cursor MCP config in subdirectory", async () => {
    const dir = createTmpProject();
    const cursorDir = path.join(dir, ".cursor");
    fs.mkdirSync(cursorDir);
    const mcpContent = JSON.stringify(
      {
        mcpServers: {
          glasstrace: { url: "https://api.glasstrace.dev/mcp" },
        },
      },
      null,
      2,
    );
    fs.writeFileSync(path.join(cursorDir, "mcp.json"), mcpContent);

    const result = await runUninit({ projectRoot: dir, dryRun: false });
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(cursorDir, "mcp.json"))).toBe(false);
  });

  it("removes glasstrace section from .codex/config.toml", async () => {
    const dir = createTmpProject();
    const codexDir = path.join(dir, ".codex");
    fs.mkdirSync(codexDir);
    const tomlContent = [
      "[mcp_servers.other]",
      'url = "https://other.dev/mcp"',
      "",
      "[mcp_servers.glasstrace]",
      'url = "https://api.glasstrace.dev/mcp"',
      'bearer_token_env_var = "GLASSTRACE_API_KEY"',
      "",
    ].join("\n");
    fs.writeFileSync(path.join(codexDir, "config.toml"), tomlContent);

    const result = await runUninit({ projectRoot: dir, dryRun: false });
    expect(result.exitCode).toBe(0);

    const content = fs.readFileSync(
      path.join(codexDir, "config.toml"),
      "utf-8",
    );
    expect(content).toContain("[mcp_servers.other]");
    expect(content).not.toContain("glasstrace");
  });

  it("handles .env.local with only GLASSTRACE entries — deletes file", async () => {
    const dir = createTmpProject();
    fs.writeFileSync(
      path.join(dir, ".env.local"),
      "# GLASSTRACE_API_KEY=key\nGLASSTRACE_COVERAGE_MAP=true\n",
    );

    const result = await runUninit({ projectRoot: dir, dryRun: false });
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(dir, ".env.local"))).toBe(false);
    expect(result.summary.some((s) => s.includes("Deleted .env.local"))).toBe(true);
  });
});
