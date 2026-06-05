import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  configureOtel,
  resetOtelConfigForTesting,
} from "../../../packages/sdk/src/otel-config.js";
import { SessionManager } from "../../../packages/sdk/src/session.js";
import { GlasstraceExporter } from "../../../packages/sdk/src/enriching-exporter.js";
import { DEFAULT_CAPTURE_CONFIG } from "@glasstrace/protocol";
import type { ResolvedConfig } from "../../../packages/sdk/src/env-detection.js";
import * as otelApi from "@opentelemetry/api";
import * as otelSdk from "@opentelemetry/sdk-trace-base";
import * as lifecycle from "../../../packages/sdk/src/lifecycle.js";

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


describe("configureOtel()", () => {
  let sessionManager: SessionManager;

  beforeEach(() => {
    otelApi.trace.disable();
    lifecycle.resetLifecycleForTesting();
    lifecycle.initLifecycle({ logger: vi.fn() });
    resetOtelConfigForTesting();
    vi.restoreAllMocks();
    sessionManager = new SessionManager();
  });

  afterEach(() => {
    lifecycle.resetLifecycleForTesting();
    resetOtelConfigForTesting();
    otelApi.trace.disable();
    otelApi.context.disable();
    otelApi.propagation.disable();
    otelApi.diag.disable();
  });

  describe("Provider coexistence (DISC-1202)", () => {
    it("Scenario A: registers normally when no existing provider", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const hookSpy = vi.spyOn(lifecycle, "registerShutdownHook");

      await configureOtel(createTestConfig(), sessionManager);

      // Should register a shutdown hook via lifecycle coordinator
      expect(hookSpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: "otel-provider-shutdown" }),
      );
    });

    it("Scenario B-auto: injects processor into existing v2 provider", async () => {
      const existingProvider = new otelSdk.BasicTracerProvider();
      otelApi.trace.setGlobalTracerProvider(existingProvider);

      vi.spyOn(console, "warn").mockImplementation(() => {});

      await configureOtel(createTestConfig(), sessionManager);

      // Verify the processor was injected by checking _spanProcessors
      const multi = (existingProvider as unknown as {
        _activeSpanProcessor: { _spanProcessors: unknown[] };
      })._activeSpanProcessor;
      expect(multi._spanProcessors.length).toBeGreaterThanOrEqual(1);
    });

    it("Scenario B-auto: does not add SIGTERM/SIGINT handlers", async () => {
      const existingProvider = new otelSdk.BasicTracerProvider();
      otelApi.trace.setGlobalTracerProvider(existingProvider);

      vi.spyOn(console, "warn").mockImplementation(() => {});

      const sigTermBefore = process.listenerCount("SIGTERM");

      await configureOtel(createTestConfig(), sessionManager);

      // No SIGTERM/SIGINT handlers — existing provider owns those
      expect(process.listenerCount("SIGTERM")).toBe(sigTermBefore);
    });

    it("Scenario B-auto: registers coexistence flush hook and beforeExit trigger via coordinator", async () => {
      const existingProvider = new otelSdk.BasicTracerProvider();
      otelApi.trace.setGlobalTracerProvider(existingProvider);

      vi.spyOn(console, "warn").mockImplementation(() => {});
      const hookSpy = vi.spyOn(lifecycle, "registerShutdownHook");
      const triggerSpy = vi.spyOn(lifecycle, "registerBeforeExitTrigger");

      await configureOtel(createTestConfig(), sessionManager);

      // Hook registered via coordinator
      expect(hookSpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: "coexistence-flush", priority: 5 }),
      );
      // beforeExit trigger wired via coordinator (not direct handler)
      expect(triggerSpy).toHaveBeenCalledTimes(1);
    });

    it("Scenario B-clean: skips injection when branded processor already present", async () => {
      // Create a provider with a Glasstrace-branded processor already in it
      const brandedExporter = new GlasstraceExporter({
        getApiKey: () => "test",
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CAPTURE_CONFIG,
        environment: undefined,
        endpointUrl: "https://test/v1/traces",
        createDelegate: null,
      });
      const brandedProcessor = new otelSdk.BatchSpanProcessor(brandedExporter);
      const existingProvider = new otelSdk.BasicTracerProvider({
        spanProcessors: [brandedProcessor],
      });
      otelApi.trace.setGlobalTracerProvider(existingProvider);

      vi.spyOn(console, "warn").mockImplementation(() => {});

      await configureOtel(createTestConfig({ verbose: true }), sessionManager);

      // Should NOT inject a second processor
      const multi = (existingProvider as unknown as {
        _activeSpanProcessor: { _spanProcessors: unknown[] };
      })._activeSpanProcessor;
      expect(multi._spanProcessors).toHaveLength(1);
    });

    it("Scenario D1: uses addSpanProcessor when available (v1-style provider)", async () => {
      const addSpy = vi.fn();
      const v1Provider = {
        getTracer: () => ({ constructor: { name: "Tracer" } }),
        addSpanProcessor: addSpy,
      };
      // Wrap in ProxyTracerProvider by registering globally
      otelApi.trace.setGlobalTracerProvider(
        v1Provider as unknown as otelApi.TracerProvider,
      );

      vi.spyOn(console, "warn").mockImplementation(() => {});

      await configureOtel(createTestConfig(), sessionManager);

      // Should have called addSpanProcessor with a BatchSpanProcessor
      expect(addSpy).toHaveBeenCalledTimes(1);
      expect(addSpy.mock.calls[0][0]).toBeInstanceOf(otelSdk.BatchSpanProcessor);
    });

    it("Scenario C/F: emits guidance when provider internals are inaccessible", async () => {
      // Create a minimal provider that does NOT have _activeSpanProcessor
      const minimalProvider = {
        getTracer: () => ({ constructor: { name: "SomeTracer" } }),
      };
      otelApi.trace.setGlobalTracerProvider(
        minimalProvider as unknown as otelApi.TracerProvider,
      );

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await configureOtel(createTestConfig(), sessionManager);

      const guidanceWarning = warnSpy.mock.calls.find(
        (call) =>
          typeof call[0] === "string" &&
          call[0].includes("could not auto-attach"),
      );
      expect(guidanceWarning).toBeDefined();
    });

    it("Scenario C/F (DISC-1556): emits otel:failed with structured lastError payload", async () => {
      // Reproduces the Next 16 production "auto-attach returned null"
      // failure mode. The opaque provider has neither addSpanProcessor
      // (v1) nor _activeSpanProcessor._spanProcessors (v2), so
      // tryAutoAttachGlasstraceProcessor returns null. The coexistence
      // path must emit a structured `otel:failed` event whose payload
      // is safe to persist via the runtime-state CLI bridge.
      const opaqueProvider = {
        getTracer: () => ({ constructor: { name: "DDTracer" } }),
      };
      // Set the global so the proxy unwrap inside readProviderClass()
      // resolves the same opaque object as the delegate.
      otelApi.trace.setGlobalTracerProvider(
        opaqueProvider as unknown as otelApi.TracerProvider,
      );

      vi.spyOn(console, "warn").mockImplementation(() => {});

      const failedEvents: unknown[] = [];
      lifecycle.onLifecycleEvent("otel:failed", (payload) => {
        failedEvents.push(payload);
      });

      await configureOtel(createTestConfig(), sessionManager);

      expect(failedEvents).toHaveLength(1);
      const payload = failedEvents[0] as {
        category: string;
        message: string;
        timestamp: string;
        providerClass?: string;
      };
      expect(payload.category).toBe("auto-attach-returned-null");
      expect(payload.message).toContain(
        "tryAutoAttachGlasstraceProcessor returned null",
      );
      // ISO 8601 timestamp.
      expect(() => new Date(payload.timestamp).toISOString()).not.toThrow();
      // PII-safety: providerClass is the constructor name of the
      // unwrapped delegate. The opaque object literal's constructor is
      // `Object`, not a URL or header.
      expect(payload.providerClass).toBe("Object");
      // Negative assertion: nothing in the message reveals user-app
      // internals like delegate URLs or headers.
      expect(payload.message).not.toMatch(/https?:\/\//);
      expect(payload.message).not.toMatch(/authorization/i);
    });

    it("Scenario C/F (DISC-1556 + DISC-1247): preserves FSM guard — KEY_PENDING does not transition to ACTIVE_DEGRADED", async () => {
      // Regression test against a future change that relaxes the
      // FSM and accidentally allows KEY_PENDING → ACTIVE_DEGRADED.
      // VALID_CORE_TRANSITIONS at lifecycle.ts (DISC-1247) rejects
      // this transition; the guard at otel-config.ts must continue
      // to skip setCoreState(ACTIVE_DEGRADED) when prior state is
      // KEY_PENDING.
      const opaqueProvider = {
        getTracer: () => ({ constructor: { name: "DDTracer" } }),
      };
      otelApi.trace.setGlobalTracerProvider(
        opaqueProvider as unknown as otelApi.TracerProvider,
      );

      vi.spyOn(console, "warn").mockImplementation(() => {});

      // Drive core state to KEY_PENDING via the legitimate path.
      lifecycle.setCoreState(lifecycle.CoreState.REGISTERING);
      lifecycle.setCoreState(lifecycle.CoreState.KEY_PENDING);
      expect(lifecycle.getCoreState()).toBe(lifecycle.CoreState.KEY_PENDING);

      await configureOtel(createTestConfig(), sessionManager);

      // The C/F branch must NOT have transitioned the core state.
      expect(lifecycle.getCoreState()).toBe(lifecycle.CoreState.KEY_PENDING);
    });

    it("Scenario C/F (DISC-1556): readProviderClass falls back to undefined when constructor access throws", async () => {
      // Defensive contract: a hostile provider that throws on
      // constructor lookup must not crash the failure path. The
      // sanitized providerClass simply becomes undefined.
      const hostileProvider = new Proxy(
        {
          getTracer: () => ({ constructor: { name: "Tracer" } }),
        },
        {
          get(target, prop) {
            if (prop === "constructor") {
              throw new Error("hostile constructor access");
            }
            return (target as Record<string | symbol, unknown>)[prop];
          },
        },
      );
      otelApi.trace.setGlobalTracerProvider(
        hostileProvider as unknown as otelApi.TracerProvider,
      );

      vi.spyOn(console, "warn").mockImplementation(() => {});

      const failedEvents: unknown[] = [];
      lifecycle.onLifecycleEvent("otel:failed", (payload) => {
        failedEvents.push(payload);
      });

      // Must not throw — the failure-emit path is defensive.
      await expect(
        configureOtel(createTestConfig(), sessionManager),
      ).resolves.not.toThrow();

      expect(failedEvents).toHaveLength(1);
      const payload = failedEvents[0] as { providerClass?: string };
      // The Proxy throws on constructor access — readProviderClass
      // catches and returns undefined.
      expect(payload.providerClass).toBeUndefined();
    });

    it("Scenario C/F (DISC-1556 + DISC-1247): ACTIVE transitions to ACTIVE_DEGRADED (preserved behavior)", async () => {
      const opaqueProvider = {
        getTracer: () => ({ constructor: { name: "DDTracer" } }),
      };
      otelApi.trace.setGlobalTracerProvider(
        opaqueProvider as unknown as otelApi.TracerProvider,
      );

      vi.spyOn(console, "warn").mockImplementation(() => {});

      // Drive to ACTIVE via the legitimate path.
      lifecycle.setCoreState(lifecycle.CoreState.REGISTERING);
      lifecycle.setCoreState(lifecycle.CoreState.KEY_PENDING);
      lifecycle.setCoreState(lifecycle.CoreState.KEY_RESOLVED);
      lifecycle.setCoreState(lifecycle.CoreState.ACTIVE);

      await configureOtel(createTestConfig(), sessionManager);

      expect(lifecycle.getCoreState()).toBe(lifecycle.CoreState.ACTIVE_DEGRADED);
    });

    it("Scenario E regression: Vercel path skipped when existing provider present", async () => {
      // Even if @vercel/otel is installed (mocked), the Vercel path should
      // NOT run when an existing provider is detected — coexistence path
      // runs instead.
      const existingProvider = new otelSdk.BasicTracerProvider();
      otelApi.trace.setGlobalTracerProvider(existingProvider);

      vi.spyOn(console, "warn").mockImplementation(() => {});

      await configureOtel(createTestConfig(), sessionManager);

      // Verify coexistence injection happened (not Vercel registration)
      const multi = (existingProvider as unknown as {
        _activeSpanProcessor: { _spanProcessors: unknown[] };
      })._activeSpanProcessor;
      expect(multi._spanProcessors.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Shutdown hooks (lifecycle coordinator)", () => {
    it("should register OTel shutdown hook and beforeExit trigger for bare provider (Scenario A)", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const hookSpy = vi.spyOn(lifecycle, "registerShutdownHook");
      const signalSpy = vi.spyOn(lifecycle, "registerSignalHandlers");
      const triggerSpy = vi.spyOn(lifecycle, "registerBeforeExitTrigger");

      await configureOtel(createTestConfig(), sessionManager);

      const otelHook = hookSpy.mock.calls.find(
        (call) => call[0].name === "otel-provider-shutdown",
      );
      expect(otelHook).toBeDefined();
      expect(otelHook![0].priority).toBe(0);
      // Signal handlers are now registered in registerGlasstrace(), not here
      // (DISC-1249) — configureOtel() must not call registerSignalHandlers().
      expect(signalSpy).not.toHaveBeenCalled();
      expect(triggerSpy).toHaveBeenCalledTimes(1);
    });

    it("should register coexistence flush hook + beforeExit trigger for coexistence (Scenario B-auto)", async () => {
      const existingProvider = new otelSdk.BasicTracerProvider();
      otelApi.trace.setGlobalTracerProvider(existingProvider);

      vi.spyOn(console, "warn").mockImplementation(() => {});
      const hookSpy = vi.spyOn(lifecycle, "registerShutdownHook");
      const triggerSpy = vi.spyOn(lifecycle, "registerBeforeExitTrigger");

      await configureOtel(createTestConfig(), sessionManager);

      // Both hook and trigger registered via coordinator
      const flushHook = hookSpy.mock.calls.find(
        (call) => call[0].name === "coexistence-flush",
      );
      expect(flushHook).toBeDefined();
      expect(triggerSpy).toHaveBeenCalledTimes(1);
    });

    it("should NOT register any hooks when coexistence fails (Scenario C/F)", async () => {
      const minimalProvider = {
        getTracer: () => ({ constructor: { name: "SomeTracer" } }),
      };
      otelApi.trace.setGlobalTracerProvider(
        minimalProvider as unknown as otelApi.TracerProvider,
      );

      vi.spyOn(console, "warn").mockImplementation(() => {});
      const hookSpy = vi.spyOn(lifecycle, "registerShutdownHook");

      await configureOtel(createTestConfig(), sessionManager);

      expect(hookSpy).not.toHaveBeenCalled();
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

  describe("Context propagation", () => {
    it("should register a real tracer provider (not ProxyTracer) via provider.register()", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});

      await configureOtel(createTestConfig(), sessionManager);

      // After register(), creating a tracer and starting a span should
      // use the real context manager (not the no-op ProxyTracer default).
      // We verify by checking that the global tracer provider is set.
      const provider = otelApi.trace.getTracerProvider();
      const tracer = provider.getTracer("test");
      // A real tracer (not ProxyTracer) means register() ran successfully
      expect(tracer.constructor.name).not.toBe("ProxyTracer");
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

  describe("Prisma instrumentation diagnostic (DISC-1308)", () => {
    // The default test environment has no @prisma/instrumentation installed,
    // so the bare (Scenario A) registration path's tryImport resolves null —
    // exactly the silent-skip condition DISC-1308 reported. The diagnostic is
    // verbose-gated, so it must fire only when the caller opts in.
    it("warns in verbose mode when @prisma/instrumentation is unavailable", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await configureOtel(createTestConfig({ verbose: true }), sessionManager);

      const prismaWarn = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes("@prisma/instrumentation"));
      expect(prismaWarn).toBeDefined();
      expect(prismaWarn).toContain("Prisma query spans will");
      expect(prismaWarn).toContain(
        "add @prisma/instrumentation as a direct dependency",
      );
    });

    it("stays silent about Prisma when verbose is false", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await configureOtel(createTestConfig({ verbose: false }), sessionManager);

      const prismaWarn = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes("@prisma/instrumentation"));
      expect(prismaWarn).toBeUndefined();
    });
  });

});
