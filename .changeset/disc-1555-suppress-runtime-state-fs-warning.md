---
"@glasstrace/sdk": patch
---

Suppress benign `node:fs unavailable` warning emitted on Next.js dev/start
server startup. The runtime-state writer now silently skips when synchronous
`node:fs` is unreachable — traces still capture as before; only diagnostic
noise is removed (DISC-1555).
