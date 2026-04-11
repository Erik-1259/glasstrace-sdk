import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerGlasstrace,
  _resetRegistrationForTesting,
  getDiscoveryHandler,
} from "../../../packages/sdk/src/register.js";
import { _resetConfigForTesting } from "../../../packages/sdk/src/init-client.js";
import * as otelConfig from "../../../packages/sdk/src/otel-config.js";

/** Valid developer API key for testing (gt_dev_ prefix + 48 hex chars). */
const TEST_DEV_API_KEY = "gt_dev_" + "a".repeat(48);

/** Alternate valid developer API key for isolation between tests. */
const TEST_DEV_API_KEY_ALT = "gt_dev_" + "b".repeat(48);

/** Duration (ms) to wait for background promises to settle in async tests. */
const BACKGROUND_SETTLE_MS = 200;

/** Standard init response fields shared by all mock variants. */
const STANDARD_INIT_FIELDS = {
  config: {
    requestBodies: false,
    queryParamValues: false,
    envVarValues: false,
    fullConsoleOutput: false,
    importGraph: false,
  },
  minimumSdkVersion: "0.0.0",
  apiVersion: "v1",
  tierLimits: {
    tracesPerMinute: 100,
    storageTtlHours: 48,
    maxTraceSizeBytes: 512000,
    maxConcurrentSessions: 1,
  },
};

/** Creates a mock fetch Response matching the SdkInitResponse schema. */
function createMockInitResponse(): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      ...STANDARD_INIT_FIELDS,
      subscriptionStatus: "anonymous",
    }),
  });
}

/** Valid dev API key that satisfies DevApiKeySchema (gt_dev_ + 48 hex chars). */
const CLAIMED_DEV_KEY = "gt_dev_" + "c".repeat(48);

/**
 * Creates a mock fetch Response whose init payload includes a claimResult,
 * simulating the backend reporting an account claim transition.
 */
function createMockInitResponseWithClaim(): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      ...STANDARD_INIT_FIELDS,
      subscriptionStatus: "claimed",
      claimResult: {
        newApiKey: CLAIMED_DEV_KEY,
        accountId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        graceExpiresAt: Date.now() + 86_400_000,
      },
    }),
  });
}

