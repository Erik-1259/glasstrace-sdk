import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runInit } from "../../packages/sdk/src/cli/init.js";

/** Valid anonymous key matching gt_anon_ + 48 hex chars. */
const ANON_KEY = "gt_anon_" + "a1b2c3d4e5f6".repeat(4);

/** MCP endpoint used by the SDK. */
const MCP_ENDPOINT = "https://api.glasstrace.dev/mcp";

/**
 * Creates a minimal temp project directory with package.json
 * and optionally a .glasstrace/anon_key file.
 */
function createTmpProject(opts: { withAnonKey?: boolean } = {}): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "glasstrace-integration-"),
  );
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "test-project" }),
  );
  if (opts.withAnonKey !== false) {
    const glasstraceDir = path.join(dir, ".glasstrace");
    fs.mkdirSync(glasstraceDir, { recursive: true });
    fs.writeFileSync(path.join(glasstraceDir, "anon_key"), ANON_KEY);
  }
  return dir;
}

/**
 * Saves environment variables that tests may mutate.
 * Returns a restore function that MUST be called in afterEach.
 */
function saveEnv(): () => void {
  // Snapshot the entire env object for robust restoration.
  // This ensures any env var mutated during a test is restored,
  // not just the ones we anticipate.
  const snapshot = { ...process.env };
  return () => {
    // Remove any keys added during the test
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) {
        delete process.env[key];
      }
    }
    // Restore original values
    for (const [key, value] of Object.entries(snapshot)) {
      process.env[key] = value;
    }
  };
}

