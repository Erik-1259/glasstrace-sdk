---
"@glasstrace/sdk": patch
---

Update `@vercel/otel` peer dependency range to `^2.0.0` (DISC-1264).

The previous peer range of `^1.0.0` was effectively broken: `@vercel/otel@1.x`
requires `@opentelemetry/sdk-trace-base@<2.0.0`, but `@glasstrace/sdk` depends
on `@opentelemetry/sdk-trace-base@^2.6.1`, making joint installation impossible
(ERESOLVE). The updated range reflects the version the SDK actually supports and
eliminates the spurious `unmet peer` warning for users on `@vercel/otel@2.x`.
