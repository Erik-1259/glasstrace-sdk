---
"@glasstrace/sdk": patch
---

Fix trace context propagation — switch from BasicTracerProvider to NodeTracerProvider so spans from the same HTTP request share a traceId and have proper parent-child relationships (DISC-1183).
