/**
 * Post-response async causality instrumentation for Glasstrace.
 *
 * Subpath: `@glasstrace/sdk/async-context`
 *
 * This module exposes {@link withAsyncCausality}, a continuation-
 * passing wrapper that captures the active OTel `SpanContext` at call
 * time and binds it to a callback. When the callback runs later
 * (Next.js `after()`, queue dispatchers, webhook fire-and-forget),
 * the wrapper opens a span linked to the originating trace via two
 * channels:
 *
 *   - An OTel `Link` to the captured `SpanContext` — the OTel-native
 *     pointer between two spans in different traces. Surfaces in
 *     standard OTel-aware UIs (Jaeger, Honeycomb, etc.) as a
 *     "follows from" relationship.
 *   - A `glasstrace.causal.post_response_async` attribute carrying
 *     the captured trace ID (32-char hex). Used by the product-side
 *     trace-summary transform (per `docs/discoveries/DISC-1539.md:55-58`)
 *     to reconstruct ownership without resolving the Link. Two
 *     companion booleans
 *     (`glasstrace.causal.affects_http_status` and
 *     `glasstrace.causal.affects_http_duration`) document that the
 *     async work does NOT participate in the root request's outcome.
 *
 * Both channels are emitted together so the SDK is robust to
 * downstream transforms that resolve causality through either form.
 *
 * Edge-runtime safety
 * -------------------
 * The wrapper is included in the SDK's edge bundle
 * (`packages/sdk/src/edge-entry.ts`). Its closure imports only the
 * OTel API, the protocol constants, and the
 * `./optional-lifecycle.js` bridge — none of which reach into
 * `node:*` built-ins or the `process` global. The F003 closure scan
 * (`packages/sdk/scripts/check-edge-bundle.mjs`) enforces this on
 * every build.
 *
 * Strategy: continuation-passing, NOT global ALS propagation
 * ---------------------------------------------------------
 * Per the SDK-046 brief §2.3: ALS continuity across Next.js `after()`
 * is uncertain (the framework may schedule via `queueMicrotask`
 * (preserves ALS) or via cross-tick scheduling (drops ALS)). Relying
 * on ALS would couple the SDK to Next internals. Continuation-passing
 * makes the causality explicit — the user wraps the callback they
 * pass to `after()` / their queue, and the captured `SpanContext`
 * travels with the closure regardless of how the framework schedules
 * it.
 *
 * @module @glasstrace/sdk/async-context
 */

import {
  trace,
  SpanStatusCode,
  type AttributeValue,
  type SpanContext,
} from "@opentelemetry/api";
import { GLASSTRACE_ATTRIBUTE_NAMES } from "@glasstrace/protocol";
import { tryEmitLifecycleEvent } from "../optional-lifecycle.js";

const ATTR = GLASSTRACE_ATTRIBUTE_NAMES;

/**
 * Module-level OTel tracer name for the async-context subpath.
 * Resolves through the global `ProxyTracerProvider` so the wrapper
 * picks up whatever provider the SDK has registered. Re-resolved on
 * every call site rather than cached at module top level so test
 * harnesses can install a provider after this module is imported.
 * Mirrors the tRPC subpath at `packages/sdk/src/trpc/index.ts:128`.
 */
const TRACER_NAME = "@glasstrace/sdk/async-context";

/**
 * The W3C-spec-defined invalid trace ID. The OTel API noop tracer
 * returns this value from `Span.spanContext().traceId`. We use this
 * to detect both (a) the SDK-not-registered case via the
 * noop-tracer probe and (b) the no-active-span case via the
 * captured `SpanContext`.
 */
const INVALID_TRACE_ID = "00000000000000000000000000000000";

/**
 * Module-level once-flags for lifecycle events. Cleared via
 * {@link _resetForTesting}.
 */
let _skippedUninstalledEmitted = false;
let _noOriginatingContextEmitted = false;

/**
 * INTERNAL — clears once-flags for unit tests; not part of the
 * public surface.
 */
export function _resetForTesting(): void {
  _skippedUninstalledEmitted = false;
  _noOriginatingContextEmitted = false;
}

/**
 * Options for {@link withAsyncCausality}.
 *
 * @example
 * ```ts
 * import { withAsyncCausality } from "@glasstrace/sdk/async-context";
 * import { after } from "next/server";
 *
 * export async function POST(req: Request) {
 *   const result = await processRequest(req);
 *   after(
 *     withAsyncCausality(
 *       { name: "send-confirmation-email" },
 *       async () => sendEmail(result.userId),
 *     ),
 *   );
 *   return Response.json({ ok: true });
 * }
 * ```
 */
