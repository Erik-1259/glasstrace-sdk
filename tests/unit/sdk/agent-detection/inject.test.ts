import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdir,
  writeFile,
  readFile,
  rm,
  chmod,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  writeMcpConfig,
  injectInfoSection,
  updateGitignore,
} from "../../../../packages/sdk/src/agent-detection/inject.js";
import type { DetectedAgent } from "../../../../packages/sdk/src/agent-detection/detect.js";

function tmpDir(): string {
  return join(tmpdir(), `glasstrace-test-${randomUUID()}`);
}

function makeAgent(
  overrides: Partial<DetectedAgent> = {},
): DetectedAgent {
  return {
    name: "claude",
    mcpConfigPath: null,
    infoFilePath: null,
    cliAvailable: false,
    registrationCommand: null,
    ...overrides,
  };
}

describe("writeMcpConfig", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = tmpDir();
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("writes content to the correct path", async () => {
    const configPath = join(testDir, ".mcp.json");
    const agent = makeAgent({ mcpConfigPath: configPath });

    await writeMcpConfig(agent, '{"test": true}', testDir);

    const written = await readFile(configPath, "utf-8");
    expect(written).toBe('{"test": true}');
  });

  it("creates parent directories", async () => {
    const configPath = join(testDir, "nested", "deep", "config.json");
    const agent = makeAgent({ mcpConfigPath: configPath });

    await writeMcpConfig(agent, '{"nested": true}', testDir);

    const written = await readFile(configPath, "utf-8");
    expect(written).toBe('{"nested": true}');
  });

  it("overwrites existing file", async () => {
    const configPath = join(testDir, "config.json");
    await writeFile(configPath, "old content");
    const agent = makeAgent({ mcpConfigPath: configPath });

    await writeMcpConfig(agent, "new content", testDir);

    const written = await readFile(configPath, "utf-8");
    expect(written).toBe("new content");
  });

  it("is a no-op when mcpConfigPath is null", async () => {
    const agent = makeAgent({ mcpConfigPath: null });

    // Should not throw or write anything
    await writeMcpConfig(agent, "content", testDir);
  });

  it("sets file permissions to 0o600", async () => {
    const configPath = join(testDir, "secure.json");
    const agent = makeAgent({ mcpConfigPath: configPath });

    await writeMcpConfig(agent, "secret", testDir);

    const fileStat = await stat(configPath);
    // Mask out file type bits, keep permission bits
    const permissions = fileStat.mode & 0o777;
    expect(permissions).toBe(0o600);
  });

  it.skipIf(process.getuid?.() === 0)("logs warning on permission denied and does not throw", async () => {
    // Create a read-only directory to prevent file creation
    const readOnlyDir = join(testDir, "readonly");
    await mkdir(readOnlyDir);
    await chmod(readOnlyDir, 0o444);

    const configPath = join(readOnlyDir, "subdir", "config.json");
    const agent = makeAgent({ mcpConfigPath: configPath });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    try {
      await writeMcpConfig(agent, "content", testDir);

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("permission denied"),
      );
    } finally {
      stderrSpy.mockRestore();
      // Restore permissions for cleanup
      await chmod(readOnlyDir, 0o755);
    }
  });
});