/** Waits for fire-and-forget background promises to settle. */
async function waitForBackgroundWork(ms = BACKGROUND_SETTLE_MS): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("registerGlasstrace() Orchestrator", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    _resetRegistrationForTesting();
    _resetConfigForTesting();
    vi.restoreAllMocks();
    // Reset env
    delete process.env.NODE_ENV;
    delete process.env.VERCEL_ENV;
    delete process.env.GLASSTRACE_API_KEY;
    delete process.env.GLASSTRACE_FORCE_ENABLE;
    delete process.env.GLASSTRACE_ENV;
    delete process.env.GLASSTRACE_COVERAGE_MAP;
    delete process.env.GLASSTRACE_DISCOVERY_ENABLED;

    // Mock fetch globally to prevent real network calls
    vi.stubGlobal("fetch", createMockInitResponse());
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    _resetRegistrationForTesting();
    _resetConfigForTesting();
    vi.unstubAllGlobals();
  });

  describe("Checkpoint 1: Production detection", () => {
    it("should disable SDK when NODE_ENV is production", () => {
      process.env.NODE_ENV = "production";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      registerGlasstrace();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Disabled in production"),
      );
    });

    it("should disable SDK when VERCEL_ENV is production", () => {
      process.env.VERCEL_ENV = "production";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      registerGlasstrace();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Disabled in production"),
      );
    });

    it("should allow registration in production when GLASSTRACE_FORCE_ENABLE is true", () => {
      process.env.NODE_ENV = "production";
      process.env.GLASSTRACE_FORCE_ENABLE = "true";
      process.env.GLASSTRACE_API_KEY = TEST_DEV_API_KEY;
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      registerGlasstrace();

      const productionWarning = warnSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("Disabled in production"),
      );
      expect(productionWarning).toBeUndefined();
    });
  });

  describe("Checkpoint 2: Anonymous mode", () => {
    it("should select anonymous auth mode when no API key is provided", () => {
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});

      registerGlasstrace({ verbose: true });

      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("Auth mode = anonymous"),
      );
    });

    it("should register discovery endpoint in anonymous development mode", async () => {
      process.env.NODE_ENV = "development";
      vi.spyOn(console, "info").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});

      registerGlasstrace({ verbose: true });

      await waitForBackgroundWork();

      const handler = getDiscoveryHandler();
      expect(handler).not.toBeNull();
    });
  });

  describe("Checkpoint 3: Dev key mode", () => {
    it("should select dev-key auth mode when GLASSTRACE_API_KEY is set", () => {
      process.env.GLASSTRACE_API_KEY = TEST_DEV_API_KEY;
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});

      registerGlasstrace({ verbose: true });

      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("Auth mode = dev-key"),
      );
    });

    it("should not expose discovery endpoint in dev-key mode", async () => {
      process.env.GLASSTRACE_API_KEY = TEST_DEV_API_KEY;
      vi.spyOn(console, "warn").mockImplementation(() => {});

      registerGlasstrace();

      await waitForBackgroundWork();

      const handler = getDiscoveryHandler();
      expect(handler).toBeNull();
    });
  });

  describe("Checkpoint 4: OTel configuration", () => {
    it("should configure OTel without throwing", async () => {
      process.env.GLASSTRACE_API_KEY = TEST_DEV_API_KEY;
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = registerGlasstrace();
      expect(result).toBeUndefined();

      await waitForBackgroundWork();

      // Verify initialization completed by checking that console.warn was called
      // (dev-key mode always warns about dev-key usage)
      expect(warnSpy).toHaveBeenCalled();
    });

    it("should log OTel configuration step in verbose mode", async () => {
      process.env.GLASSTRACE_API_KEY = TEST_DEV_API_KEY;
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});

      registerGlasstrace({ verbose: true });

      await waitForBackgroundWork();

      const messages = infoSpy.mock.calls
        .map((c) => String(c[0]));
      expect(messages.some((m) => m.includes("OTel configured"))).toBe(true);
    });
  });

  describe("Checkpoint 5: Non-blocking background init", () => {
    it("should return synchronously without waiting for background work", () => {
      process.env.GLASSTRACE_API_KEY = TEST_DEV_API_KEY;
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const start = Date.now();
      registerGlasstrace();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(100);
    });

    it("should send init request to the backend in the background", async () => {
      process.env.GLASSTRACE_API_KEY = TEST_DEV_API_KEY;
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const fetchSpy = createMockInitResponse();
      vi.stubGlobal("fetch", fetchSpy);

      registerGlasstrace();

      await waitForBackgroundWork();

      expect(fetchSpy).toHaveBeenCalled();
    });
  });

  describe("Checkpoint 6: Verbose logging", () => {
    it("should log all synchronous initialization steps when verbose is enabled", () => {
      process.env.GLASSTRACE_API_KEY = TEST_DEV_API_KEY;
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});

      registerGlasstrace({ verbose: true });

      const messages = infoSpy.mock.calls
        .map((c) => String(c[0]));
      expect(messages.some((m) => m.includes("Config resolved"))).toBe(true);
      expect(messages.some((m) => m.includes("Not production-disabled"))).toBe(true);
      expect(messages.some((m) => m.includes("Auth mode"))).toBe(true);
      expect(messages.some((m) => m.includes("Cached config"))).toBe(true);
      expect(messages.some((m) => m.includes("SessionManager created"))).toBe(true);
    });
  });

  describe("Checkpoint 7: Error resilience", () => {
    it("should never throw regardless of input", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(() => registerGlasstrace()).not.toThrow();
    });

    it("should silently no-op on second registration call", async () => {
      process.env.GLASSTRACE_API_KEY = TEST_DEV_API_KEY;
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

      registerGlasstrace({ verbose: true });

      // Wait for async OTel config to settle before clearing,
      // so its log doesn't leak into the second registration window.
      await waitForBackgroundWork(300);
      infoSpy.mockClear();

      registerGlasstrace({ verbose: true });

      // Second registration should produce no log messages at all
      expect(infoSpy.mock.calls).toHaveLength(0);
    });
  });

  describe("Discovery endpoint integration", () => {
    it("should not expose discovery endpoint when using a developer API key", async () => {
      process.env.GLASSTRACE_API_KEY = TEST_DEV_API_KEY_ALT;
      vi.spyOn(console, "warn").mockImplementation(() => {});

      _resetRegistrationForTesting();
      registerGlasstrace();

      await waitForBackgroundWork();

      const handler = getDiscoveryHandler();
      expect(handler).toBeNull();
    });
  });

  describe("Anonymous + production with force-enable", () => {
    it("should not expose discovery endpoint in production even with force-enable", async () => {
      process.env.NODE_ENV = "production";
      process.env.GLASSTRACE_FORCE_ENABLE = "true";
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "info").mockImplementation(() => {});

      registerGlasstrace({ verbose: true });

      await waitForBackgroundWork();

      const handler = getDiscoveryHandler();
      expect(handler).toBeNull();
    });
  });

  describe("Error handling in background work", () => {
    it("should accept any options shape without throwing", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "info").mockImplementation(() => {});

      expect(() => registerGlasstrace(undefined)).not.toThrow();
      _resetRegistrationForTesting();
      expect(() => registerGlasstrace({})).not.toThrow();
    });
  });

  describe("Dev-key background init error handling", () => {
    it("should log a warning and continue when background init network request fails", async () => {
      process.env.GLASSTRACE_API_KEY = "gt_dev_" + "c".repeat(48);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

      registerGlasstrace();

      await waitForBackgroundWork();

      // Verify the error was caught and logged, not swallowed silently
      const networkWarning = warnSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("network down"),
      );
      expect(networkWarning).toBeDefined();
    });
  });

  describe("Coverage map verbose logging", () => {
    it("should log import graph skip message when coverage map is enabled in verbose mode", () => {
      process.env.GLASSTRACE_API_KEY = TEST_DEV_API_KEY;
      process.env.GLASSTRACE_COVERAGE_MAP = "true";
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});

      registerGlasstrace({ verbose: true });

      const messages = infoSpy.mock.calls
        .map((c) => String(c[0]));
      expect(messages.some((m) => m.includes("Import graph building skipped"))).toBe(true);
    });
  });

  describe("Discovery endpoint environment guard", () => {
    it("should not expose discovery endpoint when NODE_ENV is staging", async () => {
      process.env.NODE_ENV = "staging";
      vi.spyOn(console, "warn").mockImplementation(() => {});

      registerGlasstrace();

      await waitForBackgroundWork();

      const handler = getDiscoveryHandler();
      expect(handler).toBeNull();
    });

    it("should not expose discovery endpoint when NODE_ENV is test", async () => {
      process.env.NODE_ENV = "test";
      vi.spyOn(console, "warn").mockImplementation(() => {});

      registerGlasstrace();

      await waitForBackgroundWork();

      const handler = getDiscoveryHandler();
      expect(handler).toBeNull();
    });

    it("should expose discovery endpoint when NODE_ENV is development", async () => {
      process.env.NODE_ENV = "development";
      vi.spyOn(console, "info").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});

      registerGlasstrace({ verbose: true });

      await waitForBackgroundWork();

      const handler = getDiscoveryHandler();
      expect(handler).not.toBeNull();
    });

    it("should expose discovery endpoint when NODE_ENV is unset", async () => {
      delete process.env.NODE_ENV;
      vi.spyOn(console, "info").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});

      registerGlasstrace({ verbose: true });

      await waitForBackgroundWork();

      const handler = getDiscoveryHandler();
      expect(handler).not.toBeNull();
    });

    it("should respect GLASSTRACE_DISCOVERY_ENABLED=true over NODE_ENV=staging", async () => {
      process.env.NODE_ENV = "staging";
      process.env.GLASSTRACE_DISCOVERY_ENABLED = "true";
      vi.spyOn(console, "warn").mockImplementation(() => {});

      registerGlasstrace();

      await waitForBackgroundWork();

      const handler = getDiscoveryHandler();
      expect(handler).not.toBeNull();
    });

    it("should respect GLASSTRACE_DISCOVERY_ENABLED=false over NODE_ENV=development", async () => {
      process.env.NODE_ENV = "development";
      process.env.GLASSTRACE_DISCOVERY_ENABLED = "false";
      vi.spyOn(console, "warn").mockImplementation(() => {});

      registerGlasstrace();

      await waitForBackgroundWork();

      const handler = getDiscoveryHandler();
      expect(handler).toBeNull();
    });
  });

  describe("Log message ordering", () => {
    it("logs initialization steps in expected order for a complete dev-key flow", async () => {
      process.env.GLASSTRACE_API_KEY = TEST_DEV_API_KEY;
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});

      registerGlasstrace({ verbose: true });

      await waitForBackgroundWork(300);

      const messages = infoSpy.mock.calls.map((c) => String(c[0]));
      const configResolvedIdx = messages.findIndex((m) => m.includes("Config resolved"));
      const authModeIdx = messages.findIndex((m) => m.includes("Auth mode"));
      const otelIdx = messages.findIndex((m) => m.includes("OTel configured"));

      // Guard: all messages must be present before asserting order
      expect(configResolvedIdx).not.toBe(-1);
      expect(authModeIdx).not.toBe(-1);
      expect(otelIdx).not.toBe(-1);

      // Config resolved must come before auth mode, which comes before OTel configured
      expect(configResolvedIdx).toBeGreaterThanOrEqual(0);
      expect(authModeIdx).toBeGreaterThan(configResolvedIdx);
      expect(otelIdx).toBeGreaterThan(authModeIdx);
    });
  });

  describe("Mock leak sentinel", () => {
    it("beforeEach properly stubs fetch for each test", () => {
      // This test verifies that the afterEach vi.unstubAllGlobals() call
      // properly restores fetch. beforeEach re-stubs fetch, so we check
      // that the stub is a mock (expected) — but if unstubAllGlobals
      // failed in a previous afterEach, this test's beforeEach would
      // layer a second stub. The real guard is that vi.isMockFunction
      // returns true for the current stub, confirming the test harness
      // is in control.
      expect(vi.isMockFunction(globalThis.fetch)).toBe(true);
    });
  });

  describe("OTel configured immediately with lazy auth", () => {
    it("should configure OTel asynchronously while allowing synchronous return", async () => {
      // OTel is registered immediately in all modes.
      // GlasstraceExporter buffers spans and defers auth to export time.
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});

      registerGlasstrace({ verbose: true });

      // OTel config is async (fire-and-forget), so it should not appear synchronously
      const syncMessages = infoSpy.mock.calls
        .map((c) => String(c[0]));
      expect(syncMessages.some((m) => m.includes("OTel configured"))).toBe(false);

      // After the async configureOtel resolves, the message should appear
      await waitForBackgroundWork(300);

      const allMessages = infoSpy.mock.calls
        .map((c) => String(c[0]));
      expect(allMessages.some((m) => m.includes("OTel configured"))).toBe(true);
    });

    it("should run performInit independently of OTel configuration", async () => {
      // configureOtel and performInit run in separate fire-and-forget chains.
      // An OTel failure must not prevent the init request.
      process.env.NODE_ENV = "development";
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "info").mockImplementation(() => {});

      registerGlasstrace({ verbose: true });

      await waitForBackgroundWork(300);

      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  describe("Claim propagation in backgroundInit", () => {
    // Isolate filesystem side effects from writeClaimedKey() so that
    // claim-path tests never touch .env.local in the repo root.
    let claimTempDir: string;

    beforeEach(async () => {
      claimTempDir = await mkdtemp(join(tmpdir(), "glasstrace-claim-test-"));
      vi.spyOn(process, "cwd").mockReturnValue(claimTempDir);
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    });

    afterEach(async () => {
      await rm(claimTempDir, { recursive: true, force: true });
    });

    it("should update the resolved API key when init returns a claimResult in dev-key mode", async () => {
      process.env.GLASSTRACE_API_KEY = TEST_DEV_API_KEY;
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const setKeySpy = vi.spyOn(otelConfig, "setResolvedApiKey");
      const notifySpy = vi.spyOn(otelConfig, "notifyApiKeyResolved");

      vi.stubGlobal("fetch", createMockInitResponseWithClaim());

      registerGlasstrace();

      await waitForBackgroundWork(400);

      // setResolvedApiKey is called once synchronously with the dev key,
      // then a second time from backgroundInit with the claimed key.
      const setKeyCalls = setKeySpy.mock.calls.map((c) => c[0]);
      expect(setKeyCalls).toContain(TEST_DEV_API_KEY);
      expect(setKeyCalls).toContain(CLAIMED_DEV_KEY);

      // notifyApiKeyResolved is called from backgroundInit after the claim
      expect(notifySpy).toHaveBeenCalled();
    });

    it("should not call setResolvedApiKey a second time when init has no claimResult", async () => {
      process.env.GLASSTRACE_API_KEY = TEST_DEV_API_KEY;
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const setKeySpy = vi.spyOn(otelConfig, "setResolvedApiKey");
      const notifySpy = vi.spyOn(otelConfig, "notifyApiKeyResolved");

      // Standard mock — no claimResult in the response
      vi.stubGlobal("fetch", createMockInitResponse());

      registerGlasstrace();

      await waitForBackgroundWork(400);

      // setResolvedApiKey is called exactly once: the synchronous dev-key set
      expect(setKeySpy).toHaveBeenCalledTimes(1);
      expect(setKeySpy).toHaveBeenCalledWith(TEST_DEV_API_KEY);

      // notifyApiKeyResolved should NOT be called from backgroundInit
      // (it is not called in the dev-key path outside of claim propagation)
      expect(notifySpy).not.toHaveBeenCalled();
    });

    it("should propagate claimResult in anonymous mode", async () => {
      // Anonymous mode: no GLASSTRACE_API_KEY set
      process.env.NODE_ENV = "development";
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "info").mockImplementation(() => {});

      const setKeySpy = vi.spyOn(otelConfig, "setResolvedApiKey");
      const notifySpy = vi.spyOn(otelConfig, "notifyApiKeyResolved");

      vi.stubGlobal("fetch", createMockInitResponseWithClaim());

      registerGlasstrace();

      await waitForBackgroundWork(400);

      // In anonymous mode, setResolvedApiKey is called:
      //   1. With the anonymous key (after getOrCreateAnonKey resolves)
      //   2. With the claimed dev key (from backgroundInit claimResult)
      const setKeyCalls = setKeySpy.mock.calls.map((c) => c[0]);
      expect(setKeyCalls.length).toBeGreaterThanOrEqual(2);
      expect(setKeyCalls[setKeyCalls.length - 1]).toBe(CLAIMED_DEV_KEY);

      // notifyApiKeyResolved is called at least twice:
      //   1. After anonymous key resolution
      //   2. After claim propagation in backgroundInit
      expect(notifySpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
