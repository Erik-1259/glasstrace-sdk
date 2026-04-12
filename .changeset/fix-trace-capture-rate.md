---
"@glasstrace/sdk": patch
---

Fix trace capture rate by reducing BatchSpanProcessor flush interval from 5 seconds to 1 second, adding export failure logging so OTLP errors are no longer silent, fixing forceFlush to drain pending span batches, and enabling OTel diagnostic logging in verbose mode.
