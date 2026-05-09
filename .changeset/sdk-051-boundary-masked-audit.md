---
"@glasstrace/sdk": minor
"@glasstrace/protocol": patch
---

feat(sdk): boundary-masked-error audit attribute + lifecycle event (SDK-051)

Adds observability for the SDK's existing same-span boundary-masked-error
heuristic (the DISC-1134 status-inference path at
`enriching-exporter.ts`):

- New wire attribute `glasstrace.http.boundary_masked: true` is set on
  HTTP server spans where the SDK promotes an inferred `status_code`
  because an error signal (any of: `span.status === ERROR`, an
  `exception` event, or `exception.*` attributes) was present
  alongside a trigger-set status (`{200, 0, undefined}`). Strict
  additivity — backend ignores unknown attributes today, so this is
  for downstream observability of heuristic activation rate.
- New lifecycle event `core:error_boundary_detected` fires once per
  promotion with `{ spanId, inferredStatus, exceptionMessage? }`.
  Subscribers MAY consume this for activation-rate dashboards; the
  heuristic's behavior does NOT depend on subscribers. Exception
  messages are truncated to 256 chars in the payload and omitted
  entirely when neither an exception event nor `exception.message`
  attribute was present.

**Same-span scope only.** This release covers the case where the HTTP
server span itself carries the error signal. Page-route boundary
detection where the exception lives in a child span requires
descendant-traversal in the exporter and is tracked in a follow-up
DISC. DISC-1125 stays PARTIAL after this release.

Patch bump for `@glasstrace/protocol` (new constant; strict
additivity).
