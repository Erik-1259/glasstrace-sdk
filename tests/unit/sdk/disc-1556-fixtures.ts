/**
 * Shared test fixtures for DISC-1556 regression coverage.
 *
 * Helpers in this module are imported by both
 * `disc-1556-fail-loud.test.ts` (Wave 11 Option C) and
 * `disc-1556-option-a.test.ts` (Wave 12 Option A). Keeping them in a
 * non-`*.test.ts` file is deliberate: Vitest's discovery glob is
 * `tests/**\/*.test.ts`, so importing from a `*.test.ts` module would
 * re-execute the imported file's `describe`/`hook` registrations as a
 * side effect, duplicating tests across workers and risking
 * order-dependent failures (Codex / Copilot caught this on PR #233).
 *
 * Expected callers: SDK unit tests only. Not exported from the SDK
 * package and not intended for downstream consumption.
 */

import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";

/**
 * Build a non-inert opaque provider that defeats both
 * `tryAutoAttachGlasstraceProcessor` injection paths while keeping the
 * provider's span lifecycle intact (so `getTracer().startSpan()` still
 * produces real OTel spans). This is the test fixture that closes the
 * DISC-493 Issue 2 inert-provider coverage gap and the DISC-1556
 * regression-test contract carried forward by Wave 11 §7 step 2.
 *
 * The provider:
 *
 * - is a real `BasicTracerProvider`, so `getTracer().startSpan()`
 *   produces real OTel spans (NOT no-op spans);
 * - has no usable injection point: `addSpanProcessor` is deleted (so
 *   the v1_public path's `typeof === "function"` feature-detect
 *   fails), and `_activeSpanProcessor` is replaced with a stub whose
 *   `_spanProcessors` field is intentionally omitted (so the
 *   v2_internal path's `Array.isArray(...)` check fails). Both
 *   branches return false, so `tryAutoAttachGlasstraceProcessor`
 *   returns `null`.
 */
export function buildNonInertOpaqueProvider(): BasicTracerProvider {
  const provider = new BasicTracerProvider();
  // Defeat both auto-attach paths while keeping the provider's span
  // lifecycle intact (so spans can still be created — that is the
  // "non-inert" requirement that distinguishes this fixture from
  // DISC-493 Issue 2's coverage):
  //
  // - v2 path: `tryAutoAttachGlasstraceProcessor` reads
  //   `delegate._activeSpanProcessor._spanProcessors`. Replace
  //   `_activeSpanProcessor` with a stub whose onStart/onEnd are
  //   no-ops AND whose `_spanProcessors` field is *missing* so the
  //   `Array.isArray(...)` check fails. The provider's
  //   `Tracer.startSpan` still calls `onStart` successfully — spans
  //   flow through, just nowhere useful.
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
    // Intentionally no `_spanProcessors` field — the auto-attach v2
    // introspection path reads this and expects an array.
  };
  // Defeat the v1 public injection path. The shape `delegate` exposes
  // determines which branch `tryAutoAttachGlasstraceProcessor` takes.
  delete internal.addSpanProcessor;
  return provider;
}
