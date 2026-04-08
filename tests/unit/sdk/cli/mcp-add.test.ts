import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Valid anon key: gt_anon_ prefix + 48 hex chars (24 bytes)
const TEST_ANON_KEY =
  "gt_anon_000102030405060708090a0b0c0d0e0f1011121314151617";

// Mock child_process.execFile so CLI registration always fails (no real binaries)
vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      _args: string[],
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(new Error("CLI not available"), "", "");
    },
  ),
}));

let tmpDir: string;
let originalCwd: () => string;

function createTmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glasstrace-mcp-test-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "test-project" }),
  );
  return dir;
}

function writeAnonKey(dir: string): void {
  const glassDir = path.join(dir, ".glasstrace");
  fs.mkdirSync(glassDir, { recursive: true });
  fs.writeFileSync(path.join(glassDir, "anon_key"), TEST_ANON_KEY, "utf-8");
}

function writeMarkerFile(dir: string): void {
  const glassDir = path.join(dir, ".glasstrace");
  fs.mkdirSync(glassDir, { recursive: true });
  const marker = JSON.stringify({
    keyHash: "sha256:abc123",
    configuredAt: new Date().toISOString(),
  });
  fs.writeFileSync(path.join(glassDir, "mcp-connected"), marker);
}

beforeEach(() => {
  tmpDir = createTmpProject();

  // Override process.cwd() to return tmpDir
  originalCwd = process.cwd;
  process.cwd = () => tmpDir;
});

