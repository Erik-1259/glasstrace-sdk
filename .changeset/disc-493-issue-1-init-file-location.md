---
"@glasstrace/sdk": minor
---

Detect `src/` layout and merge into existing `instrumentation.ts` instead of overwriting (DISC-493 Issue 1). Fixes the silent-init failure on every Next.js app using `src/` as its root layout.
