---
"@glasstrace/sdk": patch
---

fix(sdk): wave-15b instrumentation hardening — defensive try/catch around
tracer calls; path-attribute privacy documentation; regression tests for
the sampler-drop and span-activation review fixes (Wave 15B-impl
post-merge review)

Surfaces from a 500-pass adversarial review of PR #262 after merge.
Codex was unavailable for that PR (config issue) and Copilot caught
two of three substantive bugs, but the post-merge review found four
P2 hardening items that warranted a patch.

## Defensive instrumentation

Both `tracedRequestMiddleware` (`@glasstrace/sdk/middleware`) and
`withAsyncCausality` (`@glasstrace/sdk/async-context`) now wrap their
respective `tracer.startActiveSpan` / `tracer.startSpan` calls in
try/catch. OTel's noop tracer never throws, but a real provider
under a misbehaving custom processor in coexistence could. If the
tracer call throws, instrumentation falls back to direct invocation
of the user's handler / continuation — a failing instrumentation
must never break a user request hook.

Behaviorally this is invisible until something else is already
broken; it just means a buggy upstream OTel processor degrades the
SDK to a no-op for that one call instead of taking down the user's
request handler.

## Privacy documentation

The `glasstrace.causal.middleware_for_request` attribute is the raw
URL pathname. Pathnames in real applications can carry
user-controlled data (user IDs, email addresses, document slugs,
opaque keys). The SDK does NOT redact this attribute — that is the
caller's responsibility per the general "don't put secrets in URLs"
rule.

This release adds the explicit privacy note to the `README.md`
"Middleware-Ownership Tracing" section and to the
`tracedRequestMiddleware` JSDoc so the contract is unambiguous at
both the docs surface and the call site.

## Regression coverage

Two new tests pin behavior that was fixed during the PR #262 review
cycle but lacked dedicated regression coverage:

- `tracedRequestMiddleware — sampler-drop discriminator`: a real
  provider whose sampler returns `NOT_RECORD` produces a non-recording
  span with a valid trace ID. The wrapper must take the normal
  enrichment path (NOT the SDK-not-registered fast path) and must NOT
  emit `middleware:skipped_uninstalled`. Without this guard, every
  sampled-out request in production deployments using head sampling
  would emit a spurious lifecycle event.

- `withAsyncCausality — span activation`: child spans created inside
  the wrapped `fn()` callback are parented under the async-causality
  span. The fix used `context.with(trace.setSpan(...), fn)`; without
  it the child spans would become orphan roots in a separate trace
  tree.

## Tests

2166 → 2168 passing.

## Backward compatibility

Patch-level — no public API surface change, no behavior change for
healthy code paths. The defensive try/catch only fires when an
upstream OTel implementation is broken; the privacy note is purely
documentary.
