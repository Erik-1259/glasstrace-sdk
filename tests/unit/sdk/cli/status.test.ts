import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runStatus } from "../../../../packages/sdk/src/cli/status.js";
import type { StatusResult } from "../../../../packages/sdk/src/cli/status.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

function createTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "glasstrace-status-test-"),
  );
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
// Tests
// ---------------------------------------------------------------------------

describe("runStatus", () => {
  describe("empty project", () => {
    it("reports all-false when no SDK files exist", () => {
      const dir = createTmpDir();
      const result = runStatus({ projectRoot: dir });

      expect(result.installed).toBe(false);
      expect(result.initialized).toBe(false);
      expect(result.instrumentation).toBe(false);
      expect(result.configWrapped).toBe(false);
      expect(result.anonKey).toBe(false);
      expect(result.mcpConfigured).toBe(false);
      expect(result.agents).toEqual([]);
    });
  });

  describe("installed detection", () => {
    it("detects @glasstrace/sdk in dependencies", () => {
      const dir = createTmpDir();
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ dependencies: { "@glasstrace/sdk": "^0.12.0" } }),
      );

      const result = runStatus({ projectRoot: dir });
      expect(result.installed).toBe(true);
    });

    it("detects @glasstrace/sdk in devDependencies", () => {
      const dir = createTmpDir();
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ devDependencies: { "@glasstrace/sdk": "^0.12.0" } }),
      );

      const result = runStatus({ projectRoot: dir });
      expect(result.installed).toBe(true);
    });

    it("reports false when package.json has no glasstrace dependency", () => {
      const dir = createTmpDir();
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ dependencies: { "next": "^14.0.0" } }),
      );

      const result = runStatus({ projectRoot: dir });
      expect(result.installed).toBe(false);
    });
  });

  describe("instrumentation detection", () => {
    it("detects instrumentation.ts with registerGlasstrace", () => {
      const dir = createTmpDir();
      fs.writeFileSync(
        path.join(dir, "instrumentation.ts"),
        'import { registerGlasstrace } from "@glasstrace/sdk";\nexport function register() { registerGlasstrace(); }\n',
      );

      const result = runStatus({ projectRoot: dir });
      expect(result.instrumentation).toBe(true);
    });

    it("detects instrumentation.js with registerGlasstrace", () => {
      const dir = createTmpDir();
      fs.writeFileSync(
        path.join(dir, "instrumentation.js"),
        'const { registerGlasstrace } = require("@glasstrace/sdk");\nmodule.exports = { register() { registerGlasstrace(); } };\n',
      );

      const result = runStatus({ projectRoot: dir });
      expect(result.instrumentation).toBe(true);
    });

    it("detects src/instrumentation.ts with registerGlasstrace", () => {
      const dir = createTmpDir();
      fs.mkdirSync(path.join(dir, "src"));
      fs.writeFileSync(
        path.join(dir, "src", "instrumentation.ts"),
        'import { registerGlasstrace } from "@glasstrace/sdk";\nexport function register() { registerGlasstrace(); }\n',
      );

      const result = runStatus({ projectRoot: dir });
      expect(result.instrumentation).toBe(true);
    });

    it("reports false when instrumentation.ts exists but has no registerGlasstrace", () => {
      const dir = createTmpDir();
      fs.writeFileSync(
        path.join(dir, "instrumentation.ts"),
        'export function register() { console.log("hello"); }\n',
      );

      const result = runStatus({ projectRoot: dir });
      expect(result.instrumentation).toBe(false);
    });
  });

  describe("initialized detection", () => {
    it("detects .glasstrace/ directory", () => {
      const dir = createTmpDir();
      fs.mkdirSync(path.join(dir, ".glasstrace"));

      const result = runStatus({ projectRoot: dir });
      expect(result.initialized).toBe(true);
    });
  });

  describe("anon key detection", () => {
    it("detects .glasstrace/anon_key", () => {
      const dir = createTmpDir();
      fs.mkdirSync(path.join(dir, ".glasstrace"));
      fs.writeFileSync(
        path.join(dir, ".glasstrace", "anon_key"),
        "gt_anon_" + "a".repeat(48),
      );

      const result = runStatus({ projectRoot: dir });
      expect(result.anonKey).toBe(true);
    });
  });

  describe("MCP config detection", () => {
    it("detects glasstrace server in .mcp.json", () => {
      const dir = createTmpDir();
      fs.writeFileSync(
        path.join(dir, ".mcp.json"),
        JSON.stringify({ mcpServers: { glasstrace: { url: "https://api.glasstrace.dev/mcp" } } }),
      );

      const result = runStatus({ projectRoot: dir });
      expect(result.mcpConfigured).toBe(true);
    });

    it("detects glasstrace server in .cursor/mcp.json", () => {
      const dir = createTmpDir();
      fs.mkdirSync(path.join(dir, ".cursor"));
      fs.writeFileSync(
        path.join(dir, ".cursor", "mcp.json"),
        JSON.stringify({ mcpServers: { glasstrace: { url: "https://api.glasstrace.dev/mcp" } } }),
      );

      const result = runStatus({ projectRoot: dir });
      expect(result.mcpConfigured).toBe(true);
    });

    it("detects glasstrace server in .glasstrace/mcp.json", () => {
      const dir = createTmpDir();
      fs.mkdirSync(path.join(dir, ".glasstrace"));
      fs.writeFileSync(
        path.join(dir, ".glasstrace", "mcp.json"),
        JSON.stringify({ mcpServers: { glasstrace: { url: "https://api.glasstrace.dev/mcp" } } }),
      );

      const result = runStatus({ projectRoot: dir });
      expect(result.mcpConfigured).toBe(true);
    });

    it("detects glasstrace server in .codex/config.toml", () => {
      const dir = createTmpDir();
      fs.mkdirSync(path.join(dir, ".codex"));
      fs.writeFileSync(
        path.join(dir, ".codex", "config.toml"),
        '[mcp_servers.glasstrace]\nurl = "https://api.glasstrace.dev/mcp"\n',
      );

      const result = runStatus({ projectRoot: dir });
      expect(result.mcpConfigured).toBe(true);
    });

    it("reports false when MCP config has no glasstrace server", () => {
      const dir = createTmpDir();
      fs.writeFileSync(
        path.join(dir, ".mcp.json"),
        JSON.stringify({ mcpServers: { other: { url: "https://example.com" } } }),
      );

      const result = runStatus({ projectRoot: dir });
      expect(result.mcpConfigured).toBe(false);
    });
  });

  describe("config wrapped detection", () => {
    it("detects withGlasstraceConfig in next.config.ts", () => {
      const dir = createTmpDir();
      fs.writeFileSync(
        path.join(dir, "next.config.ts"),
        'import { withGlasstraceConfig } from "@glasstrace/sdk";\nexport default withGlasstraceConfig({});\n',
      );

      const result = runStatus({ projectRoot: dir });
      expect(result.configWrapped).toBe(true);
    });

    it("reports false when next.config exists without withGlasstraceConfig", () => {
      const dir = createTmpDir();
      fs.writeFileSync(
        path.join(dir, "next.config.js"),
        "module.exports = {};\n",
      );

      const result = runStatus({ projectRoot: dir });
      expect(result.configWrapped).toBe(false);
    });
  });

  describe("agent detection", () => {
    it("detects glasstrace marker in CLAUDE.md", () => {
      const dir = createTmpDir();
      fs.writeFileSync(
        path.join(dir, "CLAUDE.md"),
        "# Project\n\n<!-- glasstrace:mcp:start -->\nGlasstrace info\n<!-- glasstrace:mcp:end -->\n",
      );

      const result = runStatus({ projectRoot: dir });
      expect(result.agents).toEqual(["CLAUDE.md"]);
    });

    it("detects hash-style marker in .cursorrules", () => {
      const dir = createTmpDir();
      fs.writeFileSync(
        path.join(dir, ".cursorrules"),
        "# Project\n\n# glasstrace:mcp:start\nGlasstrace info\n# glasstrace:mcp:end\n",
      );

      const result = runStatus({ projectRoot: dir });
      expect(result.agents).toEqual([".cursorrules"]);
    });

    it("detects multiple agent files", () => {
      const dir = createTmpDir();
      fs.writeFileSync(
        path.join(dir, "CLAUDE.md"),
        "<!-- glasstrace:mcp:start -->\ninfo\n<!-- glasstrace:mcp:end -->\n",
      );
      fs.writeFileSync(
        path.join(dir, "codex.md"),
        "# glasstrace:mcp:start\ninfo\n# glasstrace:mcp:end\n",
      );

      const result = runStatus({ projectRoot: dir });
      expect(result.agents).toContain("CLAUDE.md");
      expect(result.agents).toContain("codex.md");
    });

    it("reports empty agents when no markers found", () => {
      const dir = createTmpDir();
      fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# My Project\n");

      const result = runStatus({ projectRoot: dir });
      expect(result.agents).toEqual([]);
    });
  });

  describe("edge cases", () => {
    it("handles missing projectRoot gracefully", () => {
      const result = runStatus({
        projectRoot: path.join(os.tmpdir(), "nonexistent-" + Date.now()),
      });

      expect(result.installed).toBe(false);
      expect(result.initialized).toBe(false);
      expect(result.instrumentation).toBe(false);
      expect(result.configWrapped).toBe(false);
      expect(result.anonKey).toBe(false);
      expect(result.mcpConfigured).toBe(false);
      expect(result.agents).toEqual([]);
    });

    it("handles corrupted JSON in package.json", () => {
      const dir = createTmpDir();
      fs.writeFileSync(path.join(dir, "package.json"), "not valid json{{{");

      const result = runStatus({ projectRoot: dir });
      expect(result.installed).toBe(false);
    });

    it("handles corrupted JSON in MCP config", () => {
      const dir = createTmpDir();
      fs.writeFileSync(path.join(dir, ".mcp.json"), "broken json");

      const result = runStatus({ projectRoot: dir });
      expect(result.mcpConfigured).toBe(false);
    });
  });

  describe("output format", () => {
    it("returns a valid StatusResult object", () => {
      const dir = createTmpDir();
      const result = runStatus({ projectRoot: dir });

      // Verify all expected fields exist with correct types
      expect(typeof result.installed).toBe("boolean");
      expect(typeof result.initialized).toBe("boolean");
      expect(typeof result.instrumentation).toBe("boolean");
      expect(typeof result.configWrapped).toBe("boolean");
      expect(typeof result.anonKey).toBe("boolean");
      expect(typeof result.mcpConfigured).toBe("boolean");
      expect(Array.isArray(result.agents)).toBe(true);

      // Verify JSON serialization round-trips correctly
      const serialized = JSON.stringify(result);
      const parsed = JSON.parse(serialized) as StatusResult;
      expect(parsed).toEqual(result);
    });
  });
});
