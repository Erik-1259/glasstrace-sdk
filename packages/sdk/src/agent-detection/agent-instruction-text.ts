/**
 * The text body the SDK injects into a user's agent-instruction file
 * (CLAUDE.md, .cursorrules, codex.md, etc.) between the
 * `<!-- glasstrace:mcp:start v=<sdkVersion> -->` ... `<!-- glasstrace:mcp:end -->`
 * managed-section markers.
 *
 * **Why this lives in its own module:** the text is the contract
 * between the SDK and the user's coding agent at runtime — what the
 * AI reads when it decides whether to call Glasstrace MCP and how to
 * use the returned evidence. It evolves on a different cadence from
 * the surrounding marker / version-stamp / per-agent-format
 * machinery in `configs.ts`. Keeping it in a sibling module means
 * future content edits are a single-file change and don't risk
 * disturbing the `configs.ts` rendering machinery (which carries the
 * SDK-050 / DISC-1592 / DISC-1602 marker contract that has soaked in
 * production and must not regress).
 *
 * **Vocabulary alignment:** every MCP tool name and response-field
 * name in the body below is verified against the current
 * `@glasstrace/protocol` `wire-mcp.ts` contract. If the server-side
 * MCP contract evolves (renames a field, restructures
 * `suggestedFollowups`, etc.), update this module in lockstep with
 * the protocol change so the agent-instruction text never references
 * fields that don't exist.
 *
 * **Heuristic-first vs tool-first framing:** the body opens with
 * explicit "Call Glasstrace FIRST when" / "SKIP Glasstrace when"
 * rules so a frontier agent has a cheap pre-tool-call decision
 * heuristic it can apply BEFORE spending tokens on tool
 * consideration. The Workflow section then names
 * `find_trace_candidates` as the entry point and instructs the
 * agent to READ `closeMatches` / `recentRoutesSample` /
 * `recoveryActions` before pivoting to source — that is the
 * load-bearing recovery contract from MCP-025 / MCP-027 (codified
 * in `wire-mcp.ts` `ToolDiagnosticSchema` and `CandidateDiagnosticSchema`)
 * and is the failure mode the prior SDK-050 cost-aware decision
 * paragraph did not surface.
 */

/**
 * The full agent-instruction body, returned as a markdown string.
 *
 * The body has NO endpoint URL inlined — frontier agents reach
 * Glasstrace via the MCP server name `glasstrace` configured in the
 * user's MCP config (`.glasstrace/mcp.json` or per-agent native
 * config), not by reading a URL out of the instruction file. Keeping
 * the URL out of the instruction text avoids drift between the
 * instruction file and the MCP config and keeps the body tight.
 *
 * Returns the body WITHOUT the surrounding markers — the caller
 * (`generateInfoSection` in `configs.ts`) wraps the body with the
 * version-stamped start/end markers per the SDK-050 / DISC-1592
 * marker contract.
 */
export function buildAgentInstructionBody(): string {
  return [
    "",
    "## Glasstrace MCP — Runtime Debugging Evidence",
    "",
    "Glasstrace is connected via MCP (`glasstrace`). It captures runtime traces from this app and exposes them through tools that disambiguate bugs source alone cannot resolve.",
    "",
    "### Call Glasstrace FIRST when:",
    "- A value passed at runtime is suspect: wrong role, locale, timezone, template, tenant id, or any enum/config that branches downstream.",
    "- The bug is in a side-effect operation: email sent, calendar event created, webhook dispatched, queued job, `after()` callback.",
    "- The user reports a symptom but you do not yet know which code path actually executed.",
    "- You need to confirm a route or procedure ran in the relevant time window before doing a source dive.",
    "",
    "### SKIP Glasstrace when:",
    "- The bug is statically obvious from source (N+1 query, missing await, redundant query, type error, missing null check).",
    "- The change is a refactor whose correctness does not depend on runtime behavior.",
    "- You already have a precise traceId from another source.",
    "",
    "### Workflow",
    "1. Start with `find_trace_candidates`. Pass whatever route or procedure name is natural — the server normalizes vocabulary and, on miss, returns close matches and a sample of routes actually present in the window.",
    "2. Take the highest-confidence candidate's `suggestedFollowups` and pass them straight to `get_trace` or `get_root_cause`.",
    "3. For side-effect bugs, read `sideEffectSummary` in the `get_trace` / `get_root_cause` response. The allowlisted fields (`templateKey`, `role`, `locale`, `timezone`, `status`, `phase`) are the ones that disambiguate payload bugs.",
    "4. If a tool returns empty, READ the response's `closeMatches`, `recentRoutesSample`, and `recoveryActions` before pivoting to source. Empty results carry `notAbsenceProof: true` — they are never proof the bug did not occur.",
    "",
    "### Tools",
    "- `find_trace_candidates` — discovery, vocabulary-tolerant filter",
    "- `get_trace` / `get_root_cause` — exact trace by id",
    "- `get_session_timeline` — events for a session",
    "- `get_latest_error` / `get_error_list` — recent server errors",
    "",
    "Side-effect evidence is allowlisted and compact by design. Fields you don't see may have been omitted by policy, not absent at runtime.",
    "",
  ].join("\n");
}
