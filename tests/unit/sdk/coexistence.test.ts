import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import * as otelApi from "@opentelemetry/api";
import {
  createGlasstraceSpanProcessor,
  emitNudgeMessage,
  emitGuidanceMessage,
  isGlasstraceProcessorPresent,
  shouldShowNudge,
  tryAutoAttachGlasstraceProcessor,
} from "../../../packages/sdk/src/coexistence.js";
import * as otelConfig from "../../../packages/sdk/src/otel-config.js";
import {
  configureOtel,
  resetOtelConfigForTesting,
} from "../../../packages/sdk/src/otel-config.js";
import { SessionManager } from "../../../packages/sdk/src/session.js";
import type { ResolvedConfig } from "../../../packages/sdk/src/env-detection.js";
import {
  initLifecycle,
  setOtelState,
  OtelState,
  getOtelState,
  resetLifecycleForTesting,
} from "../../../packages/sdk/src/lifecycle.js";
import * as consoleCapture from "../../../packages/sdk/src/console-capture.js";

describe("OTel Coexistence Public API", () => {
  beforeEach(() => {
    resetLifecycleForTesting();
    initLifecycle({ logger: vi.fn() });
    vi.restoreAllMocks();
  });

  describe("createGlasstraceSpanProcessor()", () => {
    it("returns a BatchSpanProcessor", () => {
      const processor = createGlasstraceSpanProcessor();
      expect(processor).toBeInstanceOf(BatchSpanProcessor);
    });

    it("creates a processor with the branded symbol", () => {
      const processor = createGlasstraceSpanProcessor();
      // Access the internal exporter to check for the brand
      const bsp = processor as unknown as { _exporter?: unknown };
      const exporter = bsp._exporter as Record<symbol, unknown> | undefined;
      const brand = Symbol.for("glasstrace.exporter");
      expect(exporter?.[brand]).toBe(true);
    });

    it("accepts optional GlasstraceOptions", () => {
      const processor = createGlasstraceSpanProcessor({
        endpoint: "https://custom.glasstrace.dev",
      });
      expect(processor).toBeInstanceOf(BatchSpanProcessor);
    });

    it("works without registerGlasstrace() being called first", () => {
      // Should not throw — creates processor with pending key
      const processor = createGlasstraceSpanProcessor();
      expect(processor).toBeDefined();
    });

    it("registers exporter for key notification", () => {
      const spy = vi.spyOn(otelConfig, "registerExporterForKeyNotification");

      createGlasstraceSpanProcessor();

      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it("propagates verbose option into the underlying GlasstraceExporter", () => {
      // Regression guard for the auto-attach path — when the coexistence
      // path builds processors via this primitive, verbose must still
      // reach GlasstraceExporter so enrichment/export debug logs fire.
      const processor = createGlasstraceSpanProcessor({ verbose: true });
      const bsp = processor as unknown as { _exporter?: { verbose?: boolean } };
      expect(bsp._exporter?.verbose).toBe(true);
    });

    it("defaults verbose to false when the option is omitted", () => {
      const processor = createGlasstraceSpanProcessor();
      const bsp = processor as unknown as { _exporter?: { verbose?: boolean } };
      expect(bsp._exporter?.verbose).toBe(false);
    });
  });

  describe("Nudge messaging", () => {
    it("emitNudgeMessage shows generic example when Sentry is not installed", () => {
      const spy = vi.spyOn(consoleCapture, "sdkLog").mockImplementation(() => {});

      emitNudgeMessage();

      const calls = spy.mock.calls.map((c) => c[1]);
      expect(calls.some((msg) => msg.includes("createGlasstraceSpanProcessor"))).toBe(true);
      expect(calls.some((msg) => msg.includes("auto-attached"))).toBe(true);

      spy.mockRestore();
    });

    it("emitGuidanceMessage warns with instructions via sdkLog", () => {
      const spy = vi.spyOn(consoleCapture, "sdkLog").mockImplementation(() => {});

      emitGuidanceMessage();

      const calls = spy.mock.calls.filter((c) => c[0] === "warn").map((c) => c[1]);
      expect(calls.some((msg) => msg.includes("createGlasstraceSpanProcessor"))).toBe(true);
      expect(calls.some((msg) => msg.includes("could not auto-attach"))).toBe(true);

      spy.mockRestore();
    });
  });

  describe("shouldShowNudge()", () => {
    it("returns true when OTel state is AUTO_ATTACHED", () => {
      setOtelState(OtelState.CONFIGURING);
      setOtelState(OtelState.AUTO_ATTACHED);
      expect(shouldShowNudge()).toBe(true);
    });

    it("returns false when OTel state is PROCESSOR_PRESENT (B-clean)", () => {
      setOtelState(OtelState.CONFIGURING);
      setOtelState(OtelState.PROCESSOR_PRESENT);
      expect(shouldShowNudge()).toBe(false);
    });

    it("returns false when OTel state is OWNS_PROVIDER", () => {
      setOtelState(OtelState.CONFIGURING);
      setOtelState(OtelState.OWNS_PROVIDER);
      expect(shouldShowNudge()).toBe(false);
    });
  });

  describe("tryAutoAttachGlasstraceProcessor() — DISC-493 Issues 2 + 4", () => {
    afterEach(() => {
      otelApi.trace.disable();
    });

    it("v2 provider (simulated Next.js 16 production): injects via _spanProcessors", () => {
      // Next.js 16 production pre-registers a BasicTracerProvider (v2)
      // before instrumentation.ts runs. registerGlasstrace() must
      // auto-attach rather than silently giving up.
      const preRegistered = new BasicTracerProvider();
      otelApi.trace.setGlobalTracerProvider(preRegistered);

      const result = tryAutoAttachGlasstraceProcessor(preRegistered);

      expect(result).not.toBeNull();
      expect(result).not.toBe("already_present");
      if (result && result !== "already_present") {
        expect(result.method).toBe("v2_private");
        expect(result.processor).toBeInstanceOf(BatchSpanProcessor);
      }

      // The branded processor should now be present in the provider's list.
      const multi = (preRegistered as unknown as {
        _activeSpanProcessor: { _spanProcessors: unknown[] };
      })._activeSpanProcessor;
      expect(multi._spanProcessors.length).toBeGreaterThanOrEqual(1);
      expect(isGlasstraceProcessorPresent(preRegistered)).toBe(true);
    });

    it("Sentry-style provider (simulated hoisted import): injects via _spanProcessors", () => {
      // Sentry's @sentry/node provider is a BasicTracerProvider in OTel v2.
      // When @sentry/nextjs's ES module import hoists above
      // registerGlasstrace(), Sentry registers first. Auto-attach must
      // still succeed — same code path as Next 16 production.
      const sentryLike = new BasicTracerProvider({
        spanProcessors: [], // Sentry adds its own processor here in reality
      });
      otelApi.trace.setGlobalTracerProvider(sentryLike);

      const result = tryAutoAttachGlasstraceProcessor(sentryLike);

      expect(result).not.toBeNull();
      expect(result).not.toBe("already_present");
      if (result && result !== "already_present") {
        expect(result.method).toBe("v2_private");
      }
      expect(isGlasstraceProcessorPresent(sentryLike)).toBe(true);
    });

    it("v1-style provider with addSpanProcessor(): uses the public API", () => {
      const addSpy = vi.fn();
      const v1Provider = {
        getTracer: () => ({ constructor: { name: "Tracer" } }),
        addSpanProcessor: addSpy,
      } as unknown as otelApi.TracerProvider;

      const result = tryAutoAttachGlasstraceProcessor(v1Provider);

      expect(result).not.toBeNull();
      expect(result).not.toBe("already_present");
      if (result && result !== "already_present") {
        expect(result.method).toBe("v1_public");
      }
      expect(addSpy).toHaveBeenCalledTimes(1);
      expect(addSpy.mock.calls[0][0]).toBeInstanceOf(BatchSpanProcessor);
    });

    it("is idempotent: duplicate calls do not inject a second processor", () => {
      // Wave 3 invariant: registerGlasstrace() must be safe under
      // duplicate calls (e.g., Next.js HMR re-running instrumentation.ts).
      const provider = new BasicTracerProvider();
      otelApi.trace.setGlobalTracerProvider(provider);

      const first = tryAutoAttachGlasstraceProcessor(provider);
      const second = tryAutoAttachGlasstraceProcessor(provider);

      expect(first).not.toBeNull();
      expect(first).not.toBe("already_present");
      expect(second).toBe("already_present");

      const multi = (provider as unknown as {
        _activeSpanProcessor: { _spanProcessors: unknown[] };
      })._activeSpanProcessor;
      // Only one Glasstrace-branded processor should be present.
      const brand = Symbol.for("glasstrace.exporter");
      const brandedCount = multi._spanProcessors.filter((p) => {
        const exporter = (p as { _exporter?: Record<symbol, unknown> })._exporter;
        return exporter?.[brand] === true;
      }).length;
      expect(brandedCount).toBe(1);
    });

    it("returns 'already_present' when a Glasstrace processor was manually wired", () => {
      // Developer passed createGlasstraceSpanProcessor() into
      // BasicTracerProvider's spanProcessors option directly. The
      // auto-attach path must NOT add a duplicate.
      const manual = createGlasstraceSpanProcessor();
      const provider = new BasicTracerProvider({ spanProcessors: [manual] });
      otelApi.trace.setGlobalTracerProvider(provider);

      const result = tryAutoAttachGlasstraceProcessor(provider);

      expect(result).toBe("already_present");
    });

    it("returns null when provider internals are inaccessible (Scenario C/F)", () => {
      // Datadog-style provider that exposes no injection point.
      const opaque = {
        getTracer: () => ({ constructor: { name: "DDTracer" } }),
      } as unknown as otelApi.TracerProvider;

      const result = tryAutoAttachGlasstraceProcessor(opaque);

      expect(result).toBeNull();
    });
  });

  describe("configureOtel integration — auto-attach end-to-end", () => {
    function testConfig(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
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

    beforeEach(() => {
      otelApi.trace.disable();
      resetOtelConfigForTesting();
    });

    afterEach(() => {
      otelApi.trace.disable();
      otelApi.context.disable();
      otelApi.propagation.disable();
      otelApi.diag.disable();
      resetOtelConfigForTesting();
    });

    it("auto-attaches when an existing v2 provider is pre-registered", async () => {
      const preRegistered = new BasicTracerProvider();
      otelApi.trace.setGlobalTracerProvider(preRegistered);

      vi.spyOn(console, "warn").mockImplementation(() => {});

      await configureOtel(testConfig(), new SessionManager());

      // OTel state should reflect auto-attach, not coexistence failure.
      expect(getOtelState()).toBe(OtelState.AUTO_ATTACHED);
      expect(isGlasstraceProcessorPresent(preRegistered)).toBe(true);
    });

    it("does not auto-attach when no provider is pre-registered (regression guard)", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});

      await configureOtel(testConfig(), new SessionManager());

      // Bare path (Scenario A) should own the provider, not auto-attach.
      expect(getOtelState()).toBe(OtelState.OWNS_PROVIDER);
    });

    it("auto-attach is idempotent across duplicate configureOtel calls", async () => {
      const preRegistered = new BasicTracerProvider();
      otelApi.trace.setGlobalTracerProvider(preRegistered);

      vi.spyOn(console, "warn").mockImplementation(() => {});

      await configureOtel(testConfig(), new SessionManager());
      await configureOtel(testConfig(), new SessionManager());

      // Even after two calls, only one Glasstrace-branded processor.
      const multi = (preRegistered as unknown as {
        _activeSpanProcessor: { _spanProcessors: unknown[] };
      })._activeSpanProcessor;
      const brand = Symbol.for("glasstrace.exporter");
      const brandedCount = multi._spanProcessors.filter((p) => {
        const exporter = (p as { _exporter?: Record<symbol, unknown> })._exporter;
        return exporter?.[brand] === true;
      }).length;
      expect(brandedCount).toBe(1);
    });

    it("reuses createGlasstraceSpanProcessor() for auto-attach (primitive parity)", async () => {
      // Brand parity: the processor auto-attached must carry the same
      // Symbol.for("glasstrace.exporter") brand as one produced by the
      // public primitive. This guarantees idempotence and B-clean
      // detection across versions.
      const preRegistered = new BasicTracerProvider();
      otelApi.trace.setGlobalTracerProvider(preRegistered);

      vi.spyOn(console, "warn").mockImplementation(() => {});

      await configureOtel(testConfig(), new SessionManager());

      const multi = (preRegistered as unknown as {
        _activeSpanProcessor: {
          _spanProcessors: Array<{ _exporter?: Record<symbol, unknown> }>;
        };
      })._activeSpanProcessor;

      const brand = Symbol.for("glasstrace.exporter");
      const attached = multi._spanProcessors.find(
        (p) => p._exporter?.[brand] === true,
      );
      expect(attached).toBeDefined();
      expect(attached).toBeInstanceOf(BatchSpanProcessor);
    });
  });
});
