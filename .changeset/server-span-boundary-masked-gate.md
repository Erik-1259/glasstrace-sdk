---
"@glasstrace/sdk": patch
---

Only infer boundary-masked error status on HTTP server spans

The status promotion that surfaces errors masked behind a `200` response
previously gated on the presence of `http.method` but not on span kind. OTel
client spans (a failed outbound `fetch`, a DB-over-HTTP call, or the SDK's own
OTLP export `POST`) also carry `http.method`, and a failed outbound request
typically has an exception event / `ERROR` status with no or `200` status — so
it was wrongly promoted to a `500` and tagged `glasstrace.http.boundary_masked`,
which could appear as a spurious error trace. The heuristic is now restricted to
server spans, mirroring the existing span-kind gate on the fetch-target
classifier. No public API surface changes.
