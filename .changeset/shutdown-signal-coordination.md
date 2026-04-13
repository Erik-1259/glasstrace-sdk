---
"@glasstrace/sdk": patch
---

Fix shutdown signal race between OTel provider and heartbeat handlers (DISC-1146). The heartbeat no longer re-raises the process signal, delegating that to the OTel shutdown handler.
