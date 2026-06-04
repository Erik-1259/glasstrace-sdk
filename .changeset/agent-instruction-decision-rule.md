---
"@glasstrace/sdk": minor
---

Clarify first-call decision guidance in SDK-installed agent instructions

Restructure the Workflow §1 in the SDK-managed agent-instruction section
into an explicit three-way decision tree keyed on symptom class:

- **Active failure** (stack trace, recent error, request that just failed)
  → `get_latest_error` first.
- **Known route or procedure with suspected misbehavior** →
  `find_trace_candidates` with a tight time window.
- **Historical exploration** (no recent failure, checking whether a code
  path ever ran) → `find_trace_candidates` with an open window.

The prior wording started every workflow with `find_trace_candidates`
regardless of symptom; in production traffic this caused agents to skip
`get_latest_error` even when an active failure made it the cheapest and
most decisive first call.

The SDK-050 cost-aware framing ("Call Glasstrace FIRST when" / "SKIP
Glasstrace when") is preserved unchanged alongside the new decision
tree, so the agent has both the symptom-class router (which tool first)
and the cost-vs-skip guidance (whether to call at all). Existing
installations re-render on the next `glasstrace dev` invocation; no
manual migration needed.
