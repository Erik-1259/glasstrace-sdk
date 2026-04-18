import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { ExportResult } from "@opentelemetry/core";
import { GLASSTRACE_ATTRIBUTE_NAMES } from "@glasstrace/protocol";
import type { CaptureConfig } from "@glasstrace/protocol";
import type { SessionManager } from "./session.js";
import { classifyFetchTarget } from "./fetch-classifier.js";
import { recordSpansExported, recordSpansDropped } from "./health-collector.js";
import { sdkLog } from "./console-capture.js";
import { maybeShowServerActionNudge } from "./nudge/error-nudge.js";

const ATTR = GLASSTRACE_ATTRIBUTE_NAMES;

/**
 * Sentinel value indicating the API key has not yet been resolved.
 */
export const API_KEY_PENDING = "pending" as const;

/**
 * Maximum number of spans to buffer while waiting for key resolution.
 * Prevents unbounded memory growth if the key never resolves.
 */
const MAX_PENDING_SPANS = 1024;


/**
 * Options for constructing a {@link GlasstraceExporter}.
 */
export interface GlasstraceExporterOptions {
  getApiKey: () => string;
  sessionManager: SessionManager;
  getConfig: () => CaptureConfig;
  environment: string | undefined;
  endpointUrl: string;
  createDelegate: ((url: string, headers: Record<string, string>) => SpanExporter) | null;
  /** When true, logs diagnostic details about enrichment decisions via sdkLog. */
  verbose?: boolean;
}

interface PendingBatch {
  spans: ReadableSpan[];
  resultCallback: (result: ExportResult) => void;
}

/**
 * A SpanExporter that enriches spans with glasstrace.* attributes at export
 * time, then delegates to a real OTLP exporter.
 *
 * This design resolves three issues:
 * - Spans emitted before the API key resolves are buffered (not dropped)
 *   and flushed once the key is available.
 * - Enrichment happens in the exporter (not onEnding), so it works
 *   on Vercel where CompositeSpanProcessor does not forward onEnding().
 * - Session ID is computed at export time using the resolved API key,
 *   not the "pending" placeholder.
 */
export class GlasstraceExporter implements SpanExporter {
  private readonly getApiKey: () => string;
  private readonly sessionManager: SessionManager;
  private readonly getConfig: () => CaptureConfig;
  private readonly environment: string | undefined;
  private readonly endpointUrl: string;
  private readonly createDelegateFn: ((url: string, headers: Record<string, string>) => SpanExporter) | null;
  private readonly verbose: boolean;

  private delegate: SpanExporter | null = null;
  private delegateKey: string | null = null;
  private pendingBatches: PendingBatch[] = [];
  private pendingSpanCount = 0;
  private overflowLogged = false;

  constructor(options: GlasstraceExporterOptions) {
    this.getApiKey = options.getApiKey;
    this.sessionManager = options.sessionManager;
    this.getConfig = options.getConfig;
    this.environment = options.environment;
    this.endpointUrl = options.endpointUrl;
    this.createDelegateFn = options.createDelegate;
    this.verbose = options.verbose ?? false;

    // Brand for coexistence detection — allows isGlasstraceProcessorPresent()
    // to detect our exporter across bundled copies via a global symbol registry.
    (this as unknown as Record<symbol, boolean>)[Symbol.for("glasstrace.exporter")] = true;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const currentKey = this.getApiKey();
    if (currentKey === API_KEY_PENDING) {
      // Buffer raw (unenriched) spans — enrichment deferred to flush time
      // so session IDs are computed with the resolved key, not "pending".
      this.bufferSpans(spans, resultCallback);
      return;
    }

    // Key is available — enrich and export
    const enrichedSpans = spans.map((span) => this.enrichSpan(span));
    const exporter = this.ensureDelegate();
    if (exporter) {
      exporter.export(enrichedSpans, (result) => {
        if (result.code !== 0) {
          sdkLog("warn", `[glasstrace] Span export failed: ${result.error?.message ?? "unknown error"}`);
        }
        resultCallback(result);
      });
      recordSpansExported(enrichedSpans.length);
    } else {
      // No delegate factory — spans are discarded, count as dropped
      recordSpansDropped(enrichedSpans.length);
      resultCallback({ code: 0 });
    }
  }

