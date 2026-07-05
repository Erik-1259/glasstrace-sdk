---
"@glasstrace/sdk": minor
---

Reinforce the SDK-installed agent guidance so agents drill into
`find_trace_candidates` results before deciding and, for stale, cross-request,
or cross-batch state, target the durable decision boundary instead of
forwarding observed request or batch values.
