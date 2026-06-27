---
"@glasstrace/sdk": minor
---

Teach installed agent guidance that a sparse trace candidate is not absence of evidence

The managed Glasstrace MCP section the SDK writes into agent instruction files now
tells the agent that a `find_trace_candidates` candidate whose compact summaries are
absent is still evidence: the compact category projections (`performanceQuerySummary`,
`dataShapeSummary`, `raceConcurrencySummary`, `contextBranchSummary`) appear only on
the top-ranked candidate within a small inline budget, and a `sideEffectEvidence` that
is absent or has status `missing`/`withheld`/`unsupported` is not proof there was no
side effect — in each case the agent should pull the trace via `get_trace` /
`get_root_cause`. It also guides the agent to broaden or retry a sparse or ambiguous
search by procedure (`find_trace_candidates({ procedure: "<name>" })`, preferred over a vague
route fragment), and to compare the candidate's matched route against the URL it
searched before concluding a code path never ran.
