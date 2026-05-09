---
"@glasstrace/sdk": patch
---

feat(sdk): replace agent-instruction body with explicit FIRST/SKIP decision rules; align cursor + windsurf MCP config with canonical http shape

The text the SDK injects into `CLAUDE.md` / `.cursorrules` / `codex.md`
between the `<!-- glasstrace:mcp:start v=... -->` markers now opens with
explicit "Call Glasstrace FIRST when:" / "SKIP Glasstrace when:"
decision rules so a frontier coding agent has a cheap pre-tool-call
heuristic before spending tokens on tool consideration. The Workflow
section names `find_trace_candidates` as the discovery entry point
and instructs the agent to read `closeMatches`, `recentRoutesSample`,
and `recoveryActions` before pivoting to source — preventing the
bail-to-source failure mode after an empty MCP result. The body is
sourced from a new internal sibling module
(`agent-instruction-text.ts`) so future content edits are isolated
from the surrounding marker / version-stamp / per-agent-format
machinery in `configs.ts`.

The body deliberately does NOT inline the endpoint URL — agents
reach Glasstrace via the MCP server name `glasstrace` configured in
`.glasstrace/mcp.json` or per-agent native config, not by reading a
URL out of the instruction file. Keeping the URL out of the
instruction text avoids drift between the instruction file and the
MCP config and keeps the body tight.

Bundled config-shape fixes:

- Cursor MCP config now emits the canonical
  `{ type: "http", url, headers }` shape (the prior shape omitted
  `type`).
- Windsurf MCP config now emits `url` (not the prior `serverUrl`)
  and includes `type: "http"`.

Both align with the Claude-compatible HTTP shape the generic branch
already used. Apps that previously consumed the cursor or windsurf
config in the prior shapes will pick up the new shape on next
`npx glasstrace mcp add` / `npx glasstrace init` run.

Existing users on stale SDKs continue to see the prior content in
their agent instruction files until they run
`npx glasstrace upgrade-instructions` (or `npx glasstrace mcp add`
against the same target). This is the explicit DISC-1592
upgrade-refresh contract — body and stamp refresh together when the
user opts in via the upgrade command.

The marker contract from SDK-050 / DISC-1592 / DISC-1602 is preserved
intact: `<!-- glasstrace:mcp:start v=<sdkVersion> -->` start marker,
unstamped end marker, idempotent in-place replacement on re-render,
stale-stamp warning at SDK init.

**Patch bump.** Content/config evolution only — no public API surface
change, no exported function signature changes.