describe("Agent MCP auto-configuration integration tests", () => {
  let tmpDir: string;
  let restoreEnv: () => void;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    restoreEnv = saveEnv();
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    // Default to non-CI so agent detection runs
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.NODE_ENV;
    delete process.env.VERCEL_ENV;
    delete process.env.GLASSTRACE_FORCE_ENABLE;
  });

  afterEach(() => {
    restoreEnv();
    stderrSpy.mockRestore();

    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ───── Test 1: Full init flow ─────

  it("full init flow: creates MCP config, info section, gitignore, and marker", async () => {
    tmpDir = createTmpProject();

    // Create .claude/ marker so Claude agent is detected, plus CLAUDE.md
    // so the info section file path is populated by detectAgents
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "# Project\n");

    // Initialize git repo so detectAgents can find git root
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });

    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.errors).toHaveLength(0);

    // .mcp.json created with Claude Code format
    const mcpJson = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8"),
    );
    expect(mcpJson.mcpServers.glasstrace.type).toBe("http");
    expect(mcpJson.mcpServers.glasstrace.url).toBe(MCP_ENDPOINT);
    expect(mcpJson.mcpServers.glasstrace.headers.Authorization).toContain(
      "Bearer ",
    );

    // CLAUDE.md contains informational section (no auth tokens)
    const claudeMd = fs.readFileSync(
      path.join(tmpDir, "CLAUDE.md"),
      "utf-8",
    );
    expect(claudeMd).toContain("<!-- glasstrace:mcp:start -->");
    expect(claudeMd).toContain("<!-- glasstrace:mcp:end -->");
    expect(claudeMd).toContain("Glasstrace MCP Integration");
    expect(claudeMd).not.toContain("gt_anon_");
    expect(claudeMd).not.toContain("Bearer");

    // .gitignore contains .mcp.json
    const gitignore = fs.readFileSync(
      path.join(tmpDir, ".gitignore"),
      "utf-8",
    );
    expect(gitignore).toContain(".mcp.json");

    // .glasstrace/mcp-connected marker exists with key hash
    const markerPath = path.join(tmpDir, ".glasstrace", "mcp-connected");
    expect(fs.existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
    expect(marker.keyHash).toBeDefined();
    expect(typeof marker.keyHash).toBe("string");
    expect(marker.keyHash.length).toBeGreaterThan(0);
    expect(marker.configuredAt).toBeDefined();
  });

  // ───── Test 2: Multi-agent detection ─────

  it("multi-agent detection: creates correct config files for Claude, Cursor, Gemini", async () => {
    tmpDir = createTmpProject();
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });

    // Create agent markers
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".cursor"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".gemini"), { recursive: true });

    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Claude: .mcp.json with type: "http" + url
    const claudeConfig = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8"),
    );
    expect(claudeConfig.mcpServers.glasstrace.type).toBe("http");
    expect(claudeConfig.mcpServers.glasstrace.url).toBe(MCP_ENDPOINT);

    // Cursor: .cursor/mcp.json with url (no type)
    const cursorConfig = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".cursor", "mcp.json"), "utf-8"),
    );
    expect(cursorConfig.mcpServers.glasstrace.url).toBe(MCP_ENDPOINT);
    expect(cursorConfig.mcpServers.glasstrace).not.toHaveProperty("type");

    // Gemini: .gemini/settings.json with httpUrl
    const geminiConfig = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, ".gemini", "settings.json"),
        "utf-8",
      ),
    );
    expect(geminiConfig.mcpServers.glasstrace.httpUrl).toBe(MCP_ENDPOINT);
    expect(geminiConfig.mcpServers.glasstrace).not.toHaveProperty("url");
    expect(geminiConfig.mcpServers.glasstrace).not.toHaveProperty("type");

    // Generic: .glasstrace/mcp.json always present
    const genericConfig = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, ".glasstrace", "mcp.json"),
        "utf-8",
      ),
    );
    expect(genericConfig.mcpServers.glasstrace.url).toBe(MCP_ENDPOINT);
  });

  // ───── Test 3: Idempotency ─────

  it("idempotency: running init twice does not duplicate content", async () => {
    tmpDir = createTmpProject();
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "# Project\n");

    // First run
    const result1 = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });
    expect(result1.exitCode).toBe(0);

    // Capture content after first run
    const mcpJson1 = fs.readFileSync(
      path.join(tmpDir, ".mcp.json"),
      "utf-8",
    );

    // Second run
    const result2 = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });
    expect(result2.exitCode).toBe(0);

    // CLAUDE.md: markers prevent duplication
    const claudeMd2 = fs.readFileSync(
      path.join(tmpDir, "CLAUDE.md"),
      "utf-8",
    );
    const startMarkerCount = (
      claudeMd2.match(/<!-- glasstrace:mcp:start -->/g) || []
    ).length;
    const endMarkerCount = (
      claudeMd2.match(/<!-- glasstrace:mcp:end -->/g) || []
    ).length;
    expect(startMarkerCount).toBe(1);
    expect(endMarkerCount).toBe(1);

    // MCP config files have correct content (overwritten, not appended)
    const mcpJson2 = fs.readFileSync(
      path.join(tmpDir, ".mcp.json"),
      "utf-8",
    );
    // Both runs should produce valid JSON (not doubled content)
    expect(() => JSON.parse(mcpJson2)).not.toThrow();
    const parsed1 = JSON.parse(mcpJson1);
    const parsed2 = JSON.parse(mcpJson2);
    expect(parsed2).toEqual(parsed1);

    // .gitignore entries not duplicated
    const gitignore = fs.readFileSync(
      path.join(tmpDir, ".gitignore"),
      "utf-8",
    );
    const mcpJsonEntries = gitignore
      .split("\n")
      .filter((line) => line.trim() === ".mcp.json");
    expect(mcpJsonEntries).toHaveLength(1);
  });

  // ───── Test 4: Agent-specific Claude Code ─────

  it("agent-specific Claude Code: .mcp.json has type http + url + headers", async () => {
    tmpDir = createTmpProject();
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });

    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });
    expect(result.exitCode).toBe(0);

    const mcpJson = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8"),
    );
    expect(mcpJson).toEqual({
      mcpServers: {
        glasstrace: {
          type: "http",
          url: MCP_ENDPOINT,
          headers: {
            Authorization: `Bearer ${ANON_KEY}`,
          },
        },
      },
    });
  });

  // ───── Test 5: Agent-specific Cursor ─────

  it("agent-specific Cursor: .cursor/mcp.json has url + headers, no type field", async () => {
    tmpDir = createTmpProject();
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".cursor"), { recursive: true });

    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });
    expect(result.exitCode).toBe(0);

    const cursorConfig = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".cursor", "mcp.json"), "utf-8"),
    );
    expect(cursorConfig).toEqual({
      mcpServers: {
        glasstrace: {
          url: MCP_ENDPOINT,
          headers: {
            Authorization: `Bearer ${ANON_KEY}`,
          },
        },
      },
    });
    // Explicitly verify no type field
    expect(
      Object.keys(cursorConfig.mcpServers.glasstrace),
    ).not.toContain("type");
  });

  // ───── Test 6: Agent-specific Windsurf ─────

  it("agent-specific Windsurf: config uses serverUrl", async () => {
    tmpDir = createTmpProject();
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });

    // Create .windsurfrules marker in project
    fs.writeFileSync(path.join(tmpDir, ".windsurfrules"), "");

    // Redirect HOME so Windsurf config writes to test sandbox
    const fakeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "glasstrace-windsurf-home-"),
    );

    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;

    try {
      const result = await runInit({
        projectRoot: tmpDir,
        yes: true,
        coverageMap: false,
      });
      expect(result.exitCode).toBe(0);

      // Windsurf config uses serverUrl
      const windsurfConfigPath = path.join(
        fakeHome,
        ".codeium",
        "windsurf",
        "mcp_config.json",
      );
      expect(fs.existsSync(windsurfConfigPath)).toBe(true);

      const windsurfConfig = JSON.parse(
        fs.readFileSync(windsurfConfigPath, "utf-8"),
      );
      expect(windsurfConfig.mcpServers.glasstrace.serverUrl).toBe(
        MCP_ENDPOINT,
      );
      expect(windsurfConfig.mcpServers.glasstrace).not.toHaveProperty(
        "url",
      );
      expect(windsurfConfig.mcpServers.glasstrace).not.toHaveProperty(
        "httpUrl",
      );
    } finally {
      // Clean up fake home
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  // ───── Test 7: Security — no auth tokens in committed files ─────

  it("security: no auth tokens in info section files, tokens present in MCP configs", async () => {
    tmpDir = createTmpProject();
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });

    // Create markers for agents with info files
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "# Project\n");
    fs.mkdirSync(path.join(tmpDir, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".cursorrules"), "");

    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });
    expect(result.exitCode).toBe(0);

    // Info section files must NOT contain auth tokens
    const claudeMd = fs.readFileSync(
      path.join(tmpDir, "CLAUDE.md"),
      "utf-8",
    );
    expect(claudeMd).not.toContain("gt_anon_");
    expect(claudeMd).not.toContain("Bearer");

    // .cursorrules info file must not contain auth tokens
    const cursorrules = fs.readFileSync(
      path.join(tmpDir, ".cursorrules"),
      "utf-8",
    );
    expect(cursorrules).not.toContain("gt_anon_");
    expect(cursorrules).not.toContain("Bearer");

    // MCP config files DO contain auth tokens (they are gitignored)
    const mcpConfig = fs.readFileSync(
      path.join(tmpDir, ".mcp.json"),
      "utf-8",
    );
    expect(mcpConfig).toContain("gt_anon_");
    expect(mcpConfig).toContain("Bearer");

    const cursorMcpConfig = fs.readFileSync(
      path.join(tmpDir, ".cursor", "mcp.json"),
      "utf-8",
    );
    expect(cursorMcpConfig).toContain("gt_anon_");
    expect(cursorMcpConfig).toContain("Bearer");
  });

  // ───── Test 8: Gitignore entries ─────

  it("gitignore: all agent config paths are listed", async () => {
    tmpDir = createTmpProject();
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });

    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });
    expect(result.exitCode).toBe(0);

    const gitignore = fs.readFileSync(
      path.join(tmpDir, ".gitignore"),
      "utf-8",
    );
    expect(gitignore).toContain(".mcp.json");
    expect(gitignore).toContain(".cursor/mcp.json");
    expect(gitignore).toContain(".gemini/settings.json");
    expect(gitignore).toContain(".codex/config.toml");
  });

  // ───── Test 9: First-error nudge (marker absent) ─────

  it("nudge: fires on first error when marker absent, suppressed on second call", async () => {
    tmpDir = createTmpProject({ withAnonKey: false });

    const originalCwd = process.cwd;
    process.cwd = () => tmpDir;

    try {
      vi.resetModules();
      const mod = await import(
        "../../packages/sdk/src/nudge/error-nudge.js"
      );
      const maybeShowMcpNudge = mod.maybeShowMcpNudge;

      // First call — nudge should fire
      maybeShowMcpNudge("GET /api/test -> 500");

      expect(stderrSpy).toHaveBeenCalled();
      const firstOutput = stderrSpy.mock.calls[0]![0] as string;
      expect(firstOutput).toContain("[glasstrace] Error captured:");
      expect(firstOutput).toContain("GET /api/test -> 500");
      expect(firstOutput).toContain("npx glasstrace mcp add");

      // Reset spy to track second call
      stderrSpy.mockClear();

      // Second call — no second nudge (one-per-process)
      maybeShowMcpNudge("POST /api/other -> 503");
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      process.cwd = originalCwd;
    }
  });

  // ───── Test 10: Nudge suppressed in production ─────

  it("nudge: suppressed in production (NODE_ENV=production)", async () => {
    tmpDir = createTmpProject({ withAnonKey: false });

    const originalCwd = process.cwd;
    process.cwd = () => tmpDir;
    process.env.NODE_ENV = "production";

    try {
      vi.resetModules();
      const mod = await import(
        "../../packages/sdk/src/nudge/error-nudge.js"
      );
      mod.maybeShowMcpNudge("some error");

      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      process.cwd = originalCwd;
    }
  });

  // ───── Test 11: CI environment ─────

  it("CI environment: only generic .glasstrace/mcp.json created", async () => {
    tmpDir = createTmpProject();
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });

    // Create agent markers that would normally trigger agent-specific configs
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".cursor"), { recursive: true });

    // Set CI environment
    process.env.CI = "true";

    const result = await runInit({
      projectRoot: tmpDir,
      yes: true,
      coverageMap: false,
    });
    expect(result.exitCode).toBe(0);

    // Generic config should exist
    expect(
      fs.existsSync(path.join(tmpDir, ".glasstrace", "mcp.json")),
    ).toBe(true);

    // Agent-specific configs should NOT exist
    expect(fs.existsSync(path.join(tmpDir, ".mcp.json"))).toBe(false);
    expect(
      fs.existsSync(path.join(tmpDir, ".cursor", "mcp.json")),
    ).toBe(false);

    // Summary should mention CI mode
    expect(result.summary.some((s) => s.includes("CI mode"))).toBe(true);
  });
});
