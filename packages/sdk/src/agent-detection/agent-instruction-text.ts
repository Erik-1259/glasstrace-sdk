/**
 * The text body the SDK injects into a user's agent-instruction file
 * (AGENTS.md, CLAUDE.md, GEMINI.md, .cursor/rules/glasstrace.mdc,
 * .windsurf/rules/glasstrace.md, plus legacy .cursorrules — the
 * canonical set follows the 2026 cross-tool standard) between the
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
 * marker contract that has soaked in production and must not regress).
 *
 * **Vocabulary alignment:** every MCP tool name and response-field
 * name in the body below is verified against the current server-side
 * MCP server contract; the SDK consumes the resulting wire format but
 * does not own the schema source of truth for those tool names and
 * field names. If the server-side MCP contract evolves (renames a field,
 * restructures `suggestedFollowups`, adds new tools, etc.), update
 * this module in lockstep with the protocol change so the
 * agent-instruction text never references fields that don't exist.
 *
 * **Vocabulary-mismatch-recovery follow-up:** the
 * vocabulary-mismatch-recovery work added five fields to
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
 * (per `wire-mcp.ts` `NoMatchWindowActivitySchema`). Without `windowActivity`
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
 * load-bearing recovery contract (codified in the server-side MCP
 * `ToolDiagnosticSchema` and `CandidateDiagnosticSchema`), and it
 * prevents the bail-to-source failure mode the prior cost-aware
 * decision paragraph did not surface. Beyond routing the first call,
 * the Workflow also teaches how to USE what the tools return: it frames
 * `sideEffectEvidence` (compact presence on candidates) and
 * `sideEffectSummary` (the per-operation values on `get_latest_error` /
 * `get_trace` / `get_root_cause`) as first-class runtime evidence,
 * reads `*Holds` keys as boolean claims, treats a thin follow-up (an
 * empty `get_span_attributes`, an `unavailable` `get_root_cause`) as
 * still-usable rather than a dead end, and narrows to the smallest
 * source path the evidence names — while cross-checking every trace
 * fact against source.
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
 * version-stamped start/end markers per the marker contract.
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
    "3. Side-effect evidence is first-class runtime evidence, not metadata. `find_trace_candidates` candidates (and trace summaries) may carry a compact `sideEffectEvidence` (present only when the trace captured side-effect evidence) — listing which operation kinds and field keys were observed; when present, it is a signal to pull the trace, not a dead end. The actual per-operation values come from `sideEffectSummary`, returned by `get_latest_error`, `get_trace`, and `get_root_cause` (likewise present when the trace captured side-effect evidence). Read both directly:",
    "   - **Semantic booleans** — any field whose key ends in `Holds` is a true/false claim about what the trace observed. Interpret it as that claim, not as opaque metadata.",
    "   - **Categorical fields** — `templateKey`, `providerOperation`, and the operation `status` / `phase` (on each `sideEffectSummary.operations[]` entry) identify which operation ran and what state transition it reached. The allowlisted disambiguators are `templateKey`, `providerOperation`, `role`, `locale`, `timezone`, `status`, `phase`.",
    "   - Cross-check what the trace asserts against source and direct verification — trace facts are observations to confirm in code, not a substitute for reading it.",
    "   - **A candidate with absent compact summaries is still evidence.** The compact category projections — `performanceQuerySummary`, `dataShapeSummary`, `raceConcurrencySummary`, `contextBranchSummary` — are emitted only on the top-ranked candidate and only when they fit a small inline budget, so their absence is normal, not absence of evidence. A `sideEffectEvidence` that is absent or has `status` `missing` / `withheld` / `unsupported` is likewise not proof there was no side effect (it carries `notAbsenceProof`). In every case, pull the trace with `get_trace` / `get_root_cause` for the full values before concluding nothing happened.",
    "4. If a tool returns empty, READ the response's empty-result envelope before pivoting to source — each field disambiguates a different reason for the empty result:",
    "   - `closeMatches` / `recentRoutesSample` — your filter vocabulary doesn't match server-side names; the server returns the closest known names + a sample of routes actually present.",
    "   - `windowActivity` — load-bearing four-way distinguisher. `totalTracesInWindow === 0` AND `totalTracesInTenantEver > 0` means \"your time window missed the activity\"; `totalTracesInTenantEver === 0` means \"this tenant has never produced traces\" (SDK not registered, or never hit); `captureConfigBlocksRequest === true` means \"the SDK's capture config dropped this route\"; otherwise the empty result is a vocabulary miss — see `closeMatches`.",
    "   - `humanReadable` — prose guidance written for the agent.",
    "   - `recoveryActions` — concrete next-call shapes.",
    "   - `diagnosticValue` / `recommendedNextStep` — whether to keep searching or stop.",
    "   Empty results carry `notAbsenceProof: true` — they are never proof the bug did not occur.",
    "5. Follow-up tools refine evidence; they do not invalidate it:",
    "   - `get_span_attributes` is a scalar drill-down for span attributes. An empty result (no scalars returned) only means there was no scalar drill-down for that trace — it does NOT invalidate side-effect evidence already present in a candidate or trace summary.",
    "   - If `get_root_cause` returns `status: \"unavailable\"`, the trace is still usable: continue from the candidate summaries and the trace detail it still ships — `summary` and `spans` (always), plus `sideEffectSummary` when the trace captured side-effect evidence — rather than retrying the same call or discarding the trace.",
    "6. Once trace evidence names a route, procedure, or operation, open the smallest source path tied to that operation first. Widen to broad framework / auth / UI exploration only if that path does not explain the evidence.",
    "7. Stateful bugs often span more than one request — for example a write or update request followed by a later read, render, or action request. When a single trace looks correct in isolation, compare the relevant traces in sequence before concluding.",
    "8. If a route-based search is sparse, ambiguous, or returns only a weak candidate, do not conclude the code path never ran — broaden or retry by procedure/operation: `find_trace_candidates({ procedure: \"<name>\" })` (e.g. `{ procedure: \"billing.subscribe\" }` or `{ procedure: \"settings.update\" }`). The `procedure` filter is preferred over a vague route fragment, and is especially useful for runtime-state bugs. Before concluding a path did not run, compare the candidate's `route` pattern against the URL you actually searched — a mismatch usually means you filtered on the wrong name, not that the path is absent.",
    "",
    "### Tools",
    "- `find_trace_candidates` — discovery, vocabulary-tolerant filter",
    "- `get_trace` — exact trace by `traceId`",
    "- `get_root_cause` — root-cause analysis for a `traceId`",
    "- `get_span_attributes` — scalar span-attribute drill-down for a `traceId`",
    "- `get_session_timeline` — events for a session",
    "- `get_latest_error` / `get_error_list` — recent server errors",
    "",
    "Side-effect evidence is allowlisted and compact by design. Fields you don't see may have been omitted by policy, not absent at runtime.",
    "",
  ].join("\n");
}
