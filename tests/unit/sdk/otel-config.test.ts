import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  configureOtel,
  resetOtelConfigForTesting,
} from "../../../packages/sdk/src/otel-config.js";
import { SessionManager } from "../../../packages/sdk/src/session.js";
import type { ResolvedConfig } from "../../../packages/sdk/src/env-detection.js";
import * as otelApi from "@opentelemetry/api";
import * as otelSdk from "@opentelemetry/sdk-trace-base";

/** Builds a minimal ResolvedConfig for testing. */
function createTestConfig(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    endpoint: "https://ingest.glasstrace.dev",
    environment: "test",
    verbose: false,
    nodeEnv: "test",
    vercelEnv: undefined,
    apiKey: undefined,
    coverageMapEnabled: false,
    forceEnable: false,
    ...overrides,
  };
}

/** Flushes pending microtasks so promise callbacks run. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("configureOtel()", () => {
  let sessionManager: SessionManager;

  beforeEach(() => {
    otelApi.trace.disable();
    resetOtelConfigForTesting();
    vi.restoreAllMocks();
    sessionManager = new SessionManager();
  });

  afterEach(() => {
    // Clean up signal listeners before disabling trace to prevent leaks
    resetOtelConfigForTesting();
    otelApi.trace.disable();
    otelApi.diag.disable();
  });

  describe("Provider coexistence", () => {
    it("should skip registration when a non-proxy provider is already registered", async () => {
      // Register a provider before Glasstrace runs
      const existingProvider = new otelSdk.BasicTracerProvider();
      otelApi.trace.setGlobalTracerProvider(existingProvider);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await configureOtel(createTestConfig(), sessionManager);

      // Should warn about existing provider
      const coexistenceWarning = warnSpy.mock.calls.find(
        (call) =>
          typeof call[0] === "string" &&
          call[0].includes("already registered"),
      );
      expect(coexistenceWarning).toBeDefined();
    });

    it("should detect collision via ProxyTracer check and not add signal handlers", async () => {
      // Pre-register a real provider
      const existingProvider = new otelSdk.BasicTracerProvider();
      otelApi.trace.setGlobalTracerProvider(existingProvider);

      vi.spyOn(console, "warn").mockImplementation(() => {});

      const sigTermBefore = process.listenerCount("SIGTERM");

      await configureOtel(createTestConfig(), sessionManager);

      // No new shutdown handlers should be registered when collision detected
      expect(process.listenerCount("SIGTERM")).toBe(sigTermBefore);
    });

    it("should register normally when only the default ProxyTracer is present", async () => {
      // Default state: no provider registered, OTel returns ProxyTracer
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const sigTermBefore = process.listenerCount("SIGTERM");

      await configureOtel(createTestConfig(), sessionManager);

      // Should register and add shutdown handlers
      expect(process.listenerCount("SIGTERM")).toBe(sigTermBefore + 1);
    });
  });

  describe("Shutdown hooks", () => {
    it("should register SIGTERM and SIGINT handlers", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const sigTermBefore = process.listenerCount("SIGTERM");
      const sigIntBefore = process.listenerCount("SIGINT");

      await configureOtel(createTestConfig(), sessionManager);

      expect(process.listenerCount("SIGTERM")).toBe(sigTermBefore + 1);
      expect(process.listenerCount("SIGINT")).toBe(sigIntBefore + 1);
    });

    it("should remove handlers on reset", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const sigTermBefore = process.listenerCount("SIGTERM");
      const sigIntBefore = process.listenerCount("SIGINT");

      await configureOtel(createTestConfig(), sessionManager);

      resetOtelConfigForTesting();

      expect(process.listenerCount("SIGTERM")).toBe(sigTermBefore);
      expect(process.listenerCount("SIGINT")).toBe(sigIntBefore);
    });

    it("should call provider.shutdown() when SIGTERM fires", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const shutdownSpy = vi
        .spyOn(otelSdk.BasicTracerProvider.prototype, "shutdown")
        .mockResolvedValue(undefined);

      // Prevent re-raise from actually killing the test process
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      try {
        await configureOtel(createTestConfig(), sessionManager);

        process.emit("SIGTERM", "SIGTERM");
        await flushMicrotasks();

        expect(shutdownSpy).toHaveBeenCalled();
      } finally {
        killSpy.mockRestore();
      }
    });

    it("should log a warning when provider.shutdown() rejects", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      vi.spyOn(otelSdk.BasicTracerProvider.prototype, "shutdown").mockRejectedValue(
        new Error("shutdown failed"),
      );

      // Prevent re-raise from actually killing the test process
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      try {
        await configureOtel(createTestConfig(), sessionManager);

        process.emit("SIGINT", "SIGINT");
        await flushMicrotasks();

        const shutdownWarning = warnSpy.mock.calls.find(
          (call) =>
            typeof call[0] === "string" &&
            call[0].includes("Error during OTel shutdown"),
        );
        expect(shutdownWarning).toBeDefined();
      } finally {
        killSpy.mockRestore();
      }
    });

    it("should be idempotent when both SIGTERM and SIGINT fire", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const shutdownSpy = vi
        .spyOn(otelSdk.BasicTracerProvider.prototype, "shutdown")
        .mockResolvedValue(undefined);

      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      try {
        await configureOtel(createTestConfig(), sessionManager);

        process.emit("SIGTERM", "SIGTERM");
        process.emit("SIGINT", "SIGINT");
        await flushMicrotasks();

        // shutdown should only be called once despite both signals
        expect(shutdownSpy).toHaveBeenCalledTimes(1);
      } finally {
        killSpy.mockRestore();
      }
    });
  });

  describe("BatchSpanProcessor configuration", () => {
    it("should use 1-second flush interval instead of 5-second default", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const bspSpy = vi.spyOn(otelSdk, "BatchSpanProcessor");

      await configureOtel(createTestConfig(), sessionManager);

      expect(bspSpy).toHaveBeenCalledTimes(1);
      const configArg = bspSpy.mock.calls[0][1];
      expect(configArg).toBeDefined();
      expect(configArg?.scheduledDelayMillis).toBe(1000);
    });
  });

  describe("OTel diagnostic logging", () => {
    it("should enable diag logger at WARN level when verbose is true", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const diagSpy = vi.spyOn(otelApi.diag, "setLogger");

      await configureOtel(createTestConfig({ verbose: true }), sessionManager);

      expect(diagSpy).toHaveBeenCalledTimes(1);
      // Custom sdkLog-based logger (not DiagConsoleLogger) with warn/error methods
      const logger = diagSpy.mock.calls[0][0];
      expect(typeof logger.warn).toBe("function");
      expect(typeof logger.error).toBe("function");
      expect(diagSpy.mock.calls[0][1]).toBe(otelApi.DiagLogLevel.WARN);
    });

    it("should NOT enable diag logger when verbose is false", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const diagSpy = vi.spyOn(otelApi.diag, "setLogger");

      await configureOtel(createTestConfig({ verbose: false }), sessionManager);

      expect(diagSpy).not.toHaveBeenCalled();
    });
  });

  describe("BSP config diagnostic logging", () => {
    it("should log BSP configuration when verbose is true", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

      await configureOtel(createTestConfig({ verbose: true }), sessionManager);

      const bspLog = infoSpy.mock.calls.find(
        (call) =>
          typeof call[0] === "string" &&
          call[0].includes("[glasstrace:diag] BatchSpanProcessor"),
      );
      expect(bspLog).toBeDefined();
      expect(bspLog![0]).toContain("scheduledDelayMillis=1000");
      // Log only reports values we explicitly set — no hardcoded OTel defaults
      // that could be overridden by environment variables
      expect(bspLog![0]).not.toContain("maxQueueSize");

    });

    it("should NOT log BSP configuration when verbose is false", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

      await configureOtel(createTestConfig({ verbose: false }), sessionManager);

      const bspLogs = infoSpy.mock.calls.filter(
        (call) =>
          typeof call[0] === "string" &&
          call[0].includes("[glasstrace:diag] BatchSpanProcessor"),
      );
      expect(bspLogs).toHaveLength(0);
    });
  });
});
