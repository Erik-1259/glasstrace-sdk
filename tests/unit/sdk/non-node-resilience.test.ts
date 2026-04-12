/**
 * Tests that runtime modules degrade gracefully when Node.js built-in
 * modules (node:fs, node:path, node:crypto) are unavailable.
 *
 * These tests verify the dynamic import fallback paths added for
 * non-Node environments (Edge Runtime, browser bundles).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("anon-key without node:fs", () => {
  beforeEach(() => {
    vi.resetModules();
    // Mock node:fs/promises and node:path to simulate non-Node environment
    vi.doMock("node:fs/promises", () => {
      throw new Error("Module not found: node:fs/promises");
    });
    vi.doMock("node:path", () => {
      throw new Error("Module not found: node:path");
    });
  });

  afterEach(() => {
    vi.doUnmock("node:fs/promises");
    vi.doUnmock("node:path");
  });

  it("readAnonKey returns null when node:fs is unavailable", async () => {
    const { readAnonKey } = await import(
      "../../../packages/sdk/src/anon-key.js"
    );
    const result = await readAnonKey("/tmp/nonexistent");
    expect(result).toBeNull();
  });

  it("getOrCreateAnonKey returns an ephemeral key when node:fs is unavailable", async () => {
    const { getOrCreateAnonKey } = await import(
      "../../../packages/sdk/src/anon-key.js"
    );
    const key = await getOrCreateAnonKey("/tmp/nonexistent");
    expect(key).toMatch(/^gt_anon_[a-f0-9]{48}$/);
  });

  it("ephemeral key is stable across repeated calls", async () => {
    const { getOrCreateAnonKey } = await import(
      "../../../packages/sdk/src/anon-key.js"
    );
    const key1 = await getOrCreateAnonKey("/tmp/nonexistent");
    const key2 = await getOrCreateAnonKey("/tmp/nonexistent");
    expect(key1).toBe(key2);
  });
});

describe("init-client without node:fs", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("node:fs/promises", () => {
      throw new Error("Module not found: node:fs/promises");
    });
    vi.doMock("node:fs", () => {
      throw new Error("Module not found: node:fs");
    });
    vi.doMock("node:path", () => {
      throw new Error("Module not found: node:path");
    });
  });

  afterEach(() => {
    vi.doUnmock("node:fs/promises");
    vi.doUnmock("node:fs");
    vi.doUnmock("node:path");
  });

  it("loadCachedConfig returns null when node:fs is unavailable", async () => {
    const { loadCachedConfig } = await import(
      "../../../packages/sdk/src/init-client.js"
    );
    const result = loadCachedConfig("/tmp/nonexistent");
    expect(result).toBeNull();
  });

  it("saveCachedConfig is a no-op when node:fs is unavailable", async () => {
    const { saveCachedConfig } = await import(
      "../../../packages/sdk/src/init-client.js"
    );
    // Should not throw
    await expect(
      saveCachedConfig(
        {
          config: {
            requestBodies: false,
            queryParamValues: false,
            envVarValues: false,
            fullConsoleOutput: false,
            importGraph: false,
            consoleErrors: false,
          },
          subscriptionStatus: "anonymous",
          minimumSdkVersion: "0.0.0",
          apiVersion: "v1",
          tierLimits: {
            tracesPerMinute: 100,
            storageTtlHours: 48,
            maxTraceSizeBytes: 512000,
            maxConcurrentSessions: 1,
          },
        } as import("@glasstrace/protocol").SdkInitResponse,
        "/tmp/nonexistent",
      ),
    ).resolves.toBeUndefined();
  });

  it("writeClaimedKey falls through to dashboard message when node:fs is unavailable", async () => {
    const { writeClaimedKey } = await import(
      "../../../packages/sdk/src/init-client.js"
    );
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await writeClaimedKey("gt_dev_" + "a".repeat(48), "/tmp/nonexistent");

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((msg) => msg.includes("dashboard settings"))).toBe(true);
    // Key must never appear in output
    expect(calls.every((msg) => !msg.includes("gt_dev_"))).toBe(true);

    stderrSpy.mockRestore();
  });

  it("loadCachedConfig returns null when config file does not exist", async () => {
    const { loadCachedConfig } = await import(
      "../../../packages/sdk/src/init-client.js"
    );
    // Path that definitely has no .glasstrace/config file
    const result = loadCachedConfig("/tmp/glasstrace-nonexistent-dir-" + Date.now());
    expect(result).toBeNull();
  });
});

describe("error-nudge without node:fs", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    // Default to non-production
    delete process.env.NODE_ENV;
    delete process.env.VERCEL_ENV;
    delete process.env.GLASSTRACE_FORCE_ENABLE;
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    vi.doUnmock("node:fs");
    vi.doUnmock("node:path");
  });

  it("fires nudge when node:fs is unavailable (marker check gracefully skipped)", async () => {
    // Mock node:fs to throw on require()
    vi.doMock("node:fs", () => {
      throw new Error("Module not found: node:fs");
    });
    vi.doMock("node:path", () => {
      throw new Error("Module not found: node:path");
    });

    const { maybeShowMcpNudge } = await import(
      "../../../packages/sdk/src/nudge/error-nudge.js"
    );
    maybeShowMcpNudge("Test error");

    expect(stderrSpy).toHaveBeenCalledOnce();
    const output = stderrSpy.mock.calls[0]![0] as string;
    expect(output).toContain("[glasstrace] Error captured: Test error");
  });
});
