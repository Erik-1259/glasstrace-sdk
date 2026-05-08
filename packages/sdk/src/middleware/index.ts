/**
 * Request-middleware-ownership instrumentation for Glasstrace.
 *
 * Subpath: `@glasstrace/sdk/middleware`
 *
 * This module exposes {@link tracedRequestMiddleware}, a wrapper that
 * turns a Next.js `middleware.ts` function (or any generic
 * `Request → Response`-shaped handler) into a span-emitting middleware
 * function. Each invocation opens a child span and tags it with the
 * `glasstrace.causal.middleware_for_request` causal-evidence attribute
 * carrying the originating request's normalized path so the
 * product-side trace-summary transform can link the middleware span
 * to the owning HTTP request trace (DISC-1537 / SDK-046).
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
 * Causal-evidence form
 * --------------------
 * The wrapper attaches the originating request path as a span
 * attribute (`glasstrace.causal.middleware_for_request`). It does NOT
 * emit an OTel `Link`. Reasons:
 *
 *   1. The Next.js Edge runtime does not propagate AsyncLocalStorage
 *      into `middleware.ts`, so there is no in-process
 *      `SpanContext` to link to in that environment. Attribute-only
 *      causality works in both Node and Edge runtimes; a Link would
 *      degrade to a no-op (no parent context) on Edge.
 *   2. The product-side trace-summary transform reconstructs
 *      ownership from `glasstrace.causal.*` attributes per
 *      DISC-1539 §51-58; it does not require a Link.
 *
 * Invariants
 * ----------
 *
 *   - The wrapped function preserves the user's call-site type so
 *     Next.js's `middleware` export contract (`(req: NextRequest) =>
 *     NextResponse | Response`) flows through unchanged.
 *   - The middleware span MUST NOT overwrite `glasstrace.route`,
 *     `glasstrace.http.status_code`, or `glasstrace.http.duration_ms`
 *     on the parent HTTP span — root-request semantics are owned by
 *     the enriching exporter (`packages/sdk/src/enriching-exporter.ts`).
 *   - On a thrown handler error: span ends with `ERROR` status +
 *     `recordException`; rethrows. The exception is normalized to
 *     `Error | string` first so non-Error throwables (number, plain
 *     object) do not crash `recordException`.
 *   - Always ends the span (`finally`), even on `throw`.
 *
 * @module @glasstrace/sdk/middleware
 */

import {
  trace,
  SpanStatusCode,
  type AttributeValue,
} from "@opentelemetry/api";
import { GLASSTRACE_ATTRIBUTE_NAMES } from "@glasstrace/protocol";
import { tryEmitLifecycleEvent } from "../optional-lifecycle.js";

const ATTR = GLASSTRACE_ATTRIBUTE_NAMES;

/**
 * Module-level OTel tracer name for the middleware subpath. Resolves
 * through the global `ProxyTracerProvider` so the wrapper picks up
 * whatever provider the SDK has detected or registered (the SDK's
 * own enriching exporter, Sentry's processor in coexistence mode,
 * etc.). Re-resolved on every call site rather than cached at module
 * top level so test harnesses can install a provider after this
 * module is imported. This mirrors the tRPC subpath at
 * `packages/sdk/src/trpc/index.ts:128`.
 */
const TRACER_NAME = "@glasstrace/sdk/middleware";

/**
 * Module-level once-flag for the
 * `middleware:skipped_uninstalled` lifecycle event. The flag is
 * exported via {@link _resetForTesting} so unit tests can re-arm it
 * between scenarios.
 */
let _skippedUninstalledEmitted = false;

/**
 * INTERNAL — clears the once-flag for the
 * `middleware:skipped_uninstalled` lifecycle event. Invoked by
 * Vitest fixtures only; not part of the public surface.
 */
export function _resetForTesting(): void {
  _skippedUninstalledEmitted = false;
}

/**
 * Permissive structural bound for a request-middleware function. The
 * shape is the intersection of Next.js's `middleware.ts` export
 * (`(req: NextRequest, event?: NextFetchEvent) => NextResponse |
 * Response | Promise<NextResponse | Response> | undefined`) and the
 * generic Web Fetch API (`(req: Request, ...rest: any[]) => Response
 * | Promise<Response>`). The parameter list is typed with `any[]` for
 * the rest position so any caller-narrowed signature is assignable
 * without the wrapper having to import `next/server` types.
 *
 * Exported so consumers can reference it for type-inference assertions
 * (e.g., proving a strongly-typed handler fits the bound). The
 * runtime contract is fixed by the Web Fetch API: the first argument
 * is a `Request`-shaped object and the return is a `Response`-shaped
 * value (or a Promise of one).
 */
