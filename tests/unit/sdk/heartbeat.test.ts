import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  startHeartbeat,
  stopHeartbeat,
  _resetHeartbeatForTesting,
} from "../../../packages/sdk/src/heartbeat.js";
import * as initClient from "../../../packages/sdk/src/init-client.js";
import * as healthCollector from "../../../packages/sdk/src/health-collector.js";
import * as lifecycle from "../../../packages/sdk/src/lifecycle.js";
const {
  executeShutdown,
  registerShutdownHook,
  resetLifecycleForTesting,
  initLifecycle,
} = lifecycle;
import type { ResolvedConfig } from "../../../packages/sdk/src/env-detection.js";
import type { SdkInitResponse } from "@glasstrace/protocol";

const TEST_API_KEY = "gt_dev_" + "a".repeat(48);

function createTestConfig(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    apiKey: TEST_API_KEY,
    endpoint: "https://api.glasstrace.dev",
    forceEnable: false,
    verbose: false,
    environment: undefined,
    coverageMapEnabled: false,
    nodeEnv: undefined,
    vercelEnv: undefined,
    ...overrides,
  };
}

function makeInitResponse(): SdkInitResponse {
  return {
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
  } as SdkInitResponse;
}

describe("heartbeat", () => {
  beforeEach(() => {
    _resetHeartbeatForTesting();
    resetLifecycleForTesting();
    initLifecycle({ logger: () => {} });
    vi.useFakeTimers();
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeInitResponse()),
    }));
  });

  afterEach(() => {
    _resetHeartbeatForTesting();
    resetLifecycleForTesting();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("Timer lifecycle", () => {
    it("starts timer after startHeartbeat is called", () => {
      const spy = vi.spyOn(global, "setInterval");
      const config = createTestConfig();

      startHeartbeat(config, null, "1.0.0", 1, vi.fn());

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(expect.any(Function), 5 * 60 * 1000);
    });

    it("timer is unref()'d", () => {
      const config = createTestConfig();

      startHeartbeat(config, null, "1.0.0", 1, vi.fn());

      // The setInterval return value should have had .unref() called
      // We verify this by checking the timer doesn't prevent exit
      // (indirect check — if unref wasn't called, the timer would keep the process alive)
      // Direct check: spy on the timer's unref
      const setIntervalSpy = vi.spyOn(global, "setInterval");
      _resetHeartbeatForTesting();

      const mockTimer = { unref: vi.fn(), ref: vi.fn() };
      setIntervalSpy.mockReturnValue(mockTimer as unknown as ReturnType<typeof setInterval>);

      startHeartbeat(config, null, "1.0.0", 1, vi.fn());

      expect(mockTimer.unref).toHaveBeenCalledTimes(1);
    });

    it("prevents double-start", () => {
      const spy = vi.spyOn(global, "setInterval");
      const config = createTestConfig();

      startHeartbeat(config, null, "1.0.0", 1, vi.fn());
      startHeartbeat(config, null, "1.0.0", 1, vi.fn());

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("stopHeartbeat clears the timer", () => {
      const clearSpy = vi.spyOn(global, "clearInterval");
      const config = createTestConfig();

      startHeartbeat(config, null, "1.0.0", 1, vi.fn());
      stopHeartbeat();

      expect(clearSpy).toHaveBeenCalledTimes(1);
    });

    it("_resetHeartbeatForTesting clears all state", () => {
      const clearSpy = vi.spyOn(global, "clearInterval");
      const config = createTestConfig();

      startHeartbeat(config, null, "1.0.0", 1, vi.fn());
      _resetHeartbeatForTesting();

      expect(clearSpy).toHaveBeenCalled();
    });
  });

  describe("Heartbeat tick", () => {
    it("calls collectHealthReport and performInit on each tick", async () => {
      const collectSpy = vi.spyOn(healthCollector, "collectHealthReport");
      const performSpy = vi.spyOn(initClient, "performInit");
      const config = createTestConfig();

      startHeartbeat(config, null, "1.0.0", 1, vi.fn());

      // Advance past one interval
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(collectSpy).toHaveBeenCalledTimes(1);
      expect(performSpy).toHaveBeenCalledTimes(1);
    });

    it("stops heartbeat when generation changes", async () => {
      const config = createTestConfig();

      startHeartbeat(config, null, "1.0.0", 1, vi.fn());

      // Reset changes the generation
      _resetHeartbeatForTesting();

      // Start with a new generation
      startHeartbeat(config, null, "1.0.0", 2, vi.fn());

      // The old timer was cleared by reset, new timer is running
      const performSpy = vi.spyOn(initClient, "performInit");
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      // Should have fired for the new generation
      expect(performSpy).toHaveBeenCalled();
    });

    it("skips tick when in backoff window", async () => {
      // Force positive jitter so backoff extends past the next 5-minute tick.
      vi.spyOn(Math, "random").mockReturnValue(1);
      vi.spyOn(initClient, "consumeRateLimitFlag")
        .mockReturnValueOnce(true)
        .mockReturnValue(false);
      const performSpy = vi.spyOn(initClient, "performInit").mockResolvedValue(null);
      const config = createTestConfig();

      startHeartbeat(config, null, "1.0.0", 1, vi.fn());

      // First tick triggers 429 backoff.
      // With random=1: jitter = 5min * 0.2 * (1*2-1) = +1 min → backoff = 6 min.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(performSpy).toHaveBeenCalledTimes(1);

      // Advance to the next interval tick at t=10min. Since the backoff lasts
      // until t=11min, that tick should be skipped.
      performSpy.mockClear();
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(performSpy).not.toHaveBeenCalled();
    });

    it("prevents concurrent ticks via tickInProgress guard", async () => {
      // Track how many times the tick function enters
      let activeTicks = 0;
      let maxActiveTicks = 0;

      vi.spyOn(initClient, "performInit").mockImplementation(async () => {
        activeTicks++;
        maxActiveTicks = Math.max(maxActiveTicks, activeTicks);
        // Simulate slow async work
        await new Promise((r) => setTimeout(r, 1));
        activeTicks--;
        return null;
      });
      vi.spyOn(initClient, "consumeRateLimitFlag").mockReturnValue(false);

      const config = createTestConfig();
      startHeartbeat(config, null, "1.0.0", 1, vi.fn());

      // Fire multiple ticks rapidly
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      // At most 1 tick should be active at a time
      expect(maxActiveTicks).toBeLessThanOrEqual(1);
    });
  });

  describe("Exponential backoff", () => {
    it("applies backoff on 429 — next tick is skipped", async () => {
      // Force positive jitter so backoff extends past the next tick
      vi.spyOn(Math, "random").mockReturnValue(1);
      vi.spyOn(initClient, "consumeRateLimitFlag")
        .mockReturnValueOnce(true)
        .mockReturnValue(false);
      const performSpy = vi.spyOn(initClient, "performInit").mockResolvedValue(null);
      const config = createTestConfig();

      startHeartbeat(config, null, "1.0.0", 1, vi.fn());

      // First tick at t=5min triggers 429.
      // random=1 → jitter = +20% → backoff = 6 min → expires at t=11min
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(performSpy).toHaveBeenCalledTimes(1);

      // Next tick at t=10min: backoff until t=11min → skipped
      performSpy.mockClear();
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(performSpy).not.toHaveBeenCalled();

      // Tick at t=15min: backoff expired → fires
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(performSpy).toHaveBeenCalledTimes(1);
    });

    it("resets backoff on success", async () => {
      // First tick: 429
      const consumeSpy = vi.spyOn(initClient, "consumeRateLimitFlag").mockReturnValue(true);
      const performSpy = vi.spyOn(initClient, "performInit").mockResolvedValue(null);
      const config = createTestConfig();

      startHeartbeat(config, null, "1.0.0", 1, vi.fn());

      // First tick triggers 429
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      const callsAfterFirst = performSpy.mock.calls.length;

      // Wait long enough for backoff to definitely expire (base 5min + 20% jitter = max 6min)
      // plus need to land on a timer tick (every 5min)
      consumeSpy.mockReturnValue(false);
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

      // Should have fired at least once more after backoff expired
      expect(performSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });

    it("caps backoff at 30 minutes", async () => {
      // Zero jitter for deterministic timing
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const consumeSpy = vi.spyOn(initClient, "consumeRateLimitFlag");
      const performSpy = vi.spyOn(initClient, "performInit").mockResolvedValue(null);
      const config = createTestConfig();

      startHeartbeat(config, null, "1.0.0", 1, vi.fn());

      // Drive consecutive 429s. With random=0.5 (zero jitter), backoff
      // doubles: 5m, 10m, 20m, then caps at 30m.
      consumeSpy.mockReturnValue(true);
      // t=5m: first tick, 429 → backoff 5m
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      // t=10m: backoff expired, tick fires, 429 → backoff 10m
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      // t=20m: backoff expired, tick fires, 429 → backoff 20m
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      // t=40m: backoff expired, tick fires, 429 → backoff 30m (cap)
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

      // Now verify the cap: next tick should be skipped for 30 minutes
      consumeSpy.mockReturnValue(false);
      performSpy.mockClear();

      // t=65m (25m later): still within 30m cap → skipped
      await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
      expect(performSpy).not.toHaveBeenCalled();

      // t=75m (10m more = 35m after last 429): cap expired → fires
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(performSpy).toHaveBeenCalled();
    });
  });

  describe("Claim transitions", () => {
    it("calls onClaimTransition when performInit returns claimResult", async () => {
      const claimCallback = vi.fn();
      const claimedKey = "gt_dev_" + "c".repeat(48);

      vi.spyOn(initClient, "performInit").mockResolvedValue({
        claimResult: {
          newApiKey: claimedKey,
          accountId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          graceExpiresAt: Date.now() + 86_400_000,
        },
      });
      vi.spyOn(initClient, "consumeRateLimitFlag").mockReturnValue(false);

      const config = createTestConfig();
      startHeartbeat(config, null, "1.0.0", 1, claimCallback);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(claimCallback).toHaveBeenCalledWith(claimedKey, "a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    });
  });

  describe("Verbose logging", () => {
    it("logs heartbeat start in verbose mode", () => {
      const config = createTestConfig({ verbose: true });
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

      startHeartbeat(config, null, "1.0.0", 1, vi.fn());

      const startLog = infoSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("Heartbeat started"),
      );
      expect(startLog).toBeDefined();
    });

    it("logs heartbeat completion in verbose mode", async () => {
      vi.spyOn(initClient, "performInit").mockResolvedValue(null);
      vi.spyOn(initClient, "consumeRateLimitFlag").mockReturnValue(false);
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

      const config = createTestConfig({ verbose: true });
      startHeartbeat(config, null, "1.0.0", 1, vi.fn());
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      const completedLog = infoSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("Heartbeat completed"),
      );
      expect(completedLog).toBeDefined();
    });
  });

  describe("Lifecycle shutdown migration (DISC-1248)", () => {
    it("registers the final-report hook at priority 10 (heartbeat slot per sdk-lifecycle.md Section 8.3)", () => {
      const hookSpy = vi.spyOn(lifecycle, "registerShutdownHook");

      const config = createTestConfig();
      startHeartbeat(config, null, "1.0.0", 1, vi.fn());

      expect(hookSpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: "heartbeat-final-report", priority: 10 }),
      );
    });

    it("does not register direct SIGTERM/SIGINT handlers when started", () => {
      const sigTermBefore = process.listenerCount("SIGTERM");
      const sigIntBefore = process.listenerCount("SIGINT");

      const config = createTestConfig();
      startHeartbeat(config, null, "1.0.0", 1, vi.fn());

      // Regression guard for DISC-1248: heartbeat must not install its own
      // signal handlers. Signal handling is owned by the lifecycle
      // coordinator (registerSignalHandlers in otel-config.ts).
      expect(process.listenerCount("SIGTERM")).toBe(sigTermBefore);
      expect(process.listenerCount("SIGINT")).toBe(sigIntBefore);
    });

    it("executes final report via lifecycle coordinator in priority order (OTel first, heartbeat second)", async () => {
      const order: string[] = [];
      const collectSpy = vi.spyOn(healthCollector, "collectHealthReport");
      const performSpy = vi.spyOn(initClient, "performInit").mockImplementation(async () => {
        order.push("heartbeat-report");
        return null;
      });
      vi.spyOn(initClient, "consumeRateLimitFlag").mockReturnValue(false);

      // Simulate the OTel flush hook that's registered in otel-config.ts
      // with priority 0 — must run before heartbeat's priority 10 hook.
      registerShutdownHook({
        name: "otel-provider-shutdown",
        priority: 0,
        fn: async () => {
          order.push("otel-flush");
        },
      });

      const config = createTestConfig();
      startHeartbeat(config, null, "1.0.0", 1, vi.fn());

      // Drive the coordinator — this is what signals/beforeExit would do.
      await executeShutdown();
      // Allow any microtasks scheduled by performInit to drain.
      await vi.advanceTimersByTimeAsync(0);

      expect(order).toEqual(["otel-flush", "heartbeat-report"]);
      expect(collectSpy).toHaveBeenCalledTimes(1);
      expect(performSpy).toHaveBeenCalledTimes(1);
    });

    it("emits the final health report exactly once even if shutdown runs twice", async () => {
      const performSpy = vi.spyOn(initClient, "performInit").mockResolvedValue(null);
      vi.spyOn(initClient, "consumeRateLimitFlag").mockReturnValue(false);

      const config = createTestConfig();
      startHeartbeat(config, null, "1.0.0", 1, vi.fn());

      await executeShutdown();
      await executeShutdown();
      await vi.advanceTimersByTimeAsync(0);

      // Second executeShutdown() is a no-op via the coordinator's
      // _shutdownExecuted guard; the heartbeat module also guards with
      // shutdownFired. Together they must ensure at-most-once reporting.
      expect(performSpy).toHaveBeenCalledTimes(1);
    });

    it("stops the heartbeat timer during the shutdown hook so no further ticks race", async () => {
      const performSpy = vi.spyOn(initClient, "performInit").mockResolvedValue(null);
      vi.spyOn(initClient, "consumeRateLimitFlag").mockReturnValue(false);

      const config = createTestConfig();
      startHeartbeat(config, null, "1.0.0", 1, vi.fn());

      await executeShutdown();
      await vi.advanceTimersByTimeAsync(0);
      const callsAfterShutdown = performSpy.mock.calls.length;

      // Advance past several interval boundaries. If the timer were still
      // live, setInterval would drive additional performInit calls.
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      expect(performSpy.mock.calls.length).toBe(callsAfterShutdown);
    });

    it("registers the shutdown hook only once across repeated startHeartbeat calls", async () => {
      const performSpy = vi.spyOn(initClient, "performInit").mockResolvedValue(null);
      vi.spyOn(initClient, "consumeRateLimitFlag").mockReturnValue(false);

      const config = createTestConfig();
      startHeartbeat(config, null, "1.0.0", 1, vi.fn());
      stopHeartbeat();
      startHeartbeat(config, null, "1.0.0", 2, vi.fn());

      await executeShutdown();
      await vi.advanceTimersByTimeAsync(0);

      // Even though startHeartbeat ran twice, the hook must fire exactly once.
      expect(performSpy).toHaveBeenCalledTimes(1);
    });

    it("swallows errors from the final report so the rest of shutdown completes", async () => {
      vi.spyOn(initClient, "performInit").mockRejectedValue(new Error("network down"));
      vi.spyOn(initClient, "consumeRateLimitFlag").mockReturnValue(false);

      const later: string[] = [];
      registerShutdownHook({
        name: "later-hook",
        priority: 20,
        fn: async () => {
          later.push("ran");
        },
      });

      const config = createTestConfig();
      startHeartbeat(config, null, "1.0.0", 1, vi.fn());

      await executeShutdown();
      await vi.advanceTimersByTimeAsync(0);

      // Later hook must still run even though heartbeat's inner performInit rejected.
      expect(later).toEqual(["ran"]);
    });
  });
});
