---
"@glasstrace/sdk": patch
---

Fix context manager timing — register AsyncLocalStorage context manager synchronously in registerGlasstrace() before configureOtel() runs, so Next.js spans created during async OTel setup inherit trace context (DISC-1183).
