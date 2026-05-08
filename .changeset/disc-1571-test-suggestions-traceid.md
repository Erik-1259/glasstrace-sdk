---
"@glasstrace/sdk": patch
---

fix(sdk): name required `traceId` parameter in `get_test_suggestions`
description rendered into agent instruction files (DISC-1571)

`generateInfoSection()` injects MCP tool descriptions into
`CLAUDE.md` / `.cursorrules` / `codex.md` when users run
`npx glasstrace mcp add` or `npx glasstrace init`. The
`get_test_suggestions` bullet previously read:

> `get_test_suggestions` - Get test suggestions based on recent errors

This omitted the `traceId` requirement that the MCP server's
`GetTestSuggestionsParamsSchema` enforces. User AI agents read the
description, called `get_test_suggestions({})`, and the MCP server
rejected the request with a Zod validation error citing the missing
`traceId`. The user paid in tokens and reasoning cycles for a 100%-
failure interaction.

This fix mirrors the wording shape from the `get_root_cause` fix that
shipped in 1.3.6 (DISC-1536 SDK-side):

> `get_test_suggestions` - Get test suggestions for a specific error
> trace (requires a `traceId` from `get_latest_error`,
> `get_error_list`, or `get_trace`)

A regression test in `configs.test.ts` mirrors the existing
`get_root_cause` test pattern: it pins on the
`^- \`get_test_suggestions\`` bullet, asserts the substring
`traceId`, and asserts the description references at least one of
the three trace-id source tools.

The defect was identified during glasstrace-sdk PR #236's recon C7
audit and reserved as DISC-1571 for a follow-up; this PR closes it.
The audit also verified the four other tools in the same block
(`get_latest_error`, `get_error_list`, `get_trace`,
`get_session_timeline`) accurately reflect their schemas — no
parallel defect remains.
