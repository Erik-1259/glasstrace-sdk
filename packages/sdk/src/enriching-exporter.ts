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
import {
  coerceHttpStatus,
  isHttpErrorStatus,
  prepareErrorResponseBody,
} from "./error-response-body.js";
import { prepareStack } from "./error-stack.js";
import { getBuildHash } from "./build-info.js";
import {
  getExportCircuitBreaker,
  type ExportCircuitBreaker,
} from "./export-circuit-breaker.js";
import {
  emitLifecycleEvent,
  pushDegradationSource,
  clearDegradationSource,
} from "./lifecycle.js";

const ATTR = GLASSTRACE_ATTRIBUTE_NAMES;

/**
 * Sentinel value indicating the API key has not yet been resolved.
 */
export const API_KEY_PENDING = "pending" as const;

/**
 * Maximum number of spans to buffer while waiting for key resolution.
 * Prevents unbounded memory growth if the key never resolves.
 *
 * @drift-check ../glasstrace-product/docs/component-designs/sdk-architecture.md §5.4 Buffering during KEY_PENDING
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
  /**
   * Lazily-bound reference to the export-path circuit breaker
   * (DISC-1568 / Wave 15C). Resolved on first export so this
   * constructor stays side-effect-free. The breaker is a module-
   * singleton — every `GlasstraceExporter` instance shares the same
   * one so a rotation event observed in `init-client.ts` reaches
   * every active exporter.
   */
  private circuitBreaker: ExportCircuitBreaker | null = null;

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

  /**
   * Returns the export-path circuit breaker, lazily wiring it on
   * first call. The breaker is a module-singleton so all exporter
   * instances share state — a credential rotation observed once
   * resets the breaker for every active exporter, and a single
   * outage at the OTLP endpoint trips a single breaker rather than
   * one per exporter copy.
   *
   * The wiring binds:
   * - the lifecycle event sink to the SDK's lifecycle bus
   *   (`emitLifecycleEvent`) so the `otel:circuit_*` events surface
   *   to runtime-state, the CLI bridge, and any user-installed
   *   subscribers.
   * - the dropped-span counter to {@link recordSpansDropped} so OPEN-
   *   state drops show up in the existing health surface.
   * - the FSM hooks to {@link pushDegradationSource} /
   *   {@link clearDegradationSource} keyed on `"export-circuit"`,
   *   which routes the OPEN/CLOSED transitions through the
   *   centralised `recomputeCoreFromDegradationSources()` helper.
   *   That helper guards `ACTIVE ↔ ACTIVE_DEGRADED` so a circuit
   *   recovery never clobbers an unrelated `OtelState.COEXISTENCE_FAILED`
   *   degradation source.
   */
  private getCircuitBreaker(): ExportCircuitBreaker {
    if (this.circuitBreaker !== null) return this.circuitBreaker;
    this.circuitBreaker = getExportCircuitBreaker({
      events: {
        emitOpened: (payload) => emitLifecycleEvent("otel:circuit_opened", payload),
        emitHalfOpen: (payload) => emitLifecycleEvent("otel:circuit_half_open", payload),
        emitClosed: (payload) => emitLifecycleEvent("otel:circuit_closed", payload),
      },
      recordDropped: (count) => recordSpansDropped(count),
      fsm: {
        onCircuitOpened: () => pushDegradationSource("export-circuit"),
        onCircuitClosed: () => clearDegradationSource("export-circuit"),
      },
    });
    return this.circuitBreaker;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const currentKey = this.getApiKey();
    if (currentKey === API_KEY_PENDING) {
      // Buffer raw (unenriched) spans — enrichment deferred to flush time
      // so session IDs are computed with the resolved key, not "pending".
      this.bufferSpans(spans, resultCallback);
      return;
    }

    // Circuit-breaker gate (DISC-1568 / Wave 15C). When OPEN, drop
    // the batch entirely: increment the dropped-spans health counter
    // and call back with `{ code: 0 }` so the BSP retries nothing
    // (the OPEN window itself is the backoff). The decision to drop
    // (rather than buffer) is documented in the design memo §Decision 4
    // — buffering during OPEN created the permanent-export-disabled
    // failure mode the original PR #26 had to revert.
    const breaker = this.getCircuitBreaker();
    if (!breaker.shouldExport()) {
      breaker.onSpansDropped(spans.length);
      resultCallback({ code: 0 });
      return;
    }

    // Key is available — enrich and export
    const enrichedSpans = spans.map((span) => this.enrichSpan(span));
    const exporter = this.ensureDelegate();
    if (exporter) {
      // Snapshot the breaker's generation counter so a credential
      // rotation that fires while this batch is in flight can be
      // detected on the result callback (memo §Decision 7 edge case).
      // The probe-during-rotation race must NOT push a stale failure
      // into the post-rotation breaker.
      const generationAtIssue = breaker.getGeneration();
      exporter.export(enrichedSpans, (result) => {
        if (result.code !== 0) {
          sdkLog("warn", `[glasstrace] Span export failed: ${result.error?.message ?? "unknown error"}`);
        }
        // Discard the result if the breaker rotated mid-flight.
        if (breaker.getGeneration() !== generationAtIssue) {
          resultCallback(result);
          return;
        }
        if (result.code === 0) {
          breaker.recordSuccess();
        } else {
          breaker.recordFailure({ error: result.error });
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

      // glasstrace.build.hash (DISC-1543 / SDK-040).
      // Stamped from `process.env.GLASSTRACE_BUILD_HASH` captured at
      // module load by `build-info.ts`. Ingestion uses the value to
      // construct the sourcemap blob key
      // (`sourcemaps/{accountId}/{buildHash}/{file}`); a missing hash
      // leaves stored traces' `buildHash` column null and prevents the
      // dashboard from rendering mapped frames for those traces. The
      // SDK silently omits the attribute when the env var is unset so
      // deployments that have not adopted the convention behave
      // exactly as before.
      const buildHash = getBuildHash();
      if (buildHash) {
        extra[ATTR.BUILD_HASH] = buildHash;
      }

      // glasstrace.correlation.id
      const existingCid = attrs["glasstrace.correlation.id"];
      if (typeof existingCid === "string") {
        extra[ATTR.CORRELATION_ID] = existingCid;
      }

      // glasstrace.route
      // OTel's AttributeValue allows non-string shapes (number, boolean,
      // array) on `http.route`. A custom instrumentation could set a
      // non-string there and blow up `.trim()` / `.startsWith()` calls
      // below; guard with typeof so malformed route attributes fall back
      // to `name` (always a string per OTel span contract) instead of
      // disabling all enrichment for the span.
      const rawRoute = attrs["http.route"];
      const route = typeof rawRoute === "string" ? rawRoute : name;
      if (route) {
        extra[ATTR.ROUTE] = route;
      }

      // Capture the raw HTTP URL once; multiple downstream blocks
      // depend on it (tRPC procedure extraction, SDK-041 framework
      // fallback original-path detection). Variable name reflects
      // its general HTTP-URL role rather than any single use site.
      const rawUrlAttr = attrs["http.url"] ?? attrs["url.full"] ?? attrs["http.target"];
      const rawHttpUrl = typeof rawUrlAttr === "string" ? rawUrlAttr : undefined;

      // glasstrace.trpc.procedure
      // Extract tRPC procedure name from URL path (DISC-1215).
      // Pattern: /api/trpc/{procedure} where procedure is a single path segment
      // that may contain dots (polls.modify) or commas (batched: proc1,proc2).
      if (rawHttpUrl) {
        const trpcMatch = rawHttpUrl.match(/\/api\/trpc\/([^/?#]+)/);
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
      //
      // OTel attribute values are typed
      // `string | number | boolean | (string | number | boolean)[]`.
      // Several real-world instrumentations (custom HTTP wrappers,
      // edge runtimes that round-trip headers verbatim, some community
      // Node adapters) emit `http.status_code` and
      // `http.response.status_code` as strings. A TypeScript `as number`
      // cast applies no runtime coercion, so a string-shaped `"200"`
      // would (a) flow verbatim into the wire payload — downstream
      // ingestion and UI assume numeric — and (b) defeat the inference
      // block below (`statusCode === 200` is `false` for `"200"`),
      // silently failing the Next.js timing-race promotion
      // (DISC-1134 / DISC-1204) on string-status spans (DISC-1551).
      // `coerceHttpStatus` returns `number | undefined` at runtime, not
      // just at the TS type level.
      const statusCode =
        coerceHttpStatus(attrs["http.status_code"]) ??
        coerceHttpStatus(attrs["http.response.status_code"]);
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

      // Gate on SpanKind.SERVER. A boundary-masked HTTP *response* status
      // belongs to an inbound request span. OTel CLIENT spans (outbound
      // fetch, DB-over-HTTP, the SDK's own OTLP export POST) also carry
      // `http.method`, and a failed outbound request typically has an
      // exception event / ERROR status with no/200 status — without this
      // gate it would be wrongly promoted to a 500 + boundary_masked,
      // surfacing as a spurious error trace. Mirrors the explicit
      // `span.kind === SpanKind.CLIENT` gate on the fetch-target
      // classifier below. SERVER (not `!== CLIENT`) is correct here:
      // the only inbound request spans carrying `http.method` in this
      // stack (`@opentelemetry/instrumentation-http` incoming, Next.js
      // request spans) are SERVER kind, so narrowing to SERVER fixes the
      // false positive without losing any legitimate promotion.
      if (method && span.kind === SpanKind.SERVER && statusNotExplicitlyOK && (isErrorByStatus || isErrorByEvent || isErrorByAttrs)) {
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

          // SDK-051 / DISC-1125 — boundary-masked-error audit attribute.
          // Set to true exactly when the inference block fires. Strict
          // additivity: backend ignores unknown attributes today; this
          // surface is for downstream observability of heuristic
          // activation rate. Same-span scope only — descendant-traversal
          // (the page-route boundary case) is tracked in a follow-up DISC.
          extra[ATTR.HTTP_BOUNDARY_MASKED] = true;

          // Emit lifecycle event for subscribers (informational; the
          // heuristic's behavior does NOT depend on subscribers). The
          // payload's `exceptionMessage` is truncated to 256 chars and is
          // the same content already on the span's exception event — no
          // new disclosure surface beyond the trace itself.
          const inferredStatus = extra[ATTR.HTTP_STATUS_CODE] as number;
          const eventDetails = getExceptionEventDetails(span);
          const exceptionMessage = eventDetails.message
            ?? (typeof attrs["exception.message"] === "string"
                  ? (attrs["exception.message"] as string)
                  : undefined);
          emitLifecycleEvent("core:error_boundary_detected", {
            spanId: span.spanContext().spanId,
            inferredStatus,
            ...(exceptionMessage !== undefined
              ? { exceptionMessage: exceptionMessage.slice(0, 256) }
              : {}),
          });

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
        : { type: undefined, message: undefined, stacktrace: undefined };

      // SDK-041 / DISC-1535: track which surface produced the error
      // facts so product consumers can tell `otel_exception` (event)
      // from `otel_event` (`exception.*` set as span attributes) from
      // `framework_fallback` (route-rewrite). Set on any span where
      // we emit at least one of the new `glasstrace.error.*`
      // attributes; falls through to undefined when no error attrs
      // land.
      //
      // Precedence: `otel_exception > otel_event > framework_fallback`.
      // The exception event is the canonical OTel surface for
      // exceptions (it's what `recordException()` emits); attributes
      // are a non-canonical alternative some instrumentations use.
      // When both are present, the event wins so downstream evidence
      // ranking treats the canonical surface as the more authoritative
      // source.
      let errorSource: string | undefined;

      // Prefer the exception event; fall back to span attributes
      // (this inverts SDK <= 1.5.x precedence, which preferred span
      // attrs — that ordering mislabeled provenance and lost the
      // canonical-OTel-surface signal).
      const attrMessage = attrs["exception.message"];
      if (eventDetails.message) {
        extra[ATTR.ERROR_MESSAGE] = eventDetails.message;
        errorSource = "otel_exception";
      } else if (typeof attrMessage === "string") {
        extra[ATTR.ERROR_MESSAGE] = attrMessage;
        errorSource = "otel_event";
      }

      // Guard against non-string attribute values (OTel attributes can be
      // string | number | boolean | Array) to prevent toLowerCase() throws.
      const attrType = attrs["exception.type"];
      if (eventDetails.type) {
        extra[ATTR.ERROR_CODE] = eventDetails.type;
        extra[ATTR.ERROR_CATEGORY] = deriveErrorCategory(eventDetails.type);
        errorSource = errorSource ?? "otel_exception";
      } else if (typeof attrType === "string") {
        extra[ATTR.ERROR_CODE] = attrType;
        extra[ATTR.ERROR_CATEGORY] = deriveErrorCategory(attrType);
        errorSource = errorSource ?? "otel_event";
      }

      // glasstrace.error.stack + glasstrace.error.stack.{truncated,redacted}
      // SDK-041 / DISC-1535. Bounded `exception.stacktrace` capture,
      // sanitized for absolute paths + URL query/fragment + credential
      // patterns, then truncated to a UTF-8 byte budget. Sibling
      // metadata attributes carry truncated/redacted booleans so
      // product can disclaim partial evidence to agents.
      //
      // Read precedence mirrors the new event-first error.message
      // ordering: the OTel exception event (set by `recordException()`)
      // is the canonical primary source; an `exception.stacktrace`
      // span attribute is the fallback for instrumentations that
      // bypass the event mechanism. Same statusNotExplicitlyOK gate
      // as message/type so a recovered span doesn't get labeled with
      // a handled exception's stack.
      if (statusNotExplicitlyOK) {
        const rawStack = eventDetails.stacktrace
          ?? (typeof attrs["exception.stacktrace"] === "string"
                ? (attrs["exception.stacktrace"] as string)
                : undefined);
        if (rawStack) {
          const prepared = prepareStack(rawStack);
          if (prepared !== null) {
            extra[ATTR.ERROR_STACK] = prepared.stack;
            extra[ATTR.ERROR_STACK_TRUNCATED] = prepared.truncated;
            extra[ATTR.ERROR_STACK_REDACTED] = prepared.redacted;
            // Stack source mirrors the message/type source so a span
            // with both facts gets a consistent provenance label.
            errorSource = errorSource
              ?? (eventDetails.stacktrace ? "otel_exception" : "otel_event");
          }
        }
      }

      // glasstrace.error.framework.kind + glasstrace.error.original_path + glasstrace.error.fallback_route
      // SDK-041 / DISC-1535 / AESC §5.5. When a request reaches a
      // framework fallback route (Next.js `/_error`, `/_not-found`,
      // etc.), the framework rewrites `http.route` to the fallback,
      // which loses the originally requested path. We preserve both:
      //
      //   - `glasstrace.route` continues to carry whatever the
      //     framework set (so existing consumers keep working).
      //   - `glasstrace.error.fallback_route` carries the fallback
      //     path explicitly.
      //   - `glasstrace.error.original_path` carries the concrete
      //     requested path, parsed from `http.url` / `url.full` /
      //     `http.target` (whichever the upstream instrumentation
      //     populated). Path-only — no query, no fragment.
      //
      // We only mark a fallback when both (a) the route looks like a
      // known fallback AND (b) we have an original path that
      // differs. Otherwise we'd label an actual visit to `/_error`
      // (an app might have a real `/_error` page) as a framework
      // fallback by accident.
      const routeIsFallback =
        route === "/_error" ||
        route === "/_not-found" ||
        route === "/_404" ||
        route === "/_500";
      if (routeIsFallback && rawHttpUrl) {
        const originalPath = extractPathOnly(rawHttpUrl);
        // Normalize trailing slashes on both sides before the
        // differ check so frameworks/proxies that round-trip a
        // trailing slash on `http.url` (e.g., `/_error/`) don't
        // produce a false-positive fallback marker on a real visit
        // to the literal fallback page (Codex P2 review on PR #251).
        const normOriginal = stripTrailingSlash(originalPath);
        const normRoute = stripTrailingSlash(route);
        if (normOriginal && normOriginal !== normRoute) {
          extra[ATTR.ERROR_ORIGINAL_PATH] = normOriginal;
          extra[ATTR.ERROR_FALLBACK_ROUTE] = route;
          extra[ATTR.ERROR_FRAMEWORK_KIND] = "fallback";
          // Promote to framework_fallback only when no upstream OTel
          // source has already claimed provenance — otherwise we'd
          // overwrite a more specific `otel_exception` label with a
          // less specific framework one.
          errorSource = errorSource ?? "framework_fallback";
        }
      }

      if (errorSource !== undefined) {
        extra[ATTR.ERROR_SOURCE] = errorSource;
      }

      if (this.verbose && (extra[ATTR.ERROR_MESSAGE] || extra[ATTR.ERROR_CODE])) {
        // Source label reflects which surface won under the new
        // event-first precedence (SDK-041 / DISC-1535).
        const msgSource = eventDetails.message ? "event"
          : typeof attrMessage === "string" ? "attrs"
          : "none";
        const typeSource = eventDetails.type ? "event"
          : typeof attrType === "string" ? "attrs"
          : "none";
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

      // glasstrace.error.response_body (DISC-1216)
      //
      // Adapters (e.g., a tRPC handler wrapper) populate the internal
      // attribute `glasstrace.internal.response_body` on the active span
      // when an HTTP handler returns a 4xx/5xx body. The exporter
      // conditionally promotes it to the public attribute under three
      // gates:
      //
      //   1. Account opt-in via `captureConfig.errorResponseBodies`. The
      //      flag defaults to `false`, so capture is off unless the
      //      account has explicitly enabled it server-side.
      //   2. HTTP status in the inclusive range [400..599]. We read the
      //      *enriched* status (`extra[HTTP_STATUS_CODE]`) first because
      //      the inference block above may have promoted a misreported
      //      0/200 to 5xx based on `error.type` / exception events; if
      //      that block did not run we fall through to the raw OTel
      //      attributes. A successful response (2xx/3xx) never leaks
      //      even if an adapter mistakenly populated the internal attr.
      //   3. Body shape: must be a non-empty string. Binary streams,
      //      `null`, and structured values are silently ignored.
      //
      // Before promotion the body is (a) sanitized to redact common
      // secret patterns (Bearer tokens, JWTs, Glasstrace API keys, AWS
      // access keys, generic key/secret/password/token=value pairs) and
      // (b) truncated to a UTF-8 byte budget with a `...[truncated]`
      // marker appended when truncation fires. Sanitization runs before
      // truncation so secrets straddling the boundary are still removed
      // from the visible portion.
      if (this.getConfig().errorResponseBodies) {
        const responseBody = attrs["glasstrace.internal.response_body"];
        if (typeof responseBody === "string") {
          // Prefer the enriched status from the inference block above
          // (covers the Next.js timing-race promotion of 0/200 → 5xx);
          // fall back to the raw `statusCode` computed earlier which
          // already merges `http.status_code` and `http.response.status_code`.
          const enrichedStatus = extra[ATTR.HTTP_STATUS_CODE];
          const effectiveStatus =
            typeof enrichedStatus === "number" ? enrichedStatus : statusCode;
          if (isHttpErrorStatus(effectiveStatus)) {
            const prepared = prepareErrorResponseBody(responseBody);
            if (prepared !== null) {
              extra[ATTR.ERROR_RESPONSE_BODY] = prepared;
            }
          }
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
   *
   * Honors the circuit breaker symmetrically with {@link export}: if the
   * breaker is OPEN at flush time, every buffered batch is dropped via
   * `recordSpansDropped` and its callback completed with `{ code: 0 }`,
   * preserving the bounded-memory contract during outages.
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

    const breaker = this.getCircuitBreaker();
    const batches = this.pendingBatches;
    this.pendingBatches = [];
    this.pendingSpanCount = 0;

    for (const batch of batches) {
      // Circuit-breaker gate: honor OPEN state on flush too (buffered
      // batches that survive a key-pending → key-resolved transition
      // arrive here and would otherwise bypass the gate).
      if (!breaker.shouldExport()) {
        breaker.onSpansDropped(batch.spans.length);
        batch.resultCallback({ code: 0 });
        continue;
      }
      // Enrich at flush time with the now-resolved key
      const enriched = batch.spans.map((span) => this.enrichSpan(span));
      const generationAtIssue = breaker.getGeneration();
      exporter.export(enriched, (result) => {
        if (result.code !== 0) {
          sdkLog("warn", `[glasstrace] Span export failed: ${result.error?.message ?? "unknown error"}`);
        }
        if (breaker.getGeneration() !== generationAtIssue) {
          batch.resultCallback(result);
          return;
        }
        if (result.code === 0) {
          breaker.recordSuccess();
        } else {
          breaker.recordFailure({ error: result.error });
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
  stacktrace: string | undefined;
} {
  const event = span.events?.find((e) => e.name === "exception");
  if (!event?.attributes) {
    return { type: undefined, message: undefined, stacktrace: undefined };
  }
  const type = event.attributes["exception.type"];
  const message = event.attributes["exception.message"];
  const stacktrace = event.attributes["exception.stacktrace"];
  return {
    type: typeof type === "string" ? type : undefined,
    message: typeof message === "string" ? message : undefined,
    stacktrace: typeof stacktrace === "string" ? stacktrace : undefined,
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
 * Strips a trailing `/` from a path so two paths that differ only in
 * trailing-slash form compare equal. Used by the SDK-041 framework-
 * fallback differ check; frameworks/proxies inconsistently round-trip
 * trailing slashes between `http.route` and `http.url`, and a
 * literal-string compare without normalization would produce
 * false-positive fallback markers on real visits to a literal
 * `/_error` page (Codex P2 review on PR #251).
 *
 * Returns the original input for `undefined` and for the root path
 * `"/"` (where stripping the slash would lose the path entirely);
 * otherwise returns the input with any single trailing slash removed.
 */
function stripTrailingSlash(path: string | undefined): string | undefined {
  if (!path) return path;
  if (path === "/") return path;
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * Extracts the path component (no query, no fragment) from a URL or
 * a bare path. Used by the SDK-041 framework-fallback handler to
 * compute `glasstrace.error.original_path` from the upstream
 * `http.url` / `url.full` / `http.target` value when a request gets
 * rewritten to a fallback route like `/_error`.
 *
 * Accepts:
 *
 *   - Absolute URLs: `http://host:3000/api/storage/x?foo=bar` → `/api/storage/x`
 *   - Protocol-relative URLs: `//host/api/x?q=y` → `/api/x`
 *   - Bare paths with query/fragment: `/api/x?q=y#z` → `/api/x`
 *   - Bare paths: `/api/x` → `/api/x`
 *
 * Returns `undefined` for empty / whitespace-only input or values
 * that do not contain a recognizable path component (e.g.
 * `mailto:...`, `data:...`, or arbitrary non-URL strings). Callers
 * use the undefined return as a truthy guard.
 *
 * Rejects values that don't ultimately resolve to a `/`-prefixed
 * path so the framework-fallback handler doesn't accidentally
 * promote a non-path URL into `glasstrace.error.original_path`.
 */
export function extractPathOnly(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  // URL parser handles absolute URLs (`http://...`, `https://...`)
  // and protocol-relative URLs (`//host/path`); both forms have a
  // recognizable scheme prefix. Only invoke the parser for those
  // forms — invoking it on arbitrary relative strings like
  // `"api/users"` resolves them against the sentinel base
  // (`http://_/api/users`) and silently coerces a non-path input
  // into a fake path, which would falsely emit
  // `glasstrace.error.original_path` for unparseable upstream
  // values (Copilot review on PR #251).
  const isAbsoluteUrl = /^https?:\/\//i.test(trimmed);
  const isProtocolRelative = trimmed.startsWith("//");
  if (isAbsoluteUrl || isProtocolRelative) {
    try {
      const parsed = new URL(trimmed, "http://_/");
      if (parsed.pathname && parsed.pathname.startsWith("/")) {
        return parsed.pathname;
      }
    } catch {
      // Fall through to bare-path fast path below.
    }
  }

  // Bare-path fast path: strip query/fragment if present. Requires
  // a leading `/` so we don't accept `"api/users"` as if it were a
  // path.
  if (trimmed.startsWith("/")) {
    const queryIdx = trimmed.indexOf("?");
    const fragIdx = trimmed.indexOf("#");
    let cut = trimmed.length;
    if (queryIdx >= 0) cut = Math.min(cut, queryIdx);
    if (fragIdx >= 0) cut = Math.min(cut, fragIdx);
    return trimmed.slice(0, cut);
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
