/**
 * DISC-1556 Option A — structural proxy classification regression tests.
 *
 * Reproduces the Next 16 production failure mode the conductor recon at
 * `/tmp/recon-option-A-DISC-1556.md` documented:
 *
 *   - The bundler renames `@opentelemetry/api`'s `ProxyTracerProvider`
 *     and `ProxyTracer` constructors to short minified names
 *     (`eN`/`ek`/`e_`/`ew`).
 *   - The SDK's previous `probeTracer.constructor.name !== "ProxyTracer"`
 *     check returned `true` against the SDK's own bundled proxy.
 *   - Coexistence/auto-attach then ran against a proxy with no real
 *     delegate; spans were silently lost.
 *
 * The fix replaces the constructor-name check at both probe sites with
 * the structural classifiers in `packages/sdk/src/proxy-detection.ts`.
 * These tests cover:
 *
 *   (a) Minified-constructor regression: synthetic proxy with names
 *       `eN`/`ek` matching the recon's evidence; assert helpers + the
 *       `configureOtel` probe path classify correctly.
 *   (b) `configureOtel` regression with a structurally-shaped proxy:
 *       assert it does NOT enter `COEXISTENCE_FAILED`.
 *   (c1) Real attachable non-proxy via `BasicTracerProvider`: assert
 *       coexistence path attaches via the v1 public path and reaches
 *       `OtelState.AUTO_ATTACHED`.
 *   (c2) Real opaque (non-attachable) non-proxy via Wave 11's
 *       `buildNonInertOpaqueProvider`: assert the C/F branch fires AND
 *       Wave 11's structured-failure surfaces (`lastError`,
 *       `getStatus().tracing === "not-configured"`, escalated
 *       production-mode log) all fire correctly — proves Option A does
 *       not regress Wave 11's Option C.
 *   (e) Tracer ownership disambiguator (three subcases): `_provider`
 *       absent, `_provider === undefined`, `_provider` pointing at a
 *       different provider. All yield `isProxyTracer === false`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as otelApi from "@opentelemetry/api";
import * as otelSdk from "@opentelemetry/sdk-trace-base";
import {
  isProxyTracer,
  isProxyTracerProvider,
} from "../../../packages/sdk/src/proxy-detection.js";
import {
  configureOtel,
  resetOtelConfigForTesting,
} from "../../../packages/sdk/src/otel-config.js";
import { SessionManager } from "../../../packages/sdk/src/session.js";
import * as lifecycle from "../../../packages/sdk/src/lifecycle.js";
import { OtelState } from "../../../packages/sdk/src/lifecycle.js";
import {
  startRuntimeStateWriter,
  _resetRuntimeStateForTesting,
} from "../../../packages/sdk/src/runtime-state.js";
import type { RuntimeState } from "../../../packages/sdk/src/runtime-state.js";
import type { ResolvedConfig } from "../../../packages/sdk/src/env-detection.js";
import { buildNonInertOpaqueProvider } from "./disc-1556-fixtures.js";

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

/**
 * Builds a synthetic provider/tracer pair whose runtime constructor
 * names match the recon evidence (`eN`/`ek`) but whose structural shape
 * matches `@opentelemetry/api`'s `ProxyTracerProvider` and `ProxyTracer`.
 *
 * The constructor names are forced to the recon's exact minified names
 * so the regression test bytewise-asserts that a future bundler change
 * which re-introduces constructor-name-based classification cannot
 * sneak through.
 */
function buildMinifiedProxyPair(): {
  provider: object;
  tracer: object;
} {
  // Force the constructor name to "eN" — the recon's minified
  // `ProxyTracerProvider` name.
  const ProviderCtor = { eN: class { } }.eN;
  // Force the constructor name to "ek" — the recon's minified
  // `ProxyTracer` name.
  const TracerCtor = { ek: class { } }.ek;

  const provider = new ProviderCtor() as Record<string, unknown>;
  const tracer = new TracerCtor() as Record<string, unknown>;

  // ProxyTracerProvider's four prototype methods.
  provider.getTracer = () => tracer;
  provider.getDelegate = () => null;
  provider.setDelegate = () => { };
  provider.getDelegateTracer = () => null;

  // ProxyTracer's three prototype methods + the `_provider` ownership
  // pointer back at the provider.
  tracer._getTracer = () => null;
  tracer.startSpan = () => null;
  tracer.startActiveSpan = () => null;
  tracer._provider = provider;

  return { provider, tracer };
}

