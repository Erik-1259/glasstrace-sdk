---
"@glasstrace/sdk": patch
---

Refresh managed MCP config when a project transitions to an account credential.

When a project moves from anon to account/dev-key (claim transition), the
managed `.glasstrace/mcp.json` and per-agent MCP configs previously kept the
unclaimed anon bearer. MCP queries stayed scoped to anon rows while ingestion
wrote account-scoped traces, so traces visible in the dashboard returned no
matches via MCP. The SDK now resolves the project's effective MCP credential
(`.env.local` dev key → `.glasstrace/claimed-key` → `.glasstrace/anon_key`)
and refreshes managed configs whenever the on-disk file is the SDK-shaped
output for the current anon key. User-edited MCP config files are preserved.

`glasstrace mcp add` detects credential drift via a versioned
`mcp-connected` marker and re-registers when the marker no longer matches
the resolver's effective credential. Vendor MCP CLI registration (Claude,
Gemini) is now anon-only; dev keys fall through to the file-config path
which writes `0o600` and never exposes the bearer in process arguments.
Codex's `bearer_token_env_var = "GLASSTRACE_API_KEY"` pattern is
preserved.
