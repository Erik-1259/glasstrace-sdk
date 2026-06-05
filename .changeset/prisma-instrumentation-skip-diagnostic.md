---
"@glasstrace/sdk": patch
---

Surface a verbose-mode diagnostic when Prisma instrumentation is skipped

When `@prisma/instrumentation` cannot be resolved at startup, the SDK
previously skipped Prisma span registration silently, leaving developers
with missing database spans and no explanation. The SDK now logs a
diagnostic in verbose mode (`registerGlasstrace({ verbose: true })`) on
both the Vercel and bare OpenTelemetry paths — including when
instrumentation initialization throws — explaining that Prisma query
spans will not be captured and how to resolve it.

The README gains a "Database query spans (Prisma)" section documenting the
most common cause (package managers such as pnpm not exposing transitive
copies of optional peers) and the fix: add `@prisma/instrumentation` as a
direct dependency. There is no behavior change when Prisma is present, and
the diagnostic stays silent unless verbose mode is enabled.
