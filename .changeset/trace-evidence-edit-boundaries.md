---
"@glasstrace/sdk": minor
---

Teach installed agent guidance to bind trace evidence to source edit boundaries before editing.

The managed Glasstrace MCP section now tells agents to pause after finding a relevant trace, write down the runtime fact, the route/procedure/operation that produced it, the likely source decision point, and the intended edit boundary, then prefer the smallest source path that owns the runtime decision. It also warns agents not to rewrite routing, batching, request transport, middleware, or sibling propagation unless the trace implicates that layer; clarifies stale-state and categorical side-effect-field handling; and tells agents to pull, retry, or broaden when a plausible candidate lacks semantic evidence.
