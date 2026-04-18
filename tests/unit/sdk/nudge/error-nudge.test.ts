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

  it("sets hasFired on production early-return so resolveConfig is not called again", async () => {
    const resolveConfigSpy = vi.fn(() => ({
      apiKey: undefined,
      endpoint: "https://api.glasstrace.dev",
      forceEnable: false,
      verbose: false,
      environment: undefined,
      coverageMapEnabled: false,
      nodeEnv: "production",
      vercelEnv: undefined,
    }));

    vi.doMock("../../../../packages/sdk/src/env-detection.js", () => ({
      resolveConfig: resolveConfigSpy,
      isProductionDisabled: (config: { forceEnable: boolean; nodeEnv?: string; vercelEnv?: string }) => {
        if (config.forceEnable) return false;
        if (config.nodeEnv === "production") return true;
        if (config.vercelEnv === "production") return true;
        return false;
      },
    }));

    try {
      const maybeShowMcpNudge = await loadModule();

      // First call: resolveConfig runs, detects production, sets hasFired
      maybeShowMcpNudge("first error");
      expect(resolveConfigSpy).toHaveBeenCalledOnce();
      expect(stderrSpy).not.toHaveBeenCalled();

      // Second call: hasFired is true, fast-exits without calling resolveConfig
      maybeShowMcpNudge("second error");
      expect(resolveConfigSpy).toHaveBeenCalledOnce(); // still 1, not 2
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../../../../packages/sdk/src/env-detection.js");
    }
  });

  it("sets hasFired on marker-exists early-return so resolveConfig is not called again", async () => {
    // Create marker file
    const glasstraceDir = join(tempDir, ".glasstrace");
    mkdirSync(glasstraceDir, { recursive: true });
    writeFileSync(join(glasstraceDir, "mcp-connected"), "");

    const maybeShowMcpNudge = await loadModule();

    // First call: marker exists, sets hasFired, suppresses nudge
    maybeShowMcpNudge("first error");
    expect(stderrSpy).not.toHaveBeenCalled();

    // Remove marker to prove second call doesn't re-check filesystem
    rmSync(join(glasstraceDir, "mcp-connected"));

    // Second call: hasFired is true, fast-exits even though marker is gone
    maybeShowMcpNudge("second error");
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe("maybeShowServerActionNudge (DISC-1253)", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    originalEnv = { ...process.env };
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    // Default to non-production so the nudge fires unless suppressed.
    delete process.env.NODE_ENV;
    delete process.env.VERCEL_ENV;
    delete process.env.GLASSTRACE_FORCE_ENABLE;
    delete process.env.GLASSTRACE_SUPPRESS_ACTION_NUDGE;
  });

  afterEach(() => {
    process.env = originalEnv;
    stderrSpy.mockRestore();
  });

  async function loadServerActionNudge() {
    const mod = await import(
      "../../../../packages/sdk/src/nudge/error-nudge.js"
    );
    return mod.maybeShowServerActionNudge as () => void;
  }

  it("fires a one-time stderr nudge with the documented message", async () => {
    const nudge = await loadServerActionNudge();
    nudge();

    expect(stderrSpy).toHaveBeenCalledOnce();
    const output = stderrSpy.mock.calls[0]![0] as string;
    expect(output).toBe(
      `[glasstrace] Detected a Next.js Server Action trace. Install the ` +
        `Glasstrace browser extension to capture the Server Action identifier ` +
        `for precise action-level debugging. https://glasstrace.dev/ext\n`,
    );
  });

  it("dedupes within a process (second call is a no-op)", async () => {
    const nudge = await loadServerActionNudge();
    nudge();
    nudge();
    nudge();

    expect(stderrSpy).toHaveBeenCalledOnce();
  });

  it("is silenced by GLASSTRACE_SUPPRESS_ACTION_NUDGE=1", async () => {
    process.env.GLASSTRACE_SUPPRESS_ACTION_NUDGE = "1";
    const nudge = await loadServerActionNudge();

    nudge();

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("does NOT fire in NODE_ENV=production", async () => {
    process.env.NODE_ENV = "production";
    const nudge = await loadServerActionNudge();

    nudge();

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("does NOT fire in VERCEL_ENV=production", async () => {
    process.env.VERCEL_ENV = "production";
    const nudge = await loadServerActionNudge();

    nudge();

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("fires in production when GLASSTRACE_FORCE_ENABLE=true", async () => {
    process.env.NODE_ENV = "production";
    process.env.GLASSTRACE_FORCE_ENABLE = "true";
    const nudge = await loadServerActionNudge();

    nudge();

    expect(stderrSpy).toHaveBeenCalledOnce();
  });

  it("uses process.stderr.write (not console.error)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error");
    const nudge = await loadServerActionNudge();

    nudge();

    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("sets hasFiredServerAction on silencer path so subsequent calls fast-exit", async () => {
    process.env.GLASSTRACE_SUPPRESS_ACTION_NUDGE = "1";
    const nudge = await loadServerActionNudge();

    nudge();
    expect(stderrSpy).not.toHaveBeenCalled();

    // Remove the silencer to prove the second call short-circuits via
    // hasFiredServerAction rather than re-reading process.env.
    delete process.env.GLASSTRACE_SUPPRESS_ACTION_NUDGE;
    nudge();
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe("server-action nudge and MCP nudge are independent (DISC-1253)", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalCwd: typeof process.cwd;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let tempDir: string;

  beforeEach(() => {
    vi.resetModules();
    originalEnv = { ...process.env };
    originalCwd = process.cwd;
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    tempDir = join(tmpdir(), `nudge-indep-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });

    delete process.env.NODE_ENV;
    delete process.env.VERCEL_ENV;
    delete process.env.GLASSTRACE_FORCE_ENABLE;
    delete process.env.GLASSTRACE_SUPPRESS_ACTION_NUDGE;
    process.cwd = () => tempDir;
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } finally {
      process.env = originalEnv;
      process.cwd = originalCwd;
      stderrSpy.mockRestore();
    }
  });

  it("firing the server-action nudge does NOT consume the MCP nudge budget", async () => {
    const mod = await import(
      "../../../../packages/sdk/src/nudge/error-nudge.js"
    );

    mod.maybeShowServerActionNudge();
    expect(stderrSpy).toHaveBeenCalledOnce();

    mod.maybeShowMcpNudge("some error");
    expect(stderrSpy).toHaveBeenCalledTimes(2);
    const mcpOutput = stderrSpy.mock.calls[1]![0] as string;
    expect(mcpOutput).toContain("[glasstrace] Error captured:");
  });
});
