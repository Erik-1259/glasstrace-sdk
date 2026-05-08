/**
 * Error evidence value-enum constants (SDK-041 / DISC-1535).
 *
 * Companion to the new `glasstrace.error.*` attribute keys in
 * `constants.ts`. The runtime `as const` tuples are the source of
 * truth for allowlisted attribute-value sets; TypeScript types are
 * derived via `typeof T[number]` so consumers get literal unions
 * without a separate string-literal-union declaration that could
 * silently drift from the runtime allowlist.
 *
 * These tuples align with the Agent Evidence Engine SDK Attribute
 * Contract §5.5 in `glasstrace-product/docs/component-designs/agent-evidence-sdk-attribute-contract.md`.
 * Members must remain in sync across both repos; product-side
 * validators enforce these allowlists at ingestion as a second
 * defense, not the primary boundary.
 *
 * @drift-check ../../glasstrace-product/docs/component-designs/agent-evidence-sdk-attribute-contract.md §5.5
 */

/**
 * Allowlisted source-provenance values for `glasstrace.error.source`.
 *
 * The SDK emits one of these to tell product consumers which surface
 * supplied each error fact. Values:
 *
 * - `otel_exception` — facts came from an OTel exception event
 *   (recordException() / span event with `name === "exception"`).
 * - `otel_event` — facts came from a non-exception span event that
 *   carried `exception.message` / `exception.type` attributes
 *   directly. Distinct from `otel_exception` so product can tell
 *   whether the exception path was taken or whether facts were
 *   piggybacked on another event class.
 * - `glasstrace_attribute` — facts came from a `glasstrace.error.*`
 *   span attribute set explicitly by an adapter or user code (e.g.,
 *   the tRPC handler wrapper populating `glasstrace.error.message`).
 * - `framework_runtime` — facts came from a framework runtime fault
 *   surface (Next.js `_error` page, route-handler unhandled
 *   rejection, etc.) where the SDK observed the failure but the
 *   underlying app exception type was not directly observable.
 * - `framework_fallback` — facts came from a framework fallback
 *   route (e.g., `/_error`, `/_not-found`); the SDK preserves the
 *   originally-requested path in `glasstrace.error.original_path`
 *   and the fallback route in `glasstrace.error.fallback_route`.
 * - `response_body` — facts came from a captured response body
 *   gated on `captureConfig.errorResponseBodies`; only set when
 *   the body itself was the source of the error message/code, not
 *   when a body was captured alongside other fact sources.
 *
 * Order of preference when multiple sources provide the same fact:
 * `otel_exception` > `otel_event` > `glasstrace_attribute` >
 * `framework_runtime` > `framework_fallback` > `response_body`.
 */
export const ERROR_SOURCE_VALUES = [
  "otel_exception",
  "otel_event",
  "glasstrace_attribute",
  "framework_runtime",
  "framework_fallback",
  "response_body",
] as const;

/**
 * One of the allowlisted source-provenance values.
 *
 * @see {@link ERROR_SOURCE_VALUES}
 */
export type ErrorSource = (typeof ERROR_SOURCE_VALUES)[number];

/**
 * Allowlisted framework-classification values for
 * `glasstrace.error.framework.kind`.
 *
 * Set when the SDK can classify the failure family beyond the
 * OTel-level `exception.type`. Values:
 *
 * - `runtime` — the framework reported the failure as a runtime
 *   fault (e.g., a Next.js route handler threw and was caught by
 *   the framework error boundary).
 * - `compile` — a compile-time diagnostic the SDK observed
 *   (Next.js dev-server module-resolution failure, etc.).
 *   Compile-diagnostic capture beyond the marker itself is gated
 *   behind a future capture policy and is NOT in the v1 contract;
 *   the SDK currently emits this kind only as a category marker
 *   when the existence of the diagnostic is observable.
 * - `fallback` — the failing request was rerouted by the framework
 *   to a fallback route (e.g., `/_error`, `/_not-found`); the SDK
 *   preserves the original request path in
 *   `glasstrace.error.original_path`.
 * - `unknown` — the SDK observed an error but could not classify
 *   the framework family. Distinct from "no value emitted at all"
 *   so product can tell deliberate uncertainty from missing
 *   evidence.
 */
export const ERROR_FRAMEWORK_KIND_VALUES = [
  "runtime",
  "compile",
  "fallback",
  "unknown",
] as const;

/**
 * One of the allowlisted framework-classification values.
 *
 * @see {@link ERROR_FRAMEWORK_KIND_VALUES}
 */
export type ErrorFrameworkKind =
  (typeof ERROR_FRAMEWORK_KIND_VALUES)[number];
