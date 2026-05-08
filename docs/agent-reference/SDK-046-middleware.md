<!-- version: 1 -->
# SDK-046 — Middleware-Ownership and Post-Response Async Instrumentation Brief

**Status:** scoping brief (Wave 15B-brief)
**Author:** SDK conductor
**Wave plan:** `../glasstrace-product/.claude/plans/2026-05-08-sdk-loose-ends-wave-15.md`
**Implements (downstream):** Wave 15B-impl
**Closes (downstream):** DISC-1537 (P2 PARTIAL), DISC-1539 (P3 PARTIAL)
**Companion:** product-side SDK-046 task brief at
`../glasstrace-product/docs/task-briefs/SDK-046.md` (1-133) — defines WHAT
product needs; this brief defines HOW the SDK delivers it.

## 0. Purpose and review class

This brief is the SDK-side scoping document for two related instrumentation
gaps:

1. Middleware-ownership tracing: the SDK has no hook today that emits
   `middleware_for_request` causal evidence linking a middleware-only span
   to its owning request trace (DISC-1537, R5 in the wave plan).
2. Post-response async tracing: the SDK has no hook today that links
   post-response work (Next.js `after()`, queue dispatchers, webhook
   fire-and-forget) to the originating request's trace (DISC-1539, R6 in
   the wave plan).

This is internal SDK documentation under
`docs/agent-reference/`. The brand-sensitive 500-pass implementation review
applies to Wave 15B-impl, NOT to this brief; brief authoring uses the
standard 100-pass baseline plus the high-integrity overlay
(`docs/agent-reference/high-integrity-briefing.md`). Every claim below is
either backed by a `file:line` citation or marked `uncertain` for
resolution at impl time.

## 1. Hook surface for middleware ownership (DISC-1537)

### 1.1 What the SDK has today (proved)

The SDK exposes one middleware primitive:
`tracedMiddleware<T extends MiddlewareFunction>(options, middleware): T`
at `packages/sdk/src/trpc/index.ts:191-325`. Behavior:

- Resolves the global tracer lazily (`trace.getTracer(TRACER_NAME)`,
  `packages/sdk/src/trpc/index.ts:209`) so it picks up whichever provider
  the SDK or a coexisting tool registered.
- Opens a span via `tracer.startActiveSpan(options.name, ...)`
  (`packages/sdk/src/trpc/index.ts:210`); inheriting whatever active OTel
  context the runtime exposes when tRPC's dispatcher calls the middleware
  (typically the HTTP server span).
- Forwards `trpc.path` and `trpc.type` from the runtime-supplied options
  (`packages/sdk/src/trpc/index.ts:226-237`).
- Three failure paths handled explicitly: thrown error (records exception,
  sets `ERROR` status, rethrows — `packages/sdk/src/trpc/index.ts:261-302`);
  short-circuit `{ ok: false }` result (sets `ERROR` status, no
  `recordException` — `packages/sdk/src/trpc/index.ts:252-258`); success
  (status left `UNSET` per OTel guidance —
  `packages/sdk/src/trpc/index.ts:152`).
- Always ends the span (`finally` at `packages/sdk/src/trpc/index.ts:303-315`).

The OTel context manager that makes parent/child relationships work is
installed by `installContextManager()` at
`packages/sdk/src/context-manager.ts:184`, called synchronously from
`packages/sdk/src/register.ts:241` before `configureOtel`. The manager
wraps `node:async_hooks#AsyncLocalStorage` (static import at
`packages/sdk/src/context-manager.ts:1`).

### 1.2 What the SDK does NOT have (proved)

`grep -rn "middleware_for_request\|glasstrace.causal" packages/sdk/src/`
returns zero matches (verified 2026-05-08, branch
`docs/sdk-046-middleware-scoping-brief` from origin/main `d3295a3`). There
is no instrumentation hook today that:

- Emits `glasstrace.causal.middleware_for_request` (or any
  `glasstrace.causal.*` attribute) on a span.
- Wraps Next.js `middleware.ts` exports for ownership attribution.
- Captures non-tRPC, non-Next middleware (Express-style, custom adapters).

