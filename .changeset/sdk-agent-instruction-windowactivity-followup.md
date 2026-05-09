---
"@glasstrace/sdk": patch
---

feat(sdk): expand Workflow §4 of the agent-instruction body to name the new `windowActivity` / `humanReadable` / `diagnosticValue` / `recommendedNextStep` empty-result envelope fields

Wave 17 follow-up. The vocabulary-mismatch-recovery wave that
landed on the server side (closing DISC-1626 + 40 sibling DISCs)
added five fields to the no-match envelope on
`find_trace_candidates`'s `CandidateDiagnosticSchema` and the
sibling-tools' `ToolDiagnosticSchema`: `windowActivity`,
`humanReadable`, `diagnosticValue`, `recommendedNextStep`, and
`maxUsefulFollowups`. The Wave 17 SDK-injected agent-instruction
body shipped before those fields landed, so its Workflow §4 named
only `closeMatches` / `recentRoutesSample` / `recoveryActions`.

This release expands Workflow §4 to name each of the new fields
with a one-line gloss on what each one disambiguates. Most
importantly, `windowActivity` is now described as the load-bearing
four-way distinguisher between "wrong vocabulary", "no traffic in
window", "captureConfig-blocked", and "no traces ever for this
tenant" branches — without `windowActivity` the agent cannot tell
a vocabulary miss apart from "the SDK was never registered for
this tenant", because the two look identical at the
`closeMatches`-only layer.

Existing users on stale SDKs continue to see the prior content in
their agent instruction files until they run
`npx @glasstrace/sdk upgrade-instructions` (or
`npx @glasstrace/sdk mcp add` against the same target) — the
explicit DISC-1592 upgrade-refresh contract.

The DISC-1592 / DISC-1602 marker contract is preserved intact;
this is content-only, no public API surface change. **Patch bump.**
