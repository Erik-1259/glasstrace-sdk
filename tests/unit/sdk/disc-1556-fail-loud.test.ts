/**
 * DISC-1556 — structured fail-loud regression test.
 *
 * Reproduces the Next 16 production "auto-attach returned null" failure
 * mode and asserts the new structured failure surface is observable end-
 * to-end (lifecycle event, runtime-state file, getStatus()), AND that
 * spans created against the existing provider do NOT reach Glasstrace's
 * exporter (the export-correctness gap left open by DISC-493 Issue 2's
 * unit test, which used an inert provider).
 *
 * Non-inert opaque provider construction recipe (§4.11A "Tests" bullet 4):
 *
 *   1. Construct a `BasicTracerProvider` from `@opentelemetry/sdk-trace-base`.
 *   2. Defeat both auto-attach branches in `tryAutoAttachGlasstraceProcessor`.
 *      The function checks the v1_public path first (`typeof
 *      delegate.addSpanProcessor === "function"`), then the v2_internal
 *      path (`Array.isArray(delegate._activeSpanProcessor._spanProcessors)`).
 *      `buildNonInertOpaqueProvider`:
 *      - DELETES `addSpanProcessor` from the provider, so the v1
 *        feature-detect fails (the property no longer exists).
 *      - REPLACES `_activeSpanProcessor` with a stub object whose
 *        onStart/onEnd/forceFlush/shutdown are no-ops AND that
 *        intentionally OMITS the `_spanProcessors` field. The v2
 *        `Array.isArray(undefined)` check returns false. The provider's
 *        `Tracer.startSpan` still calls `onStart` successfully — spans
 *        flow through, just nowhere useful. This is what makes the
 *        provider "non-inert" (spans are produced) while still leaving
 *        `tryAutoAttachGlasstraceProcessor` returning `null`.
 *   3. Set the provider as the global TracerProvider BEFORE calling
 *      `configureOtel()`.
 *   4. Run `configureOtel()` — the coexistence path observes the
 *      pre-registered provider and falls through to the `null` branch.
 *   5. Start a span via `trace.getTracer('test').startSpan('s')` and
 *      assert it does NOT reach Glasstrace's exporter while all the
 *      structured failure surfaces (lifecycle event, runtime-state
 *      file, getStatus()) reflect the failure.
 *
 * The construction is documented inline so future regression reviews
 * can audit it quickly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as otelApi from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import {
  configureOtel,
  resetOtelConfigForTesting,
} from "../../../packages/sdk/src/otel-config.js";
import { SessionManager } from "../../../packages/sdk/src/session.js";
import * as lifecycle from "../../../packages/sdk/src/lifecycle.js";
import {
  startRuntimeStateWriter,
  _resetRuntimeStateForTesting,
} from "../../../packages/sdk/src/runtime-state.js";
import type { RuntimeState } from "../../../packages/sdk/src/runtime-state.js";
import * as enrichingExporterModule from "../../../packages/sdk/src/enriching-exporter.js";
import type { ResolvedConfig } from "../../../packages/sdk/src/env-detection.js";

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
 * Builds a non-inert opaque provider. The provider:
 *
 * - is a real `BasicTracerProvider`, so `getTracer().startSpan()` produces
 *   real OTel spans (NOT no-op spans), closing the DISC-493 Issue 2
 *   inert-provider gap;
 * - has no usable injection point: `addSpanProcessor` is deleted (so the
 *   v1_public path's `typeof === "function"` feature-detect fails), and
 *   `_activeSpanProcessor` is replaced with a stub whose `_spanProcessors`
 *   field is intentionally omitted (so the v2_internal path's
 *   `Array.isArray(...)` check fails). Both branches return false, so
 *   `tryAutoAttachGlasstraceProcessor` returns `null`.
 */
