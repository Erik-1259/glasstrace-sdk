---
"@glasstrace/sdk": minor
---

Auto-attach the Glasstrace span processor onto an existing OTel provider (Next.js 16 production, Sentry, Datadog, New Relic) instead of silently giving up. Closes the "no traces exported" black hole documented in DISC-493 Issues 2 and 4. Auto-attach reuses the `createGlasstraceSpanProcessor()` primitive, so the automatic and manual integration paths share identical wiring and idempotence via the branded exporter symbol.