// The `any[]` in the rest position is load-bearing: a tighter bound
// (e.g. `unknown[]`) would reject `(req, event?) => ...` because
// `unknown` cannot be passed in the contravariant parameter position
// without an explicit cast at every call site. Capturing
// `H extends RequestMiddlewareFunction` preserves caller types
// through the wrapper's `: H` return.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RequestMiddlewareFunction = (req: any, ...rest: any[]) => unknown;

/**
 * Options for {@link tracedRequestMiddleware}.
 *
 * @example
 * ```ts
 * import { tracedRequestMiddleware } from "@glasstrace/sdk/middleware";
 * import type { NextRequest } from "next/server";
 *
 * export const middleware = tracedRequestMiddleware(
 *   { name: "auth-middleware", attributes: { "auth.required": true } },
 *   async (req: NextRequest) => {
 *     // … your auth logic here …
 *     return NextResponse.next();
 *   },
 * );
 * ```
 */
export interface TracedRequestMiddlewareOptions {
  /**
   * Span name. Required, non-empty string. Used as the OTel span name
   * and appears in trace timelines. Names should be stable across
   * runs so the product-side transform can reason about middleware
   * identity (e.g., "auth-middleware", "rate-limiter"); avoid
   * embedding request data in the name.
   */
  name: string;
  /**
   * Optional attributes attached to the span before the wrapped
   * handler runs. Forwarded to OTel as-is via `span.setAttributes()`.
   * The SDK does not redact, sanitize, or scan values here — callers
   * MUST avoid placing tokens, credentials, or other sensitive data
   * in `attributes`.
   *
   * Sensitive request/response data is captured through gated SDK
   * paths (e.g., `glasstrace.error.response_body`), not through this
   * surface.
   */
  attributes?: Record<string, AttributeValue>;
}

/**
 * Extract the originating request path from a Fetch-API `Request` or
 * `NextRequest`-shaped object. Preference order:
 *
 *   1. `req.nextUrl.pathname` — present on `NextRequest`. This is
 *      Next.js's parsed URL and is the most reliable source on the
 *      Next.js Edge runtime, where `req.url` may be a relative form
 *      depending on framework-internal rewrites.
 *   2. `new URL(req.url).pathname` — present on the generic Fetch
 *      `Request`. The URL constructor accepts an absolute URL; if
 *      `req.url` is relative we synthesize a base of
 *      `http://localhost` to make parsing succeed (the host is
 *      discarded — only the path is used).
 *   3. `undefined` — when neither field exists or both fail to
 *      parse, the wrapper omits the causal attribute rather than
 *      emitting a guessed value, per the SDK-046 product brief's
 *      "missing or unknown evidence is preferable to guessed
 *      evidence" rule (DISC-1537 / DISC-1539 product handoff).
 *
 * This function never throws.
 */
function extractRequestPath(req: unknown): string | undefined {
  if (req === null || typeof req !== "object") return undefined;
  try {
    // NextRequest.nextUrl — already a URL-like object with .pathname.
    const nextUrl = (req as { nextUrl?: unknown }).nextUrl;
    if (nextUrl !== null && typeof nextUrl === "object") {
      const pathname = (nextUrl as { pathname?: unknown }).pathname;
      if (typeof pathname === "string" && pathname.length > 0) {
        return pathname;
      }
    }
    // Fall back to req.url. On Edge / Web Fetch this is always
    // absolute; on some Node frameworks it can be relative
    // (`/api/foo?x=1`), so synthesize a base if the URL constructor
    // throws on the absolute parse.
    const url = (req as { url?: unknown }).url;
    if (typeof url === "string" && url.length > 0) {
      try {
        return new URL(url).pathname;
      } catch {
        try {
          return new URL(url, "http://localhost").pathname;
        } catch {
          return undefined;
        }
      }
    }
  } catch {
    // Defensive: any unexpected shape failure returns undefined.
  }
  return undefined;
}

/**
 * Sentinel trace ID returned by the OTel API's noop tracer
 * (`@opentelemetry/api`'s `NonRecordingSpan`). Per the OTel
 * specification's noop semantics, the noop SpanContext exposes
 * `traceId === "00000000000000000000000000000000"`. Used by
 * {@link isNoopSpan} below to discriminate "no provider registered"
 * from "real provider whose sampler dropped this span" — the latter
 * also returns `isRecording() === false` but produces a valid
 * 32-char hex trace ID because the SDK assigns one before sampler
 * invocation for propagation purposes.
 */
const INVALID_TRACE_ID = "00000000000000000000000000000000";

