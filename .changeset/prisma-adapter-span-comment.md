---
"@glasstrace/sdk": patch
---

Clarify the `prismaAdapter` owned-span documentation: the captured `db.<Model>.<op>` span is described as a same-trace descendant of the request span (its immediate parent is the active span, which on some Prisma / instrumentation versions is the still-recording database operation span) rather than always a direct child of the request span. Documentation-only — no public API or runtime behavior change.
