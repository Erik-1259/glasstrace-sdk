/**
 * SDK constants.
 */

import type { CaptureConfig } from "./config.js";

/**
 * All glasstrace.* semantic attribute keys used by the SDK.
 *
 * @drift-check OpenTelemetry Semantic Conventions (https://opentelemetry.io/docs/specs/semconv/) + ../glasstrace-product/docs/component-designs/sdk-architecture.md §7.5 Span attributes (Tier 1)
 */
export const GLASSTRACE_ATTRIBUTE_NAMES = {
  // Server-side attributes
  TRACE_TYPE: "glasstrace.trace.type",
  SESSION_ID: "glasstrace.session.id",
  CORRELATION_ID: "glasstrace.correlation.id",
  ENVIRONMENT: "glasstrace.environment",
  ROUTE: "glasstrace.route",
  HTTP_METHOD: "glasstrace.http.method",
  HTTP_STATUS_CODE: "glasstrace.http.status_code",
  HTTP_DURATION_MS: "glasstrace.http.duration_ms",
  /**
   * Boolean audit attribute set to `true` only when the SDK's
   * boundary-masked-error heuristic at `enriching-exporter.ts`
   * fires (SDK-051 / DISC-1125 — same-span scope; descendant-traversal
   * scope is tracked in a follow-up DISC).
   *
   * Strict additivity: backend ingestion ignores unknown attributes
   * today; this attribute is for audit/observability. Downstream
   * tooling MAY surface heuristic activation rates by querying for
   * spans with this attribute set; the backend's status-handling
   * pipeline does NOT depend on it.
   *
   * Absent on spans where the heuristic did not fire.
   */
  HTTP_BOUNDARY_MASKED: "glasstrace.http.boundary_masked",
  ERROR_MESSAGE: "glasstrace.error.message",
  ERROR_CODE: "glasstrace.error.code",
  ERROR_CATEGORY: "glasstrace.error.category",
  ERROR_FIELD: "glasstrace.error.field",

  // Error evidence v1 (SDK-041 / DISC-1535).
  // Additive to the existing `glasstrace.error.*` family. Bounded
  // stacktrace input for the product-side StackSummary parser
  // (SCHEMA-033); plus framework-fallback markers so the original
  // request path is preserved when Next.js (or another framework)
  // rewrites the route to a fallback like `/_error` or `/_not-found`;
  // plus a source-provenance enum so product can tell which surface
  // emitted each error fact (`exception.message` event vs span attr
  // vs response body vs framework runtime).
  //
  // Wire keys remain in `glasstrace.error.*` for namespace consistency
  // with the Tier-1 `error.message` / `error.code` / `error.category`
  // attributes already in this registry.
  ERROR_STACK: "glasstrace.error.stack",
  ERROR_STACK_TRUNCATED: "glasstrace.error.stack.truncated",
  ERROR_STACK_REDACTED: "glasstrace.error.stack.redacted",
  ERROR_SOURCE: "glasstrace.error.source",
  ERROR_FRAMEWORK_KIND: "glasstrace.error.framework.kind",
  ERROR_ORIGINAL_PATH: "glasstrace.error.original_path",
  ERROR_FALLBACK_ROUTE: "glasstrace.error.fallback_route",
  ORM_PROVIDER: "glasstrace.orm.provider",
  ORM_MODEL: "glasstrace.orm.model",
  ORM_OPERATION: "glasstrace.orm.operation",
  ORM_DURATION_MS: "glasstrace.orm.duration_ms",
  FETCH_URL: "glasstrace.fetch.url",
  FETCH_METHOD: "glasstrace.fetch.method",
  FETCH_STATUS_CODE: "glasstrace.fetch.status_code",
  FETCH_DURATION_MS: "glasstrace.fetch.duration_ms",
  FETCH_TARGET: "glasstrace.fetch.target",
  ENV_REFERENCED: "glasstrace.env.referenced",
  BUILD_HASH: "glasstrace.build.hash",
  SOURCE_FILE: "glasstrace.source.file",
  SOURCE_LINE: "glasstrace.source.line",
  SOURCE_MAPPED: "glasstrace.source.mapped",
  TRPC_PROCEDURE: "glasstrace.trpc.procedure",
  /**
   * Zero-based positional index of the current member within a tRPC
   * HTTP-batch dispatch (SDK-052 / DISC-1534 SDK-side slice). Set on
   * member spans by `tracedMiddleware` when the SDK's
   * `wrapBatchedHttpHandler` envelope is in scope. Numeric.
   *
   * Load-bearing for batches that include the same procedure name
   * more than once — name-only matching cannot disambiguate, so the
   * positional index is the canonical disambiguator. Absent on
   * non-batched spans and on apps not using `wrapBatchedHttpHandler`.
   */
  TRPC_BATCH_MEMBER_INDEX: "glasstrace.trpc.batch.member_index",
  /**
   * Ordered list of all procedure names in the current tRPC HTTP
   * batch (SDK-052 / DISC-1534 SDK-side slice). Stored as an OTel
   * typed string array (`string[]`), NOT a JSON-encoded string —
   * the typed-array form preserves first-class queryability in the
   * OTel ingest pipeline.
   *
   * Set on each member span that `tracedMiddleware` produces when a
   * `wrapBatchedHttpHandler` envelope is in scope. Absent on
   * non-batched spans, on the root HTTP server span (today's
   * release ships strict-additive scope only — per-root-span
   * attribution is deferred to a follow-up wave because changing
   * the root span's existing `glasstrace.trpc.procedure` shape from
   * comma-joined to first-member representative is non-additive),
   * and on apps not using `wrapBatchedHttpHandler`.
   */
  TRPC_BATCH_MEMBER_PROCEDURES:
    "glasstrace.trpc.batch.member_procedures",
  ERROR_RESPONSE_BODY: "glasstrace.error.response_body",
  NEXT_ACTION_DETECTED: "glasstrace.next.action.detected",

  // Client-side attributes
  PLATFORM: "glasstrace.platform",
  GESTURE_TYPE: "glasstrace.gesture.type",
  TRIGGER_TYPE: "glasstrace.trigger.type",
  ELEMENT_FINGERPRINT: "glasstrace.element.fingerprint",
  ELEMENT_CONFIDENCE: "glasstrace.element.confidence",
  TAB_ID: "glasstrace.tab.id",

  // Causal evidence (SDK-046 / DISC-1537 + DISC-1539).
  //
  // The SDK emits `glasstrace.causal.*` attributes on spans that
  // carry instrumentation-time evidence about a span's relationship
  // to its owning request trace. Two families are defined here:
  //
  //   - `MIDDLEWARE_FOR_REQUEST` — middleware-ownership marker. Set
  //     on a middleware-only span by `tracedRequestMiddleware()` from
  //     `@glasstrace/sdk/middleware`. Carries the originating
  //     request's normalized path so the product-side trace-summary
  //     transform can link the middleware span to the owning HTTP
  //     request trace even when the middleware runs in an edge
  //     runtime that does not propagate AsyncLocalStorage parents.
  //
  //   - `POST_RESPONSE_ASYNC` — post-response async marker. Set on a
  //     span emitted from inside `withAsyncCausality()` from
  //     `@glasstrace/sdk/async-context`. Carries the originating
  //     request's trace ID (32-character hex) captured at the call
  //     site so async work scheduled via Next.js `after()`, queues,
  //     or webhooks can be linked back to its originating request.
  //     Companion booleans `CAUSAL_AFFECTS_HTTP_STATUS` /
  //     `CAUSAL_AFFECTS_HTTP_DURATION` document whether the async
  //     work participates in the root request's outcome (default
  //     `false` — non-outcome async work).
  //
  // Wire keys live under the `glasstrace.causal.*` namespace so they
  // are namespace-distinct from `glasstrace.error.*`,
  // `glasstrace.http.*`, `glasstrace.trpc.*`, and the side-effect
  // family below. Adding these constants is a `@glasstrace/protocol`
  // minor bump; existing entries are untouched.
  CAUSAL_MIDDLEWARE_FOR_REQUEST: "glasstrace.causal.middleware_for_request",
  CAUSAL_POST_RESPONSE_ASYNC: "glasstrace.causal.post_response_async",
  CAUSAL_AFFECTS_HTTP_STATUS: "glasstrace.causal.affects_http_status",
  CAUSAL_AFFECTS_HTTP_DURATION: "glasstrace.causal.affects_http_duration",

  // Side-effect evidence (SDK-049 / SCHEMA-036).
  // Top-level operation attributes attached to the active span when a
  // side-effect is recorded via `recordSideEffect()`. The wire-string
  // set aligns verbatim with the product-side filter in
  // `packages/ingestion/src/services/trace-writer.ts`.
  SIDE_EFFECT_KIND: "glasstrace.side_effect.kind",
  SIDE_EFFECT_OPERATION: "glasstrace.side_effect.operation",
  SIDE_EFFECT_STATUS: "glasstrace.side_effect.status",
  SIDE_EFFECT_PHASE: "glasstrace.side_effect.phase",

  // Allowlisted semantic field attributes — one per allowlisted key.
  // Wire keys are camelCase to match the SCHEMA-036 enum members
  // exactly; the SDK constant names are SCREAMING_SNAKE per the rest
  // of GLASSTRACE_ATTRIBUTE_NAMES.
  SIDE_EFFECT_FIELD_TEMPLATE_KEY: "glasstrace.side_effect.field.templateKey",
  SIDE_EFFECT_FIELD_PROVIDER_OPERATION:
    "glasstrace.side_effect.field.providerOperation",
  SIDE_EFFECT_FIELD_ROLE: "glasstrace.side_effect.field.role",
  SIDE_EFFECT_FIELD_LOCALE: "glasstrace.side_effect.field.locale",
  SIDE_EFFECT_FIELD_TIMEZONE: "glasstrace.side_effect.field.timezone",
  SIDE_EFFECT_FIELD_STATUS: "glasstrace.side_effect.field.status",
  SIDE_EFFECT_FIELD_PHASE: "glasstrace.side_effect.field.phase",
  SIDE_EFFECT_FIELD_RECIPIENT_CLASS:
    "glasstrace.side_effect.field.recipientClass",
  SIDE_EFFECT_FIELD_PARTICIPANT_COUNT:
    "glasstrace.side_effect.field.participantCount",
  SIDE_EFFECT_FIELD_ACTIVE_PARTICIPANT_COUNT:
    "glasstrace.side_effect.field.activeParticipantCount",

  // Omission reason attributes — one per allowlisted reason. The
  // attribute value carries an integer count; the rejected value is
  // never echoed.
  SIDE_EFFECT_OMITTED_PII: "glasstrace.side_effect.omitted.pii",
  SIDE_EFFECT_OMITTED_SECRET: "glasstrace.side_effect.omitted.secret",
  SIDE_EFFECT_OMITTED_RAW_PAYLOAD:
    "glasstrace.side_effect.omitted.raw_payload",
  SIDE_EFFECT_OMITTED_UNSUPPORTED_KEY:
    "glasstrace.side_effect.omitted.unsupported_key",
  SIDE_EFFECT_OMITTED_VALUE_TOO_LONG:
    "glasstrace.side_effect.omitted.value_too_long",
  SIDE_EFFECT_OMITTED_NOT_EMITTED:
    "glasstrace.side_effect.omitted.not_emitted",
  SIDE_EFFECT_OMITTED_CAPTURE_DISABLED:
    "glasstrace.side_effect.omitted.capture_disabled",
} as const;

