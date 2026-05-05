---
"@glasstrace/sdk": patch
---

DISC-1536 SDK-side fix. Update the `get_root_cause` description rendered by `generateInfoSection()` and injected into agent instruction files (`CLAUDE.md`, `.cursorrules`, `codex.md`, etc.) so the user's AI coding agent learns that `get_root_cause` requires a `traceId` (sourced from `get_latest_error`, `get_error_list`, or `get_trace`). The injection runs from both `npx glasstrace mcp add` and `npx glasstrace init`. Previously the description omitted the requirement, so AI agents would call `get_root_cause` with no arguments and the MCP server would reject the request, costing the user tokens and reasoning cycles on a broken interaction. To pick up the corrected guidance, re-run `npx glasstrace mcp add` (or `npx glasstrace init`) in your project so the updated instructions are written into your agent's instruction file.
