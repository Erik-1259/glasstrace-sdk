---
"@glasstrace/sdk": minor
"@glasstrace/protocol": patch
---

feat(sdk): tRPC batch member span emission via wrapBatchedHttpHandler (SDK-052)

Adds opt-in per-member span attribution for batched tRPC HTTP
requests. Apps that wrap their tRPC HTTP handler with the new
`wrapBatchedHttpHandler` AND use `tracedMiddleware` get a
`glasstrace.trpc.batch.member_index` (number) and
`glasstrace.trpc.batch.member_procedures` (OTel typed string array)
attribute on each member span, so per-member attribution is
preserved when tRPC's HTTP-batch link bundles multiple procedures
into a single HTTP request.

**Public API additions:**

- `wrapBatchedHttpHandler<H>(handler, options?: { basePath?: string })`
  exported from `@glasstrace/sdk/trpc`. Apps wrap their tRPC HTTP
  handler (Next.js app-router route, Express endpoint, etc.) once
  at the boundary; the wrapper inspects each request's URL and
  sets a request-scoped `AsyncLocalStorage` envelope when the URL
  matches the batch pattern at the configured base path.
  Default `basePath` is `/api/trpc/`; apps that mount tRPC at a
  different path pass their actual base path explicitly (per
  DISC-1215, the tRPC base path is configurable on the user side).

**Wire format additions (strict additivity):**

- `glasstrace.trpc.batch.member_index` — zero-based positional
  index of each member in the batch. Load-bearing for batches that
  include the same procedure name more than once (positional
  matching, NOT name-only matching).
- `glasstrace.trpc.batch.member_procedures` — OTel typed string
  array (`string[]`) listing all member procedure names in the
  batch order.

**Lifecycle event addition:**

- `otel:trpc_batch_member_mismatch` fires when `tracedMiddleware`
  runs under an envelope but the procedure name doesn't match any
  positional member (the failure mode that preserves trace shape).
  Informational; subscribers MAY consume it for observability.

**Cross-version compatibility:** works with `@trpc/server@^10` and
`@trpc/server@^11`. The envelope is propagated via Node
`AsyncLocalStorage` rather than tRPC's `createContext` shape
(which differs between major versions).

**Out of scope (DISC-1534 stays PARTIAL after this release):**

- Product backend ingestion storage of per-member span hierarchy —
  separate product-side wave.
- MCP query projection of per-member duration / status / DB
  attribution — separate product-side wave.
- Auto-attach integration (wrapping tRPC handlers automatically) —
  v1 is opt-in; a future brief may add auto-detection.
- Root HTTP server span shape — the existing comma-joined
  `glasstrace.trpc.procedure` attribute is unchanged. The brief
  proposed reshaping it to a first-member representative + array,
  but that is non-additive and is deferred to a separate wave.

Apps not using `wrapBatchedHttpHandler`, and apps not using
`tracedMiddleware`, see no trace-shape change.

Patch bump for `@glasstrace/protocol` (new constants; strict
additivity).