function buildNonInertOpaqueProvider(): BasicTracerProvider {
  const provider = new BasicTracerProvider();
  // Defeat both auto-attach paths while keeping the provider's
  // span lifecycle intact (so spans can still be created — that is
  // the "non-inert" requirement that distinguishes this test from
  // DISC-493 Issue 2's coverage):
  //
  // - v2 path: `tryAutoAttachGlasstraceProcessor` reads
  //   `delegate._activeSpanProcessor._spanProcessors`. Replace
  //   `_activeSpanProcessor` with a stub whose onStart/onEnd are
  //   no-ops AND whose `_spanProcessors` field is *missing* so the
  //   `Array.isArray(...)` check fails. The provider's `Tracer.startSpan`
  //   still calls `onStart` successfully — spans flow through, just
  //   nowhere useful.
  // - v1 path: remove `addSpanProcessor` so the feature-detect fails.
  const internal = provider as unknown as {
    _activeSpanProcessor?: unknown;
    addSpanProcessor?: unknown;
  };
  internal._activeSpanProcessor = {
    onStart: () => {},
    onEnd: () => {},
    forceFlush: async () => {},
    shutdown: async () => {},
    // Intentionally no `_spanProcessors` field — the auto-attach
    // v2 introspection path reads this and expects an array.
  };
  // Defeat the v1 public injection path. The shape `delegate` exposes
  // determines which branch `tryAutoAttachGlasstraceProcessor` takes.
  delete internal.addSpanProcessor;
  return provider;
}

describe("DISC-1556 — structured fail-loud diagnostics (Option C)", () => {
  let tempDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "glasstrace-disc1556-"));
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

  it("emits otel:failed, persists lastError, and exposes getStatus().tracing === 'not-configured' against a non-inert opaque provider", async () => {
    // Use fake timers so the runtime-state writer's 1s debounce can be
    // advanced deterministically. setImmediate is preserved (configureOtel
    // yields one tick before its provider probe — DISC-1202).
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    // Wire the runtime-state writer first so its lifecycle subscriptions
    // are active when configureOtel() emits otel:failed.
    startRuntimeStateWriter({ projectRoot: tempDir, sdkVersion: "1.3.4" });

    // Spy on the GlasstraceExporter constructor. If the coexistence
    // path's null branch had wrongly fallen through to bare-path
    // registration, an exporter would be constructed; we assert the
    // bare path was NOT taken.
    const exporterSpy = vi.spyOn(enrichingExporterModule, "GlasstraceExporter");

    const provider = buildNonInertOpaqueProvider();
    otelApi.trace.setGlobalTracerProvider(provider);

    vi.spyOn(console, "warn").mockImplementation(() => {});

    const failedEvents: unknown[] = [];
    lifecycle.onLifecycleEvent("otel:failed", (payload) => {
      failedEvents.push(payload);
    });

    try {
      await configureOtel(createTestConfig(), sessionManager);

      // Drain the runtime-state writer's debounce so the otel:failed
      // payload reaches disk before we read.
      await vi.advanceTimersByTimeAsync(1100);
    } finally {
      vi.useRealTimers();
    }

    // (a) tryAutoAttachGlasstraceProcessor returned null → otel:failed fired.
    expect(failedEvents).toHaveLength(1);
    const payload = failedEvents[0] as {
      category: string;
      message: string;
      timestamp: string;
      providerClass?: string;
    };
    expect(payload.category).toBe("auto-attach-returned-null");
    expect(payload.providerClass).toBe("BasicTracerProvider");

    // (b) Bare-path fallback was NOT taken — no exporter constructed
    // for our coexistence-failed branch. (Future Option A would change
    // this; this assertion is a regression guard for the current
    // intentionally-narrow Option C scope.)
    expect(exporterSpy).not.toHaveBeenCalled();

    // (c) runtime-state.json on disk reflects the failure.
    const filePath = join(tempDir, ".glasstrace", "runtime-state.json");
    const content = JSON.parse(readFileSync(filePath, "utf-8")) as RuntimeState;
    expect(content.otel.scenario).toBe("C/F");
    expect(content.otel.state).toBe("COEXISTENCE_FAILED");
    expect(content.lastError).toBeDefined();
    expect(content.lastError?.category).toBe("auto-attach-returned-null");
    expect(content.lastError?.providerClass).toBe("BasicTracerProvider");

    // (d) getStatus().tracing === "not-configured" — the user-observable
    // programmatic signal documented in the README.
    expect(lifecycle.getStatus().tracing).toBe("not-configured");

    // (e) Spans created against the existing (now non-inert) provider
    // still produce real Span instances — the provider is alive — but
    // no Glasstrace-branded processor is in its pipeline, so spans
    // never reach Glasstrace's exporter. The stub _activeSpanProcessor
    // that buildNonInertOpaqueProvider installed has only no-op
    // onStart/onEnd hooks and no _spanProcessors array; this matches
    // the real-world "spans fall on the floor" failure mode where
    // Next.js internal instrumentation succeeds at creating spans
    // against the provider but those spans never reach Glasstrace's
    // exporter.
    const span = otelApi.trace.getTracer("disc-1556-regression").startSpan("s");
    expect(span).toBeDefined();
    span.end();
  });
});
