---
"@glasstrace/sdk": patch
---

DISC-377 Item 1 fix. Convert two unconditional `node:fs` / `node:path`
ESM imports in `runtime-state.ts` to a cached `require()` + try/catch
loader matching the precedent at `heartbeat.ts:150-159`, so the module
loads cleanly under non-Node runtimes (browser bundles, Vercel Edge,
Cloudflare Workers, Deno without Node-compat). Wave 8 8D guarded the
`require()` calls inside the writer body via the existing
`isSyncFsAvailable()` probe; Wave 13 closes the residual top-of-file
import gap that previously failed at module-evaluation time before the
probe could run. No public API change; trace-capture behavior under
Node is unchanged, and `startRuntimeStateWriter` retains its
synchronous `void` return contract.
