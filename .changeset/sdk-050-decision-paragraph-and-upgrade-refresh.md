---
"@glasstrace/sdk": minor
---

feat(sdk): cost-aware cross-tool decision paragraph and version-stamped
upgrade-refresh mechanism for the agent-instruction managed section
(SDK-050; covers DISC-1585 and DISC-1586)

## Summary

The Glasstrace MCP managed section that the SDK injects into agent
instruction files (CLAUDE.md / codex.md / .cursorrules) now opens with
a cost-aware cross-tool decision paragraph and carries an SDK version
stamp on its start marker. Two new behaviours flow from the stamp:

1. `npx glasstrace upgrade-instructions` — refreshes the managed
   section in every detected agent instruction file in one run.
   Idempotent and safe to re-run; only files that already contain a
   Glasstrace marker pair are touched, so a hand-written `CLAUDE.md`
   without a Glasstrace block is left alone.
2. A one-time stderr warning at SDK init when the running SDK version
   is strictly newer than the on-disk stamp. Respects the
   `GLASSTRACE_DISABLE_UPGRADE_NOTICE` opt-out
   (`"1"` / `"true"` / `"yes"`, case-insensitive). Stderr only,
   Node-only, no file mutation, no network I/O, never throws.

The decision paragraph names cheapest-orientation routing per symptom
class — `get_latest_error` / `get_error_list` for current errors,
`find_trace_candidates` for known route/procedure/URL fragments — and
restates the no-candidates / no_traces_found "scoped retrieval result,
not absence proof" framing in user-facing language so the agent does
not give up on a miss.

## Backward compatibility

The marker parser recognises both legacy unstamped markers
(pre-SDK-050) AND stamped markers (SDK-050+). An upgrading user's
first re-render replaces the existing block in place rather than
appending a duplicate; subsequent re-renders write the stamped form.
A stale managed section with an unparseable stamp is treated as
"stamp present but unknown" — the warning is suppressed, but the
upgrade command still re-renders correctly (overwriting the
unparseable stamp with a fresh one).

The stamp encodes only the SDK semver string (e.g. `1.4.0`,
`0.0.0-canary-20260508120000`); arbitrary or environment-derived
content is rejected at the render site.

## Validation Prompt

<!-- version: 1 -->
# Validation Prompt: SDK-050 Canary Verification