The product-side brief at
`../glasstrace-product/docs/task-briefs/SDK-046.md:51-60` explicitly
requires emission of `middleware_for_request` causal evidence "only when
the SDK can prove the owning request" — i.e., new SDK code is required.

### 1.3 Existing helper that consumers use today (proved)

`captureCorrelationId(req)` at
`packages/sdk/src/correlation-id.ts:72-93` is the documented entry point
for a Next.js `middleware.ts` to enrich the active span with the
`x-gt-cid` correlation ID. It is intentionally a no-op when no active
span exists (`packages/sdk/src/correlation-id.ts:83-86`). 15B-impl SHOULD
treat this as the existing precedent for "user calls the SDK from
`middleware.ts`" patterns.

### 1.4 Recommended SDK-side hook surface (proposed)

15B-impl SHOULD add a new module
`packages/sdk/src/middleware/` (new directory; reserved by the wave
plan at line 207 of the wave plan). The recommended public surface, to be
finalized at impl time:

```ts
// @glasstrace/sdk/middleware  (new subpath, ESM + CJS)
export interface TracedRequestMiddlewareOptions {
  /** Span name. Required, non-empty string. */
  name: string;
  /** Optional pre-start attributes (forwarded as-is, not redacted). */
  attributes?: Record<string, AttributeValue>;
}

/**
 * Wrap a Next.js / generic-fetch middleware function. Emits a span
 * named `options.name` and tags it with the `glasstrace.causal.middleware_for_request`
 * attribute carrying the originating request's normalized path so the
 * product-side trace-summary transform can link the middleware span to
 * the owning request trace (DISC-1537, AESC §5.5).
 */
export function tracedRequestMiddleware<
  H extends (req: Request, ...rest: any[]) => Promise<Response> | Response,
>(options: TracedRequestMiddlewareOptions, handler: H): H;
```

Design notes (each MUST be re-verified at impl time):

- The wrapper SHOULD NOT statically import `next/server`. tRPC's existing
  helper (`packages/sdk/src/trpc/index.ts:16-22`) intentionally avoids
  `@trpc/server` runtime coupling for the same reason. 15B-impl follows
  the same structural-bound pattern.
- The originating request path SHOULD come from `req.nextUrl?.pathname`
  if present, falling back to parsing `req.url`. Marked `uncertain` —
  Next 16 may rewrite `req.url` for edge runtime; 15B-impl re-verifies.
- `glasstrace.causal.middleware_for_request` SHOULD be the proposed
  protocol attribute name. It MUST be added to
  `packages/protocol/src/constants.ts:GLASSTRACE_ATTRIBUTE_NAMES`
  (currently lines 12-111) before SDK code references it. Adding a
  protocol constant is a `@glasstrace/protocol` minor bump under the
  contract-change workflow in `CLAUDE.md` §"Contract Change Workflow".
- The middleware span MUST NOT overwrite `glasstrace.route`,
  `glasstrace.http.status_code`, or `glasstrace.http.duration_ms` on the
  parent HTTP span. These are root-request semantics owned by the
  enriching exporter (`packages/sdk/src/enriching-exporter.ts:234-378`).
  Per the product brief at
  `../glasstrace-product/docs/task-briefs/SDK-046.md:57-58`: "Do not
  overwrite the root request status, route, or duration with middleware
  or fallback evidence."

### 1.5 Edge runtime constraint (proved + uncertain)

Next.js 16 middleware runs in the Edge Runtime by default
(`packages/sdk/src/edge-entry.ts:11-22` documents the SDK's edge surface
constraints). Edge runtime does not provide:

- `node:async_hooks` / `AsyncLocalStorage`
  (`packages/sdk/src/context-manager.ts:142-147`).
- The `process` global
  (`packages/sdk/src/edge-entry.ts:11-22`).
- Any `node:*` built-in (`packages/sdk/src/edge-entry.ts:6-7`).

This means the middleware-ownership wrapper has TWO valid call sites:

1. Node-runtime middleware (user's `middleware.ts` declares
   `export const config = { runtime: "nodejs" }`). The full ALS-backed
   context manager works; spans inherit parent context automatically.
