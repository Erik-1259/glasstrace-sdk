/**
 * The text body the SDK injects into a user's agent-instruction file
 * (AGENTS.md, CLAUDE.md, GEMINI.md, .cursor/rules/glasstrace.mdc,
 * .windsurf/rules/glasstrace.md, plus legacy .cursorrules — Wave 18
 * expanded the canonical set per DISC-1782) between the
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
 * name in the body below is verified against the current MCP server
 * contract maintained in the private `glasstrace-product` repo
 * (`shared/types/wire-mcp.ts` and `shared/types/agent-evidence.ts`
 * there); the SDK consumes the resulting wire format but does not
 * own the schema source of truth for those tool names and field
 * names. If the server-side MCP contract evolves (renames a field,
 * restructures `suggestedFollowups`, adds new tools, etc.), update
 * this module in lockstep with the protocol change so the
 * agent-instruction text never references fields that don't exist.
 *
 * **Wave 17 follow-up (2026-05-09, post-PR-998):** the
 * vocabulary-mismatch-recovery wave (DISC-1626 + 40 sibling DISCs,
 * shipped via `glasstrace-product` PR #998) added five fields to
 * the no-match envelope on `find_trace_candidates`'s
 * `CandidateDiagnosticSchema` and the sibling-tools'
 * `ToolDiagnosticSchema`: `windowActivity`, `humanReadable`,
 * `diagnosticValue`, `recommendedNextStep`, and `maxUsefulFollowups`.
 * The Workflow §4 below names `closeMatches` /
 * `recentRoutesSample` / `windowActivity` / `humanReadable` /
 * `recoveryActions` / `diagnosticValue` / `recommendedNextStep`
 * because each disambiguates a different reason for an empty
 * result — most notably, `windowActivity` carries the four-way
 * distinguisher between "wrong vocabulary", "no traffic in window",
 * "captureConfig-blocked", and "no traces ever for this tenant"
 * (per `wire-mcp.ts` `NoMatchWindowActivitySchema` /
 * DISC-1652 Amendment 1 / DISC-1654). Without `windowActivity`
 * the agent cannot distinguish a vocabulary miss from "the SDK was
 * never registered for this tenant" — they look identical at the
 * `closeMatches`-only layer.
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
    "1. Pick the first call by symptom:",
    "   - **Active failure** (a stack trace, a recent error in this session, or a request that just failed) → `get_latest_error` first. It is the cheapest entry point when you know an error happened; it returns the most recent server error with its trace context and lets you skip the search step entirely.",
    "   - **Known route or procedure with suspected misbehavior** (you have a name to filter on, and a rough time window) → `find_trace_candidates` with that name and a **tight time window**. Pass the route name as you see it in source — the server normalizes vocabulary and, on miss, returns close matches and a sample of routes actually present in the window.",
    "   - **Historical exploration** (no known recent failure, you're checking whether a code path ever ran) → `find_trace_candidates` with an **open window**. Same tool, wider lens.",
    "2. Take the highest-confidence candidate's `suggestedFollowups` and pass them straight to `get_trace` or `get_root_cause`.",
    "3. For side-effect bugs, read `sideEffectSummary` in the `get_trace` / `get_root_cause` response. The allowlisted fields (`templateKey`, `providerOperation`, `role`, `locale`, `timezone`, `status`, `phase`) are the ones that disambiguate payload bugs.",
    "4. If a tool returns empty, READ the response's empty-result envelope before pivoting to source — each field disambiguates a different reason for the empty result:",
    "   - `closeMatches` / `recentRoutesSample` — your filter vocabulary doesn't match server-side names; the server returns the closest known names + a sample of routes actually present.",
    "   - `windowActivity` — load-bearing four-way distinguisher. `totalTracesInWindow === 0` AND `totalTracesInTenantEver > 0` means \"your time window missed the activity\"; `totalTracesInTenantEver === 0` means \"this tenant has never produced traces\" (SDK not registered, or never hit); `captureConfigBlocksRequest === true` means \"the SDK's capture config dropped this route\"; otherwise the empty result is a vocabulary miss — see `closeMatches`.",
    "   - `humanReadable` — prose guidance written for the agent.",
    "   - `recoveryActions` — concrete next-call shapes.",
    "   - `diagnosticValue` / `recommendedNextStep` — whether to keep searching or stop.",
    "   Empty results carry `notAbsenceProof: true` — they are never proof the bug did not occur.",
    "",
    "### Tools",
    "- `find_trace_candidates` — discovery, vocabulary-tolerant filter",
    "- `get_trace` — exact trace by `traceId`",
    "- `get_root_cause` — root-cause analysis for a `traceId`",
    "- `get_session_timeline` — events for a session",
    "- `get_latest_error` / `get_error_list` — recent server errors",
    "",
    "Side-effect evidence is allowlisted and compact by design. Fields you don't see may have been omitted by policy, not absent at runtime.",
    "",
  ].join("\n");
}
