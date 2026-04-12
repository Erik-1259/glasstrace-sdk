import { SpanKind } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { ExportResult } from "@opentelemetry/core";
import { GLASSTRACE_ATTRIBUTE_NAMES } from "@glasstrace/protocol";
import type { CaptureConfig } from "@glasstrace/protocol";
import type { SessionManager } from "./session.js";
import { classifyFetchTarget } from "./fetch-classifier.js";
import { recordSpansExported, recordSpansDropped } from "./health-collector.js";
import { sdkLog } from "./console-capture.js";

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
      const extra: Record<string, string | number> = {};

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

      // glasstrace.http.method
      const method =
        (attrs["http.method"] as string | undefined) ??
        (attrs["http.request.method"] as string | undefined);
      if (method) {
        extra[ATTR.HTTP_METHOD] = method;
      }

      // glasstrace.http.status_code
      const statusCode =
        (attrs["http.status_code"] as number | undefined) ??
        (attrs["http.response.status_code"] as number | undefined);
      if (statusCode !== undefined) {
        extra[ATTR.HTTP_STATUS_CODE] = statusCode;
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

      // glasstrace.error.message
      const errorMessage = attrs["exception.message"];
      if (typeof errorMessage === "string") {
        extra[ATTR.ERROR_MESSAGE] = errorMessage;
      }

      // glasstrace.error.code + glasstrace.error.category
      // Guard against non-string attribute values (OTel attributes can be
      // string | number | boolean | Array) to prevent toLowerCase() throws.
      const errorType = attrs["exception.type"];
      if (typeof errorType === "string") {
        extra[ATTR.ERROR_CODE] = errorType;
        extra[ATTR.ERROR_CATEGORY] = deriveErrorCategory(errorType);
      }

      // glasstrace.error.field
      const errorField = attrs["error.field"];
      if (typeof errorField === "string") {
        extra[ATTR.ERROR_FIELD] = errorField;
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
  extra: Record<string, string | number>,
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