  /**
   * Called when the API key transitions from "pending" to a resolved value.
   * Creates the delegate exporter and flushes all buffered spans.
   */
  notifyKeyResolved(): void {
    this.flushPending();
  }

  async shutdown(): Promise<void> {
    const currentKey = this.getApiKey();
    if (currentKey !== API_KEY_PENDING && this.pendingBatches.length > 0) {
      this.flushPending();
    } else if (this.pendingBatches.length > 0) {
      console.warn(
        `[glasstrace] Shutdown with ${this.pendingSpanCount} buffered spans — API key never resolved, spans lost.`,
      );
      recordSpansDropped(this.pendingSpanCount);
      // Complete pending callbacks so pipeline doesn't hang
      for (const batch of this.pendingBatches) {
        batch.resultCallback({ code: 0 });
      }
      this.pendingBatches = [];
      this.pendingSpanCount = 0;
    }

    if (this.delegate) {
      return this.delegate.shutdown();
    }
  }

  /**
   * Flushes any pending buffered spans (if the API key has resolved) and
   * delegates to the underlying exporter's forceFlush to drain its queue.
   */
  forceFlush(): Promise<void> {
    // Flush pending batches if the key has resolved but they haven't been
    // drained yet (e.g., key resolved between the last export and this flush).
    if (this.getApiKey() !== API_KEY_PENDING && this.pendingBatches.length > 0) {
      this.flushPending();
    }

    if (this.delegate?.forceFlush) {
      return this.delegate.forceFlush();
    }
    return Promise.resolve();
  }

