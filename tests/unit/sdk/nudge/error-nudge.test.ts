import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("maybeShowMcpNudge", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalCwd: typeof process.cwd;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let tempDir: string;

  beforeEach(() => {
    vi.resetModules();
    originalEnv = { ...process.env };
    originalCwd = process.cwd;
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    // Create a unique temp directory for each test
    tempDir = join(tmpdir(), `nudge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });

    // Default to non-production
    delete process.env.NODE_ENV;
    delete process.env.VERCEL_ENV;
    delete process.env.GLASSTRACE_FORCE_ENABLE;

    // Point cwd to temp directory (no .glasstrace dir by default)
    process.cwd = () => tempDir;
  });

  afterEach(() => {
    try {
      // Clean up filesystem first, then restore mocks
      rmSync(tempDir, { recursive: true, force: true });
    } finally {
      process.env = originalEnv;
      process.cwd = originalCwd;
      stderrSpy.mockRestore();
    }
  });

  async function loadModule() {
    const mod = await import(
      "../../../../packages/sdk/src/nudge/error-nudge.js"
    );
    return mod.maybeShowMcpNudge as (errorSummary: string) => void;
  }

  it("fires nudge on first error when marker file absent (non-production)", async () => {
    const maybeShowMcpNudge = await loadModule();
    maybeShowMcpNudge("TypeError: Cannot read properties of undefined");

    expect(stderrSpy).toHaveBeenCalledOnce();
    const output = stderrSpy.mock.calls[0]![0] as string;
    expect(output).toContain("[glasstrace] Error captured:");
    expect(output).toContain("TypeError: Cannot read properties of undefined");
    expect(output).toContain("npx glasstrace mcp add");
  });

  it("does NOT fire on second call (one-per-process)", async () => {
    const maybeShowMcpNudge = await loadModule();
    maybeShowMcpNudge("first error");
    maybeShowMcpNudge("second error");

    expect(stderrSpy).toHaveBeenCalledOnce();
  });

  it("does NOT fire when .glasstrace/mcp-connected marker exists", async () => {
    // Create marker file
    const glasstraceDir = join(tempDir, ".glasstrace");
    mkdirSync(glasstraceDir, { recursive: true });
    writeFileSync(join(glasstraceDir, "mcp-connected"), "");

    const maybeShowMcpNudge = await loadModule();
    maybeShowMcpNudge("some error");

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("does NOT fire in production (NODE_ENV=production)", async () => {
    process.env.NODE_ENV = "production";

    const maybeShowMcpNudge = await loadModule();
    maybeShowMcpNudge("some error");

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("fires when .glasstrace/ directory does not exist", async () => {
    // tempDir has no .glasstrace directory by default
    const maybeShowMcpNudge = await loadModule();
    maybeShowMcpNudge("error in fresh project");

    expect(stderrSpy).toHaveBeenCalledOnce();
  });

  it("fires when marker file check throws permission denied", async () => {
    // Use vi.doMock to intercept existsSync for this dynamic import
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        existsSync: () => {
          const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        },
      };
    });

    try {
      const maybeShowMcpNudge = await loadModule();
      maybeShowMcpNudge("permission error scenario");

      expect(stderrSpy).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock("node:fs");
    }
  });

  it("uses process.stderr.write (not console.error)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error");

    const maybeShowMcpNudge = await loadModule();
    maybeShowMcpNudge("check stderr only");

    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("shows nudge with empty errorSummary", async () => {
    const maybeShowMcpNudge = await loadModule();
    maybeShowMcpNudge("");

    expect(stderrSpy).toHaveBeenCalledOnce();
    const output = stderrSpy.mock.calls[0]![0] as string;
    expect(output).toContain("[glasstrace] Error captured: \n");
  });

  it("output format matches expected format exactly", async () => {
    const maybeShowMcpNudge = await loadModule();
    maybeShowMcpNudge("Test error message");

    expect(stderrSpy).toHaveBeenCalledOnce();
    const output = stderrSpy.mock.calls[0]![0] as string;
    expect(output).toBe(
      `[glasstrace] Error captured: Test error message\n` +
        `  Debug with AI: ask your agent "What's the latest Glasstrace error?"\n` +
        `  Not connected? Run: npx glasstrace mcp add\n`,
    );
  });

  it("sanitizes control characters from errorSummary", async () => {
    const maybeShowMcpNudge = await loadModule();
    maybeShowMcpNudge("evil\x1b[31m\ninjection\x00");

    expect(stderrSpy).toHaveBeenCalledOnce();
    const output = stderrSpy.mock.calls[0]![0] as string;
    // Control chars and newline should be stripped
    expect(output).toContain("[glasstrace] Error captured: evil[31minjection");
    expect(output).not.toContain("\x1b");
    expect(output).not.toContain("\x00");
  });

  it("does NOT fire in VERCEL_ENV=production", async () => {
    process.env.VERCEL_ENV = "production";

    const maybeShowMcpNudge = await loadModule();
    maybeShowMcpNudge("some error");

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("fires when forceEnable overrides production", async () => {
    process.env.NODE_ENV = "production";
    process.env.GLASSTRACE_FORCE_ENABLE = "true";

    const maybeShowMcpNudge = await loadModule();
    maybeShowMcpNudge("forced error");

    expect(stderrSpy).toHaveBeenCalledOnce();
  });
});
