---
"@glasstrace/sdk": patch
---

Clarify in the README that emitting a value-fidelity scalar is separate from
retaining it at ingestion. Admission currently requires the scalar to ride a
database-operation (`db.<Model>.<op>`) span — captured by the `prismaAdapter`, or
one passed via `{ span }`. The `external_api` example uses the default ambient
active span, which is neither, so its scalars are not yet admissible and are
dropped server-side. The note steers evidence on non-database operations to the
boolean `*Holds` relations and the categorical `fields` channel, and cross-links
the two-allowlist contract. Docs-only; no API or behavior change.