describe("DISC-1556 Option A — structural proxy classification", () => {
  describe("isProxyTracerProvider", () => {
    it("(a) returns true for a structurally-shaped proxy with minified constructor name 'eN'", () => {
      const { provider } = buildMinifiedProxyPair();
      // Sanity-check the bytewise constructor name matches the recon
      // evidence — a future regression that loses the structural check
      // and reverts to constructor-name comparison would fail here.
      expect(provider.constructor.name).toBe("eN");
      expect(isProxyTracerProvider(provider)).toBe(true);
    });

    it("returns false for null / undefined / non-object inputs", () => {
      expect(isProxyTracerProvider(null)).toBe(false);
      expect(isProxyTracerProvider(undefined)).toBe(false);
      expect(isProxyTracerProvider(42)).toBe(false);
      expect(isProxyTracerProvider("ProxyTracerProvider")).toBe(false);
      expect(isProxyTracerProvider(true)).toBe(false);
    });

    it("(c1) returns false for a real BasicTracerProvider", () => {
      const provider = new otelSdk.BasicTracerProvider();
      expect(isProxyTracerProvider(provider)).toBe(false);
    });

    it("returns false when one of the four prototype methods is missing", () => {
      const partial = {
        getTracer: () => null,
        getDelegate: () => null,
        setDelegate: () => { },
        // getDelegateTracer intentionally absent
      };
      expect(isProxyTracerProvider(partial)).toBe(false);
    });

    it("returns false when a method-named property is not a function", () => {
      const malformed = {
        getTracer: "not-a-function",
        getDelegate: () => null,
        setDelegate: () => { },
        getDelegateTracer: () => null,
      };
      expect(isProxyTracerProvider(malformed)).toBe(false);
    });
  });

  describe("isProxyTracer", () => {
    it("(a) returns true for a structurally-shaped tracer with minified constructor name 'ek' and matching ownership", () => {
      const { provider, tracer } = buildMinifiedProxyPair();
      expect(tracer.constructor.name).toBe("ek");
      expect(isProxyTracer(tracer, provider)).toBe(true);
    });

    it("returns false for null / undefined / non-object inputs", () => {
      const { provider } = buildMinifiedProxyPair();
      expect(isProxyTracer(null, provider)).toBe(false);
      expect(isProxyTracer(undefined, provider)).toBe(false);
      expect(isProxyTracer(42, provider)).toBe(false);
      expect(isProxyTracer("ProxyTracer", provider)).toBe(false);
    });

    it("(e1) returns false when _provider property is absent entirely", () => {
      const { provider } = buildMinifiedProxyPair();
      const tracer: Record<string, unknown> = {
        _getTracer: () => null,
        startSpan: () => null,
        startActiveSpan: () => null,
        // _provider intentionally absent
      };
      expect("_provider" in tracer).toBe(false);
      expect(isProxyTracer(tracer, provider)).toBe(false);
    });

    it("(e2) returns false when _provider is present but undefined", () => {
      const { provider } = buildMinifiedProxyPair();
      const tracer = {
        _getTracer: () => null,
        startSpan: () => null,
        startActiveSpan: () => null,
        _provider: undefined,
      };
      expect("_provider" in tracer).toBe(true);
      expect(isProxyTracer(tracer, provider)).toBe(false);
    });

    it("(e3) returns false when _provider points at a different provider object", () => {
      const { tracer } = buildMinifiedProxyPair();
      const otherProvider = {
        getTracer: () => null,
        getDelegate: () => null,
        setDelegate: () => { },
        getDelegateTracer: () => null,
      };
      // tracer._provider points at the provider that produced it, NOT
      // `otherProvider` — so the ownership disambiguator should reject
      // the match.
      expect(isProxyTracer(tracer, otherProvider)).toBe(false);
    });

    it("returns false when one of the three prototype methods is missing", () => {
      const { provider } = buildMinifiedProxyPair();
      const partial = {
        _getTracer: () => null,
        startSpan: () => null,
        // startActiveSpan intentionally absent
        _provider: provider,
      };
      expect(isProxyTracer(partial, provider)).toBe(false);
    });
  });

  describe("configureOtel regression (load-bearing — DISC-1556)", () => {
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

    it("(b) takes the normal registration path when the global provider is the SDK's own bundler-minified proxy", async () => {
      // Simulate Next 16's failure mode: the global TracerProvider is a
      // proxy whose constructor name has been minified, but its
      // structural shape matches `@opentelemetry/api`'s `ProxyTracerProvider`.
      //
      // We can't `setGlobalTracerProvider(...)` with a bare object
      // (the OTel API validates the shape), so instead we stub
      // `otelApi.trace.getTracerProvider` directly. The SDK code under
      // test reads `otelApi.trace.getTracerProvider()` and then calls
      // `getTracer()` on the result — the stubbed pair satisfies both.
      const { provider, tracer } = buildMinifiedProxyPair();

      vi.spyOn(otelApi.trace, "getTracerProvider").mockReturnValue(
        provider as unknown as otelApi.TracerProvider,
      );
      // The provider's `getTracer` returns our minified-name tracer,
      // matching the recon's "Provider Shape" snapshot.
      const getTracerSpy = vi.spyOn(provider as { getTracer: () => unknown }, "getTracer");
      getTracerSpy.mockReturnValue(tracer);

      vi.spyOn(console, "warn").mockImplementation(() => { });
      vi.spyOn(console, "info").mockImplementation(() => { });

      await configureOtel(createTestConfig(), sessionManager);

      // Pre-DISC-1556: this assertion would fail because the
      // constructor-name check would misclassify the minified proxy as
      // an external provider, the SDK would enter the coexistence
      // path, auto-attach would return null, and the OtelState would
      // become COEXISTENCE_FAILED.
      //
      // Post-fix: the structural classifier recognizes the minified
      // proxy as our own, so the SDK takes the normal registration
      // path (Scenario A) and reaches OWNS_PROVIDER.
      expect(lifecycle.getOtelState()).toBe(OtelState.OWNS_PROVIDER);
    });
  });

  describe("configureOtel coexistence path with real non-proxy providers", () => {
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

    it("(c1) real attachable BasicTracerProvider — coexistence path reaches AUTO_ATTACHED via v1_public", async () => {
      // BasicTracerProvider exposes `addSpanProcessor`, so the v1
      // public auto-attach path succeeds. The structural classifier
      // correctly recognizes BasicTracerProvider as NOT a proxy,
      // so the coexistence path runs against the real provider.
      const existingProvider = new otelSdk.BasicTracerProvider();
      otelApi.trace.setGlobalTracerProvider(existingProvider);

      // Sanity check: the structural classifier sees the real provider
      // as non-proxy.
      expect(isProxyTracerProvider(existingProvider)).toBe(false);

      vi.spyOn(console, "warn").mockImplementation(() => { });
      vi.spyOn(console, "info").mockImplementation(() => { });

      await configureOtel(createTestConfig(), sessionManager);

      expect(lifecycle.getOtelState()).toBe(OtelState.AUTO_ATTACHED);
    });
  });

  describe("configureOtel C/F branch — Wave 11 Option C surfaces still fire", () => {
    let tempDir: string;
    let sessionManager: SessionManager;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "glasstrace-disc1556-opta-"));
      otelApi.trace.disable();
      lifecycle.resetLifecycleForTesting();
      _resetRuntimeStateForTesting();
      lifecycle.initLifecycle({ logger: vi.fn() });
      resetOtelConfigForTesting();
      vi.restoreAllMocks();
      sessionManager = new SessionManager();
    });

    afterEach(async () => {
      _resetRuntimeStateForTesting();
      lifecycle.resetLifecycleForTesting();
      resetOtelConfigForTesting();
      otelApi.trace.disable();
      otelApi.context.disable();
      otelApi.propagation.disable();
      otelApi.diag.disable();
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    });

    it("(c2) real opaque non-proxy via buildNonInertOpaqueProvider — isProxyTracerProvider === false AND C/F surfaces fire", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

      startRuntimeStateWriter({ projectRoot: tempDir, sdkVersion: "1.3.4" });

      const provider = buildNonInertOpaqueProvider();

      // Structural classifier correctly recognizes the real provider
      // (with a custom shape that defeats both auto-attach branches)
      // as NOT a proxy — so the SDK enters the coexistence path and
      // exercises the C/F branch Wave 11's Option C hardened.
      expect(isProxyTracerProvider(provider)).toBe(false);

      otelApi.trace.setGlobalTracerProvider(provider);

      vi.spyOn(console, "warn").mockImplementation(() => { });
      vi.spyOn(console, "info").mockImplementation(() => { });

      const failedEvents: unknown[] = [];
      lifecycle.onLifecycleEvent("otel:failed", (payload) => {
        failedEvents.push(payload);
      });

      try {
        await configureOtel(createTestConfig(), sessionManager);
        await vi.advanceTimersByTimeAsync(1100);
      } finally {
        vi.useRealTimers();
      }

      // Wave 11 Option C surfaces — these should all still fire. A
      // regression that breaks the C/F branch (e.g. by mis-classifying
      // a real non-proxy as a proxy and skipping the coexistence path)
      // would fail these assertions.
      expect(lifecycle.getOtelState()).toBe(OtelState.COEXISTENCE_FAILED);
      expect(failedEvents).toHaveLength(1);
      const payload = failedEvents[0] as {
        category: string;
        providerClass?: string;
      };
      expect(payload.category).toBe("auto-attach-returned-null");
      expect(payload.providerClass).toBe("BasicTracerProvider");

      const filePath = join(tempDir, ".glasstrace", "runtime-state.json");
      const content = JSON.parse(readFileSync(filePath, "utf-8")) as RuntimeState;
      expect(content.otel.scenario).toBe("C/F");
      expect(content.lastError?.category).toBe("auto-attach-returned-null");

      expect(lifecycle.getStatus().tracing).toBe("not-configured");
    });
  });
});