/** Default SDK capture config (conservative defaults). */
export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  requestBodies: false,
  queryParamValues: false,
  envVarValues: false,
  fullConsoleOutput: false,
  importGraph: false,
  consoleErrors: false,
  errorResponseBodies: false,
  sideEffectEvidence: false,
};

// --- Source map upload limits ---
//
// These constants mirror the backend canonical bounds enforced on the
// presigned source map upload pipeline. They are exported from
// `@glasstrace/protocol` so SDK code and external tooling that consumes
// the wire schemas can reference the same numeric ceilings the backend
// applies at write time, instead of duplicating literal magic numbers.

/**
 * Maximum length, in characters, of a source map `filePath` carried in the
 * presigned upload wire schemas.
 *
 * Backend-canonical: applied to `PresignedUploadResponseSchema.files[].filePath`,
 * `PresignedUploadRequestSchema.files[].filePath`, and
 * `SourceMapManifestRequestSchema.files[].filePath`.
 */
export const MAX_SOURCE_MAP_FILE_PATH_LENGTH = 512;

/**
 * Maximum size, in bytes, of an individual source map file (50 MiB).
 *
 * Backend-canonical: applied to `PresignedUploadResponseSchema.files[].maxBytes`,
 * `PresignedUploadRequestSchema.files[].sizeBytes`, and
 * `SourceMapManifestRequestSchema.files[].sizeBytes`.
 */
export const MAX_SOURCE_MAP_FILE_SIZE = 50 * 1024 * 1024;

/**
 * Maximum number of source map files per presigned upload request or
 * manifest activation.
 *
 * Backend-canonical: applied to the top-level `files` array bound on
 * `PresignedUploadRequestSchema`, `PresignedUploadResponseSchema`, and
 * `SourceMapManifestRequestSchema`.
 */
export const MAX_SOURCE_MAP_FILE_COUNT = 100;
