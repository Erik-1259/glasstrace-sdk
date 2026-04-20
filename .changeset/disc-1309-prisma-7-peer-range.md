---
"@glasstrace/sdk": minor
---

Widen `@prisma/instrumentation` peer range to include `^7.0.0`. The SDK runtime already tolerates any major version of `@prisma/instrumentation` because the only references are dynamic `tryImport("@prisma/instrumentation")` call sites in `packages/sdk/src/otel-config.ts`, each of which guards on the `PrismaInstrumentation` constructor being present before use. This change advertises existing compatibility so consumers on Prisma 7 can install `@glasstrace/sdk` without a peer-dep conflict. Closes DISC-1309.
