// @glasstrace/sdk

/**
 * Internal SDK error class with a typed diagnostic code.
 * Caught at the boundary and converted to a log message; never thrown to the developer.
 */
export { SdkError } from "./errors.js";

/**
 * Reads all recognized Glasstrace environment variables from `process.env`,
 * including `GLASSTRACE_*`, `NODE_ENV`, and `VERCEL_ENV`.
 *
 * {@link resolveConfig} merges explicit options with environment variables,
 * returning a {@link ResolvedConfig} used throughout the SDK.
 *
 * {@link isProductionDisabled} returns `true` when the SDK should be inactive
 * (production detected without `GLASSTRACE_FORCE_ENABLE=true`).
 *
 * {@link isAnonymousMode} returns `true` when no real API key is configured
 * (undefined, empty, or `gt_anon_*` prefix).
 */
export {
  readEnvVars,
  resolveConfig,
  isProductionDisabled,
  isAnonymousMode,
} from "./env-detection.js";

/**
 * Resolved SDK configuration after merging explicit options with environment variables.
 */
export type { ResolvedConfig } from "./env-detection.js";

/**
 * {@link deriveSessionId} computes a deterministic 16-character hex session ID
 * from an API key, origin, date, and 4-hour window index using SHA-256.
 *
 * {@link getOrigin} returns the deployment origin string (`GLASSTRACE_ENV` or
 * `localhost:{PORT}`).
 *
 * {@link getDateString} returns the current UTC date as `YYYY-MM-DD`.
 *
 * {@link SessionManager} tracks session state with automatic 4-hour window
 * rotation and date/key change detection.
 */
export {
  deriveSessionId,
  getOrigin,
  getDateString,
  SessionManager,
} from "./session.js";

/**
 * Classifies an outbound fetch URL into a known target category
 * (`supabase`, `stripe`, `internal`, or `unknown`) based on hostname matching.
 */
export { classifyFetchTarget } from "./fetch-classifier.js";

/**
 * The set of recognized fetch target categories returned by {@link classifyFetchTarget}.
 */
export type { FetchTarget } from "./fetch-classifier.js";

/**
 * {@link getOrCreateAnonKey} reads or generates an anonymous API key persisted
 * to `.glasstrace/anon_key`, with atomic write and ephemeral in-memory fallback.
 *
 * {@link readAnonKey} reads an existing anonymous key from disk without creating one.
 */
export { getOrCreateAnonKey, readAnonKey } from "./anon-key.js";

/**
 * {@link loadCachedConfig} reads and validates a cached init response from
 * `.glasstrace/config`. Returns `null` on any failure.
 *
 * {@link saveCachedConfig} persists an init response to disk for offline startup.
 *
 * {@link sendInitRequest} sends a `POST /v1/sdk/init` request to the ingestion API
 * and validates the response against `SdkInitResponseSchema`.
 *
 * {@link performInit} orchestrates the full init flow (request, cache, claim handling)
 * and never throws.
 *
 * {@link getActiveConfig} returns the current capture config from a three-tier
 * fallback chain: in-memory, file cache, then built-in defaults.
 *
 * {@link getLinkedAccountId} returns the `linkedAccountId` from the current
 * in-memory init response, or `undefined` if unavailable.
 */
export {
  loadCachedConfig,
  saveCachedConfig,
  sendInitRequest,
  performInit,
  getActiveConfig,
  getLinkedAccountId,
} from "./init-client.js";

/**
 * Result returned by {@link performInit} when the backend reports an
 * account claim transition. `null` means no claim was present.
 */
export type { InitClaimResult } from "./init-client.js";

/**
 * Lightweight SpanProcessor that delegates to a wrapped processor.
 * All enrichment has moved to {@link GlasstraceExporter}; this class is
 * retained for backward compatibility.
 *
 * @deprecated Use {@link GlasstraceExporter} for span enrichment.
 */
export { GlasstraceSpanProcessor } from "./span-processor.js";

/**
 * SpanExporter that enriches spans with `glasstrace.*` attributes at export time,
 * buffers spans while the API key is pending, and delegates to an OTLP exporter.
 */
export { GlasstraceExporter } from "./enriching-exporter.js";

/**
 * Configuration options for constructing a {@link GlasstraceExporter}.
 */
export type { GlasstraceExporterOptions } from "./enriching-exporter.js";

/**
 * Creates a request handler for the `/__glasstrace/config` discovery endpoint.
 * Returns `null` for non-matching paths. On a successful `GET`, responds with the
 * anonymous key and current session ID; other methods or error states return
 * appropriate HTTP error responses. CORS is restricted to known browser extension origins.
 *
 * When provided, the `getClaimState` callback includes `claimed` and optional
 * `accountHint` fields in the response for the browser extension.
 */
export { createDiscoveryHandler } from "./discovery-endpoint.js";

/**
 * Claim state shape returned by the `getClaimState` callback passed to
 * {@link createDiscoveryHandler}.
 */
export type { ClaimState } from "./discovery-endpoint.js";

