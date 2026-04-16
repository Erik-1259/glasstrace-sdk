import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CoreState,
  OtelState,
  initLifecycle,
  setCoreState,
  setOtelState,
  emitLifecycleEvent,
  resetLifecycleForTesting,
} from "../../../packages/sdk/src/lifecycle.js";
import {
  startRuntimeStateWriter,
  _resetRuntimeStateForTesting,
} from "../../../packages/sdk/src/runtime-state.js";
import type { RuntimeState } from "../../../packages/sdk/src/runtime-state.js";
import { runStatus } from "../../../packages/sdk/src/cli/status.js";

describe("Runtime State Bridge (SDK-026)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "glasstrace-state-test-"));
    resetLifecycleForTesting();
    _resetRuntimeStateForTesting();
    initLifecycle({ logger: vi.fn() });
  });

  afterEach(async () => {
    _resetRuntimeStateForTesting();
    resetLifecycleForTesting();
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  describe("State writer", () => {
    it("writes runtime-state.json on startup", () => {
      startRuntimeStateWriter({ projectRoot: tempDir, sdkVersion: "1.0.0" });

      const filePath = join(tempDir, ".glasstrace", "runtime-state.json");
      expect(existsSync(filePath)).toBe(true);

      const content = JSON.parse(readFileSync(filePath, "utf-8")) as RuntimeState;
      expect(content.sdkVersion).toBe("1.0.0");
      expect(content.pid).toBe(process.pid);
      expect(content.core.state).toBe(CoreState.IDLE);
    });

    it("updates file on core state transition (debounced)", async () => {
      vi.useFakeTimers();
      try {
        startRuntimeStateWriter({ projectRoot: tempDir, sdkVersion: "1.0.0" });

        setCoreState(CoreState.REGISTERING);

        // Advance past the 1-second debounce
        await vi.advanceTimersByTimeAsync(1100);

        const content = JSON.parse(
          readFileSync(join(tempDir, ".glasstrace", "runtime-state.json"), "utf-8"),
        ) as RuntimeState;
        expect(content.core.state).toBe(CoreState.REGISTERING);
      } finally {
        vi.useRealTimers();
      }
    });

    it("writes SHUTDOWN immediately (bypasses debounce)", () => {
      startRuntimeStateWriter({ projectRoot: tempDir, sdkVersion: "1.0.0" });

      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.SHUTTING_DOWN);
      setCoreState(CoreState.SHUTDOWN);

      // No wait — SHUTDOWN writes immediately
      const content = JSON.parse(
        readFileSync(join(tempDir, ".glasstrace", "runtime-state.json"), "utf-8"),
      ) as RuntimeState;
      expect(content.core.state).toBe(CoreState.SHUTDOWN);
    });

    it("includes OTel scenario from otel:configured event", async () => {
      vi.useFakeTimers();
      try {
        startRuntimeStateWriter({ projectRoot: tempDir, sdkVersion: "1.0.0" });

        setOtelState(OtelState.CONFIGURING);
        setOtelState(OtelState.OWNS_PROVIDER);
        emitLifecycleEvent("otel:configured", { state: OtelState.OWNS_PROVIDER, scenario: "A" });

        await vi.advanceTimersByTimeAsync(1100);

        const content = JSON.parse(
          readFileSync(join(tempDir, ".glasstrace", "runtime-state.json"), "utf-8"),
        ) as RuntimeState;
        expect(content.otel.scenario).toBe("A");
      } finally {
        vi.useRealTimers();
      }
    });

    it("creates .glasstrace directory if missing", () => {
      // tempDir has no .glasstrace/ yet
      expect(existsSync(join(tempDir, ".glasstrace"))).toBe(false);

      startRuntimeStateWriter({ projectRoot: tempDir, sdkVersion: "1.0.0" });

      expect(existsSync(join(tempDir, ".glasstrace"))).toBe(true);
    });

    it("is idempotent — second call ignored", () => {
      startRuntimeStateWriter({ projectRoot: tempDir, sdkVersion: "1.0.0" });
      startRuntimeStateWriter({ projectRoot: tempDir, sdkVersion: "2.0.0" });

      const content = JSON.parse(
        readFileSync(join(tempDir, ".glasstrace", "runtime-state.json"), "utf-8"),
      ) as RuntimeState;
      expect(content.sdkVersion).toBe("1.0.0"); // First call wins
    });

    it("handles write failure gracefully (no throw)", () => {
      // Use a path that can't be written (file where directory should be)
      const badRoot = join(tempDir, "not-a-dir");
      writeFileSync(badRoot, "block");

      // Should not throw
      expect(() => {
        startRuntimeStateWriter({ projectRoot: badRoot, sdkVersion: "1.0.0" });
      }).not.toThrow();
    });
  });

  describe("Status command runtime reading", () => {
    it("reads runtime state from file", () => {
      startRuntimeStateWriter({ projectRoot: tempDir, sdkVersion: "1.0.0" });

      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.KEY_RESOLVED);
      setCoreState(CoreState.ACTIVE);

      // Force immediate write (SHUTDOWN bypasses debounce, but we want ACTIVE)
      // Write directly for this test
      const state = {
        updatedAt: new Date().toISOString(),
        pid: process.pid,
        sdkVersion: "1.0.0",
        core: { state: "ACTIVE" },
        auth: { state: "ANONYMOUS" },
        otel: { state: "OWNS_PROVIDER", scenario: "A" },
      };
      const dir = join(tempDir, ".glasstrace");
      writeFileSync(
        join(dir, "runtime-state.json"),
        JSON.stringify(state),
      );

      const result = runStatus({ projectRoot: tempDir });
      expect(result.runtime.available).toBe(true);
      expect(result.runtime.coreState).toBe("ACTIVE");
      expect(result.runtime.otelState).toBe("OWNS_PROVIDER");
      expect(result.runtime.otelScenario).toBe("A");
      expect(result.runtime.stale).toBe(false);
    });

    it("returns unavailable when no runtime state file", () => {
      const result = runStatus({ projectRoot: tempDir });
      expect(result.runtime.available).toBe(false);
      expect(result.runtime.coreState).toBeNull();
    });

    it("detects stale state from dead process", () => {
      const dir = join(tempDir, ".glasstrace");
      mkdirSync(dir, { recursive: true });
      const state = {
        updatedAt: new Date(Date.now() - 60_000).toISOString(), // 60s ago
        pid: 999999, // Very unlikely to be a real PID
        sdkVersion: "1.0.0",
        core: { state: "ACTIVE" },
        auth: { state: "ANONYMOUS" },
        otel: { state: "OWNS_PROVIDER" },
      };
      writeFileSync(
        join(dir, "runtime-state.json"),
        JSON.stringify(state),
      );

      const result = runStatus({ projectRoot: tempDir });
      expect(result.runtime.available).toBe(true);
      expect(result.runtime.stale).toBe(true);
    });

    it("reports SHUTDOWN as not stale", () => {
      const dir = join(tempDir, ".glasstrace");
      mkdirSync(dir, { recursive: true });
      const state = {
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
        pid: 999999,
        sdkVersion: "1.0.0",
        core: { state: "SHUTDOWN" },
        auth: { state: "ANONYMOUS" },
        otel: { state: "OWNS_PROVIDER" },
      };
      writeFileSync(
        join(dir, "runtime-state.json"),
        JSON.stringify(state),
      );

      const result = runStatus({ projectRoot: tempDir });
      expect(result.runtime.available).toBe(true);
      expect(result.runtime.stale).toBe(false);
      expect(result.runtime.coreState).toBe("SHUTDOWN");
    });
  });
});