/**
 * Type guard for OTel spans created by the noop tracer. The OTel
 * API's noop SpanContext returns the all-zeros sentinel for
 * `traceId`; real SDK-emitted spans always have a valid 32-char hex
 * trace ID (even when a sampler decided to DROP the span). Using
 * the SpanContext discriminator keeps the SDK-not-registered fast
 * path from misfiring under normal head sampling configurations
 * (Copilot review 2026-05-08).
 *
 * Returning `true` here means the caller should NOT proceed with
 * span enrichment; the noop tracer would discard everything anyway.
 */
function isNoopSpan(
  span: ReturnType<ReturnType<typeof trace.getTracer>["startSpan"]>,
): boolean {
  try {
    return span.spanContext().traceId === INVALID_TRACE_ID;
  } catch {
    // Defensive: treat "could not determine" as not-noop so we
    // continue down the enrichment path. The noop tracer itself
    // never throws from `spanContext()`.
    return false;
  }
}

/**
 * Wrap a Next.js / generic-fetch request-middleware function in an
 * OTel span tagged with `glasstrace.causal.middleware_for_request`.
 *
 * **Privacy:** the value of
 * `glasstrace.causal.middleware_for_request` is the raw URL
 * pathname. Pathnames can carry user-controlled data (IDs, emails,
 * opaque keys). The SDK does NOT redact this attribute. Callers MUST
 * NOT place secrets, tokens, or other sensitive data in URL paths;
 * the same general HTTP best practice that keeps secrets out of
 * server logs keeps them out of Glasstrace trace evidence.
 *
 * Each call to the returned function:
 *
 *   1. Detects the SDK's registration state. When the OTel API is
 *      still on the noop tracer (SDK not registered, or
 *      `OtelState.UNCONFIGURED`), runs the wrapped handler directly
 *      and emits a `middleware:skipped_uninstalled` lifecycle event
 *      (at most once per process). No span is opened.
 *   2. Otherwise opens a span named `options.name` under the active
 *      OTel context (typically the HTTP server span on Node;
 *      detached on Edge where AsyncLocalStorage is not available).
 *      Sets `options.attributes` first, then attaches the originating
 *      request's path (via {@link extractRequestPath}) as
 *      `glasstrace.causal.middleware_for_request`. The path is
 *      omitted when extraction returns `undefined` so absent evidence
 *      is preferred over guessed evidence.
 *   3. Awaits the wrapped handler.
 *   4. On a thrown error: normalizes the throwable to `Error | string`
 *      so `recordException` does not throw on non-Error values; sets
 *      `span.status` to `ERROR` with the error's message; rethrows the
 *      original (un-normalized) error verbatim.
 *   5. On a successful return: leaves the span status `UNSET` per OTel
 *      instrumentation-library guidance (explicit `OK` would shadow
 *      downstream consumers' error transitions).
 *   6. Always ends the span, even on `throw` or `return`.
 *
 * Type-inference: the returned function preserves the input function's
 * type `H`, so caller-narrowed signatures (e.g., `(req: NextRequest)
 * => NextResponse`) flow through unchanged.
 *
 * @param options - Span name and optional pre-start attributes.
 * @param handler - The user's middleware handler. Must accept a
 *   request-shaped object as its first argument and return (or
 *   resolve to) a response-shaped value.
 * @returns The wrapped handler with the same call signature and
 *   return type as `handler`.
 *
 * @example Next.js middleware.ts
 * ```ts
 * import { tracedRequestMiddleware } from "@glasstrace/sdk/middleware";
 * import { NextResponse, type NextRequest } from "next/server";
 *
 * export const middleware = tracedRequestMiddleware(
 *   { name: "auth-middleware" },
 *   async (req: NextRequest) => {
 *     if (!req.cookies.get("session")) {
 *       return NextResponse.redirect(new URL("/login", req.url));
 *     }
 *     return NextResponse.next();
 *   },
 * );
 *
 * export const config = { matcher: ["/dashboard/:path*"] };
 * ```
 */