/**
 * {@link registerGlasstrace} is the primary SDK entry point. Call it in
 * `instrumentation.ts` to start tracing. It is synchronous and never throws.
 *
 * {@link getDiscoveryHandler} returns the registered discovery handler, or
 * `null` if not registered (e.g., production mode or non-anonymous auth).
 *
 * @see {@link registerGlasstrace}
 */
export {
  registerGlasstrace,
  getDiscoveryHandler,
} from "./register.js";

/**
 * Wraps a Next.js config object to enable server-side source map generation
 * and automatic upload of `.map` files to the Glasstrace ingestion API at build time.
 * The build never fails because of Glasstrace -- all errors are caught and logged.
 */
export { withGlasstraceConfig } from "./config-wrapper.js";

/**
 * {@link isReady} returns true when the SDK is in ACTIVE or ACTIVE_DEGRADED state.
 *
 * {@link waitForReady} returns a Promise that resolves when the SDK is ready,
 * or rejects if the SDK enters a terminal state (production disabled, registration
 * failed) or times out.
 *
 * {@link getStatus} returns a simplified public view of the SDK state —
 * ready/mode/tracing — suitable for display or programmatic checks.
 * All fields are now backed by real runtime code (auth wired in SDK-024,
 * OTel wired in SDK-025).
 */
export { isReady, waitForReady, getStatus } from "./lifecycle.js";

/**
 * {@link createGlasstraceSpanProcessor} creates a span processor for manual
 * integration with an existing OTel provider (e.g., Sentry).
 *
 * Use this when another tool owns the OTel provider and you want to add
 * Glasstrace to their processor list. `registerGlasstrace()` is still
 * required for init, config sync, session management, and health reporting.
 */
export { createGlasstraceSpanProcessor } from "./coexistence.js";

/**
 * {@link discoverSourceMapFiles} walks a build directory and returns metadata
 * for all `.map` files without reading their content into memory.
 *
 * {@link collectSourceMaps} recursively finds all `.map` files in a build directory.
 * @deprecated Prefer {@link discoverSourceMapFiles} to avoid loading all source maps
 * into memory simultaneously.
 *
 * {@link computeBuildHash} returns a build identifier (git SHA or content hash fallback).
 *
 * {@link uploadSourceMaps} uploads source maps via `POST /v1/source-maps`.
 *
 * {@link PRESIGNED_THRESHOLD_BYTES} is the byte threshold (4.5 MB) above which
 * uploads route to the presigned 3-phase flow.
 *
 * {@link uploadSourceMapsPresigned} orchestrates the 3-phase presigned upload
 * (request tokens, upload to blob storage, submit manifest).
 *
 * {@link uploadSourceMapsAuto} automatically routes uploads based on total build
 * size, falling back to legacy upload when `@vercel/blob` is unavailable.
 */
export {
  discoverSourceMapFiles,
  collectSourceMaps,
  computeBuildHash,
  uploadSourceMaps,
  PRESIGNED_THRESHOLD_BYTES,
  uploadSourceMapsPresigned,
  uploadSourceMapsAuto,
} from "./source-map-uploader.js";

/**
 * {@link SourceMapFileInfo} represents metadata for a discovered source map file
 * without its content loaded, used by the streaming upload flow.
 *
 * {@link SourceMapEntry} represents a single source map file with its path and content.
 *
 * {@link BlobUploader} is the signature for the blob upload function, injectable for testing.
 *
 * {@link AutoUploadOptions} configures {@link uploadSourceMapsAuto} with optional
 * test overrides for blob availability and upload behavior.
 */
export type {
  SourceMapFileInfo,
  SourceMapEntry,
  BlobUploader,
  AutoUploadOptions,
} from "./source-map-uploader.js";

/**
 * Records an error as a span event on the currently active OTel span.
 * Works regardless of the `consoleErrors` config -- this is an explicit,
 * opt-in API for manual error reporting. Silently ignored when no span is active.
 */
export { captureError } from "./capture-error.js";

/**
 * Reads the `x-gt-cid` header from an incoming request and sets it as
 * `glasstrace.correlation.id` on the active OTel span. Call it from a
 * Next.js `middleware.ts` or a custom server request hook so Server
 * Action traces can be correlated with Glasstrace browser extension data
 * (DISC-1253).
 */
export { captureCorrelationId } from "./correlation-id.js";

/**
 * Request shape accepted by {@link captureCorrelationId}. Works with both
 * Fetch-API `Request` / `NextRequest` and Node `IncomingMessage`.
 */
export type { CorrelationIdRequest } from "./correlation-id.js";

/**
 * {@link discoverTestFiles} scans a project directory for test files matching
 * conventional patterns (`.test.ts`, `.spec.ts`) and custom vitest/jest config.
 *
 * {@link extractImports} parses ES module imports, CommonJS requires, and dynamic
 * imports from file content using regex.
 *
 * {@link buildImportGraph} combines discovery and extraction to produce an
 * `ImportGraphPayload` mapping test files to their imports.
 */
export {
  discoverTestFiles,
  extractImports,
  buildImportGraph,
} from "./import-graph.js";
