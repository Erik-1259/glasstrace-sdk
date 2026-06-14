---
"@glasstrace/sdk": patch
---

Remove internal tracking references from agent-detection JSDoc

Two JSDoc blocks describing the agent-instruction recovery contract
carried internal tracking identifiers and an internal repository name.
The sentences are reworded in plain, public language while preserving the
technical meaning — the load-bearing recovery contract codified in the
server-side MCP `ToolDiagnosticSchema` / `CandidateDiagnosticSchema`
schemas, and the bail-to-source failure mode the prior cost-aware decision
paragraph did not surface. No public API, type signature, or runtime
behavior changes — documentation text only.
