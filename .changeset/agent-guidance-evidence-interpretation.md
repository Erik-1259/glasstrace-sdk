---
"@glasstrace/sdk": minor
---

Teach the installed agent guidance to use returned MCP trace evidence

The managed Glasstrace MCP section the SDK writes into agent instruction files
now teaches agents how to act on what the tools return, not just which tool to
call first. It frames side-effect evidence as first-class runtime evidence — the
compact presence on `find_trace_candidates` candidates versus the per-operation
values on `get_latest_error` / `get_trace` / `get_root_cause` — explains that
boolean relation fields (keys ending in `Holds`) are direct true/false claims and
that categorical fields (`templateKey`, `providerOperation`, operation `status` /
`phase`) identify which operation ran and what state it reached, and clarifies
that a thin follow-up does not invalidate evidence already in hand: an empty
`get_span_attributes` result means only that no scalar drill-down was returned,
and an unavailable `get_root_cause` still ships a usable trace summary to continue
from. It also guides agents to inspect the smallest source path the trace names
before broad exploration, to compare multiple traces in sequence for stateful
bugs, and to cross-check trace facts against source and direct verification. The
`get_span_attributes` drill-down tool is now named in the tools list.
