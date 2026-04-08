import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm, symlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { detectAgents } from "../../../../packages/sdk/src/agent-detection/detect.js";

function tmpDir(): string {
  return join(tmpdir(), `glasstrace-test-${randomUUID()}`);
}

describe("detectAgents", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = tmpDir();
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("projectRoot validation", () => {
    it("throws when projectRoot does not exist", async () => {
      const nonExistent = join(testDir, "nonexistent");
      await expect(detectAgents(nonExistent)).rejects.toThrow(
        /projectRoot does not exist/,
      );
    });

    it("throws when projectRoot is a file, not a directory", async () => {
      const filePath = join(testDir, "afile.txt");
      await writeFile(filePath, "content");
      await expect(detectAgents(filePath)).rejects.toThrow(
        /projectRoot is not a directory/,
      );
    });
  });

  describe("generic fallback", () => {
    it("always includes generic as the last entry", async () => {
      const agents = await detectAgents(testDir);
      expect(agents.length).toBeGreaterThanOrEqual(1);
      const last = agents[agents.length - 1];
      expect(last.name).toBe("generic");
    });

    it("returns only generic when no agents are detected", async () => {
      const agents = await detectAgents(testDir);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("generic");
      expect(agents[0].mcpConfigPath).toBe(
        join(testDir, ".glasstrace", "mcp.json"),
      );
      expect(agents[0].infoFilePath).toBeNull();
      expect(agents[0].cliAvailable).toBe(false);
      expect(agents[0].registrationCommand).toBeNull();
    });
  });

  describe("Claude Code detection", () => {
    it("detects Claude via .claude/ directory", async () => {
      await mkdir(join(testDir, ".claude"));
      const agents = await detectAgents(testDir);
      const claude = agents.find((a) => a.name === "claude");
      expect(claude).toBeDefined();
      expect(claude!.mcpConfigPath).toBe(join(testDir, ".mcp.json"));
      expect(claude!.registrationCommand).toBe(
        "npx glasstrace mcp add --agent claude",
      );
    });

    it("detects Claude via CLAUDE.md file", async () => {
      await writeFile(join(testDir, "CLAUDE.md"), "# instructions");
      const agents = await detectAgents(testDir);
      const claude = agents.find((a) => a.name === "claude");
      expect(claude).toBeDefined();
      expect(claude!.infoFilePath).toBe(join(testDir, "CLAUDE.md"));
    });

    it("sets infoFilePath to null when CLAUDE.md does not exist", async () => {
      await mkdir(join(testDir, ".claude"));
      const agents = await detectAgents(testDir);
      const claude = agents.find((a) => a.name === "claude");
      expect(claude).toBeDefined();
      expect(claude!.infoFilePath).toBeNull();
    });
  });

  describe("Codex CLI detection", () => {
    it("detects Codex via codex.md file", async () => {
      await writeFile(join(testDir, "codex.md"), "# codex");
      const agents = await detectAgents(testDir);
      const codex = agents.find((a) => a.name === "codex");
      expect(codex).toBeDefined();
      expect(codex!.mcpConfigPath).toBe(
        join(testDir, ".codex", "config.toml"),
      );
      expect(codex!.infoFilePath).toBe(join(testDir, "codex.md"));
    });

    it("detects Codex via .codex/ directory", async () => {
      await mkdir(join(testDir, ".codex"));
      const agents = await detectAgents(testDir);
      const codex = agents.find((a) => a.name === "codex");
      expect(codex).toBeDefined();
    });
  });

  describe("Gemini CLI detection", () => {
    it("detects Gemini via .gemini/ directory", async () => {
      await mkdir(join(testDir, ".gemini"));
      const agents = await detectAgents(testDir);
      const gemini = agents.find((a) => a.name === "gemini");
      expect(gemini).toBeDefined();
      expect(gemini!.mcpConfigPath).toBe(
        join(testDir, ".gemini", "settings.json"),
      );
      expect(gemini!.infoFilePath).toBeNull();
    });

    it("does not detect Gemini when .gemini/ is absent", async () => {
      const agents = await detectAgents(testDir);
      const gemini = agents.find((a) => a.name === "gemini");
      expect(gemini).toBeUndefined();
    });
  });

  describe("Cursor detection", () => {
    it("detects Cursor via .cursor/ directory", async () => {
      await mkdir(join(testDir, ".cursor"));
      const agents = await detectAgents(testDir);
      const cursor = agents.find((a) => a.name === "cursor");
      expect(cursor).toBeDefined();
      expect(cursor!.mcpConfigPath).toBe(
        join(testDir, ".cursor", "mcp.json"),
      );
      expect(cursor!.cliAvailable).toBe(false);
    });

    it("detects Cursor via .cursorrules file and sets infoFilePath", async () => {
      await writeFile(join(testDir, ".cursorrules"), "rules");
      const agents = await detectAgents(testDir);
      const cursor = agents.find((a) => a.name === "cursor");
      expect(cursor).toBeDefined();
      expect(cursor!.infoFilePath).toBe(join(testDir, ".cursorrules"));
    });

    it("sets infoFilePath to null when .cursorrules does not exist", async () => {
      await mkdir(join(testDir, ".cursor"));
      const agents = await detectAgents(testDir);
      const cursor = agents.find((a) => a.name === "cursor");
      expect(cursor).toBeDefined();
      expect(cursor!.infoFilePath).toBeNull();
    });
  });

  describe("Windsurf detection", () => {
    it("detects Windsurf via .windsurfrules file", async () => {
      await writeFile(join(testDir, ".windsurfrules"), "rules");
      const agents = await detectAgents(testDir);
      const windsurf = agents.find((a) => a.name === "windsurf");
      expect(windsurf).toBeDefined();
      expect(windsurf!.infoFilePath).toBe(
        join(testDir, ".windsurfrules"),
      );
    });

    it("detects Windsurf via .windsurf/ directory", async () => {
      await mkdir(join(testDir, ".windsurf"));
      const agents = await detectAgents(testDir);
      const windsurf = agents.find((a) => a.name === "windsurf");
      expect(windsurf).toBeDefined();
    });

    it("Windsurf mcpConfigPath is absolute and under home directory", async () => {
      await writeFile(join(testDir, ".windsurfrules"), "rules");
      const agents = await detectAgents(testDir);
      const windsurf = agents.find((a) => a.name === "windsurf");
      expect(windsurf).toBeDefined();
      expect(windsurf!.mcpConfigPath).toContain(".codeium");
      expect(windsurf!.mcpConfigPath).toContain("windsurf");
    });
  });

  describe("multiple agents", () => {
    it("detects multiple agents simultaneously", async () => {
      await mkdir(join(testDir, ".claude"));
      await writeFile(join(testDir, "CLAUDE.md"), "# instructions");
      await mkdir(join(testDir, ".cursor"));
      await writeFile(join(testDir, ".cursorrules"), "rules");
      await writeFile(join(testDir, "codex.md"), "# codex");

      const agents = await detectAgents(testDir);
      const names = agents.map((a) => a.name);
      expect(names).toContain("claude");
      expect(names).toContain("cursor");
      expect(names).toContain("codex");
      expect(names).toContain("generic");
    });
  });

  describe("monorepo walk-up", () => {
    it("detects agent markers in parent directories up to git root", async () => {
      // Create a git root with .claude/ at top level
      const gitRoot = join(testDir, "monorepo");
      await mkdir(gitRoot, { recursive: true });
      await mkdir(join(gitRoot, ".git"));
      await mkdir(join(gitRoot, ".claude"));
      await writeFile(join(gitRoot, "CLAUDE.md"), "# root");

      // Create a nested project directory
      const nested = join(gitRoot, "packages", "mypackage");
      await mkdir(nested, { recursive: true });

      const agents = await detectAgents(nested);
      const claude = agents.find((a) => a.name === "claude");
      expect(claude).toBeDefined();
      expect(claude!.mcpConfigPath).toBe(join(gitRoot, ".mcp.json"));
    });
  });

  describe("symlinks", () => {
    // Windows symlinks require elevated privileges (SeCreateSymbolicLinkPrivilege)
    // which are not available in standard CI/CD environments, so these tests
    // are skipped on win32.
    it.skipIf(process.platform === "win32")("follows symlinks for marker detection", async () => {
      // Create a real .claude dir elsewhere and symlink to it
      const realDir = join(testDir, "real-claude");
      await mkdir(realDir);
      await symlink(realDir, join(testDir, ".claude"));

      const agents = await detectAgents(testDir);
      const claude = agents.find((a) => a.name === "claude");
      expect(claude).toBeDefined();
    });

    it.skipIf(process.platform === "win32")("handles broken/dangling symlink gracefully", async () => {
      // Create a symlink pointing to a non-existent target
      const nonExistentTarget = join(testDir, "does-not-exist");
      await symlink(nonExistentTarget, join(testDir, ".claude"));

      // detectAgents should not throw on a dangling symlink
      const agents = await detectAgents(testDir);
      // Claude may or may not be detected depending on how stat vs lstat is used,
      // but the function must not crash
      expect(Array.isArray(agents)).toBe(true);
    });
  });

  describe("CLI availability", () => {
    it("reports cliAvailable false for agents without a CLI binary", async () => {
      // Cursor has no cliBinary configured, so cliAvailable is always false
      await mkdir(join(testDir, ".cursor"));
      const agents = await detectAgents(testDir);
      const cursor = agents.find((a) => a.name === "cursor");
      expect(cursor).toBeDefined();
      expect(cursor!.cliAvailable).toBe(false);
    });
  });

  describe("permission denied", () => {
    it.skipIf(process.getuid?.() === 0)("skips agents when marker directory is not readable", async () => {
      // Create a directory that we cannot read
      const restrictedDir = join(testDir, ".gemini");
      await mkdir(restrictedDir);
      // Remove read permission
      await chmod(restrictedDir, 0o000);

      try {
        const agents = await detectAgents(testDir);
        // Gemini should NOT be detected since we can't read .gemini
        const gemini = agents.find((a) => a.name === "gemini");
        expect(gemini).toBeUndefined();
      } finally {
        // Restore permissions for cleanup
        await chmod(restrictedDir, 0o755);
      }
    });
  });
});
