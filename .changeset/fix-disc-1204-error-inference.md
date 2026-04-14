---
"@glasstrace/sdk": patch
---

Detect error traces via exception events when span status is UNSET — the Next.js dev server timing race can export spans before closeSpanWithError runs, but exception events from recordException are still present (DISC-1204).
