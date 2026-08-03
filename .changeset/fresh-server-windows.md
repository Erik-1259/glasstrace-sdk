---
"@glasstrace/sdk": minor
---

Teach installed agent guidance to let `find_trace_candidates` use its
server-clocked default window for initial route and procedure searches, and to
anchor deliberate historical searches to the returned server time instead of
inventing absolute timestamps. The guidance now uses structured close-match
and widening parameters, discards cursors when the query changes, reports
full, partial, or no requested-period coverage from valid interval overlap,
stops widening at the retention limit, treats inverted or zero-duration
effective intervals as inconclusive, and keeps candidate follow-ups scoped to
trace drill-down.

Existing projects can refresh their managed guidance after updating the SDK by
running `npm exec -- glasstrace upgrade-instructions` from the app package.
