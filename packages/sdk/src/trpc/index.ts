/**
 * tRPC middleware-chain instrumentation for Glasstrace.
 *
 * Subpath: `@glasstrace/sdk/trpc`
 *
 * This module exposes {@link tracedMiddleware}, a thin wrapper that turns
 * a user-supplied tRPC middleware function into a span-emitting middleware
 * function. Each invocation of the wrapped middleware opens a child span
 * (via {@link https://opentelemetry.io/docs/specs/otel/trace/api/#starting-a-new-active-span | tracer.startActiveSpan})
 * under whatever active OTel context the runtime exposes when the tRPC
 * dispatcher calls the middleware. In a typical Next.js / Node HTTP server
 * deployment that active context is the HTTP server span, so middleware
 * spans land as children of the HTTP span automatically — no manual
 * parent plumbing required.
 *
 * The helper does not import the `@trpc/server` runtime; it consumes the
 * middleware function shape structurally so that:
 *
 * 1. Projects that do not use tRPC pay no runtime cost (the subpath is
 *    excluded from the root barrel and tree-shakeable on its own).
 * 2. The same helper works against `@trpc/server@^10.0.0` and
 *    `@trpc/server@^11.0.0` without two parallel implementations.
 *
 * The wrapped function preserves the user's call-site type (`T`) so that
 * tRPC's procedure-builder context narrowing (e.g., adding a `session`
 * field across `.use()` chains) continues to flow through.
 *
 * Compatibility with the existing `glasstrace.trpc.procedure` URL-derived
 * attribute (DISC-1215, shipped) is by construction: that attribute is
 * attached to the **parent** HTTP span at exporter time, never to a
 * middleware child span. Middleware spans only carry `trpc.path` and
 * `trpc.type` (forwarded from the middleware options) plus whatever
 * caller-supplied attributes the {@link TracedMiddlewareOptions.attributes}
 * field carries.
 *
 * @module @glasstrace/sdk/trpc
 */

import {
  trace,
  SpanStatusCode,
  type AttributeValue,
} from "@opentelemetry/api";
import { GLASSTRACE_ATTRIBUTE_NAMES } from "@glasstrace/protocol";
import { emitLifecycleEvent } from "../lifecycle.js";
import { getBatchEnvelope, resolveBatchMember } from "./batch-context.js";

export {
  wrapBatchedHttpHandler,
  type WrapBatchedHttpHandlerOptions,
} from "./batch-handler.js";

/**
 * Permissive structural bound for a tRPC middleware function. The shape
 * is the intersection of `@trpc/server@^10` and `@trpc/server@^11`'s
 * middleware signature: an async function taking a single options object
 * and returning a thenable middleware result.
 *
 * The `opts` parameter is typed `any` so any user-narrowed middleware
 * (with strongly-typed `ctx` / `input` / `meta`) is assignable, and the
 * return type is `Promise<unknown>` so both v10's
 * `Promise<MiddlewareResult<...>>` and v11's identically-named result
 * shape (with extra fields) are accepted without import-time coupling
 * to either major version.
 *
 * Exported so consumers can reference it for type-inference assertions
 * (e.g., proving a strongly-typed middleware fits the bound) without
 * having to recreate the structural shape. The runtime contract is
 * fixed by the `@trpc/server` versions in the peer-dependency range.
 */
// The `any` here is load-bearing: a tighter bound would reject either
// v10 or v11 middleware shapes, or both, because tRPC narrows `ctx`,
// `input`, and `meta` to user-supplied types via generics. Capturing
// `T extends MiddlewareFunction` preserves that narrowing through the
// wrapper's `: T` return type (see the type-inference fixture in
// tests/unit/sdk/trpc/traced-middleware-types.test.ts).
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MiddlewareFunction = (opts: any) => Promise<unknown>;

/**
 * Options for {@link tracedMiddleware}.
 *
 * @example
 * ```ts
 * import { tracedMiddleware } from "@glasstrace/sdk/trpc";
 *
 * const isAuthed = t.middleware(
 *   tracedMiddleware(
 *     { name: "isAuthed", attributes: { "auth.required": true } },
 *     async ({ ctx, next }) => {
 *       if (!ctx.session) throw new TRPCError({ code: "UNAUTHORIZED" });
 *       return next({ ctx: { ...ctx, session: ctx.session } });
 *     },
 *   ),
 * );
 * ```
 */
export interface TracedMiddlewareOptions {
  /**
   * Span name. Required. Used as the OTel span name; appears in trace
   * timelines and is the primary identifier surfaced by enrichment when
   * a middleware step short-circuits (e.g., auth failure).
   *
   * Must be a non-empty string. Names should be stable across runs so
   * enrichment can reason about middleware identity (e.g., "isAuthed",
   * "isPro"); avoid embedding request data in the name.
   */
  name: string;
  /**
   * Optional attributes attached to the span before the wrapped
   * middleware body runs. Forwarded to OTel as-is via
   * `span.setAttributes(...)`. The SDK does not redact, sanitize, or
   * scan values here — callers must avoid placing tokens, credentials,
   * or other sensitive data in `attributes`.
   *
   * Sensitive request/response data is captured through the gated
   * `glasstrace.error.response_body` path (see DISC-1216), not through
   * this surface.
   */
  attributes?: Record<string, AttributeValue>;
}