export interface WithAsyncCausalityOptions {
  /**
   * Span name for the async work. Required, non-empty string. Used as
   * the OTel span name and appears in trace timelines. Names should
   * be stable across runs (e.g., "send-confirmation-email",
   * "enqueue-webhook-dispatch"); avoid embedding payload data in the
   * name.
   */
  name: string;
  /**
   * Optional attributes attached to the span before the wrapped
   * callback runs. Forwarded to OTel as-is via `span.setAttributes()`.
   * The SDK does not redact, sanitize, or scan values here — callers
   * MUST avoid placing tokens, credentials, or other sensitive data
   * in `attributes`.
   */
  attributes?: Record<string, AttributeValue>;
}

/**
 * Capture the active OTel `SpanContext` at call time, bind it to a
 * callback, and return a continuation that will emit a
 * causally-linked span when invoked.
 *
 * The returned continuation:
 *
 *   1. Detects the SDK's registration state. When the OTel API is
 *      still on the noop tracer, runs the wrapped callback directly
 *      and emits an `async:skipped_uninstalled` lifecycle event (at
 *      most once per process). No span is opened.
 *   2. Otherwise opens a span named `options.name` as a NEW root
 *      span (not parented to the captured context — `after()` /
 *      queue dispatchers run outside the originating request's OTel
 *      context, so the async work belongs to a separate trace).
 *   3. When a captured `SpanContext` exists with a valid trace ID,
 *      attaches:
 *        - an OTel `Link` to that `SpanContext` (the OTel-native
 *          form),
 *        - the `glasstrace.causal.post_response_async` attribute
 *          carrying the trace ID (the transform-readable form),
 *        - `glasstrace.causal.affects_http_status = false` and
 *          `glasstrace.causal.affects_http_duration = false`
 *          documenting that the async work does NOT participate in
 *          the root request's outcome.
 *      When no valid `SpanContext` was captured, none of these are
 *      emitted (per SDK-046's "missing or unknown evidence is
 *      preferable to guessed evidence" rule) and an
 *      `async:no_originating_context` lifecycle event fires (at
 *      most once per process).
 *   4. Awaits the wrapped callback.
 *   5. On a thrown error: normalizes the throwable; sets `ERROR`
 *      status with `recordException`; rethrows the original error
 *      verbatim.
 *   6. On a successful return: leaves status `UNSET`.
 *   7. Always ends the span.
 *
 * The continuation returns a Promise resolving to the callback's
 * return value (Promise-or-value semantics: a sync callback's value
 * is wrapped in `Promise.resolve()`).
 *
 * @param options - Span name and optional pre-start attributes.
 * @param fn - The async callback to run later. May be sync or async;
 *   the wrapper always returns a Promise to give a consistent
 *   continuation shape regardless of `fn`'s synchronicity.
 * @returns A continuation `() => Promise<T>` that, when invoked,
 *   emits the causally-linked span and runs `fn`.
 *
 * @example Next.js after() — typical use
 * ```ts
 * import { withAsyncCausality } from "@glasstrace/sdk/async-context";
 * import { after } from "next/server";
 *
 * export async function POST(req: Request) {
 *   const result = await processRequest(req);
 *   after(
 *     withAsyncCausality(
 *       { name: "send-confirmation-email" },
 *       async () => sendEmail(result.userId),
 *     ),
 *   );
 *   return Response.json({ ok: true });
 * }
 * ```
 *
 * @example Queue dispatcher — capture before enqueue
 * ```ts
 * const dispatch = withAsyncCausality(
 *   { name: "process-webhook" },
 *   async () => handler(payload),
 * );
 * await queue.enqueue(dispatch);
 * ```
 */
