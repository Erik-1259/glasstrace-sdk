---
"@glasstrace/sdk": minor
---

Add passive Prisma value capture. `prismaAdapter({ allow })` is a Prisma client extension that records allowlisted boolean result columns onto your traces (for an eligible operation it opens a single `db.<Model>.<op>` span and emits a `*Flag` scalar for each allowlisted column), so an agent debugging a failure can see the value a query returned. It is passive and default-deny: it never alters a query or its result, captures nothing without an explicit `allow` entry, skips `findMany`/list queries, and has no `@prisma/client` dependency. The lower-level `capture(name, value, { span })` primitive projects a single allowlisted scalar onto a span you own, for building custom adapters. Both are gated by your account's capture configuration and never throw.