describe("injectInfoSection", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = tmpDir();
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  const htmlContent = [
    "<!-- glasstrace:mcp:start -->",
    "",
    "## Glasstrace MCP Integration",
    "",
    "Some info here.",
    "",
    "<!-- glasstrace:mcp:end -->",
    "",
  ].join("\n");

  const hashContent = [
    "# glasstrace:mcp:start",
    "",
    "## Glasstrace MCP Integration",
    "",
    "Some info here.",
    "",
    "# glasstrace:mcp:end",
    "",
  ].join("\n");

  it("creates new file with section when file does not exist", async () => {
    const infoPath = join(testDir, "CLAUDE.md");
    const agent = makeAgent({ infoFilePath: infoPath });

    await injectInfoSection(agent, htmlContent, testDir);

    const written = await readFile(infoPath, "utf-8");
    expect(written).toBe(htmlContent);
  });

  it("appends section when file exists but has no markers", async () => {
    const infoPath = join(testDir, "CLAUDE.md");
    await writeFile(infoPath, "# My Project\n\nExisting content.\n");
    const agent = makeAgent({ infoFilePath: infoPath });

    await injectInfoSection(agent, htmlContent, testDir);

    const written = await readFile(infoPath, "utf-8");
    expect(written).toContain("# My Project");
    expect(written).toContain("Existing content.");
    expect(written).toContain("<!-- glasstrace:mcp:start -->");
    expect(written).toContain("<!-- glasstrace:mcp:end -->");
  });

  it("replaces content between markers when markers exist", async () => {
    const infoPath = join(testDir, "CLAUDE.md");
    const existing = [
      "# My Project",
      "",
      "<!-- glasstrace:mcp:start -->",
      "Old glasstrace content",
      "<!-- glasstrace:mcp:end -->",
      "",
      "# Other section",
    ].join("\n");
    await writeFile(infoPath, existing);
    const agent = makeAgent({ infoFilePath: infoPath });

    await injectInfoSection(agent, htmlContent, testDir);

    const written = await readFile(infoPath, "utf-8");
    expect(written).toContain("# My Project");
    expect(written).toContain("# Other section");
    expect(written).toContain("Some info here.");
    expect(written).not.toContain("Old glasstrace content");
    // Only one pair of markers
    const startCount = written.split("<!-- glasstrace:mcp:start -->").length - 1;
    expect(startCount).toBe(1);
  });

  it("is a no-op when infoFilePath is null", async () => {
    const agent = makeAgent({ infoFilePath: null });
    await injectInfoSection(agent, htmlContent, testDir);
  });

  it("is idempotent — running twice produces same result", async () => {
    const infoPath = join(testDir, "CLAUDE.md");
    await writeFile(infoPath, "# My Project\n");
    const agent = makeAgent({ infoFilePath: infoPath });

    await injectInfoSection(agent, htmlContent, testDir);
    const afterFirst = await readFile(infoPath, "utf-8");

    await injectInfoSection(agent, htmlContent, testDir);
    const afterSecond = await readFile(infoPath, "utf-8");

    expect(afterFirst).toBe(afterSecond);
  });

  it("handles malformed content between markers by replacing entirely", async () => {
    const infoPath = join(testDir, "CLAUDE.md");
    const malformed = [
      "<!-- glasstrace:mcp:start -->",
      "completely garbled content @#$%",
      "more garbled stuff",
      "<!-- glasstrace:mcp:end -->",
    ].join("\n");
    await writeFile(infoPath, malformed);
    const agent = makeAgent({ infoFilePath: infoPath });

    await injectInfoSection(agent, htmlContent, testDir);

    const written = await readFile(infoPath, "utf-8");
    expect(written).toContain("Some info here.");
    expect(written).not.toContain("garbled");
  });

  it("handles hash-prefixed markers", async () => {
    const infoPath = join(testDir, ".cursorrules");
    const existing = [
      "Some cursor rules",
      "",
      "# glasstrace:mcp:start",
      "Old content",
      "# glasstrace:mcp:end",
      "",
      "More rules",
    ].join("\n");
    await writeFile(infoPath, existing);
    const agent = makeAgent({
      name: "cursor",
      infoFilePath: infoPath,
    });

    await injectInfoSection(agent, hashContent, testDir);

    const written = await readFile(infoPath, "utf-8");
    expect(written).toContain("Some cursor rules");
    expect(written).toContain("More rules");
    expect(written).toContain("Some info here.");
    expect(written).not.toContain("Old content");
  });

  it.skipIf(process.getuid?.() === 0)("logs warning when file is read-only and does not throw", async () => {
    const infoPath = join(testDir, "CLAUDE.md");
    await writeFile(infoPath, "# Existing\n");
    await chmod(infoPath, 0o444);

    const agent = makeAgent({ infoFilePath: infoPath });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    try {
      await injectInfoSection(agent, htmlContent, testDir);

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("permission denied"),
      );
    } finally {
      stderrSpy.mockRestore();
      await chmod(infoPath, 0o644);
    }
  });

  it("is a no-op when content is empty string", async () => {
    const infoPath = join(testDir, "CLAUDE.md");
    await writeFile(infoPath, "# Existing\n");
    const agent = makeAgent({ infoFilePath: infoPath });

    await injectInfoSection(agent, "", testDir);

    const written = await readFile(infoPath, "utf-8");
    expect(written).toBe("# Existing\n");
  });
});