2. Edge-runtime middleware (default in Next 16). The SDK cannot install
   an ALS-backed context manager; spans created in this runtime have no
   inherited parent. The wrapper MUST fall back to attaching the
   originating request path via attribute (`glasstrace.causal.middleware_for_request`)
   and let the product-side transform reconstruct ownership from the
   path + correlation ID.

The exact fallback strategy is `uncertain` until 15B-impl verifies that
the SDK's `dist/edge-entry.js` build can host a middleware wrapper at all
(per the F003 closure scan at `packages/sdk/src/edge-entry.ts:6-7`). If
not, the brief narrows to "Node-runtime middleware only" and 15B-impl
files a discovery for the edge gap.

## 2. Hook surface for post-response async (DISC-1539)

### 2.1 What the SDK has today (proved)

`grep -rn "AsyncLocalStorage" packages/sdk/src/` returns one match:
`packages/sdk/src/context-manager.ts:1`. The SDK uses ALS exclusively to
back the OTel context manager for parent/child span propagation. There is
no continuation-passing wrapper, no `glasstrace.causal.post_response_async`
emission, no `after()`-style helper.

`grep -rn "post_response_async" packages/sdk/src/` returns zero matches
(verified 2026-05-08).

`grep -rn "queueMicrotask\|setTimeout\b" packages/sdk/src/` shows
`setTimeout` is used only for SDK-internal debouncing (runtime-state
writes at `packages/sdk/src/runtime-state.ts:117,235`; lifecycle wait
timeouts at `packages/sdk/src/lifecycle.ts:503-507,641`; HTTPS-transport
retry scheduling at `packages/sdk/src/https-transport.ts:184,329,365`).
None of these are user-facing continuation primitives.

### 2.2 What product needs from the SDK (proved)

`../glasstrace-product/docs/task-briefs/SDK-046.md:62-70`:
"Emit `post_response_async` causal evidence for Next `after()` callbacks,
email sends, webhooks, queue dispatches, or similar work only when the SDK
can prove the originating request. Preserve `affectsHttpStatus: false` and
`affectsHttpDuration: false` for non-outcome async work."

`../glasstrace-product/docs/discoveries/DISC-1539.md:51-58` lists three
shipped product-side facts the SDK must align with:
- product has a `post_response_async` causal-link contract (MCP-017).
- the read transform derives links from `glasstrace.causal.*` span
  attributes.
- root request HTTP status / route / duration are never rewritten by
  async links.

### 2.3 Recommended SDK-side hook surface (proposed)

15B-impl SHOULD add `packages/sdk/src/async-context/` (new directory;
reserved by the wave plan at line 209). One new helper:

```ts
// @glasstrace/sdk/async-context  (new subpath, ESM + CJS, Node-only)
/**
 * Capture the active OTel context (trace ID + span ID) at call time,
 * bind it to a callback, and emit a span when the callback runs. The
 * span carries `glasstrace.causal.post_response_async` referencing the
 * captured trace ID so the product-side transform can link the async
 * work to the originating request.
 *
 * Returns a continuation that runs `fn` inside the captured context.
 * Safe to call from a request handler immediately before scheduling
 * `after()`, a queue enqueue, or a webhook dispatch.
 */
export function withAsyncCausality<T>(
  spanName: string,
  fn: () => Promise<T> | T,
): () => Promise<T>;
```

Strategy decision: **continuation-passing wrapper with explicit captured
context**, NOT global ALS propagation.

Justification (proved):

- ALS propagation across Next.js `after()` is `uncertain` — Next 16's
  `after()` may or may not preserve ALS continuity depending on whether
  the framework-side hook scheduled it via `queueMicrotask` (preserves
  ALS) or via cross-tick scheduling (drops ALS). Relying on ALS
  continuity would couple the SDK to Next internals.
- Continuation-passing makes the causality explicit — the user wraps the
  callback they pass to `after()` / their queue. The captured context
  travels with the closure regardless of how the framework schedules it.
