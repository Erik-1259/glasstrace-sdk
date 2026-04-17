---
"@glasstrace/sdk": patch
---

Register SIGTERM/SIGINT handlers earlier so spans are not lost when a signal arrives during OTel setup (DISC-1249).

Signal handlers are now installed synchronously inside `registerGlasstrace()` (after the production-disabled check and the synchronous OTel provider probe), rather than at the end of the async `configureOtel()` chain. This closes a timing window where a SIGTERM / SIGINT received during the `@vercel/otel` probe or provider registration would be delivered with no handler attached, silently dropping buffered spans. Handlers are installed only when this SDK will own the provider (Scenario A); in coexistence mode the existing provider continues to own signal shutdown unchanged.