afterEach(() => {
  process.cwd = originalCwd;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

async function loadMcpAdd(): Promise<{
  mcpAdd: (options?: { force?: boolean; dryRun?: boolean }) => Promise<{
    exitCode: number;
    results: Array<{ agent: string; success: boolean; method: string; message: string }>;
    messages: string[];
  }>;
}> {
  return import("../../../../packages/sdk/src/cli/mcp-add.js") as ReturnType<typeof loadMcpAdd>;
}

describe("mcpAdd", () => {
  it("returns error when anon key is missing", async () => {
    const { mcpAdd } = await loadMcpAdd();

    const result = await mcpAdd();

    expect(result.exitCode).toBe(1);
    expect(result.messages.join("\n")).toContain(
      "Run `glasstrace init` first",
    );
  });

  it("skips when marker file exists (idempotent)", async () => {
    writeAnonKey(tmpDir);
    writeMarkerFile(tmpDir);

    const { mcpAdd } = await loadMcpAdd();

    const result = await mcpAdd();

    expect(result.exitCode).toBe(0);
    const output = result.messages.join("\n");
    expect(output).toContain("MCP already configured");
    expect(output).toContain("--force");
  });

  it("re-runs registration with --force even when marker exists", async () => {
    writeAnonKey(tmpDir);
    writeMarkerFile(tmpDir);

    // Create a Claude marker so an agent is detected
    fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "# Test");

    const { mcpAdd } = await loadMcpAdd();

    const result = await mcpAdd({ force: true });

    const output = result.messages.join("\n");
    // Should not show "already configured" message
    expect(output).not.toContain("MCP already configured");
    // Should show registration summary
    expect(output).toContain("MCP registration");
  });

  it("prints plan but does not write files in --dry-run mode", async () => {
    writeAnonKey(tmpDir);

    // Create a Claude marker so an agent is detected
    fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "# Test");

    const { mcpAdd } = await loadMcpAdd();

    const result = await mcpAdd({ dryRun: true });

    expect(result.exitCode).toBe(0);
    const output = result.messages.join("\n");
    expect(output).toContain("Dry run");
    expect(output).toContain("Claude Code");

    // Marker file should NOT exist
    expect(
      fs.existsSync(path.join(tmpDir, ".glasstrace", "mcp-connected")),
    ).toBe(false);

    // .mcp.json should NOT be created
    expect(fs.existsSync(path.join(tmpDir, ".mcp.json"))).toBe(false);
  });

  it("uses file-based fallback when CLI is not available", async () => {
    writeAnonKey(tmpDir);

    // Create a Claude marker so an agent is detected
    fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "# Test");

    const { mcpAdd } = await loadMcpAdd();

    const result = await mcpAdd({ force: true });

    expect(result.exitCode).toBe(0);

    // File-based config should have been written
    expect(fs.existsSync(path.join(tmpDir, ".mcp.json"))).toBe(true);

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8"),
    ) as { mcpServers: { glasstrace: { url: string } } };
    expect(config.mcpServers.glasstrace.url).toContain("glasstrace.dev");
  });

  it("writes gitignore entries", async () => {
    writeAnonKey(tmpDir);

    // Create a Cursor marker
    fs.mkdirSync(path.join(tmpDir, ".cursor"), { recursive: true });

    const { mcpAdd } = await loadMcpAdd();

    await mcpAdd({ force: true });

    const gitignorePath = path.join(tmpDir, ".gitignore");
    expect(fs.existsSync(gitignorePath)).toBe(true);

    const gitignore = fs.readFileSync(gitignorePath, "utf-8");
    expect(gitignore).toContain(".mcp.json");
    expect(gitignore).toContain(".cursor/mcp.json");
  });

  it("creates marker file on success", async () => {
    writeAnonKey(tmpDir);

    // Create a Claude marker
    fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "# Test");

    const { mcpAdd } = await loadMcpAdd();

    await mcpAdd({ force: true });

    const markerPath = path.join(tmpDir, ".glasstrace", "mcp-connected");
    expect(fs.existsSync(markerPath)).toBe(true);

    const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as {
      keyHash: string;
      configuredAt: string;
    };
    expect(marker.keyHash).toMatch(/^sha256:/);
    expect(marker.configuredAt).toBeTruthy();
  });

  it("handles multiple agents", async () => {
    writeAnonKey(tmpDir);

    // Create markers for multiple agents
    fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "# Test");
    fs.mkdirSync(path.join(tmpDir, ".cursor"), { recursive: true });

    const { mcpAdd } = await loadMcpAdd();

    const result = await mcpAdd({ force: true });

    const output = result.messages.join("\n");
    // Both agents should appear in summary
    expect(output).toContain("Claude Code");
    expect(output).toContain("Cursor");
  });

  it("succeeds via CLI path when execFile mock returns success", async () => {
    writeAnonKey(tmpDir);

    // Create a Claude marker
    fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "# Test");

    // Override the mock for two invocations — auto-reverts after both calls:
    // 1st call: `which claude` (CLI availability check)
    // 2nd call: `claude mcp add-json ...` (actual registration)
    const { execFile } = await import("node:child_process");
    const successImpl = ((_cmd: string, _args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(null, "success", "");
    }) as typeof execFile;
    vi.mocked(execFile)
      .mockImplementationOnce(successImpl)
      .mockImplementationOnce(successImpl);

    const { mcpAdd } = await loadMcpAdd();

    const result = await mcpAdd({ force: true });

    expect(result.exitCode).toBe(0);
    // Verify at least one agent used the CLI method (not file fallback)
    const cliResult = result.results.find((r) => r.method === "cli");
    expect(cliResult).toBeDefined();
  });

  it("falls back to generic config when no agents detected", async () => {
    writeAnonKey(tmpDir);

    const { mcpAdd } = await loadMcpAdd();

    const result = await mcpAdd({ force: true });

    expect(result.exitCode).toBe(0);

    // Generic fallback should have written .glasstrace/mcp.json
    const genericPath = path.join(tmpDir, ".glasstrace", "mcp.json");
    expect(fs.existsSync(genericPath)).toBe(true);

    const config = JSON.parse(
      fs.readFileSync(genericPath, "utf-8"),
    ) as { mcpServers: { glasstrace: { url: string } } };
    expect(config.mcpServers.glasstrace.url).toContain("glasstrace.dev");
  });
});
