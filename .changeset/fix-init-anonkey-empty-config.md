---
"@glasstrace/sdk": patch
---

Fix first-run MCP setup by generating the anonymous key during init instead of requiring a separate dev server start, and guard against empty next.config files producing misleading "already wrapped" messages
