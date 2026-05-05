---
"@glasstrace/sdk": patch
---

fix(sdk): emit Claude-compatible MCP config from generic init path; legacy on-disk shape continues to refresh on credential rotation (DISC-1572)

The generic `.glasstrace/mcp.json` written when no agent is detected
now includes `"type": "http"` on the `glasstrace` server entry. This
matches the Claude branch of `generateMcpConfig` and is required by
Claude Code's `--strict-mcp-config` validator; without it, fresh
non-interactive `glasstrace init` runs produced configs that Claude
rejected with `Does not adhere to MCP server configuration schema`.

Existing on-disk files written by older SDK versions (without
`type: "http"`) continue to be recognized as SDK-managed by
`mcpConfigMatches`. The matcher now retries the canonical-JSON
comparison once with `type: "http"` stripped from the expected
`mcpServers.glasstrace` entry; any other field divergence still
reports a mismatch and preserves user edits. Existing legacy files
are upgraded to the new shape automatically on the next credential
rotation or `glasstrace init` re-run.