  /**
   * Enriches a ReadableSpan with all glasstrace.* attributes.
   * Returns a new ReadableSpan wrapper; the original span is not mutated.
   *
   * Only {@link SessionManager.getSessionId} is individually guarded because
   * it calls into crypto and schema validation — a session ID failure should
   * not prevent the rest of enrichment. The other helper calls
   * ({@link deriveErrorCategory}, {@link deriveOrmProvider},
   * {@link classifyFetchTarget}) are pure functions on typed string inputs
   * and rely on the outer catch for any unexpected failure.
   *
   * On total failure, returns the original span unchanged.
   */
  private enrichSpan(span: ReadableSpan): ReadableSpan {
    try {
      const attrs = span.attributes ?? {};
      const name = span.name ?? "";
      const extra: Record<string, string | number | boolean> = {};

      // glasstrace.trace.type
      extra[ATTR.TRACE_TYPE] = "server";

      // glasstrace.session.id — calls external code (crypto, schema validation)
      try {
        const sessionId = this.sessionManager.getSessionId(this.getApiKey());
        extra[ATTR.SESSION_ID] = sessionId;
      } catch { /* session ID omitted */ }

      // glasstrace.environment
      const env = this.environment ?? process.env.GLASSTRACE_ENV;
      if (env) {
        extra[ATTR.ENVIRONMENT] = env;
      }

      // glasstrace.correlation.id
      const existingCid = attrs["glasstrace.correlation.id"];
      if (typeof existingCid === "string") {
        extra[ATTR.CORRELATION_ID] = existingCid;
      }

      // glasstrace.route
      const route =
        (attrs["http.route"] as string | undefined) ?? name;
      if (route) {
        extra[ATTR.ROUTE] = route;
      }

      // glasstrace.trpc.procedure
      // Extract tRPC procedure name from URL path (DISC-1215).
      // Pattern: /api/trpc/{procedure} where procedure is a single path segment
      // that may contain dots (polls.modify) or commas (batched: proc1,proc2).
      const rawUrl = attrs["http.url"] ?? attrs["url.full"] ?? attrs["http.target"];
      const trpcUrl = typeof rawUrl === "string" ? rawUrl : undefined;
      if (trpcUrl) {
        const trpcMatch = trpcUrl.match(/\/api\/trpc\/([^/?#]+)/);
        if (trpcMatch) {
          let procedure: string;
          try {
            procedure = decodeURIComponent(trpcMatch[1]);
          } catch {
            procedure = trpcMatch[1];
          }
          if (procedure) {
            extra[ATTR.TRPC_PROCEDURE] = procedure;
          }
        }
      }

      // glasstrace.http.method
      const method =
        (attrs["http.method"] as string | undefined) ??
        (attrs["http.request.method"] as string | undefined);
      if (method) {
        extra[ATTR.HTTP_METHOD] = method;
      }

      // glasstrace.next.action.detected — DISC-1253.
      // Heuristic: a POST to a page route (not /api/*, not /_next/*) is
      // almost always a Server Action in idiomatic Next.js App Router code.
      // We cannot identify the specific action without extra metadata —
      // DISC-1254 covers that path. Label "detected" not "confirmed" to
      // leave room for rare false-positive cases (legacy form POSTs,
      // hand-rolled page-route POST handlers).
      //
      // `route` may come from `http.route` (a bare path like "/login") or
      // fall back to `span.name` (which Next.js formats as "POST /login",
      // sometimes "middleware POST", etc.). We normalize to the leading
      // path segment before matching so a span named "POST /api/auth"
      // does not slip past the `/api/` guard and get falsely flagged.
      const actionRoute = extractLeadingPath(route);
      if (method === "POST" && actionRoute) {
        const isApiRoute = actionRoute === "/api" || actionRoute.startsWith("/api/");
        const isInternalRoute = actionRoute.startsWith("/_next/");
        if (!isApiRoute && !isInternalRoute) {
          extra[ATTR.NEXT_ACTION_DETECTED] = true;
          // Developer-facing nudge (once per process): when a Server Action
          // trace is detected but no glasstrace.correlation.id is present,
          // the Glasstrace browser extension is likely absent. Installing it
          // unlocks per-action identification via the Next-Action header
          // (DISC-1254 covers capture).
          if (typeof extra[ATTR.CORRELATION_ID] !== "string") {
            maybeShowServerActionNudge();
          }
        }
      }

      // glasstrace.http.status_code
      const statusCode =
        (attrs["http.status_code"] as number | undefined) ??
        (attrs["http.response.status_code"] as number | undefined);
      if (statusCode !== undefined) {
        extra[ATTR.HTTP_STATUS_CODE] = statusCode;
      }

      // Infer error status when Next.js timing race reports 200 on error spans.
      // Three signals indicate an error span:
      //   1. span.status.code === ERROR (explicit, most reliable)
      //   2. span.events contains an "exception" event (recordException fired)
      //   3. span attributes contain exception.type or exception.message
      // The timing race in Next.js dev server (DISC-1134) can cause span
      // export before closeSpanWithError runs, leaving status.code as UNSET.
      // Exception events from recordException may still be present (DISC-1204).
      // Does NOT trigger when status is explicitly OK (handler recovered).
      const isErrorByStatus = span.status?.code === SpanStatusCode.ERROR;
      const isErrorByEvent = hasExceptionEvent(span);
      const isErrorByAttrs = typeof attrs["exception.type"] === "string"
                          || typeof attrs["exception.message"] === "string";
      const statusNotExplicitlyOK = span.status?.code !== SpanStatusCode.OK;

      if (this.verbose && method) {
        sdkLog("info",
          `[glasstrace] enrichSpan "${name}": status.code=${span.status?.code}, ` +
          `http.status_code=${statusCode}, isErrorByStatus=${isErrorByStatus}, ` +
          `isErrorByEvent=${isErrorByEvent}, isErrorByAttrs=${isErrorByAttrs}`,
        );
      }

      if (method && statusNotExplicitlyOK && (isErrorByStatus || isErrorByEvent || isErrorByAttrs)) {
        if (statusCode === undefined || statusCode === 0 || statusCode === 200) {
          const httpErrorType = attrs["error.type"];
          if (typeof httpErrorType === "string") {
            const parsed = parseInt(httpErrorType, 10);
            if (!isNaN(parsed) && parsed >= 400 && parsed <= 599) {
              extra[ATTR.HTTP_STATUS_CODE] = parsed;
            } else {
              extra[ATTR.HTTP_STATUS_CODE] = 500;
            }
          } else {
            extra[ATTR.HTTP_STATUS_CODE] = 500;
          }

          if (this.verbose) {
            sdkLog("info",
              `[glasstrace] enrichSpan "${name}": inferred status_code=${extra[ATTR.HTTP_STATUS_CODE]} ` +
              `(was ${statusCode}), error.type=${attrs["error.type"]}`,
            );
          }
        }
        // If statusCode is already >= 400, leave it alone (correct value)
      }

      // glasstrace.http.duration_ms
      if (span.startTime && span.endTime) {
        const [startSec, startNano] = span.startTime;
        const [endSec, endNano] = span.endTime;
        const durationMs =
          (endSec - startSec) * 1000 + (endNano - startNano) / 1_000_000;
        if (durationMs >= 0) {
          extra[ATTR.HTTP_DURATION_MS] = durationMs;
        }
      }

      // glasstrace.error.message + glasstrace.error.code + glasstrace.error.category
      // Primary source: span attributes. Fallback: exception event attributes.
      // OTel's recordException() stores exception info in events, not span
      // attributes, so the fallback is needed for most error spans (DISC-1204).
      // Event fallback is gated on statusNotExplicitlyOK to avoid labeling
      // recovered OK spans with error metadata from handled exceptions.
      const eventDetails = statusNotExplicitlyOK
        ? getExceptionEventDetails(span)
        : { type: undefined, message: undefined };

      const errorMessage = attrs["exception.message"];
      if (typeof errorMessage === "string") {
        extra[ATTR.ERROR_MESSAGE] = errorMessage;
      } else if (eventDetails.message) {
        extra[ATTR.ERROR_MESSAGE] = eventDetails.message;
      }

      // Guard against non-string attribute values (OTel attributes can be
      // string | number | boolean | Array) to prevent toLowerCase() throws.
      const errorType = attrs["exception.type"];
      if (typeof errorType === "string") {
        extra[ATTR.ERROR_CODE] = errorType;
        extra[ATTR.ERROR_CATEGORY] = deriveErrorCategory(errorType);
      } else if (eventDetails.type) {
        extra[ATTR.ERROR_CODE] = eventDetails.type;
        extra[ATTR.ERROR_CATEGORY] = deriveErrorCategory(eventDetails.type);
      }

      if (this.verbose && (extra[ATTR.ERROR_MESSAGE] || extra[ATTR.ERROR_CODE])) {
        const msgSource = typeof errorMessage === "string" ? "attrs"
          : eventDetails.message ? "event" : "none";
        const typeSource = typeof errorType === "string" ? "attrs"
          : eventDetails.type ? "event" : "none";
        sdkLog("info",
          `[glasstrace] enrichSpan "${name}": error.message source=${msgSource}, ` +
          `error.code source=${typeSource}`,
        );
      }

      // glasstrace.error.field
      const errorField = attrs["error.field"];
      if (typeof errorField === "string") {
        extra[ATTR.ERROR_FIELD] = errorField;
      }

      // glasstrace.error.response_body (DISC-1216 Phase 1 — passthrough)
      // Adapters (e.g., future tRPC handler wrapper) should set error response
      // body data on `glasstrace.internal.response_body` — a Glasstrace-internal
      // attribute that is only promoted to the public namespace when the config
      // flag is enabled. This prevents response body leakage when disabled.
      if (this.getConfig().errorResponseBodies) {
        const responseBody = attrs["glasstrace.internal.response_body"];
        if (typeof responseBody === "string") {
          extra[ATTR.ERROR_RESPONSE_BODY] = responseBody.slice(0, 500);
        }
      }

      // glasstrace.orm.*
      const spanAny = span as unknown as Record<string, { name?: string } | undefined>;
      const instrumentationName =
        (spanAny.instrumentationScope?.name ?? spanAny.instrumentationLibrary?.name) ?? "";
      const ormProvider = deriveOrmProvider(instrumentationName);
      if (ormProvider) {
        extra[ATTR.ORM_PROVIDER] = ormProvider;

        const table = attrs["db.sql.table"];
        const prismaModel = attrs["db.prisma.model"];
        const model = typeof table === "string" ? table
          : typeof prismaModel === "string" ? prismaModel
          : undefined;
        if (model) {
          extra[ATTR.ORM_MODEL] = model;
        }

        const operation = attrs["db.operation"];
        if (typeof operation === "string") {
          extra[ATTR.ORM_OPERATION] = operation;
        }
      }

      // glasstrace.fetch.target
      const httpUrl = attrs["http.url"];
      const fullUrl = attrs["url.full"];
      const url = typeof httpUrl === "string" ? httpUrl
        : typeof fullUrl === "string" ? fullUrl
        : undefined;
      if (url && span.kind === SpanKind.CLIENT) {
        extra[ATTR.FETCH_TARGET] = classifyFetchTarget(url);
      }

      return createEnrichedSpan(span, extra);
    } catch {
      // Return original span unchanged so the export pipeline is never blocked
      return span;
    }
  }

  /**
   * Lazily creates the delegate OTLP exporter once the API key is resolved.
   * Recreates the delegate if the key has changed (e.g., after key rotation)
   * so the Authorization header stays current.
   */
  private ensureDelegate(): SpanExporter | null {
    if (!this.createDelegateFn) return null;

    const currentKey = this.getApiKey();
    if (currentKey === API_KEY_PENDING) return null;

    // Recreate delegate if the key has changed since last creation
    if (this.delegate && this.delegateKey === currentKey) {
      return this.delegate;
    }

    // Shut down old delegate if key rotated. Catch errors to prevent
    // unhandled rejections from crashing the process during rotation.
    if (this.delegate) {
      void this.delegate.shutdown?.().catch(() => {});
    }

    this.delegate = this.createDelegateFn(this.endpointUrl, {
      Authorization: `Bearer ${currentKey}`,
    });
    this.delegateKey = currentKey;
    return this.delegate;
  }

  /**
   * Buffers raw (unenriched) spans while the API key is pending.
   * Evicts oldest batches if the buffer exceeds MAX_PENDING_SPANS.
   * Re-checks the key after buffering to close the race window where
   * the key resolves between the caller's check and this buffer call.
   */
  private bufferSpans(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    this.pendingBatches.push({ spans, resultCallback });
    this.pendingSpanCount += spans.length;

    // Evict oldest batches if over limit
    while (this.pendingSpanCount > MAX_PENDING_SPANS && this.pendingBatches.length > 1) {
      const evicted = this.pendingBatches.shift()!;
      this.pendingSpanCount -= evicted.spans.length;
      recordSpansDropped(evicted.spans.length);
      // Complete callback so pipeline doesn't hang
      evicted.resultCallback({ code: 0 });

      if (!this.overflowLogged) {
        this.overflowLogged = true;
        console.warn(
          "[glasstrace] Pending span buffer overflow — oldest spans evicted. " +
          "This usually means the API key is taking too long to resolve.",
        );
      }
    }

    // Re-check: if the key resolved between the caller's check and now,
    // flush immediately to avoid spans stuck in the buffer.
    if (this.getApiKey() !== API_KEY_PENDING) {
      this.flushPending();
    }
  }

  /**
   * Flushes all buffered spans through the delegate exporter.
   * Enriches spans at flush time (not buffer time) so that session IDs
   * are computed with the resolved API key instead of the "pending" sentinel.
   */
  private flushPending(): void {
    if (this.pendingBatches.length === 0) return;

    const exporter = this.ensureDelegate();
    if (!exporter) {
      // No delegate factory — complete callbacks and count as dropped
      let discardedCount = 0;
      for (const batch of this.pendingBatches) {
        discardedCount += batch.spans.length;
        batch.resultCallback({ code: 0 });
      }
      recordSpansDropped(discardedCount);
      this.pendingBatches = [];
      this.pendingSpanCount = 0;
      return;
    }

    const batches = this.pendingBatches;
    this.pendingBatches = [];
    this.pendingSpanCount = 0;

    for (const batch of batches) {
      // Enrich at flush time with the now-resolved key
      const enriched = batch.spans.map((span) => this.enrichSpan(span));
      exporter.export(enriched, (result) => {
        if (result.code !== 0) {
          sdkLog("warn", `[glasstrace] Span export failed: ${result.error?.message ?? "unknown error"}`);
        }
        batch.resultCallback(result);
      });
      recordSpansExported(enriched.length);
    }
  }

}

/**
 * Creates a ReadableSpan wrapper that inherits all properties from the
 * original span but overrides `attributes` to include additional entries.
 * The original span is not mutated.
 */
function createEnrichedSpan(
  span: ReadableSpan,
  extra: Record<string, string | number | boolean>,
): ReadableSpan {
  const enrichedAttributes = { ...span.attributes, ...extra };
  return Object.create(span, {
    attributes: {
      value: enrichedAttributes,
      enumerable: true,
    },
  }) as ReadableSpan;
}

/**
 * Returns true if the span has at least one "exception" event.
 * This signals that `span.recordException()` was called, even if
 * `span.setStatus(ERROR)` was not yet applied due to the timing race
 * in Next.js dev server (DISC-1204).
 */
function hasExceptionEvent(span: ReadableSpan): boolean {
  return span.events?.some((e) => e.name === "exception") ?? false;
}

/**
 * Extracts exception.type and exception.message from the first "exception"
 * event on the span. Returns undefined values if not found.
 *
 * OTel's `recordException()` stores error details in event attributes, not
 * span attributes. The enrichment code needs this fallback to populate
 * glasstrace.error.message and glasstrace.error.code when the standard
 * span attributes are absent.
 */
function getExceptionEventDetails(span: ReadableSpan): {
  type: string | undefined;
  message: string | undefined;
} {
  const event = span.events?.find((e) => e.name === "exception");
  if (!event?.attributes) {
    return { type: undefined, message: undefined };
  }
  const type = event.attributes["exception.type"];
  const message = event.attributes["exception.message"];
  return {
    type: typeof type === "string" ? type : undefined,
    message: typeof message === "string" ? message : undefined,
  };
}

/**
 * Extracts the leading path from a route-or-span-name string so the
 * Server Action heuristic (DISC-1253) can match reliably regardless of
 * whether the value came from `http.route` (bare path, e.g. "/login")
 * or from `span.name` (Next.js-formatted, e.g. "POST /login" or
 * "middleware POST /login").
 *
 * Returns the first `/…`-prefixed token, or `undefined` if no such
 * token is present. Empty input yields `undefined` so callers can use
 * the result as a truthy guard.
 */
export function extractLeadingPath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  // Fast path: already a bare path.
  if (trimmed.startsWith("/")) {
    const firstSpace = trimmed.indexOf(" ");
    return firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  }

  // Fallback: scan for the first whitespace-separated token that looks
  // like a path. Handles "POST /login", "middleware POST /login", etc.
  for (const token of trimmed.split(/\s+/)) {
    if (token.startsWith("/")) {
      return token;
    }
  }

  return undefined;
}

/**
 * Derives ORM provider from the instrumentation library name.
 */
export function deriveOrmProvider(instrumentationName: string): string | null {
  const lower = instrumentationName.toLowerCase();
  if (lower.includes("prisma")) {
    return "prisma";
  }
  if (lower.includes("drizzle")) {
    return "drizzle";
  }
  return null;
}

/**
 * Derives error category from error type string.
 */
export function deriveErrorCategory(errorType: string): string {
  const lower = errorType.toLowerCase();
  if (lower.includes("validation") || lower.includes("zod")) {
    return "validation";
  }
  if (
    lower.includes("network") ||
    lower.includes("econnrefused") ||
    lower.includes("fetch") ||
    lower.includes("timeout")
  ) {
    return "network";
  }
  if (lower.includes("auth") || lower.includes("unauthorized") || lower.includes("forbidden")) {
    return "auth";
  }
  if (lower.includes("notfound") || lower.includes("not_found")) {
    return "not-found";
  }
  return "internal";
}
