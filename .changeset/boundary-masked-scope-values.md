---
"@glasstrace/protocol": minor
"@glasstrace/sdk": patch
---

Export `BOUNDARY_MASKED_SCOPE_VALUES` and the `BoundaryMaskedScope` type from
`@glasstrace/protocol`: the two values (`same_span` and `descendant`) that the
`glasstrace.http.boundary_masked_scope` attribute takes when the SDK's
boundary-masked-error heuristic promotes a span. The SDK exporter that emits
the attribute — and any backend or tooling that reads it — now share one source
of truth for the value set instead of hardcoding the literals independently. No
wire change: the emitted values are identical.
