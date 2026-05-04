---
"@glasstrace/protocol": minor
"@glasstrace/sdk": minor
---

feat(sdk): emit `glasstrace.build.hash` and `glasstrace.source.{file,line}` on error spans (SDK-040 / DISC-1543).

The SDK now stamps three previously-dormant span attributes that the ingestion service has been reading since `@glasstrace/protocol@0.19.0`. With the writers in place, the source-map upload + resolver pipeline becomes live end-to-end: the dashboard renders mapped frames for error traces and the enrichment LLM prompt receives concrete source-location context.

- `glasstrace.build.hash` — stamped on every server span. Read once at module load from `process.env.GLASSTRACE_BUILD_HASH`. Set the env var in your build/deploy step (typically `GLASSTRACE_BUILD_HASH=$(git rev-parse HEAD)`) so the runtime trace and the build-time source-map manifest agree on the same hash. When the env var is unset, the attribute is silently omitted — no behavior change for projects that have not adopted the convention.
- `glasstrace.source.file` and `glasstrace.source.line` — stamped on the `glasstrace.error` span event by the manual `captureError()` API. Values come from the top user-attributable frame of `Error.stack`, with V8 internal frames (`node:internal/*`, `node:fs`, etc.) and SDK-internal frames (`@glasstrace/sdk` package or in-tree `packages/sdk/src/capture-error.ts`) skipped automatically. The reported `file:line` is the compiled-output path; ingestion's source-map resolver maps it back to the original source via the uploaded manifest.

`@glasstrace/protocol` adds `BUILD_HASH: "glasstrace.build.hash"` to `GLASSTRACE_ATTRIBUTE_NAMES` (the other three keys were already declared). All three new emissions are additive, edge-bundle-clean, and gated to error spans where they apply — non-error spans do not carry source-frame attributes. The `process.env.GLASSTRACE_BUILD_HASH` read lives in a Node-only helper module (`build-info.ts`) imported only by `enriching-exporter.ts`, which is itself excluded from the edge bundle by the F003 runtime-partition gate.

See the new "Source maps" section of the SDK README for the full configuration surface and behavior.
