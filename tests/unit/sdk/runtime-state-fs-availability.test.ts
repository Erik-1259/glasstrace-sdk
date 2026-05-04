/**
 * Tests for the DISC-1555 fix: runtime-state writer must skip silently
 * when synchronous `node:fs` is unreachable (e.g., when the SDK is
 * loaded as an ESM module from a Next.js dev/start server, where
 * tsup's bundled `__require` shim cannot resolve `require("node:fs")`
 * from an ESM scope).
 *
 * The positive paths (file writes, debounce, SHUTDOWN bypass) are
 * covered by `lifecycle-cli.test.ts`; this file targets only the
 * availability-probe contract introduced for DISC-1555.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("startRuntimeStateWriter — DISC-1555 silent-skip when node:fs is unreachable", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "glasstrace-rt-state-disc1555-"));
  });

  afterEach(async () => {
    vi.doUnmock("../../../packages/sdk/src/atomic-write.js");
    vi.resetModules();
    vi.restoreAllMocks();
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("returns silently and writes no file when isSyncFsAvailable() reports false", async () => {
    // Spy on console-capture's sdkLog: the DISC-1555 symptom was a
    // user-visible "[glasstrace] Failed to write runtime state: ..." warning,
    // which goes through sdkLog. The fix must avoid emitting any warning
    // in this scenario.
    const consoleCapture = await import(
      "../../../packages/sdk/src/console-capture.js"
    );
    const sdkLogSpy = vi.spyOn(consoleCapture, "sdkLog").mockImplementation(() => {});

    // Replace isSyncFsAvailable with a stub that reports false. The
    // module-mock route is preferred over a process-wide require()
    // override because it isolates the unavailability to the runtime-
    // state writer's view, leaving sibling tests' fs access intact.
    const real = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    vi.doMock("../../../packages/sdk/src/atomic-write.js", () => ({
      ...real,
      isSyncFsAvailable: () => false,
    }));

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
        projectRoot: tempDir,
        sdkVersion: "1.0.0",
      });
    }).not.toThrow();

    // No file was written.
    expect(existsSync(join(tempDir, ".glasstrace", "runtime-state.json"))).toBe(
      false,
    );
    expect(existsSync(join(tempDir, ".glasstrace"))).toBe(false);

    // No "Failed to write runtime state" warning surfaced via sdkLog —
    // the whole point of DISC-1555.
    const failureWarnings = sdkLogSpy.mock.calls.filter((call) =>
      call[1].includes("Failed to write runtime state"),
    );
    expect(failureWarnings).toEqual([]);
  });

  it("subsequent setCoreState() transitions do not surface the warning after a silent skip", async () => {
    const consoleCapture = await import(
      "../../../packages/sdk/src/console-capture.js"
    );
    const sdkLogSpy = vi.spyOn(consoleCapture, "sdkLog").mockImplementation(() => {});

    const real = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    vi.doMock("../../../packages/sdk/src/atomic-write.js", () => ({
      ...real,
      isSyncFsAvailable: () => false,
    }));

    const lifecycle = await import(
      "../../../packages/sdk/src/lifecycle.js"
    );
    lifecycle.resetLifecycleForTesting();
    lifecycle.initLifecycle({ logger: vi.fn() });

    const { startRuntimeStateWriter, _resetRuntimeStateForTesting } =
      await import("../../../packages/sdk/src/runtime-state.js");
    _resetRuntimeStateForTesting();

    startRuntimeStateWriter({ projectRoot: tempDir, sdkVersion: "1.0.0" });

    // Drive a few transitions that would normally invoke writeStateNow.
    lifecycle.setCoreState(lifecycle.CoreState.REGISTERING);
    lifecycle.setCoreState(lifecycle.CoreState.KEY_PENDING);
    lifecycle.setCoreState(lifecycle.CoreState.KEY_RESOLVED);
    lifecycle.setCoreState(lifecycle.CoreState.ACTIVE);

    const failureWarnings = sdkLogSpy.mock.calls.filter((call) =>
      call[1].includes("Failed to write runtime state"),
    );
    expect(failureWarnings).toEqual([]);
  });

  it("writes normally when isSyncFsAvailable() reports true (regression guard)", async () => {
    // No mocking — the real probe runs. Vitest itself is a Node
    // process with synchronous fs available, so the probe returns
    // true and the writer follows its existing path.
    const lifecycle = await import(
      "../../../packages/sdk/src/lifecycle.js"
    );
    lifecycle.resetLifecycleForTesting();
    lifecycle.initLifecycle({ logger: vi.fn() });

    const { startRuntimeStateWriter, _resetRuntimeStateForTesting } =
      await import("../../../packages/sdk/src/runtime-state.js");
    _resetRuntimeStateForTesting();

    startRuntimeStateWriter({ projectRoot: tempDir, sdkVersion: "1.0.0" });

    const filePath = join(tempDir, ".glasstrace", "runtime-state.json");
    expect(existsSync(filePath)).toBe(true);
    const content = JSON.parse(readFileSync(filePath, "utf-8")) as {
      sdkVersion: string;
    };
    expect(content.sdkVersion).toBe("1.0.0");
  });

  it("still emits the existing warning on genuine post-probe I/O failures", async () => {
    // Confirms the fix narrows ONLY the node:fs-unavailable pre-failure;
    // a permission/disk error after the probe succeeds still surfaces
    // through the existing try/catch in writeStateNow().
    const consoleCapture = await import(
      "../../../packages/sdk/src/console-capture.js"
    );
    const sdkLogSpy = vi.spyOn(consoleCapture, "sdkLog").mockImplementation(() => {});

    const lifecycle = await import(
      "../../../packages/sdk/src/lifecycle.js"
    );
    lifecycle.resetLifecycleForTesting();
    lifecycle.initLifecycle({ logger: vi.fn() });

    const { startRuntimeStateWriter, _resetRuntimeStateForTesting } =
      await import("../../../packages/sdk/src/runtime-state.js");
    _resetRuntimeStateForTesting();

    // Block .glasstrace/ creation by placing a regular file at the
    // expected directory path. mkdirSync(..., { recursive: true })
    // throws ENOTDIR/EEXIST in this case, exercising the post-probe
    // try/catch path.
    const blocker = join(tempDir, ".glasstrace");
    writeFileSync(blocker, "block");

    startRuntimeStateWriter({ projectRoot: tempDir, sdkVersion: "1.0.0" });

    const failureWarnings = sdkLogSpy.mock.calls.filter((call) =>
      call[1].includes("Failed to write runtime state"),
    );
    // At least one warning must surface — the genuine I/O error path
    // remains unchanged by DISC-1555.
    expect(failureWarnings.length).toBeGreaterThan(0);
  });
});
