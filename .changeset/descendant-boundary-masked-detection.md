---
"@glasstrace/sdk": minor
---

Detect boundary-masked Next.js errors that surface on a descendant render span

The boundary-masked-error heuristic previously fired only when the HTTP
request span itself carried the error signal. It now also detects the
page-route boundary case, where the request renders an HTTP 200 while a
transitive child span (for example a Next.js render-route span) records the
exception. When this case is detected, the SDK promotes the stored
`glasstrace.http.status_code` to 500 and records the new
`glasstrace.http.boundary_masked_scope` discriminator (`same_span` or
`descendant`) alongside the existing `glasstrace.http.boundary_masked`
attribute, so consumers can tell which scope produced the promotion.

Descendant detection is fenced against false positives: it requires an
exception event (not merely an error-status child), excludes framework
control-flow throws, leaves expected `error.tsx` fallbacks over a generic
application error at 200, and promotes render-route descendants only for
unexpected infrastructure failure classes (currently database/driver errors
such as a database-unreachable failure; the list grows additively). A
boundary can opt out per request with a
`glasstrace.error.expected` span attribute.

The `core:error_boundary_detected` lifecycle event now carries a `source`
discriminator (`same_span` | `descendant`) on both paths and, for the
descendant path, an `exceptionSpanId` identifying the descendant span. The
OpenTelemetry `http.status_code` is left at its original value; only the
Glasstrace status reflects the inferred failure, and the browser response
is unchanged.

Adds the `GLASSTRACE_DISABLE_BOUNDARY_MASKED` environment flag (truthy `1`
or `true`) to disable boundary-masked promotion entirely for both scopes.
