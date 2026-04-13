---
"@glasstrace/sdk": patch
---

Fix ESM context manager installation — use `createRequire` from `node:module` instead of `Function("require")` which fails in ESM global scope (DISC-1183).
