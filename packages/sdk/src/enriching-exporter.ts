import { SpanKind } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { ExportResult } from "@opentelemetry/core";
import { GLASSTRACE_ATTRIBUTE_NAMES } from "@glasstrace/protocol";
import type { CaptureConfig } from "@glasstrace/protocol";
import type { SessionManager } from "./session.js";
import { classifyFetchTarget } from "./fetch-classifier.js";

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
      exporter.export(enrichedSpans, resultCallback);
    } else {
      // No delegate factory — report success so the pipeline does not stall
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

  forceFlush(): Promise<void> {
    if (this.delegate?.forceFlush) {
      return this.delegate.forceFlush();
    }
    return Promise.resolve();
  }

  /**
   * Enriches a ReadableSpan with all glasstrace.* attributes.
   * Returns a new ReadableSpan wrapper; the original span is not mutated.
   * Each attribute derivation is wrapped in its own try-catch for partial
   * enrichment resilience.
   */
  private enrichSpan(span: ReadableSpan): ReadableSpan {
    const attrs = span.attributes ?? {};
    const name = span.name ?? "";
    const extra: Record<string, string | number> = {};

    // glasstrace.trace.type
    try {
      extra[ATTR.TRACE_TYPE] = "server";
    } catch {
      // omitted
    }

    // glasstrace.session.id — computed at export time with the current API key
    try {
      const sessionId = this.sessionManager.getSessionId(this.getApiKey());
      extra[ATTR.SESSION_ID] = sessionId;
    } catch {
      // Session ID omitted for this span
    }

    // glasstrace.environment
    try {
      const env = this.environment ?? process.env.GLASSTRACE_ENV;
      if (env) {
        extra[ATTR.ENVIRONMENT] = env;
      }
    } catch {
      // omitted
    }

    // glasstrace.correlation.id
    try {
      const existingCid = attrs["glasstrace.correlation.id"];
      if (typeof existingCid === "string") {
        extra[ATTR.CORRELATION_ID] = existingCid;
      }
    } catch {
      // omitted
    }

    // glasstrace.route
    try {
      const route =
        (attrs["http.route"] as string | undefined) ?? name;
      if (route) {
        extra[ATTR.ROUTE] = route;
      }
    } catch {
      // omitted
    }

    // glasstrace.http.method
    try {
      const method =
        (attrs["http.method"] as string | undefined) ??
        (attrs["http.request.method"] as string | undefined);
      if (method) {
        extra[ATTR.HTTP_METHOD] = method;
      }
    } catch {
      // omitted
    }

    // glasstrace.http.status_code
    try {
      const statusCode =
        (attrs["http.status_code"] as number | undefined) ??
        (attrs["http.response.status_code"] as number | undefined);
      if (statusCode !== undefined) {
        extra[ATTR.HTTP_STATUS_CODE] = statusCode;
      }
    } catch {
      // omitted
    }

    // glasstrace.http.duration_ms
    try {
      if (span.startTime && span.endTime) {
        const [startSec, startNano] = span.startTime;
        const [endSec, endNano] = span.endTime;
        const durationMs =
          (endSec - startSec) * 1000 + (endNano - startNano) / 1_000_000;
        if (durationMs >= 0) {
          extra[ATTR.HTTP_DURATION_MS] = durationMs;
        }
      }
    } catch {
      // omitted
    }

    // glasstrace.error.message
    try {
      const errorMessage = attrs["exception.message"] as string | undefined;
      if (errorMessage) {
        extra[ATTR.ERROR_MESSAGE] = errorMessage;
      }
    } catch {
      // omitted
    }

    // glasstrace.error.code + glasstrace.error.category
    try {
      const errorType = attrs["exception.type"] as string | undefined;
      if (errorType) {
        extra[ATTR.ERROR_CODE] = errorType;
        extra[ATTR.ERROR_CATEGORY] = deriveErrorCategory(errorType);
      }
    } catch {
      // omitted
    }

    // glasstrace.error.field
    try {
      const errorField = attrs["error.field"] as string | undefined;
      if (errorField) {
        extra[ATTR.ERROR_FIELD] = errorField;
      }
    } catch {
      // omitted
    }

    // glasstrace.orm.*
    try {
      // Support both OTel >=1.9 (instrumentationScope) and <1.9 (instrumentationLibrary)
      const spanAny = span as unknown as Record<string, { name?: string } | undefined>;
      const instrumentationName =
        (spanAny.instrumentationScope?.name ?? spanAny.instrumentationLibrary?.name) ?? "";
      const ormProvider = deriveOrmProvider(instrumentationName);
      if (ormProvider) {
        extra[ATTR.ORM_PROVIDER] = ormProvider;

        const model =
          (attrs["db.sql.table"] as string | undefined) ??
          (attrs["db.prisma.model"] as string | undefined);
        if (model) {
          extra[ATTR.ORM_MODEL] = model;
        }

        const operation = attrs["db.operation"] as string | undefined;
        if (operation) {
          extra[ATTR.ORM_OPERATION] = operation;
        }
      }
    } catch {
      // omitted
    }

    // glasstrace.fetch.target
    try {
      const url =
        (attrs["http.url"] as string | undefined) ??
        (attrs["url.full"] as string | undefined);
      if (url && span.kind === SpanKind.CLIENT) {
        extra[ATTR.FETCH_TARGET] = classifyFetchTarget(url);
      }
    } catch {
      // omitted
    }

    return createEnrichedSpan(span, extra);
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
      // No delegate factory — complete callbacks and discard
      for (const batch of this.pendingBatches) {
        batch.resultCallback({ code: 0 });
      }
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
      exporter.export(enriched, batch.resultCallback);
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
