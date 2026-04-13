---
"@glasstrace/sdk": patch
---

Fix context manager race condition — use static import of AsyncLocalStorage instead of async dynamic import that resolved after installContextManager() was called (DISC-1183).
