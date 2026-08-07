---
"@glasstrace/sdk": patch
---

Attach the aggregate-result family marker last, as its own ordered write
after the scalar bundle. OpenTelemetry silently drops attribute writes
beyond a host-configured span attribute-count limit, so a truncated (or
error-interrupted) bundle now always loses its family marker before any
scalar — the receiver then discards the unmarked remainder instead of
retaining a shape-valid partial aggregate result as complete. Sequencing
the marker as a separate call makes the ordering a program guarantee
independent of any provider's attribute-iteration behavior.
