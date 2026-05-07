import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
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
  hasManagedSection,
  parseStartMarkerLine,
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

function expectPermissionError(spy: MockInstance) {
  const output = spy.mock.calls.map((c) => String(c[0])).join("\n");
  expect(
    output.includes("EACCES") ||
    output.includes("permission denied") ||
    output.includes("operation not permitted"),
  ).toBe(true);
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

  it("does not leak config content (which embeds the bearer) in stderr or thrown errors", async () => {
    // Force EISDIR by pre-creating the destination as a directory.
    // EISDIR is not a permission error, so writeMcpConfig rethrows it
    // — that rethrow path is the one we care about for content leakage.
    const configPath = join(testDir, "blocked.json");
    await mkdir(configPath, { recursive: true });
    const agent = makeAgent({ mcpConfigPath: configPath });

    const bearer = "gt_dev_" + "9".repeat(48);
    const sensitiveContent = JSON.stringify({
      mcpServers: { glasstrace: { headers: { Authorization: `Bearer ${bearer}` } } },
    });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    let stderrText = "";
    let thrownText = "";

    try {
      try {
        await writeMcpConfig(agent, sensitiveContent, testDir);
      } catch (err) {
        thrownText = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
      }
      stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    } finally {
      stderrSpy.mockRestore();
    }

    // The EISDIR rethrow path is the one we want to audit. Assert
    // explicitly that an error was thrown — otherwise a future change
    // that swallows EISDIR (or gates the rethrow on something else)
    // would leave `thrownText` empty, and the leak assertions would
    // pass vacuously.
    expect(thrownText).not.toBe("");
    expect(thrownText).toMatch(/EISDIR|directory/i);

    expect(stderrText).not.toContain(bearer);
    expect(thrownText).not.toContain(bearer);
    // Defense-in-depth: assert no Bearer-prefixed substring leaked.
    expect(stderrText).not.toMatch(/Bearer gt_/);
    expect(thrownText).not.toMatch(/Bearer gt_/);
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
      expectPermissionError(stderrSpy);
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
      expectPermissionError(stderrSpy);
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

  // SDK-050 Acceptance Gate 2 / DISC-1586 backward-compatibility
  // constraint: an upgrading user's first re-render MUST find the
  // existing legacy unstamped block and replace it in place rather
  // than appending a duplicate.
  it("replaces a legacy unstamped HTML managed section in place (no duplicate appended)", async () => {
    const infoPath = join(testDir, "CLAUDE.md");
    const legacy = [
      "# My Project",
      "",
      "<!-- glasstrace:mcp:start -->",
      "Old pre-SDK-050 content",
      "<!-- glasstrace:mcp:end -->",
      "",
      "## Other section",
      "Untouched user content.",
    ].join("\n");
    await writeFile(infoPath, legacy);

    const stamped = [
      "<!-- glasstrace:mcp:start v=1.4.0 -->",
      "",
      "## Glasstrace MCP Integration",
      "Refreshed content",
      "",
      "<!-- glasstrace:mcp:end -->",
      "",
    ].join("\n");

    const agent = makeAgent({ infoFilePath: infoPath });
    await injectInfoSection(agent, stamped, testDir);

    const written = await readFile(infoPath, "utf-8");
    // Only one start marker — the legacy block was replaced, not duplicated.
    const startCount =
      (written.match(/glasstrace:mcp:start/g) ?? []).length;
    expect(startCount).toBe(1);
    expect(written).toContain("<!-- glasstrace:mcp:start v=1.4.0 -->");
    expect(written).toContain("Refreshed content");
    expect(written).not.toContain("Old pre-SDK-050 content");
    // Surrounding content outside the markers is preserved.
    expect(written).toContain("# My Project");
    expect(written).toContain("## Other section");
    expect(written).toContain("Untouched user content.");
  });

  it("replaces a legacy unstamped hash managed section in place", async () => {
    const infoPath = join(testDir, ".cursorrules");
    const legacy = [
      "Some cursor rules",
      "",
      "# glasstrace:mcp:start",
      "Old pre-SDK-050 cursor content",
      "# glasstrace:mcp:end",
      "",
      "More rules",
    ].join("\n");
    await writeFile(infoPath, legacy);

    const stamped = [
      "# glasstrace:mcp:start v=1.4.0",
      "",
      "## Glasstrace MCP Integration",
      "Refreshed cursor content",
      "",
      "# glasstrace:mcp:end",
      "",
    ].join("\n");

    const agent = makeAgent({
      name: "cursor",
      infoFilePath: infoPath,
    });
    await injectInfoSection(agent, stamped, testDir);

    const written = await readFile(infoPath, "utf-8");
    const startCount =
      (written.match(/glasstrace:mcp:start/g) ?? []).length;
    expect(startCount).toBe(1);
    expect(written).toContain("# glasstrace:mcp:start v=1.4.0");
    expect(written).toContain("Refreshed cursor content");
    expect(written).not.toContain("Old pre-SDK-050 cursor content");
    expect(written).toContain("Some cursor rules");
    expect(written).toContain("More rules");
  });

  // SDK-050 stamp-aware idempotence: re-rendering a stamped block
  // produces byte-for-byte identical output (validation prompt
  // PRE-FLIGHT 3).
  it("re-rendering a stamped block is byte-for-byte idempotent", async () => {
    const infoPath = join(testDir, "CLAUDE.md");
    const stamped = [
      "<!-- glasstrace:mcp:start v=1.4.0 -->",
      "",
      "## Glasstrace MCP Integration",
      "Stamped content",
      "",
      "<!-- glasstrace:mcp:end -->",
      "",
    ].join("\n");
    await writeFile(infoPath, "# Project intro\n\n" + stamped + "\n## Tail\n");

    const agent = makeAgent({ infoFilePath: infoPath });
    await injectInfoSection(agent, stamped, testDir);
    const afterFirst = await readFile(infoPath, "utf-8");

    await injectInfoSection(agent, stamped, testDir);
    const afterSecond = await readFile(infoPath, "utf-8");

    expect(afterSecond).toBe(afterFirst);
  });

  // SDK-050: an upgrading user re-rendering a stamped block with a
  // *different* stamp must still replace in place, not append.
  it("replaces a previously stamped block when the stamp value changes", async () => {
    const infoPath = join(testDir, "CLAUDE.md");
    const oldStamped = [
      "<!-- glasstrace:mcp:start v=1.3.0 -->",
      "",
      "## Glasstrace MCP Integration",
      "Old stamped content",
      "",
      "<!-- glasstrace:mcp:end -->",
      "",
    ].join("\n");
    await writeFile(infoPath, oldStamped);

    const newStamped = [
      "<!-- glasstrace:mcp:start v=1.4.0 -->",
      "",
      "## Glasstrace MCP Integration",
      "New stamped content",
      "",
      "<!-- glasstrace:mcp:end -->",
      "",
    ].join("\n");

    const agent = makeAgent({ infoFilePath: infoPath });
    await injectInfoSection(agent, newStamped, testDir);

    const written = await readFile(infoPath, "utf-8");
    const startCount =
      (written.match(/glasstrace:mcp:start/g) ?? []).length;
    expect(startCount).toBe(1);
    expect(written).toContain("v=1.4.0");
    expect(written).not.toContain("v=1.3.0");
    expect(written).toContain("New stamped content");
    expect(written).not.toContain("Old stamped content");
  });
});

// SDK-050 Required Semantics Item 1 / DISC-1586: shared parser used
// by inject.ts (boundary detection) and upgrade-notice.ts (staleness
// detection). Tested directly so the contract is pinned at one place.
describe("parseStartMarkerLine", () => {
  it("recognises the legacy unstamped HTML marker", () => {
    expect(parseStartMarkerLine("<!-- glasstrace:mcp:start -->"))
      .toEqual({ kind: "html", stamp: null });
  });

  it("recognises the SDK-050+ stamped HTML marker", () => {
    expect(parseStartMarkerLine("<!-- glasstrace:mcp:start v=1.4.0 -->"))
      .toEqual({ kind: "html", stamp: "1.4.0" });
  });

  it("recognises a canary-stamped HTML marker", () => {
    expect(
      parseStartMarkerLine(
        "<!-- glasstrace:mcp:start v=0.0.0-canary-20260508120000 -->",
      ),
    ).toEqual({ kind: "html", stamp: "0.0.0-canary-20260508120000" });
  });

  it("recognises the legacy unstamped hash marker", () => {
    expect(parseStartMarkerLine("# glasstrace:mcp:start"))
      .toEqual({ kind: "hash", stamp: null });
  });

  it("recognises the SDK-050+ stamped hash marker", () => {
    expect(parseStartMarkerLine("# glasstrace:mcp:start v=1.4.0"))
      .toEqual({ kind: "hash", stamp: "1.4.0" });
  });

  it("ignores leading and trailing whitespace", () => {
    expect(parseStartMarkerLine("  <!-- glasstrace:mcp:start v=1.4.0 -->  "))
      .toEqual({ kind: "html", stamp: "1.4.0" });
  });

  it("returns null for non-marker lines", () => {
    expect(parseStartMarkerLine("# Some heading")).toBeNull();
    expect(parseStartMarkerLine("plain text")).toBeNull();
    expect(parseStartMarkerLine("<!-- glasstrace:mcp:end -->")).toBeNull();
    expect(parseStartMarkerLine("")).toBeNull();
  });

  it("returns null for a malformed start marker that lacks the required terminator", () => {
    // Missing closing `-->` — a hand-edit accident or an attacker
    // probing for marker injection. Not a valid start marker.
    expect(parseStartMarkerLine("<!-- glasstrace:mcp:start v=1.4.0"))
      .toBeNull();
  });
});

describe("hasManagedSection", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = tmpDir();
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("returns true for a file with a stamped HTML managed section", async () => {
    const filePath = join(testDir, "CLAUDE.md");
    await writeFile(
      filePath,
      [
        "# Project",
        "<!-- glasstrace:mcp:start v=1.4.0 -->",
        "content",
        "<!-- glasstrace:mcp:end -->",
      ].join("\n"),
    );
    expect(await hasManagedSection(filePath)).toBe(true);
  });

  it("returns true for a file with a legacy unstamped managed section", async () => {
    const filePath = join(testDir, "CLAUDE.md");
    await writeFile(
      filePath,
      [
        "<!-- glasstrace:mcp:start -->",
        "content",
        "<!-- glasstrace:mcp:end -->",
      ].join("\n"),
    );
    expect(await hasManagedSection(filePath)).toBe(true);
  });

  it("returns true for a hash-marker section", async () => {
    const filePath = join(testDir, ".cursorrules");
    await writeFile(
      filePath,
      [
        "# glasstrace:mcp:start v=1.4.0",
        "content",
        "# glasstrace:mcp:end",
      ].join("\n"),
    );
    expect(await hasManagedSection(filePath)).toBe(true);
  });

  it("returns false for a file with no managed section", async () => {
    const filePath = join(testDir, "CLAUDE.md");
    await writeFile(filePath, "# Project\n\nHand-written content.\n");
    expect(await hasManagedSection(filePath)).toBe(false);
  });

  it("returns false for a missing file (best-effort, never throws)", async () => {
    expect(
      await hasManagedSection(join(testDir, "does-not-exist.md")),
    ).toBe(false);
  });

  it("returns false for an orphaned start marker without a matching end", async () => {
    const filePath = join(testDir, "CLAUDE.md");
    await writeFile(
      filePath,
      "<!-- glasstrace:mcp:start v=1.4.0 -->\nsome content but no end marker\n",
    );
    expect(await hasManagedSection(filePath)).toBe(false);
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
      expectPermissionError(stderrSpy);
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
