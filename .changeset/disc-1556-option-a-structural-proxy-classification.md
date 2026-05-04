---
"@glasstrace/sdk": patch
---

DISC-1556 Option A fix. Replace constructor-name proxy classification
(`probeTracer.constructor.name !== "ProxyTracer"`) with structural
classification at both probe sites in `otel-config.ts` and `register.ts`.
The constructor-name check failed under Next 16's bundler/minifier,
which renames `@opentelemetry/api`'s `ProxyTracer`/`ProxyTracerProvider`
to short minified names (`ek`/`e_`/`eN`/`ew`); the SDK then misidentified
its own bundled proxy as an external provider and silently failed to
export traces under `next build && next start`. Auto-attach detection
now classifies the SDK's own bundled proxy correctly under bundler
minification, verified against the `clean-next-sdk130` validation
fixture. The manual `createGlasstraceSpanProcessor()` workaround
documented in the README remains supported.