/**
 * Module-level OTel tracer name for the tRPC subpath. Resolves through
 * the global `ProxyTracerProvider` so it inherits whatever provider the
 * SDK has detected or registered (Glasstrace's enriching exporter,
 * Sentry's processor in coexistence mode, Datadog's processor, etc.).
 *
 * Re-resolved on every call site rather than cached at module top-level
 * so that the test harness's `trace.setGlobalTracerProvider` can be
 * picked up after this module is imported. (Caching the tracer at module
 * top-level would race against test harness setup and produce stale
 * no-op spans for the very first test.)
 */
const TRACER_NAME = "@glasstrace/sdk/trpc";

/**
 * Wrap a tRPC middleware function in an OTel span.
 *
 * Each call to the returned middleware:
 *
 * 1. Opens a span named `options.name` under the active OTel context
 *    (typically the HTTP server span). The span inherits `traceId` and
 *    parent `spanId` automatically — no manual context plumbing.
 * 2. Sets caller-supplied {@link TracedMiddlewareOptions.attributes}
 *    plus `trpc.path` and `trpc.type` (forwarded from the middleware
 *    options) on the span before calling the wrapped middleware body.
 * 3. Lets the wrapped middleware run with the new span as the active
 *    span (so any `tracer.startActiveSpan` calls inside the body open
 *    grandchild spans under the middleware span).
 * 4. On a thrown error: records the exception via `span.recordException`
 *    and sets `span.status` to `ERROR` with the error's message; rethrows.
 * 5. On a returned `{ ok: false, error }` middleware result (tRPC's
 *    short-circuit shape): sets `span.status` to `ERROR` without
 *    `recordException` (no `Error` object to record).
 * 6. On a successful `{ ok: true, ... }` result: leaves the span status
 *    as `UNSET` (per OTel instrumentation-library guidance — explicit
 *    `OK` here would shadow downstream consumers attempting their own
 *    status transitions).
 * 7. Always ends the span (`span.end()`), even on `throw` or `return`.
 *
 * Type-inference: the returned function preserves the input function's
 * type `T`, so tRPC's procedure-builder context narrowing flows through
 * unchanged. See `sdk-trpc.md` §3.3 for the recommended call pattern.
 *
 * @param options - Span name and optional pre-start attributes.
 * @param middleware - The user's tRPC middleware function. Must be
 *   structurally compatible with `@trpc/server@^10` or `@trpc/server@^11`.
 * @returns The wrapped middleware function with the same call signature
 *   and return type as `middleware`.
 *
 * @example
 * ```ts
 * // trpc.ts — user's project
 * import { initTRPC, TRPCError } from "@trpc/server";
 * import { tracedMiddleware } from "@glasstrace/sdk/trpc";
 *
 * interface MyContext { session?: { userId: string }; tier?: string }
 * const t = initTRPC.context<MyContext>().create();
 *
 * const isAuthed = t.middleware(
 *   tracedMiddleware({ name: "isAuthed" }, async ({ ctx, next }) => {
 *     if (!ctx.session) throw new TRPCError({ code: "UNAUTHORIZED" });
 *     return next({ ctx: { ...ctx, session: ctx.session } });
 *   }),
 * );
 *
 * const isPro = t.middleware(
 *   tracedMiddleware({ name: "isPro" }, async ({ ctx, next }) => {
 *     if (ctx.tier !== "pro") throw new TRPCError({ code: "FORBIDDEN" });
 *     return next();
 *   }),
 * );
 *
 * export const proProcedure = t.procedure.use(isAuthed).use(isPro);
 * ```
 */
