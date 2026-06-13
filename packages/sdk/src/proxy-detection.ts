/**
 * Structural classifiers for `@opentelemetry/api`'s `ProxyTracerProvider`
 * and `ProxyTracer`. Used by the SDK's two existing-provider probe sites
 * (`otel-config.ts`, `register.ts`) to distinguish "the SDK is looking at
 * its own bundled OTel proxy" from "another tool has registered a real
 * provider".
 *
 * **Why structural rather than constructor-name based:** Next.js 16's
 * production bundler/minifier renames `@opentelemetry/api`'s
 * `ProxyTracerProvider` and `ProxyTracer` classes to short identifiers
 * (`eN` / `ew` / `ek` / `e_` in the wild). A constructor-name comparison
 * (`probeTracer.constructor.name !== "ProxyTracer"`) therefore returns
 * `true` against the SDK's own bundled proxy, the SDK incorrectly
 * concludes that an external provider is registered, and the
 * coexistence/auto-attach path runs against a proxy with no real
 * delegate. Spans are silently lost. The structural classifiers below
 * survive minification because they inspect prototype-method shape
 * rather than identifier names.
 *
 * **Load-bearing assumptions** (a future OTel API change that violates
 * any of these requires revisiting the structural check; the test suite
 * for these helpers is the early-warning system):
 *
 * 1. `ProxyTracerProvider`'s prototype exposes exactly four method
 *    names — `getTracer`, `getDelegate`, `setDelegate`,
 *    `getDelegateTracer` — and `ProxyTracer`'s prototype exposes
 *    exactly three — `_getTracer`, `startSpan`, `startActiveSpan`.
 *    Verified against `@opentelemetry/api` ≤ 1.x at the time of writing
 *    (recon date 2026-05-04). If a future OTel API release renames or
 *    removes any of these methods, the matching structural check
 *    breaks silently — the regression test suite catches that.
 * 2. `ProxyTracer`'s `_provider` field is a stable own data property
 *    holding a `===`-comparable reference to the owning
 *    `ProxyTracerProvider`. If a future OTel API release wraps
 *    `_provider` in a JS `Proxy` object or replaces it with a getter
 *    that returns a fresh wrapper per call, the strict-equality
 *    disambiguator below breaks and the helpers must be revisited.
 * 3. The helpers detect `@opentelemetry/api`'s canonical proxy
 *    classes only. Arbitrary third-party "proxy"-style tracers that
 *    coincidentally share method-name shape are not detected as
 *    proxies; the `_provider === ownerProvider` ownership check on
 *    {@link isProxyTracer} is the disambiguator that prevents
 *    misclassification.
 */

/**
 * Returns `true` when `value` structurally matches an OTel
 * `ProxyTracerProvider`: an object exposing the four methods
 * `getTracer`, `getDelegate`, `setDelegate`, and `getDelegateTracer` as
 * functions. The check uses `in` + `typeof === "function"`, which
 * matches both prototype methods (the canonical OTel case) and own
 * properties (e.g., a hand-rolled object literal in tests). This is
 * deliberate: a structural classifier should accept any value that
 * *behaves* like a `ProxyTracerProvider`, not just instances of the
 * upstream class.
 *
 * Returns `false` for `null`, `undefined`, and non-object inputs.
 *
 * @see {@link isProxyTracer} for the matching tracer classifier.
 */
export function isProxyTracerProvider(value: unknown): boolean {
  if (value === null || value === undefined || typeof value !== "object") {
    return false;
  }
  return (
    "getTracer" in value &&
    typeof (value as { getTracer: unknown }).getTracer === "function" &&
    "getDelegate" in value &&
    typeof (value as { getDelegate: unknown }).getDelegate === "function" &&
    "setDelegate" in value &&
    typeof (value as { setDelegate: unknown }).setDelegate === "function" &&
    "getDelegateTracer" in value &&
    typeof (value as { getDelegateTracer: unknown }).getDelegateTracer === "function"
  );
}

/**
 * Returns `true` when `value` structurally matches an OTel
 * `ProxyTracer` AND its `_provider` **own data property** is
 * referentially equal (`===`) to `ownerProvider`. The structural check
 * requires the three methods `_getTracer`, `startSpan`, and
 * `startActiveSpan` present as functions (matching prototype methods OR
 * own properties — see {@link isProxyTracerProvider} for the rationale).
 * The ownership disambiguator catches third-party tracers that
 * coincidentally share the method-name shape but whose `_provider` is
 * absent, `undefined`, or points at a different provider object.
 *
 * The `_provider` check uses `Object.hasOwn(...)` (own-property only,
 * not the prototype chain) because OTel's canonical `ProxyTracer`
 * assigns `_provider` as an own data property in its constructor —
 * `this._provider = provider`. A prototype-chain match would risk
 * false positives if a third party places a `_provider` on a shared
 * prototype rather than the instance.
 *
 * Returns `false` for `null`, `undefined`, and non-object inputs.
 *
 * @param value - the candidate tracer.
 * @param ownerProvider - the provider that produced `value` via
 *   `getTracer()`. The match is against this exact object reference.
 *
 * @see {@link isProxyTracerProvider} for the matching provider classifier.
 */
export function isProxyTracer(value: unknown, ownerProvider: unknown): boolean {
  if (value === null || value === undefined || typeof value !== "object") {
    return false;
  }
  const structurallyShaped =
    "_getTracer" in value &&
    typeof (value as { _getTracer: unknown })._getTracer === "function" &&
    "startSpan" in value &&
    typeof (value as { startSpan: unknown }).startSpan === "function" &&
    "startActiveSpan" in value &&
    typeof (value as { startActiveSpan: unknown }).startActiveSpan === "function";
  if (!structurallyShaped) {
    return false;
  }
  // Ownership disambiguator: a real `ProxyTracer` carries a `_provider`
  // OWN data property (set in the ProxyTracer constructor as
  // `this._provider = provider`) pointing at the `ProxyTracerProvider`
  // that produced it. Use `Object.hasOwn` to reject prototype-chain
  // matches — a third-party tracer that exposes `_provider` on a
  // shared prototype (rather than as an own data property on the
  // instance) is NOT one of our proxies, so the probe should treat
  // the surrounding provider as a real external provider.
  if (!Object.hasOwn(value, "_provider")) {
    return false;
  }
  return (value as unknown as { _provider: unknown })._provider === ownerProvider;
}
