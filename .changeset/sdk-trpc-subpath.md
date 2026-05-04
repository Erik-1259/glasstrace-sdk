---
"@glasstrace/sdk": minor
---

feat(sdk): add `@glasstrace/sdk/trpc` subpath with `tracedMiddleware` helper for tRPC middleware-chain instrumentation (DISC-1217). Wraps each user-supplied tRPC middleware in an OTel span (via `tracer.startActiveSpan`) so enrichment can pinpoint *which* middleware short-circuited a request rather than just *that* an auth or tier check failed. Spans are children of the HTTP server span via standard OTel context propagation; the existing `glasstrace.trpc.procedure` attribute (DISC-1215) is not duplicated. `@trpc/server` is declared as an optional peer dependency (`^10.0.0 || ^11.0.0`); the subpath is excluded from the root barrel and tree-shakeable for projects that do not use tRPC.
