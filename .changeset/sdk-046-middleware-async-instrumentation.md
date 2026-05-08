---
"@glasstrace/sdk": minor
"@glasstrace/protocol": minor
---

feat(sdk): middleware-ownership and post-response async tracing
(DISC-1537 + DISC-1539 / SDK-046)

Two new instrumentation surfaces ship under additive subpaths.

### `@glasstrace/sdk/middleware` — `tracedRequestMiddleware`

Wraps a Next.js `middleware.ts` (or any generic Web Fetch-shaped
middleware function) and emits a span tagged with the
`glasstrace.causal.middleware_for_request` causal-evidence attribute
carrying the originating request's normalized path. The product-side
trace summary uses this attribute to link the middleware span back to
the owning HTTP request trace even when the middleware runs in the
Edge Runtime, where AsyncLocalStorage parents are not propagated.

The wrapper is admissible to the SDK's edge bundle: its closure
imports only `@opentelemetry/api`, `@glasstrace/protocol`, and the
edge-safe lifecycle bridge — no `node:*` built-ins and no `process`
reads. The F003 closure scan
(`packages/sdk/scripts/check-edge-bundle.mjs`) enforces this on every
build.

Path extraction prefers `req.nextUrl?.pathname` (set on
`NextRequest`), falling back to parsing `req.url` via the WHATWG `URL`
constructor (with a synthesized base when `req.url` is relative).
When neither is parseable the causal attribute is omitted, per the
"missing or unknown evidence is preferable to guessed evidence" rule.

### `@glasstrace/sdk/async-context` — `withAsyncCausality`

A continuation-passing wrapper that captures the active OTel
`SpanContext` at call time and binds it to a callback. When the
callback runs later (Next.js `after()`, queue dispatchers, webhook
fire-and-forget), the resulting async span carries:

- An OpenTelemetry `Link` to the captured `SpanContext` (the OTel-
  native form, surfaces in standard OTel-aware UIs as a "follows
  from" relationship), and
- The `glasstrace.causal.post_response_async` attribute carrying the
  originating trace ID (the transform-readable form), plus
  `glasstrace.causal.affects_http_status = false` and
  `glasstrace.causal.affects_http_duration = false` documenting that
  the async work does NOT participate in the root request's outcome.

Both channels are emitted together so the SDK is robust to downstream
transforms that resolve causality through either form. The wrapper
emits the async span as a NEW root span (not parented to the
originating trace) because post-response work runs outside the
originating request's OTel context.

Continuation-passing was chosen over global ALS propagation because
ALS continuity across `after()` is uncertain — Next.js may schedule
via `queueMicrotask` (preserves ALS) or via cross-tick scheduling
(drops ALS). Continuation-passing makes the causality explicit: the
captured `SpanContext` travels with the closure regardless of how the
framework schedules it.

The wrapper is also admissible to the edge bundle for the same reason
as the middleware wrapper.

### Lifecycle events

Three new events extend `SdkLifecycleEvents` under colon-namespaced
prefixes (matching the existing `core:*`, `auth:*`, `otel:*`, and
`health:*` convention):

- `middleware:skipped_uninstalled` — `tracedRequestMiddleware`
  invoked before the SDK is registered. The wrapped middleware still
  runs; the span landed on the noop tracer.
- `async:skipped_uninstalled` — `withAsyncCausality` continuation
  fired before the SDK is registered.
- `async:no_originating_context` — `withAsyncCausality` invoked
  outside any active request span (no captured `SpanContext` at call
  time). The continuation still runs without a causal link.

Each event is emitted at most once per process. Payloads are empty
(no PII surface).

A new edge-safe lifecycle bridge (`packages/sdk/src/optional-lifecycle.ts`)
delivers events from edge-bundle-resident wrappers to the Node-only
lifecycle module via a `Symbol.for()`-keyed `globalThis` slot; the
slot is unset in edge runtimes and the emit call falls through as a
clean no-op.

### Protocol additions (`@glasstrace/protocol` minor)

Four new wire keys in `GLASSTRACE_ATTRIBUTE_NAMES`:

- `CAUSAL_MIDDLEWARE_FOR_REQUEST` —
  `glasstrace.causal.middleware_for_request`
- `CAUSAL_POST_RESPONSE_ASYNC` —
  `glasstrace.causal.post_response_async`
- `CAUSAL_AFFECTS_HTTP_STATUS` —
  `glasstrace.causal.affects_http_status`
- `CAUSAL_AFFECTS_HTTP_DURATION` —
  `glasstrace.causal.affects_http_duration`

Existing constants are unchanged; this is a strict additive minor
bump.

### Backward compatibility

Strict additivity. No existing exported symbol's signature or type
changed; no existing OTel attribute name changed; no existing
lifecycle event was renamed or removed; the lifecycle state machines
and transition tables are untouched. Existing
`@glasstrace/sdk/trpc` `tracedMiddleware` is unaffected.

Closes the SDK-side gap behind DISC-1537 (middleware-ownership
causal evidence) and DISC-1539 (post-response async causal evidence).
