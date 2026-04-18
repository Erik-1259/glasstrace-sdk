---
"@glasstrace/sdk": minor
---

Coexistence-aware signal handler: always installed, consults runtime coexistence state at delivery time. Scenario B users now receive heartbeat final-report on process exit (DISC-1265).

Previously, signal handlers were installed only in Scenario A (Glasstrace owns the provider). This meant that in Scenario B (coexisting with Sentry, Vercel OTel, etc.), SIGTERM did not run any Glasstrace lifecycle hooks — so the heartbeat final-report and OTel flush were silently dropped on container shutdown.

The handler is now always installed at registration time. It reads a `coexistenceState` flag (set by `configureOtel()`'s async provider probe) at signal-delivery time:

- `"unknown"` or `"sole-owner"`: runs hooks, re-raises the signal (Scenarios A/E, existing behaviour).
- `"coexisting"`: runs hooks, then yields to the external provider's handler if one is present; re-raises if no other handler is registered, to prevent a process hang.
