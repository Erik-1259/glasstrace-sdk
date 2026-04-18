---
"@glasstrace/sdk": minor
---
Coexistence-aware signal handler: always installed, re-raises only when not in coexistence mode (DISC-1265). Scenario B state is set synchronously before handler installation so signals arriving in the async setup window do not race against an existing provider's flush. Scenario B users now receive heartbeat telemetry on exit.