- The captured context is read via `trace.getActiveSpan()?.spanContext()`
  inside the wrapper, exactly the same primitive
  `captureCorrelationId()` uses
  (`packages/sdk/src/correlation-id.ts:83`). No new dependency.
- For environments without ALS (Edge runtime, older Node), the wrapper
  degrades cleanly: no active span at capture time → no causal attribute
  → no orphan trace, just a span with no causal link (matches the
  product brief's "missing or unknown evidence is preferable to guessed
  evidence" rule at SDK-046.md:69-70).

Constraints (each MUST be re-verified at impl time):

- The new attribute MUST be added to
  `packages/protocol/src/constants.ts:GLASSTRACE_ATTRIBUTE_NAMES`
  (currently lines 12-111). Proposed name:
  `glasstrace.causal.post_response_async` with companion attributes
  `glasstrace.causal.affects_http_status` (boolean, default `false`)
  and `glasstrace.causal.affects_http_duration` (boolean, default
  `false`) per the product brief at
  `../glasstrace-product/docs/task-briefs/SDK-046.md:67-68`.
- Spans emitted from inside the continuation MUST be linked to the
  originating trace via OTel `Link`s (preferred) OR via attribute-only
  causality (fallback when no captured `SpanContext` is available).
  Choice between the two is `uncertain` until 15B-impl verifies that
  the OTel API surface in the peer-dep range
  (`@opentelemetry/api ^1.9.0` per
  `packages/sdk/src/context-manager.ts:35-39`) supports the Link form
  consistently across both Node and edge bundles.
- If `withAsyncCausality` is called with NO active span (capture-time
  fail), it MUST still execute `fn` — the SDK is a tracing layer, not a
  control-flow layer, and async work must run regardless of trace
  state.

### 2.4 Edge runtime constraint (proved)

Per `packages/sdk/src/edge-entry.ts:1-49`, the edge bundle excludes
`node:*` built-ins and the `process` global. Since `withAsyncCausality`
does not require `node:async_hooks` (it captures a `SpanContext`
snapshot, not an ALS handle), the wrapper SHOULD be includable in the
edge bundle. The exact wiring is `uncertain` — 15B-impl re-runs the
F003 closure scan (`scripts/check-edge-bundle.mjs`,
referenced at `packages/sdk/src/edge-entry.ts:7`) before exporting the
new symbol from `edge-entry.ts`.

## 3. Failure modes

For each instrumentation hook in §1 and §2, document the expected
behavior and the observable signal.

| Hook | Failure mode | Expected SDK behavior | Observable signal |
|---|---|---|---|
| `tracedRequestMiddleware` | Middleware throws unhandled exception | Span ends with `ERROR` status + `recordException`; rethrows; handler span (if any) is NOT emitted because the wrapped `next()` never runs | OTel exception event on the middleware span; `glasstrace.error.*` attributes populated by the enriching exporter (`packages/sdk/src/enriching-exporter.ts:415-466`) |
| `tracedRequestMiddleware` | Middleware succeeds and `next()` invokes a handler | TWO spans under the same trace: middleware span (parent) and handler span (child); `glasstrace.causal.middleware_for_request` populated on the middleware span only | Trace tree has middleware → handler edge; root request span unchanged (route, status, duration preserved per `packages/sdk/src/enriching-exporter.ts:234,321,378`) |
| `tracedRequestMiddleware` | SDK not registered when middleware runs (early-init race) | Wrapper runs middleware unwrapped; no span emitted; no crash | `lifecycle.middleware.skipped_uninstalled` event (NEW; reserved); zero spans for that request from the middleware module |
| `tracedRequestMiddleware` | SDK in `OtelState.COEXISTENCE_FAILED` (Wave 11 / DISC-1556) | Wrapper still runs middleware; `tracer.getActiveSpan()` returns OTel noop tracer span; span emitted to noop, never reaches Glasstrace exporter | `runtime-state.json` `lastError.category === "auto-attach-returned-null"` per `packages/sdk/src/runtime-state.ts:84-107`; no Glasstrace-side trace observable |
| `tracedRequestMiddleware` | Span budget exhausted (sustained-load) | Middleware runs; OTel SDK drops span at the BatchSpanProcessor / exporter layer; user-visible request behavior unaffected | OTel internal diagnostic logs; NO new SDK-level signal in 15B (the export circuit breaker — Wave 15C — is the right surface for sustained-load signals) |
| `withAsyncCausality` | Called outside a request scope (no active span at capture time) | Wrapper runs `fn`; no causal attribute emitted; span is a root span with no link | `lifecycle.async.no_originating_context` event (NEW; reserved); span emitted with no `glasstrace.causal.*` attribute |
| `withAsyncCausality` | SDK not registered when `fn` is invoked | `fn` runs; no span emitted; no crash | `lifecycle.async.skipped_uninstalled` event (NEW; reserved); zero spans for the async work |
| `withAsyncCausality` | SDK in `OtelState.COEXISTENCE_FAILED` | `fn` runs; span emitted to noop tracer; never reaches Glasstrace exporter | Same as the middleware row — `runtime-state.json.lastError` populated; no observable trace |
| `withAsyncCausality` | `fn` throws | Span ends with `ERROR` status + `recordException`; error rethrows from the continuation | OTel exception event on the async span; same enrichment path as middleware |
| `withAsyncCausality` | Span budget exhausted (sustained-load) | `fn` runs; span dropped at exporter layer | Same as middleware — Wave 15C circuit breaker is the right signal layer |

The `lifecycle.middleware.*` and `lifecycle.async.*` event-name prefixes
are reserved for Wave 15B-impl per the wave plan at
`../glasstrace-product/.claude/plans/2026-05-08-sdk-loose-ends-wave-15.md:217`.
Existing convention in `packages/sdk/src/lifecycle.ts:133-170` is
`category:event` (colon-separated); 15B-impl will translate
`lifecycle.middleware.*` to `middleware:*` and `lifecycle.async.*` to
`async:*` keys on the `SdkLifecycleEvents` interface
(`packages/sdk/src/lifecycle.ts:133`). The dotted form is the brief's
documentation namespace; the colon form is the runtime contract.

## 4. Backward compatibility fence

Strict additivity. 15B-impl MUST satisfy all of the following:

- No changes to existing exported symbols' signatures or types in
  `packages/sdk/src/index.ts` or any shipped subpath. New symbols only,
  on new subpaths.
- No changes to existing OTel attribute names. New attributes MUST live
  under the `glasstrace.causal.*` namespace; the existing
  `glasstrace.error.*`, `glasstrace.http.*`, `glasstrace.trpc.*`,
  `glasstrace.session.*`, `glasstrace.side_effect.*` namespaces in
  `packages/protocol/src/constants.ts:14-110` are unaffected.
- No changes to the existing tracing surface — `tracedMiddleware`
  remains as documented at `packages/sdk/src/trpc/index.ts:191-325`.
  `enrichSpan` at `packages/sdk/src/enriching-exporter.ts:182-731`
  is unaffected; the new attributes are forwarded as-is by the existing
  span-attribute pass-through.
- No changes to the lifecycle state machines in
  `packages/sdk/src/lifecycle.ts:25-56` or the transition tables at
  `packages/sdk/src/lifecycle.ts:66-127`. New event keys are added to
  the `SdkLifecycleEvents` interface only.

Semver impact:

- `@glasstrace/sdk`: **minor bump**. Two new subpaths
  (`@glasstrace/sdk/middleware`, `@glasstrace/sdk/async-context`) are
  additive new instrumentation surface; not breaking. Aligns with the
  wave plan's stated semver impact at line 296 ("YES — new
  instrumentation surface for middleware/async causality. Minor bump.").
- `@glasstrace/protocol`: **minor bump**. New
  `GLASSTRACE_ATTRIBUTE_NAMES` entries
  (`MIDDLEWARE_FOR_REQUEST`, `POST_RESPONSE_ASYNC`,
  `CAUSAL_AFFECTS_HTTP_STATUS`, `CAUSAL_AFFECTS_HTTP_DURATION` —
  exact constant names finalized at impl time). Existing entries at
  `packages/protocol/src/constants.ts:14-110` are unaffected.

The contract-change workflow in `CLAUDE.md` §"Contract Change Workflow"
applies — protocol bump merges and canaries first; SDK consumes the
canary; product validates round-trip; both go stable together.

## 5. Test strategy

### 5.1 Required Vitest fixtures

Implementation PR adds tests under `tests/unit/sdk/middleware/` and
`tests/unit/sdk/async-context/` (both new directories), following the
existing pattern at `tests/unit/sdk/trpc/traced-middleware.test.ts`
(referenced at `tests/unit/sdk/trpc/traced-middleware.test.ts:155-450`)
and `tests/unit/sdk/trpc/traced-middleware-types.test.ts`.

### 5.2 Middleware-ownership scenarios (DISC-1537)

| Scenario | Assertion |
|---|---|
| Middleware wraps a successful handler | TWO spans under the same `traceId`; middleware span carries `glasstrace.causal.middleware_for_request === <originating-path>`; handler span has no `glasstrace.causal.*` attribute; root HTTP span's `glasstrace.route`, `glasstrace.http.status_code`, `glasstrace.http.duration_ms` are unmodified |
| Middleware throws | Middleware span has OTel exception event + `ERROR` status; the `next()` invocation is NOT reached, so handler span is absent; rethrow propagates to test caller |
| Middleware short-circuits via `{ ok: false }`-style return (Express-like fence) | Middleware span has `ERROR` status but NO `recordException`; mirrors `tracedMiddleware`'s tRPC path at `packages/sdk/src/trpc/index.ts:252-258` |
| Middleware runs in Edge runtime | If the symbol is exported from `edge-entry.ts`: span emits with attribute-based causality; no ALS dependency. If not exported: a separate test verifies the Node-runtime path only and the brief narrows |
| SDK not registered | `tracedRequestMiddleware`-wrapped function still produces a usable Response; no spans emitted; `lifecycle.middleware.skipped_uninstalled` event fires once |
| `OtelState.COEXISTENCE_FAILED` | Test stubs `runtime-state.json.lastError = { category: "auto-attach-returned-null", … }` per `packages/sdk/src/runtime-state.ts:84-107`; wrapper still runs but no Glasstrace-side span observable |

### 5.3 Post-response async scenarios (DISC-1539)

| Scenario | Assertion |
|---|---|
| `withAsyncCausality` captures inside an active request span and `fn` runs later | Async span carries `glasstrace.causal.post_response_async === <originating-trace-id>`; `glasstrace.causal.affects_http_status === false`; `glasstrace.causal.affects_http_duration === false`; root request span's `glasstrace.http.duration_ms` is computed BEFORE the async span ends |
| `withAsyncCausality` called outside a request scope | `fn` runs; span emits with no `glasstrace.causal.*` attribute; `lifecycle.async.no_originating_context` event fires once |
| `withAsyncCausality` with `fn` that throws | Async span has exception event + `ERROR` status; rethrow propagates to caller |
| Span link form vs attribute-only form | Whichever form 15B-impl picks (see §2.3), both must produce a deterministic link that the product transform at `../glasstrace-product/shared/transforms/trace-summary.ts` can resolve back to the originating trace per `../glasstrace-product/docs/discoveries/DISC-1539.md:55-58` |
| SDK not registered when async work fires | `fn` runs; no span; `lifecycle.async.skipped_uninstalled` event fires once |
| Two concurrent `withAsyncCausality` captures with different originating traces | Each async span carries the correct `<originating-trace-id>`; no cross-contamination from ALS replay |

### 5.4 Cross-cutting assertions

- Snapshot test on the published package surface: `tsc --emitDeclarationOnly`
  + `arethetypeswrong` showing only additive changes vs the previous
  release's `.d.ts`.
- Bundle-size test: middleware + async-context subpaths each under 2KB
  gzipped (matches the budget tRPC subpath holds at
  `packages/sdk/dist/trpc/index.js`).
- Edge bundle scan: `scripts/check-edge-bundle.mjs` (referenced at
  `packages/sdk/src/edge-entry.ts:7`) green before and after.

## 6. Reservations

### 6.1 Lifecycle event-name prefixes (15B reservation)

15B-brief reserves the following event-name prefixes per the wave plan
at `../glasstrace-product/.claude/plans/2026-05-08-sdk-loose-ends-wave-15.md:217`:

- `lifecycle.middleware.*` — middleware-ownership lifecycle events.
  Maps to `middleware:*` keys on `SdkLifecycleEvents` per the existing
  colon convention at `packages/sdk/src/lifecycle.ts:133-170`.
- `lifecycle.async.*` — post-response async lifecycle events. Maps to
  `async:*` keys.

15C-memo reserves `lifecycle.export.circuit.*` (mapping to
`export:circuit:*` keys). 15B-impl and 15C-impl MUST cross-check the
other sub-slice's brief/memo before adding events under either prefix.

### 6.2 DISC pre-allocation (15B-brief and 15B-impl)

The wave plan at line 248 pre-allocates DISC-1626, DISC-1627, DISC-1628
for discoveries surfaced during 15B work. Verified free on disk
2026-05-08 — `ls /Users/erik/SoftwareDevelopment/glasstrace-product/docs/discoveries/`
shows highest current ID is DISC-1623.

If brief authoring or impl surfaces a discovery, file it under the
lowest free reserved ID via the sub-agent worktree pattern in
`CLAUDE.md` §"Filing Discoveries". No discoveries surfaced during
brief authoring (this PR).

### 6.3 Cross-wave coherence

15B and 15C run in parallel through the brief/memo phase. Both touch
`packages/sdk/src/lifecycle.ts` (per the wave plan's file-conflict
table at line 211). Coordination is by event-name prefix reservation
above; neither sub-slice modifies the lifecycle state machines or
transition tables (`packages/sdk/src/lifecycle.ts:25-127`).

## 7. What this brief does NOT specify

Resolved at 15B-impl time; do not pre-commit here:

- Final exported symbol names (`tracedRequestMiddleware` is a working
  name; impl picks the published name).
- Final attribute constant names in `GLASSTRACE_ATTRIBUTE_NAMES`. The
  wire strings (`glasstrace.causal.middleware_for_request`,
  `glasstrace.causal.post_response_async`,
  `glasstrace.causal.affects_http_status`,
  `glasstrace.causal.affects_http_duration`) are recommended; the
  SCREAMING_SNAKE constant names are not finalized.
- Edge-runtime export decisions (whether
  `tracedRequestMiddleware` and/or `withAsyncCausality` ship in
  `dist/edge-entry.js`). 15B-impl runs the F003 closure scan at impl
  time; the answer drives the brief's narrowing in §1.5 and §2.4.
- The Span-Link vs attribute-only choice for `withAsyncCausality`
  (§2.3). Impl-time recon against `@opentelemetry/api ^1.9.0` resolves.
- The product canary's exact verification scenario list. The wave plan
  at line 137 reserves "live verification on a Next 16 production
  canary build" for 15B-impl; the canary scenarios derive from the
  Vitest fixtures in §5.

## 8. Recon citation index

All citations against `origin/main` at SHA `d3295a3` (verified
2026-05-08).

| Citation | Used in §| Status |
|---|---|---|
| `packages/sdk/src/trpc/index.ts:191-325` | §1.1, §5.2 | proved |
| `packages/sdk/src/trpc/index.ts:209-210` | §1.1 | proved |
| `packages/sdk/src/trpc/index.ts:226-237` | §1.1 | proved |
| `packages/sdk/src/trpc/index.ts:252-258` | §1.1, §5.2 | proved |
| `packages/sdk/src/trpc/index.ts:261-302` | §1.1 | proved |
| `packages/sdk/src/trpc/index.ts:303-315` | §1.1 | proved |
| `packages/sdk/src/trpc/index.ts:16-22` | §1.4 | proved |
| `packages/sdk/src/context-manager.ts:1` | §1.1, §2.1 | proved |
| `packages/sdk/src/context-manager.ts:35-39` | §2.3 | proved |
| `packages/sdk/src/context-manager.ts:142-147` | §1.5 | proved |
| `packages/sdk/src/context-manager.ts:184` | §1.1 | proved |
| `packages/sdk/src/correlation-id.ts:72-93` | §1.3 | proved |
| `packages/sdk/src/correlation-id.ts:83-86` | §1.3 | proved |
| `packages/sdk/src/correlation-id.ts:83` | §2.3 | proved |
| `packages/sdk/src/edge-entry.ts:1-49` | §2.4 | proved |
| `packages/sdk/src/edge-entry.ts:6-7` | §1.5, §5.4 | proved |
| `packages/sdk/src/edge-entry.ts:7` | §2.4, §5.4 | proved |
| `packages/sdk/src/edge-entry.ts:11-22` | §1.5 | proved |
| `packages/sdk/src/enriching-exporter.ts:182-731` | §4 | proved |
| `packages/sdk/src/enriching-exporter.ts:234,321,378` | §3 | proved |
| `packages/sdk/src/enriching-exporter.ts:415-466` | §3 | proved |
| `packages/sdk/src/lifecycle.ts:25-56` | §4 | proved |
| `packages/sdk/src/lifecycle.ts:66-127` | §4 | proved |
| `packages/sdk/src/lifecycle.ts:133-170` | §3, §6.1 | proved |
| `packages/sdk/src/lifecycle.ts:503-507,641` | §2.1 | proved |
| `packages/sdk/src/register.ts:241` | §1.1 | proved |
| `packages/sdk/src/runtime-state.ts:84-107` | §3, §5.2 | proved |
| `packages/sdk/src/runtime-state.ts:117,235` | §2.1 | proved |
| `packages/sdk/src/https-transport.ts:184,329,365` | §2.1 | proved |
| `packages/protocol/src/constants.ts:12-111` | §1.4, §2.3 | proved |
| `packages/protocol/src/constants.ts:14-110` | §4 | proved |
| `tests/unit/sdk/trpc/traced-middleware.test.ts:155-450` | §5.1 | proved |
| `../glasstrace-product/docs/task-briefs/SDK-046.md:1-133` | header | proved |
| `../glasstrace-product/docs/task-briefs/SDK-046.md:51-60` | §1.2 | proved |
| `../glasstrace-product/docs/task-briefs/SDK-046.md:57-58` | §1.4 | proved |
| `../glasstrace-product/docs/task-briefs/SDK-046.md:62-70` | §2.2 | proved |
| `../glasstrace-product/docs/task-briefs/SDK-046.md:67-68` | §2.3 | proved |
| `../glasstrace-product/docs/task-briefs/SDK-046.md:69-70` | §2.3 | proved |
| `../glasstrace-product/docs/discoveries/DISC-1539.md:51-58` | §2.2 | proved |
| `../glasstrace-product/docs/discoveries/DISC-1539.md:55-58` | §5.3 | proved |
| `../glasstrace-product/.claude/plans/2026-05-08-sdk-loose-ends-wave-15.md:207` | §1.4 | proved |
| `../glasstrace-product/.claude/plans/2026-05-08-sdk-loose-ends-wave-15.md:209` | §2.3 | proved |
| `../glasstrace-product/.claude/plans/2026-05-08-sdk-loose-ends-wave-15.md:211` | §6.3 | proved |
| `../glasstrace-product/.claude/plans/2026-05-08-sdk-loose-ends-wave-15.md:217` | §3, §6.1 | proved |
| `../glasstrace-product/.claude/plans/2026-05-08-sdk-loose-ends-wave-15.md:248` | §6.2 | proved |
| Edge runtime fallback strategy (§1.5) | §1.5 | uncertain |
| `req.nextUrl?.pathname` reliability under Next 16 (§1.4) | §1.4 | uncertain |
| OTel `Link` form vs attribute-only causality (§2.3) | §2.3 | uncertain |
| Edge-bundle export of `withAsyncCausality` (§2.4) | §2.4 | uncertain |

44 proved file:line citations. 4 uncertain claims, all flagged inline
for resolution at 15B-impl time per the high-integrity overlay's
recon-disagreement rule
(`docs/agent-reference/high-integrity-briefing.md:50-58`).