describe("updateGitignore", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = tmpDir();
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("adds entries that do not exist", async () => {
    await writeFile(join(testDir, ".gitignore"), "node_modules\n");

    await updateGitignore([".mcp.json", ".glasstrace/"], testDir);

    const content = await readFile(join(testDir, ".gitignore"), "utf-8");
    expect(content).toContain(".mcp.json");
    expect(content).toContain(".glasstrace/");
    expect(content).toContain("node_modules");
  });

  it("does not duplicate existing entries", async () => {
    await writeFile(join(testDir, ".gitignore"), ".mcp.json\nnode_modules\n");

    await updateGitignore([".mcp.json"], testDir);

    const content = await readFile(join(testDir, ".gitignore"), "utf-8");
    const occurrences = content.split(".mcp.json").length - 1;
    expect(occurrences).toBe(1);
  });

  it("creates .gitignore if missing", async () => {
    await updateGitignore([".mcp.json"], testDir);

    const content = await readFile(join(testDir, ".gitignore"), "utf-8");
    expect(content).toBe(".mcp.json\n");
  });

  it("handles entries with different whitespace", async () => {
    await writeFile(
      join(testDir, ".gitignore"),
      "  .mcp.json  \nnode_modules\n",
    );

    await updateGitignore([".mcp.json"], testDir);

    const content = await readFile(join(testDir, ".gitignore"), "utf-8");
    // Should not add duplicate — existing entry matches after trimming
    const lines = content.split("\n").filter((l) => l.trim() === ".mcp.json");
    expect(lines.length).toBe(1);
  });

  it("handles empty .gitignore file", async () => {
    await writeFile(join(testDir, ".gitignore"), "");

    await updateGitignore([".mcp.json"], testDir);

    const content = await readFile(join(testDir, ".gitignore"), "utf-8");
    expect(content).toBe(".mcp.json\n");
  });

  it("normalizes backslashes to forward slashes", async () => {
    await updateGitignore([".codex\\config.toml"], testDir);

    const content = await readFile(join(testDir, ".gitignore"), "utf-8");
    expect(content).toContain(".codex/config.toml");
    expect(content).not.toContain("\\");
  });

  it("skips absolute paths", async () => {
    await updateGitignore(
      ["/Users/someone/.codeium/windsurf/mcp_config.json", ".mcp.json"],
      testDir,
    );

    const content = await readFile(join(testDir, ".gitignore"), "utf-8");
    expect(content).toContain(".mcp.json");
    expect(content).not.toContain("/Users/someone");
  });

  it.skipIf(process.getuid?.() === 0)("logs warning on permission denied and does not throw", async () => {
    // Create a read-only directory
    const readOnlyDir = join(testDir, "readonly");
    await mkdir(readOnlyDir);
    await writeFile(join(readOnlyDir, ".gitignore"), "");
    await chmod(join(readOnlyDir, ".gitignore"), 0o444);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    try {
      await updateGitignore([".mcp.json"], readOnlyDir);

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("permission denied"),
      );
    } finally {
      stderrSpy.mockRestore();
      await chmod(join(readOnlyDir, ".gitignore"), 0o644);
    }
  });

  it("is a no-op when all paths are absolute", async () => {
    await updateGitignore(
      ["/absolute/path/one", "/absolute/path/two"],
      testDir,
    );

    // .gitignore should not have been created
    await expect(
      readFile(join(testDir, ".gitignore"), "utf-8"),
    ).rejects.toThrow();
  });
});