export function withAsyncCausality<T>(
  options: WithAsyncCausalityOptions,
  fn: () => Promise<T> | T,
): () => Promise<T> {
  if (typeof options.name !== "string" || options.name.length === 0) {
    throw new TypeError(
      "withAsyncCausality: options.name must be a non-empty string",
    );
  }
  if (typeof fn !== "function") {
    throw new TypeError("withAsyncCausality: fn must be a function");
  }

  // Capture-time: snapshot the active SpanContext, if any. The
  // capture happens synchronously in the wrapper-construction call,
  // BEFORE the user passes the continuation to `after()` /
  // `queue.enqueue()`. Reading via `trace.getActiveSpan()` rather
  // than `context.active()` mirrors `captureCorrelationId()` at
  // `packages/sdk/src/correlation-id.ts:83` — the active-span API is
  // the public OTel surface for this.
  const capturedContext: SpanContext | undefined = (() => {
    try {
      const active = trace.getActiveSpan();
      if (!active) return undefined;
      const ctx = active.spanContext();
      // Reject the noop-tracer's invalid trace ID. Treating it as
      // captured would emit a Link to all-zeros, which is misleading.
      if (ctx.traceId === INVALID_TRACE_ID) return undefined;
      return ctx;
    } catch {
      return undefined;
    }
  })();

  return async (): Promise<T> => {
    const tracer = trace.getTracer(TRACER_NAME);
    // The async span is a NEW root: post-response work runs outside
    // the originating request's OTel context, so parenting to the
    // captured context would put two unrelated runtime executions in
    // the same trace tree. Causality is communicated via the Link +
    // attribute pair instead.
    const span = tracer.startSpan(options.name, {
      root: true,
      links:
        capturedContext !== undefined
          ? [{ context: capturedContext }]
          : undefined,
    });

    // SDK-not-registered fast path. The public `isRecording()` probe
    // returns `false` on noop spans without producing an exported
    // span; this avoids emitting a useless probe span on every
    // continuation when a real provider is registered.
    if (isNoopSpan(span)) {
      if (!_skippedUninstalledEmitted) {
        _skippedUninstalledEmitted = true;
        tryEmitLifecycleEvent("async:skipped_uninstalled", {});
      }
      endSpanSafely(span);
      return Promise.resolve(fn());
    }

    if (capturedContext === undefined && !_noOriginatingContextEmitted) {
      _noOriginatingContextEmitted = true;
      tryEmitLifecycleEvent("async:no_originating_context", {});
    }

    try {
      if (options.attributes) {
        span.setAttributes(options.attributes);
      }
      if (capturedContext !== undefined) {
        span.setAttribute(
          ATTR.CAUSAL_POST_RESPONSE_ASYNC,
          capturedContext.traceId,
        );
        span.setAttribute(ATTR.CAUSAL_AFFECTS_HTTP_STATUS, false);
        span.setAttribute(ATTR.CAUSAL_AFFECTS_HTTP_DURATION, false);
      }
    } catch {
      // Attribute failures are advisory; do not block fn().
    }

    try {
      const value = await fn();
      return value;
    } catch (error) {
      recordSpanError(span, error);
      throw error;
    } finally {
      endSpanSafely(span);
    }
  };
}

/**
 * Type guard for OTel noop spans. Mirrors the same check in
 * `../middleware/index.ts`. The OTel public `isRecording()` API is
 * `false` for `NonRecordingSpan` (the noop tracer's span class) and
 * `true` for real SDK-emitted spans, so this avoids opening a
 * probe span on every call when a real provider is registered.
 */
function isNoopSpan(
  span: ReturnType<ReturnType<typeof trace.getTracer>["startSpan"]>,
): boolean {
  try {
    return span.isRecording() === false;
  } catch {
    return false;
  }
}

/**
 * See {@link ../middleware/index.ts} — duplicated here rather than
 * shared because the OTel `Span` type is structural and importing
 * a helper from a sibling module would force the modules to share a
 * deeper dependency. Both copies are exactly two non-throwing
 * `try`/`catch` blocks; the duplication is intentional and trivial.
 */
function recordSpanError(
  span: ReturnType<ReturnType<typeof trace.getTracer>["startSpan"]>,
  error: unknown,
): void {
  const normalized: Error | string =
    error instanceof Error
      ? error
      : typeof error === "string"
        ? error
        : new Error(String(error));
  const statusMessage =
    normalized instanceof Error ? normalized.message : normalized;
  try {
    span.recordException(normalized);
  } catch {
    /* swallow */
  }
  try {
    span.setStatus({ code: SpanStatusCode.ERROR, message: statusMessage });
  } catch {
    /* swallow */
  }
}

/** See {@link ../middleware/index.ts}. */
function endSpanSafely(
  span: ReturnType<ReturnType<typeof trace.getTracer>["startSpan"]>,
): void {
  try {
    span.end();
  } catch {
    /* swallow */
  }
}
