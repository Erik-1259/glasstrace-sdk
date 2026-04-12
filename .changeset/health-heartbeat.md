---
"@glasstrace/sdk": patch
---

Add periodic health heartbeat that reports SDK health metrics to the backend every 5 minutes after successful init. Includes exponential backoff with jitter on rate-limit (429) responses, shutdown health report on SIGTERM/SIGINT, and concurrent tick protection. Also fixes nested catch double-count (DISC-1121), documents ZodError double-reporting trade-off (DISC-1120), and corrects JSDoc on span export counting (DISC-1118).