export function tracedMiddleware<T extends MiddlewareFunction>(
  options: TracedMiddlewareOptions,
  middleware: T,
): T {
  // Validate the span name eagerly so a mis-typed call site fails at
  // wrapper-construction time (typically at module load) rather than at
  // first request, when the failure is harder to diagnose. The structural
  // bound only enforces shape, not value-level invariants.
  if (typeof options.name !== "string" || options.name.length === 0) {
    throw new TypeError(
      "tracedMiddleware: options.name must be a non-empty string",
    );
  }

  // The wrapped function. Capture `options` and `middleware` lexically;
  // do not read them from `this` since tRPC invokes middleware as a
  // plain function (not a method).
  const wrapped = async (mwOpts: Parameters<T>[0]): Promise<unknown> => {
    const tracer = trace.getTracer(TRACER_NAME);
    return tracer.startActiveSpan(options.name, async (span) => {
      try {
        // Set caller-supplied attributes first so they appear on the
        // span before any internal attribute we add below. Caller-supplied
        // attributes are forwarded as-is — no redaction or scanning (see
        // TracedMiddlewareOptions.attributes JSDoc).
        if (options.attributes) {
          span.setAttributes(options.attributes);
        }
        // Forward the tRPC-provided `path` and `type` so consumers (the
        // enriching exporter, third-party UIs) can correlate the
        // middleware span back to its procedure without joining against
        // the parent HTTP span. Both fields are documented as Tier 2
        // heuristics in `sdk-trpc.md` §4.
        let procedurePath: string | undefined;
        if (mwOpts && typeof mwOpts === "object") {
          const path = (mwOpts as { path?: unknown }).path;
          if (typeof path === "string") {
            span.setAttribute("trpc.path", path);
            procedurePath = path;
          }
          const type = (mwOpts as { type?: unknown }).type;
          if (
            type === "query" ||
            type === "mutation" ||
            type === "subscription"
          ) {
            span.setAttribute("trpc.type", type);
          }
        }

        // SDK-052 / Wave 16B — when this invocation runs under a
        // `wrapBatchedHttpHandler` envelope, label the span with its
        // positional batch-member index and the full member-procedures
        // list. Positional matching disambiguates batches that include
        // the same procedure name multiple times. When no envelope is
        // present (the non-batched path or apps not using the
        // wrapper), this branch is a no-op and the span shape is
        // unchanged from today.
        if (procedurePath !== undefined) {
          const resolved = resolveBatchMember(procedurePath);
          if (resolved !== undefined) {
            span.setAttribute(
              GLASSTRACE_ATTRIBUTE_NAMES.TRPC_BATCH_MEMBER_INDEX,
              resolved.index,
            );
            span.setAttribute(
              GLASSTRACE_ATTRIBUTE_NAMES.TRPC_BATCH_MEMBER_PROCEDURES,
              resolved.allNames,
            );
          } else {
            // The envelope might exist but the procedure name doesn't
            // map — emit the mismatch event for observability and
            // proceed without batch attributes (trace shape preserved).
            // We only emit the event when we can confirm an envelope
            // exists; otherwise this is the non-batched path (no
            // envelope at all) and silence is correct.
            const envelope = getBatchEnvelope();
            if (envelope !== undefined) {
              emitLifecycleEvent("otel:trpc_batch_member_mismatch", {
                procedureName: procedurePath,
                // Use the envelope's precomputed allNames cache
                // rather than rebuilding `procedures.map(...)` on
                // every mismatch — the rebuild was the residual
                // O(N) waste from the original implementation that
                // the precomputed-cache fix in batch-context.ts is
                // designed to eliminate.
                batchMembers: envelope.allNames,
                spanId: span.spanContext().spanId,
              });
            }
          }
        }

        const result = await middleware(mwOpts);

        // tRPC's middleware result is a discriminated union:
        //   { ok: true, ... } — successful pass-through
        //   { ok: false, error, ... } — middleware short-circuited with
        //                               an explicit error envelope
        //
        // The error envelope is the path users hit when they call
        // `next()` and the next link returns ok:false; from the wrapper's
        // perspective the middleware did not throw, but the request did
        // fail. Mark the span ERROR so the exporter and downstream UIs
        // surface the failure, but do not call `recordException` —
        // there is no `Error` object to record.
        if (
          result !== null &&
          typeof result === "object" &&
          (result as { ok?: unknown }).ok === false
        ) {
          span.setStatus({ code: SpanStatusCode.ERROR });
        }

        return result;
      } catch (error) {
        // Thrown error path. `recordException` produces an OTel
        // exception event with the error name, message, and stack;
        // `setStatus({ code: ERROR, message })` lets standard OTel UIs
        // display the error message inline with the span.
        //
        // OpenTelemetry's `Span.recordException` accepts only
        // `Exception = string | Error` — a non-Error, non-string
        // throwable (e.g. a plain object, number, or symbol thrown by
        // user code via valid JavaScript) can cause `recordException`
        // to throw, which would otherwise leave the span status UNSET
        // even though the request failed. Normalize the throwable
        // first, then guard `recordException` and `setStatus` in
        // independent try/catch blocks so a failure inside one cannot
        // block the other from running. The user's original `error`
        // value is preserved verbatim for the `throw error` re-raise
        // below — wrapping is purely a span-side normalization.
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
          // Swallow — instrumentation must never replace the user's
          // error with its own. The span is still ended in `finally`.
        }
        try {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: statusMessage,
          });
        } catch {
          // Swallow — see comment above. Independent from the
          // recordException try/catch so a failing recordException
          // does not prevent the ERROR status from being recorded.
        }
        throw error;
      } finally {
        // Always end the span. `try/finally` covers both the success
        // and throw paths; the `return result` above happens inside the
        // try, so finally still runs before the value is yielded.
        // Defensively suppress any throw from `span.end()` so a
        // misbehaving OTel impl cannot replace the wrapped middleware's
        // return value (or thrown error) with an unrelated one.
        try {
          span.end();
        } catch {
          // Span lifecycle errors are always non-fatal at this layer.
        }
      }
    });
  };

  // The `T` cast preserves the user's function type at the call site
  // even though our wrapper widens parameters to `Parameters<T>[0]` and
  // return to `Promise<unknown>` internally. This is the load-bearing
  // type-inference contract documented in `sdk-trpc.md` §3.3 and
  // verified by `tests/unit/sdk/trpc/traced-middleware-types.test.ts`.
  return wrapped as T;
}
