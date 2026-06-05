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

describe("runtime-state module load without node:fs (DISC-377 §Item 1)", () => {
  // Wave 13 13A regression guard. Wave 8 8D guarded the writer's
  // sync `require("node:*")` call sites with the isSyncFsAvailable()
  // probe, but the top-of-file `import { mkdirSync } from "node:fs"`
  // and `import { join } from "node:path"` in runtime-state.ts still
  // failed at module-evaluation time — before the probe could run —
  // under bundlers that externalize node:* without shimming them
  // (some browser bundlers, Vercel Edge, Cloudflare Workers, Deno
  // without Node-compat). DISC-377 §Item 1 closed the residual gap
  // by converting both imports to the cached-`require()` + try/catch
  // pattern from heartbeat.ts:150-159. This test pins the contract:
  // the module must load without throwing when bare-specifier
  // resolution of `node:fs` and `node:path` fails. Mocking
  // isSyncFsAvailable() alone is insufficient because the bug is at
  // module-load time, before isSyncFsAvailable() could be called.
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("node:fs", () => {
      throw new Error("Module not found: node:fs");
    });
    vi.doMock("node:path", () => {
      throw new Error("Module not found: node:path");
    });
  });

  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.doUnmock("node:path");
  });

  it("loads the runtime-state module without throwing", async () => {
    await expect(
      import("../../../packages/sdk/src/runtime-state.js"),
    ).resolves.toBeDefined();
  });

  it("startRuntimeStateWriter is a silent no-op when node:fs is unavailable", async () => {
    const consoleCapture = await import(
      "../../../packages/sdk/src/console-capture.js"
    );
    const sdkLogSpy = vi
      .spyOn(consoleCapture, "sdkLog")
      .mockImplementation(() => {});

    const lifecycle = await import(
      "../../../packages/sdk/src/lifecycle.js"
    );
    lifecycle.resetLifecycleForTesting();
    lifecycle.initLifecycle({ logger: vi.fn() });

    const { startRuntimeStateWriter, _resetRuntimeStateForTesting } =
      await import("../../../packages/sdk/src/runtime-state.js");
    _resetRuntimeStateForTesting();

    expect(() => {
      startRuntimeStateWriter({
        projectRoot: "/tmp/glasstrace-disc-377-item-1-noexist",
        sdkVersion: "1.0.0",
      });
    }).not.toThrow();

    // No "Failed to write runtime state" warning should surface — the
    // isSyncFsAvailable() gate short-circuits before any listener is
    // registered, mirroring the DISC-1555 silent-skip contract.
    const failureWarnings = sdkLogSpy.mock.calls.filter((call) =>
      String(call[1] ?? "").includes("Failed to write runtime state"),
    );
    expect(failureWarnings).toEqual([]);
  });
});

describe("runtime-state partial-load resilience (node:fs ok, node:path fails)", () => {
  // Wave 13 13A follow-up to Codex/Copilot review feedback. If
  // `require("node:fs")` succeeds but `require("node:path")` throws,
  // the shared try/catch must clear BOTH cached refs so the
  // startRuntimeStateWriter() gate treats the runtime as non-Node.
  // atomic-write's isSyncFsAvailable() only checks node:fs, so
  // without an additional pathSync nullity check on the gate, a
  // partial-compat runtime would slip past the gate and later NPE on
  // `pathSync!.join(...)` inside writeStateNow(), surfacing repeated
  // "Failed to write runtime state" warnings instead of the intended
  // silent no-op.
  beforeEach(() => {
    vi.resetModules();
    // node:fs resolves successfully (no doMock); node:path throws.
    vi.doMock("node:path", () => {
      throw new Error("Module not found: node:path");
    });
  });

  afterEach(() => {
    vi.doUnmock("node:path");
  });

  it("startRuntimeStateWriter is a silent no-op when node:path resolution fails", async () => {
    const consoleCapture = await import(
      "../../../packages/sdk/src/console-capture.js"
    );
    const sdkLogSpy = vi
      .spyOn(consoleCapture, "sdkLog")
      .mockImplementation(() => {});

    const lifecycle = await import(
      "../../../packages/sdk/src/lifecycle.js"
    );
    lifecycle.resetLifecycleForTesting();
    lifecycle.initLifecycle({ logger: vi.fn() });

    const { startRuntimeStateWriter, _resetRuntimeStateForTesting } =
      await import("../../../packages/sdk/src/runtime-state.js");
    _resetRuntimeStateForTesting();

    expect(() => {
      startRuntimeStateWriter({
        projectRoot: "/tmp/glasstrace-disc-377-item-1-partial-noexist",
        sdkVersion: "1.0.0",
      });
    }).not.toThrow();

    // Drive a few lifecycle transitions that would normally invoke
    // writeStateNow(). With the gate's pathSync-null check in place,
    // no listener is registered and no warning surfaces.
    lifecycle.setCoreState(lifecycle.CoreState.REGISTERING);
    lifecycle.setCoreState(lifecycle.CoreState.ACTIVE);

    const failureWarnings = sdkLogSpy.mock.calls.filter((call) =>
      String(call[1] ?? "").includes("Failed to write runtime state"),
    );
    expect(failureWarnings).toEqual([]);
  });
});

describe("heartbeat checkShutdownMarker without node:fs", () => {
  // ESM-reachability audit (DISC-1563) regression guard. The other three
  // ESM-reachable sync `require("node:*")` sites in SDK source —
  // `init-client.loadFsSyncOrNull`, `nudge.markerFileExists`, and
  // `atomic-write.loadFsSync` (via `isSyncFsAvailable`) — already had
  // dedicated coverage for the catch-branch behavior. The audit found
  // `heartbeat.checkShutdownMarker` was the lone owner whose ESM-
  // unavailable branch was untested. The catch already returns the
  // same `{ triggered: false }` shape as the marker-absent branch, so
  // this test pins that contract against an `node:fs is unavailable`
  // simulation indistinguishable from the tsup `__require` throw the
  // production failure mode produces.
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("node:fs", () => {
      throw new Error("Module not found: node:fs");
    });
    vi.doMock("node:path", () => {
      throw new Error("Module not found: node:path");
    });
  });

  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.doUnmock("node:path");
  });

  it("returns { triggered: false } and does not throw", async () => {
    const { checkShutdownMarker } = await import(
      "../../../packages/sdk/src/heartbeat.js"
    );
    expect(() => checkShutdownMarker("/tmp/glasstrace-disc-1563-noexist")).not.toThrow();
    const result = checkShutdownMarker("/tmp/glasstrace-disc-1563-noexist");
    expect(result).toEqual({ triggered: false });
  });
});
