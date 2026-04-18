---
"@glasstrace/sdk": patch
---
Register a lifecycle shutdown hook on the @vercel/otel path to flush buffered spans on SIGTERM (DISC-1263). @vercel/otel does not self-flush on process exit; this hook closes the gap.
