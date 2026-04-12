---
"@glasstrace/sdk": patch
---

Add SDK health report collection to init call. Each `POST /v1/sdk/init` request now includes span export/drop counts, init failure counts, and config staleness metrics, enabling the backend to surface SDK health issues in the dashboard.
