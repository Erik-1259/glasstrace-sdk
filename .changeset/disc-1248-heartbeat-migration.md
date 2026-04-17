---
"@glasstrace/sdk": patch
---

Migrate heartbeat shutdown handlers onto the lifecycle coordinator so OTel flush and final health-report fire in a deterministic order.