export function tracedRequestMiddleware<H extends RequestMiddlewareFunction>(
  options: TracedRequestMiddlewareOptions,
  handler: H,
): H {
  // Eager validation: a mis-typed call site fails at wrapper-
  // construction time (typically at module load) rather than at
  // first request, when the failure is harder to diagnose.
  if (typeof options.name !== "string" || options.name.length === 0) {
    throw new TypeError(
      "tracedRequestMiddleware: options.name must be a non-empty string",
    );
  }

  // Capture options + handler lexically. Do not read from `this` —
  // Next.js's middleware loader invokes this as a plain function, not
  // a method, so `this` is undefined.
  const wrapped = ((req: Parameters<H>[0], ...rest: unknown[]): unknown => {
    const tracer = trace.getTracer(TRACER_NAME);
    // Defensive wrap around `tracer.startActiveSpan` itself.
    // OTel's noop tracer never throws; a real provider could
    // (e.g., a misbehaving custom processor in coexistence). If the
    // tracer call throws BEFORE invoking our callback, fall back to
    // running the handler directly so instrumentation does not break
    // the user's middleware.
    //
    // CRITICAL: the fallback runs ONLY when the tracer failed
    // pre-callback. The callback itself rethrows handler errors
    // (`recordSpanError` + `throw error`) which would otherwise be
    // intercepted here and cause the handler to run a second time
    // (Codex P1, 2026-05-08). The `callbackInvoked` flag
    // distinguishes pre-callback tracer failure from post-callback
    // handler-error rethrow.
    let callbackInvoked = false;
    try {
      return tracer.startActiveSpan(options.name, (span) => {
      callbackInvoked = true;
      // SDK-not-registered fast path. Detecting via the public
      // `isRecording()` method on the started span is the canonical
      // OTel-API-only probe — the noop tracer's `NonRecordingSpan`
      // returns `false`, real SDK-emitted spans return `true`. This
      // avoids the more expensive workaround of opening a probe span
      // ahead of time, which would emit a useless span on every
      // request when a real provider is registered.
      if (isNoopSpan(span)) {
        if (!_skippedUninstalledEmitted) {
          _skippedUninstalledEmitted = true;
          tryEmitLifecycleEvent("middleware:skipped_uninstalled", {});
        }
        // The noop span needs no enrichment and no end() because the
        // noop implementation is a no-op for both, but call end()
        // anyway for symmetry with the real-span path.
        endSpanSafely(span);
        return (handler as (...args: unknown[]) => unknown)(req, ...rest);
      }

      // Set caller-supplied attributes first so they appear on the
      // span before any internal attribute we add below.
      try {
        if (options.attributes) {
          span.setAttributes(options.attributes);
        }
        const path = extractRequestPath(req);
        if (path !== undefined) {
          span.setAttribute(ATTR.CAUSAL_MIDDLEWARE_FOR_REQUEST, path);
        }
      } catch {
        // Attribute-setting failures are advisory; never block the
        // wrapped handler from running.
      }

      let result: unknown;
      try {
        result = (handler as (...args: unknown[]) => unknown)(req, ...rest);
      } catch (error) {
        recordSpanError(span, error);
        endSpanSafely(span);
        throw error;
      }

      // The handler may be sync or async. If async, attach the
      // span-end + error-recording on the promise chain; otherwise
      // end the span synchronously and return the value.
      if (
        result !== null &&
        typeof result === "object" &&
        typeof (result as Promise<unknown>).then === "function"
      ) {
        return (result as Promise<unknown>).then(
          (value) => {
            endSpanSafely(span);
            return value;
          },
          (error: unknown) => {
            recordSpanError(span, error);
            endSpanSafely(span);
            throw error;
          },
        );
      }

      endSpanSafely(span);
      return result;
    });
    } catch (err) {
      if (callbackInvoked) {
        // The tracer's callback ran and our code (or the user's
        // handler via our rethrow) threw. That error is intentional;
        // propagate it without invoking the handler again.
        throw err;
      }
      // `tracer.startActiveSpan` failed BEFORE invoking our callback.
      // Drop instrumentation for this invocation and run the user's
      // handler directly so the request does not break.
      return (handler as (...args: unknown[]) => unknown)(req, ...rest);
    }
  }) as H;

  return wrapped;
}

/**
 * Records an exception on a span and sets the span status to `ERROR`.
 * Both calls are independently guarded so a failing `recordException`
 * cannot prevent the status transition, and vice versa. The user's
 * original error value is preserved verbatim — wrapping is purely a
 * span-side normalization.
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
    // Swallow: instrumentation must never replace the user's error.
  }
  try {
    span.setStatus({ code: SpanStatusCode.ERROR, message: statusMessage });
  } catch {
    // Swallow: independent from recordException so a failing
    // recordException does not prevent the ERROR status.
  }
}

/**
 * Ends a span, swallowing any throw from the OTel implementation. A
 * misbehaving `span.end()` must not replace the wrapped handler's
 * return value or thrown error with an unrelated one.
 */
function endSpanSafely(
  span: ReturnType<ReturnType<typeof trace.getTracer>["startSpan"]>,
): void {
  try {
    span.end();
  } catch {
    // Span lifecycle errors are always non-fatal at this layer.
  }
}