**Authoritative source for the prompt that goes to the validation agent when
the SDK-050 canary publishes.** Do not duplicate the prompt elsewhere — copy
from this file (or from the SDK canary release notes that embed this file
verbatim per SDK-050's release-artifact requirement).

**Brief:** `docs/task-briefs/SDK-050.md`
**Discoveries covered:** DISC-1585 (decision paragraph), DISC-1586
(refresh-on-upgrade mechanism)
**Sibling brief (separate canary):** `docs/task-briefs/MCP-025.md` — uses a
similar but distinct prompt at
`docs/validation-prompts/MCP-025-server-verification.md` (will be authored
when MCP-025 is ready to ship; do not conflate the two prompts).

## How to use

1. The SDK conductor publishes an `@glasstrace/sdk` canary that satisfies
   SDK-050's Acceptance Gates. The canary's changeset description embeds
   the full prompt below (copy verbatim from this file).
2. Erik (or whoever cuts the canary) opens the GitHub release page for the
   canary. The prompt is at the bottom of the release notes.
3. Copy the prompt. Replace `<CANARY_VERSION>` with the actual canary
   version string (e.g. `0.0.0-canary-20260508120000`). Hand it to the
   validation agent in `glasstrace-validation`.
4. Validation agent returns the report. The conductor reviews it against
   SDK-050's Acceptance Gates. If green, conductor closes DISC-1585 and
   DISC-1586 and marks SDK-050 IMPLEMENTED. Erik then cuts the stable
   `@glasstrace/sdk` release.

## The prompt (copy from below verbatim)

```
TASK: Verify @glasstrace/sdk canary <CANARY_VERSION> against the
2026-05-07 MCP-natural baseline.

CONTEXT
The canary ships SDK-050: (1) a new cost-aware cross-tool decision
paragraph injected at the top of the Glasstrace MCP managed section in
agent instruction files (CLAUDE.md / .cursorrules / codex.md / etc.),
(2) a version-stamp on the section's start marker, (3) a one-time
stderr warning at SDK init when the stamped version is older than the
running SDK version, and (4) idempotent re-render via
`npx glasstrace mcp add` (or `upgrade-instructions` if introduced).
The MCP server is UNCHANGED from baseline — MCP-025 is not part of
this canary. Expect SDK-side behaviour shifts only.

BASELINE (2026-05-07 half-run, MCP-natural condition):
- find_trace_candidates: 8 calls (3 found, 5 zero-candidate)
- get_trace: 2 calls (1 rejected for missing timeWindow, 1 succeeded)
- get_latest_error / get_error_list / get_root_cause /
  get_session_timeline / get_test_suggestions: 0 calls each
- Specific zero-candidate sequences: RACE-004, RACE-005, DATA-005,
  PERF-009 (first attempt), DATA-004
- PERF-009 sequence: candidate row -> get_trace({ correlationId }) ->
  rejected -> manual retry with { url, method, timeWindow } -> success

PRE-FLIGHT
Throughout PRE-FLIGHT, treat <CANARY_VERSION> as the literal version
string Erik substituted at the top of this prompt (e.g.
`0.0.0-canary-20260508120000`). Run all PRE-FLIGHT steps against an
isolated copy of the 2026-05-07 validation target — clone the target
to a fresh working directory and run PRE-FLIGHT there so PRE-FLIGHT 4's
artificial stamp edit cannot corrupt the harness baseline. Before any
edit in PRE-FLIGHT 4, also save a byte-for-byte backup of the agent
instruction file so restoration is recoverable if the upgrade command
fails. EXECUTION still runs on the same project and agent instruction
file target as the 2026-05-07 half-run; only PRE-FLIGHT inspection
happens on the clone.

The "agent instruction file" referred to throughout this prompt is the
same file the SDK detected and wrote into during the 2026-05-07
half-run (see the half-run artifacts for the exact path and target
type — CLAUDE.md / .cursorrules / codex.md / agent.md / generic
fallback). Use that one file. Do not switch targets.

The "upgrade command" referred to throughout this prompt is whatever
command the SDK canary documents for re-rendering the managed section
(per SDK-050: either `npx glasstrace upgrade-instructions` or
`npx glasstrace mcp add` if that command is now documented as
idempotent). Determine the canonical command from the canary's
release notes / `--help` output and use it consistently.

1. Install @glasstrace/sdk@<CANARY_VERSION> in the validation target
   used for the 2026-05-07 half-run. Use the same project, same agent
   instruction file target. Run the canary's upgrade command once to
   render the managed section under the canary.
2. Confirm the managed Glasstrace MCP block in the agent instruction
   file (CLAUDE.md / equivalent) now contains:
   a. A decision paragraph BEFORE the per-tool bullet list.
   b. The phrases "runtime evidence would materially reduce
      uncertainty" and "not proof the bug is absent" (the SDK
      implementation may rephrase, but both load-bearing semantic
      claims must be present: (i) Glasstrace MCP is conditionally
      worth calling when runtime evidence reduces uncertainty, and
      (ii) a no-candidates / no_traces_found result is a scoped
      retrieval result, not absence of the bug). If wording diverges,
      quote the actual rendered text in the report so the conductor
      can adjudicate.
   c. Routing references for cheapest-first calls: "get_latest_error"
      and "get_error_list" for current-error symptoms;
      "find_trace_candidates" for known route/procedure.
   d. A version stamp on the start marker. For markdown targets the
      shape is `<!-- glasstrace:mcp:start v=<actual-version> -->`;
      for plain-text targets (e.g. `.cursorrules`) the shape is
      `# glasstrace:mcp:start v=<actual-version>`. The literal token
      after `v=` must equal the installed canary version string from
      step 1 (compare exact-match, including any pre-release suffix).
3. Confirm idempotent re-render: run the upgrade command a second time
   on the same file; confirm content outside the markers is byte-for-
   byte unchanged and content inside the markers is byte-for-byte
   identical to the first run. Capture both renders as artifacts (e.g.
   `pre-flight/render-1.txt`, `pre-flight/render-2.txt`) and a diff.
4. Confirm the stale-warning behaviour:
   a. Edit only the start-marker line to replace the stamped version
      with `v=1.0.0` (leave the body unchanged). Save a backup first.
   b. Start the SDK in a fresh process (no env overrides). Capture
      stderr. Confirm exactly one warning line appears, that it
      mentions the upgrade command, and that no warning appears on
      stdout. Re-run the SDK in another fresh process and confirm
      the warning still appears (the "once per process boot" rule
      means once per process, not once ever).
   c. Start the SDK in a fresh process with
      `GLASSTRACE_DISABLE_UPGRADE_NOTICE=true` set in the
      environment. Confirm zero warning lines on stderr.
   d. Unset the env var, start the SDK in a fresh process, and
      confirm the warning returns. This proves the opt-out is
      env-driven, not persistent file state.
   e. Restore the start marker by either (i) restoring the backup
      file from step 4a, or (ii) re-running the upgrade command to
      regenerate a current stamp. Confirm via `diff` against the
      pre-PRE-FLIGHT-4 backup that restoration succeeded before
      proceeding to EXECUTION. If restoration cannot be confirmed,
      stop and report; do not proceed to EXECUTION on a corrupted
      target.
   f. Additionally confirm Acceptance Gate 4 from the brief: with a
      current (non-stale) stamp in place, starting the SDK in a
      fresh process emits zero stderr warning lines about a stale
      managed section.

EXECUTION
Run the same MCP-natural condition as the 2026-05-07 half-run. Same
scenarios, same agent harness, same measurement window. Same agent
model and configuration — read the model name, version pin, and
harness configuration from the 2026-05-07 half-run manifest under
`glasstrace-validation/results/2026-05-07/` (or whatever the harness's
canonical baseline path is in that repo); do not infer or substitute.
Re-execute the full scenario set against the canary-rendered agent
instruction file; do not reuse cached agent state, cached scenario
seeds, or cached MCP responses. Start each scenario from a fresh
agent context. If the harness supports scenario seeds, use the same
seeds the half-run recorded.

If the harness fails partway through a scenario, log the failure,
finish the remaining scenarios, and report the partial run; do not
silently restart in a way that double-counts tool calls.

CAPTURE
For each scenario, log:
- Every MCP tool call: tool name, params (redacted of values, just
  the parameter-key shape), response category (found / zero-candidate
  / rejected / succeeded / errored — where "errored" means the tool
  was invoked but failed before returning a structured response), and
  the agent's next action. Count an "errored" call toward the total
  call count for that tool but track it separately so the report can
  distinguish it from the four success/empty/rejected categories.
- Whether the agent fell back to source inspection without exhausting
  MCP tool options.
- The full rendered managed-section text from the agent instruction
  file at the start of the run (so the conductor can confirm the
  decision paragraph and version stamp the agent actually saw).

REPORT (return exactly this structure; render as machine-parseable
markdown — numbered top-level items, fenced code blocks for
sequences, no prose preamble before item 1)
1. Tool-call totals across all scenarios. Counts are total invocations
   (including errored). Sub-buckets sum to the total per tool:
   - find_trace_candidates: <count> (<found> found / <empty> zero /
     <rejected> rejected / <errored> errored)
   - get_trace: <count> (<succeeded> / <rejected> / <errored>)
   - get_latest_error: <count>
   - get_error_list: <count>
   - get_root_cause: <count>
   - get_session_timeline: <count>
   - get_test_suggestions: <count>
2. Per-scenario tool sequences for: RACE-004, RACE-005, DATA-005,
   PERF-009 (full sequence including any retries — the baseline
   PERF-009 was: candidate row -> get_trace({correlationId}) ->
   rejected -> manual retry with {url, method, timeWindow} ->
   success), DATA-004 (the same five scenarios as baseline). Format
   each as one fenced line:
   `<scenario>: tool1(params-shape) -> outcome -> tool2(...) -> outcome`
3. Specifically for PERF-009: did the agent still produce a
   malformed get_trace({ correlationId }) call? (Expected: yes,
   because MCP-025 is not in this canary; the SDK-side decision
   paragraph alone does not fix the rejection envelope. We measure
   this so MCP-025's eventual impact can be attributed. If the agent
   does NOT produce the malformed call, that is a noteworthy
   anomaly — flag it under item 8 with the actual sequence. Do not
   count its absence as a pass.)
4. Candidate-success ratio:
   `find_trace_candidates calls returning >=1 candidate /
    total find_trace_candidates calls (including errored)`
   Report as "<numerator>/<denominator> (<percentage>%)". Baseline
   was 3/8 (37.5%).
5. Cross-tool reach. For each of get_latest_error, get_error_list,
   get_root_cause, get_session_timeline, get_test_suggestions, report
   on its own line: "<tool>: Y, <count> calls across <N> scenarios:
   <scenario-ids>" or "<tool>: N". "Y" requires at least one
   invocation in any scenario (the baseline had zero across all
   scenarios for these five tools, so any non-zero count is a Y).
6. Fallback-to-source-inspection: in how many scenarios did the agent
   give up on MCP and read source code instead? Define "fell back" as
   the agent issuing a source-read action (file read / grep / code
   inspection of the application under test) after one or more
   zero-result or rejected MCP calls without first attempting any
   other Glasstrace MCP tool. Report `<count>/<total-scenarios>` and
   list the scenario IDs. Compare to the same metric in the half-run
   baseline.
7. Token-cost delta vs baseline. The 2026-05-07 half-run reported a
   1.22x median agent time multiplier and a 1.75x average agent
   tokens multiplier for MCP-natural over the no-MCP control
   condition. To compute comparable multipliers in this run, also
   execute the no-MCP control condition the half-run used (same
   scenarios, same model, MCP server disabled), or — if a control run
   already exists alongside the canary execution — reuse it and cite
   its path. Report:
   - Median agent wall-clock time per scenario: MCP-natural / control
     (seconds), and the multiplier.
   - Average agent tokens per scenario: MCP-natural / control, and
     the multiplier.
   - Aggregation is per-scenario then averaged across scenarios; do
     not aggregate per-call.
   Compare the two multipliers to the baseline (1.22x time, 1.75x
   tokens). If a control run is not available, state that explicitly
   and report the absolute MCP-natural numbers; the conductor will
   adjudicate.
8. Any anomalies, harness errors, or sequences that diverge
   meaningfully from baseline expectations. Include any PRE-FLIGHT
   step that did not return a clean green.

ARTIFACTS
- Save the full run under
  `glasstrace-validation/results/<YYYY-MM-DD>-sdk050-canary-<CANARY_VERSION>/`
  using the actual run date and canary version string. Use only
  filesystem-safe characters in the path (replace any `+` in the
  canary version with `-`).
- Inside that directory, include at minimum:
  - `pre-flight/` with the rendered managed-section text after
    install (`render-1.txt`), after the second upgrade run
    (`render-2.txt`), the diff between them, the captured stderr
    from each stale-warning sub-test, and the restored-file diff.
  - `report.md` containing the REPORT section verbatim.
  - `scenarios/<scenario-id>/` for each scenario, with the captured
    tool-call log and any scenario-specific artifacts the harness
    emits.
  - `agent-instructions-rendered.<ext>` — a copy of the full agent
    instruction file (markers and managed section included) as the
    agent saw it during EXECUTION.
- Return the run path along with the report.

DO NOT
- Modify the validation harness prompts (the per-scenario prompts the
  harness sends to the agent). The decision paragraph must reach the
  agent through the SDK-injected instruction file, not through a
  sweetened harness prompt. Installing the canary, pinning the same
  agent model, and configuring scenario seeds is allowed; rewriting
  scenario prompt text is not.
- Modify the MCP server, its responses, or its tool descriptions.
  MCP-025 is not in this canary.
- Run on a different agent model / version / temperature / tool-use
  configuration than the 2026-05-07 baseline.
- Treat "or equivalent semantics" in PRE-FLIGHT 2b as license to
  accept text that drops either of the two load-bearing claims listed
  there. If either claim is missing, report it under item 8.
```

## Acceptance criteria for closeout

The conductor closes DISC-1585, DISC-1586, and SDK-050 only when the
returned report shows ALL of the following:

- **Pre-flight 1–4 all confirm green.** The decision paragraph is
  present (with both load-bearing semantic claims from PRE-FLIGHT 2b),
  the version stamp is on the start marker and equals the installed
  canary version, idempotent re-render is byte-for-byte stable inside
  the markers and untouched outside, the stale-warning behaviour fires
  exactly once per process boot pointing at the upgrade command, the
  `GLASSTRACE_DISABLE_UPGRADE_NOTICE=true` opt-out suppresses it,
  unsetting the env var brings it back, and a current (non-stale)
  stamp produces zero stderr warnings (brief Acceptance Gate 4).
- **Cross-tool reach is non-zero.** The agent invokes at least one of
  `get_latest_error` / `get_error_list` / `get_root_cause` /
  `get_session_timeline` / `get_test_suggestions` across scenarios
  where the baseline had zero such calls. Specifically, current-error
  symptoms (RACE-004 / RACE-005 / DATA-004) should now reach for
  `get_latest_error` or `get_error_list` first.
- **Candidate-success ratio improves** vs baseline 3/8 (37.5%). A
  meaningful lift threshold is to be set by the conductor at review
  time, not pre-committed here, because the small N of the half-run
  baseline does not support a hard percentage gate. The qualitative
  question is: is the agent making fewer single-parameter guesses?
- **PERF-009-class rejection still occurs.** This is a feature, not a
  bug, of this canary. Confirms the rejection-envelope fix really does
  belong to MCP-025 and is not accidentally addressed by the SDK
  change.
- **Fallback-to-source-inspection rate does not regress** vs baseline.
- **Token-cost multipliers do not regress** materially vs baseline.

If the report misses any of these, conductor triages: file follow-up
discoveries, decide whether to iterate the canary or hold the SDK
release for a v2 canary that addresses the gap.
