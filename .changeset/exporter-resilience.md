---
"@glasstrace/sdk": patch
---

Fix exporter resilience issues that could cause trace loss or stale authentication:

- Defer span enrichment to flush time so buffered spans get session IDs computed with the resolved API key instead of the "pending" placeholder.
- Close the buffer/flush race window by re-checking the key state after buffering.
- Recreate the OTLP delegate exporter when the API key changes, supporting key rotation without restart.
