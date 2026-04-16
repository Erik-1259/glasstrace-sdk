---
"@glasstrace/sdk": minor
---

Add OTel provider coexistence, lifecycle state machine, and public APIs

- OTel coexistence: auto-attach to existing providers (Sentry, Datadog) via tiered detection (DISC-1202)
- New public API: createGlasstraceSpanProcessor() for clean manual Sentry integration
- New public APIs: isReady(), waitForReady(), getStatus() for lifecycle state querying
- Lifecycle state machine with validated transitions across core, auth, and OTel layers
- Unified shutdown coordinator with signal + beforeExit triggers
- Runtime state bridge (.glasstrace/runtime-state.json) for CLI diagnostics
- tRPC procedure name extraction from URL path (DISC-1215)
- Error response body config scaffolding (DISC-1216 Phase 1)
- Prisma instrumentation on bare OTel path (DISC-1223)
- Remove API key from request bodies — credentials sent exclusively via Authorization header (DISC-1017)
- Symbol.for('glasstrace.exporter') branding for cross-bundle processor detection
