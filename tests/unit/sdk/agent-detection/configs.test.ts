import { describe, it, expect } from "vitest";
import {
  generateMcpConfig,
  generateInfoSection,
  generateInfoSectionForCursorMdc,
  generateInfoSectionForCursorrulesLegacy,
} from "../../../../packages/sdk/src/agent-detection/configs.js";
import type { DetectedAgent } from "../../../../packages/sdk/src/agent-detection/detect.js";

const ENDPOINT = "https://mcp.glasstrace.dev/v1";
const ANON_KEY = "gt_anon_test123";
// SDK-050: generateInfoSection() now requires the SDK semver string for
// the version-stamped start marker. Pin a stable test value so snapshot
// assertions don't drift when package.json's version bumps.
const SDK_VERSION = "1.4.0";

function makeAgent(
  name: DetectedAgent["name"],
  overrides?: Partial<DetectedAgent>,
): DetectedAgent {
  return {
    name,
    mcpConfigPath: `/fake/${name}/mcp.json`,
    infoFilePath: null,
    cliAvailable: false,
    registrationCommand: null,
    ...overrides,
  };
}

describe("generateMcpConfig", () => {
  describe("input validation", () => {
    it("throws when endpoint is empty", () => {
      expect(() =>
        generateMcpConfig(makeAgent("generic"), "", ANON_KEY),
      ).toThrow(/endpoint must not be empty/);
    });

    it("throws when endpoint is whitespace-only", () => {
      expect(() =>
        generateMcpConfig(makeAgent("generic"), "   ", ANON_KEY),
      ).toThrow(/endpoint must not be empty/);
    });

    it("throws when anonKey is empty", () => {
      expect(() =>
        generateMcpConfig(makeAgent("generic"), ENDPOINT, ""),
      ).toThrow(/bearer must not be empty/);
    });

    it("throws when anonKey is whitespace-only", () => {
      expect(() =>
        generateMcpConfig(makeAgent("generic"), ENDPOINT, "   "),
      ).toThrow(/bearer must not be empty/);
    });

    it("throws when endpoint is valid but anonKey is empty (partial invalidity)", () => {
      expect(() =>
        generateMcpConfig(makeAgent("claude"), ENDPOINT, ""),
      ).toThrow(/bearer must not be empty/);
    });
  });

  describe("Claude Code config", () => {
    it("produces correct JSON with type and url fields", () => {
      const config = generateMcpConfig(
        makeAgent("claude"),
        ENDPOINT,
        ANON_KEY,
      );
      const parsed = JSON.parse(config);
      expect(parsed).toEqual({
        mcpServers: {
          glasstrace: {
            type: "http",
            url: ENDPOINT,
            headers: {
              Authorization: `Bearer ${ANON_KEY}`,
            },
          },
        },
      });
    });

    it("is pretty-printed with 2-space indent", () => {
      const config = generateMcpConfig(
        makeAgent("claude"),
        ENDPOINT,
        ANON_KEY,
      );
      expect(config).toContain("  ");
      expect(config).not.toContain("\t");
    });
  });

  describe("Codex CLI config", () => {
    it("produces valid TOML format", () => {
      const config = generateMcpConfig(
        makeAgent("codex"),
        ENDPOINT,
        ANON_KEY,
      );
      expect(config).toContain("[mcp_servers.glasstrace]");
      expect(config).toContain(`url = "${ENDPOINT}"`);
      expect(config).toContain(
        'bearer_token_env_var = "GLASSTRACE_API_KEY"',
      );
    });

    it("does NOT contain the actual token value", () => {
      const config = generateMcpConfig(
        makeAgent("codex"),
        ENDPOINT,
        ANON_KEY,
      );
      expect(config).not.toContain(ANON_KEY);
    });

    it("escapes control characters in the endpoint for valid TOML", () => {
      const malformedEndpoint = "https://example.com/path\nHost: evil.com";
      const config = generateMcpConfig(
        makeAgent("codex"),
        malformedEndpoint,
        ANON_KEY,
      );
      // The raw newline must be escaped, not embedded literally
      expect(config).not.toContain("\nHost:");
      expect(config).toContain("\\n");
      // Verify backslash and tab escaping as well
      const withTab = "https://example.com/\tpath";
      const tabConfig = generateMcpConfig(makeAgent("codex"), withTab, ANON_KEY);
      expect(tabConfig).not.toContain("\t");
      expect(tabConfig).toContain("\\t");
    });

    it("escapes carriage returns in the endpoint", () => {
      const withCR = "https://example.com/\r\npath";
      const config = generateMcpConfig(makeAgent("codex"), withCR, ANON_KEY);
      expect(config).not.toContain("\r");
      expect(config).toContain("\\r");
    });
  });

  describe("Gemini CLI config", () => {
    it("uses httpUrl instead of url", () => {
      const config = generateMcpConfig(
        makeAgent("gemini"),
        ENDPOINT,
        ANON_KEY,
      );
      const parsed = JSON.parse(config);
      expect(parsed.mcpServers.glasstrace.httpUrl).toBe(ENDPOINT);
      expect(parsed.mcpServers.glasstrace.url).toBeUndefined();
    });

    it("includes auth header", () => {
      const config = generateMcpConfig(
        makeAgent("gemini"),
        ENDPOINT,
        ANON_KEY,
      );
      const parsed = JSON.parse(config);
      expect(parsed.mcpServers.glasstrace.headers.Authorization).toBe(
        `Bearer ${ANON_KEY}`,
      );
    });
  });

  describe("Cursor config", () => {
    // DISC-1573 / Wave 17: cursor branch now emits the canonical
    // `{ type: "http", url, headers }` shape per Cursor's current MCP
    // HTTP server schema. The prior shape (no `type` field) is retired.
    it("emits the canonical Claude-compatible HTTP shape", () => {
      const config = generateMcpConfig(
        makeAgent("cursor"),
        ENDPOINT,
        ANON_KEY,
      );
      expect(JSON.parse(config)).toEqual({
        mcpServers: {
          glasstrace: {
            type: "http",
            url: ENDPOINT,
            headers: { Authorization: `Bearer ${ANON_KEY}` },
          },
        },
      });
    });

    it("includes auth header", () => {
      const config = generateMcpConfig(
        makeAgent("cursor"),
        ENDPOINT,
        ANON_KEY,
      );
      const parsed = JSON.parse(config);
      expect(parsed.mcpServers.glasstrace.headers.Authorization).toBe(
        `Bearer ${ANON_KEY}`,
      );
    });
  });

  describe("Windsurf config", () => {
    // DISC-1574 / Wave 17: windsurf branch now emits `url` (not the
    // prior `serverUrl`) and includes `type: "http"` per Windsurf's
    // current MCP HTTP server schema. The prior shape is retired.
    it("emits the canonical Claude-compatible HTTP shape (was: serverUrl + no type)", () => {
      const config = generateMcpConfig(
        makeAgent("windsurf"),
        ENDPOINT,
        ANON_KEY,
      );
      expect(JSON.parse(config)).toEqual({
        mcpServers: {
          glasstrace: {
            type: "http",
            url: ENDPOINT,
            headers: { Authorization: `Bearer ${ANON_KEY}` },
          },
        },
      });
      // Regression guard: the legacy `serverUrl` field MUST NOT appear.
      const parsed = JSON.parse(config);
      expect(parsed.mcpServers.glasstrace.serverUrl).toBeUndefined();
    });

    it("includes auth header", () => {
      const config = generateMcpConfig(
        makeAgent("windsurf"),
        ENDPOINT,
        ANON_KEY,
      );
      const parsed = JSON.parse(config);
      expect(parsed.mcpServers.glasstrace.headers.Authorization).toBe(
        `Bearer ${ANON_KEY}`,
      );
    });
  });

  describe("exhaustive switch", () => {
    it("throws for an unknown agent name", () => {
      const unknownAgent = makeAgent("claude");
      // Force an invalid name to test the default branch at runtime
      (unknownAgent as { name: string }).name = "unknown-agent";
      expect(() =>
        generateMcpConfig(unknownAgent as DetectedAgent, ENDPOINT, ANON_KEY),
      ).toThrow(/Unknown agent/);
    });
  });

  describe("Generic config", () => {
    it("uses url field", () => {
      const config = generateMcpConfig(
        makeAgent("generic"),
        ENDPOINT,
        ANON_KEY,
      );
      const parsed = JSON.parse(config);
      expect(parsed.mcpServers.glasstrace.url).toBe(ENDPOINT);
    });

    it("includes auth header", () => {
      const config = generateMcpConfig(
        makeAgent("generic"),
        ENDPOINT,
        ANON_KEY,
      );
      const parsed = JSON.parse(config);
      expect(parsed.mcpServers.glasstrace.headers.Authorization).toBe(
        `Bearer ${ANON_KEY}`,
      );
    });

    // DISC-1572: the generic shape must include `type: "http"` so
    // `.glasstrace/mcp.json` is accepted by Claude Code's
    // `--strict-mcp-config` validator. The full shape assertion below
    // pins the field set so that future emitter changes either adopt
    // the new shape or fail loudly in this test.
    it("emits the Claude-compatible HTTP shape", () => {
      const config = generateMcpConfig(
        makeAgent("generic"),
        ENDPOINT,
        ANON_KEY,
      );
      expect(JSON.parse(config)).toEqual({
        mcpServers: {
          glasstrace: {
            type: "http",
            url: ENDPOINT,
            headers: { Authorization: `Bearer ${ANON_KEY}` },
          },
        },
      });
    });
  });
});

describe("generateInfoSection", () => {
  describe("input validation", () => {
    it("throws when endpoint is empty", () => {
      expect(() => generateInfoSection(makeAgent("claude"), "", SDK_VERSION)).toThrow(
        /endpoint must not be empty/,
      );
    });

    it("throws when endpoint is whitespace-only", () => {
      expect(() =>
        generateInfoSection(makeAgent("claude"), "   ", SDK_VERSION),
      ).toThrow(/endpoint must not be empty/);
    });
  });

  describe("Claude Code info section", () => {
    it("uses HTML comment markers carrying the SDK version stamp", () => {
      const info = generateInfoSection(makeAgent("claude"), ENDPOINT, SDK_VERSION);
      expect(info).toContain(`<!-- glasstrace:mcp:start v=${SDK_VERSION} -->`);
      expect(info).toContain("<!-- glasstrace:mcp:end -->");
    });

    // Wave 17 / 2026-05-09: the new agent-instruction body deliberately
    // does NOT inline the endpoint URL — agents reach Glasstrace via the
    // MCP server name `glasstrace` configured in `.glasstrace/mcp.json`
    // or per-agent native config. Keeping the URL out of the instruction
    // file avoids drift between the instruction file and the MCP config.
    // (Prior SDK-050 contract DID inline the endpoint; that test
    // assertion has been retired in lockstep with the content evolution.)
    it("does NOT inline the endpoint URL (Wave 17 — agent reaches Glasstrace via MCP server name, not by reading URL from instruction file)", () => {
      const info = generateInfoSection(makeAgent("claude"), ENDPOINT, SDK_VERSION);
      expect(info).not.toContain(ENDPOINT);
      // The MCP server name SHOULD be present so the agent knows which
      // configured server to call.
      expect(info).toContain("`glasstrace`");
    });

    it("does NOT contain any auth token", () => {
      const info = generateInfoSection(makeAgent("claude"), ENDPOINT, SDK_VERSION);
      expect(info).not.toContain(ANON_KEY);
      expect(info).not.toContain("Bearer");
      expect(info).not.toContain("Authorization");
      expect(info).not.toContain("gt_anon_");
      expect(info).not.toContain("gt_dev_");
    });

    it("references the current MCP tools list (get_test_suggestions retired; get_span_attributes drill-down included)", () => {
      const info = generateInfoSection(makeAgent("claude"), ENDPOINT, SDK_VERSION);
      expect(info).toContain("get_latest_error");
      expect(info).toContain("find_trace_candidates");
      expect(info).toContain("get_error_list");
      expect(info).toContain("get_trace");
      expect(info).toContain("get_root_cause");
      // get_span_attributes is a registered MCP tool (the scalar
      // span-attribute drill-down); the body names it so the agent can
      // reach the Layer-2 evidence the Workflow follow-up guidance
      // refers to. Pin it to the primary Tools list line (mirrors the
      // get_test_suggestions OFF-list guard below) so dropping the list
      // entry is caught even if the §5 prose mention survives.
      expect(
        info.split("\n").some((l) => /^- `get_span_attributes`/.test(l)),
        "get_span_attributes appears on the primary Tools list",
      ).toBe(true);
      expect(info).toContain("get_session_timeline");
      // get_test_suggestions stays OFF the primary Tools list — the
      // Workflow covers the discovery-then-deep-dive path without a
      // separate test-suggestions bullet (it still requires a traceId at
      // the MCP server contract level; the agent learns the traceId via
      // `suggestedFollowups`).
      const line = info
        .split("\n")
        .find((l) => /^- `get_test_suggestions`/.test(l));
      expect(
        line,
        "get_test_suggestions stays off the primary Tools list",
      ).toBeUndefined();
    });

    // Wave 17 vocabulary correction (R13 from wave plan): the prompt
    // names `suggestedFollowups` (singular noun, no Args suffix) — that
    // is the actual server contract field name in
    // `wire-mcp.ts:755`. An earlier draft of the prompt used
    // `suggestedFollowupArgs`; if that string ever appears in the
    // rendered output, the vocabulary has drifted and downstream agents
    // will look for a non-existent field.
    it("uses the correct `suggestedFollowups` field name (NOT `suggestedFollowupArgs`)", () => {
      const info = generateInfoSection(makeAgent("claude"), ENDPOINT, SDK_VERSION);
      expect(info).toContain("`suggestedFollowups`");
      expect(info).not.toContain("suggestedFollowupArgs");
    });
  });

  describe("Codex info section", () => {
    it("uses HTML comment markers carrying the SDK version stamp", () => {
      const info = generateInfoSection(makeAgent("codex"), ENDPOINT, SDK_VERSION);
      expect(info).toContain(`<!-- glasstrace:mcp:start v=${SDK_VERSION} -->`);
      expect(info).toContain("<!-- glasstrace:mcp:end -->");
    });

    it("does NOT contain any auth token", () => {
      const info = generateInfoSection(makeAgent("codex"), ENDPOINT, SDK_VERSION);
      expect(info).not.toContain("Bearer");
      expect(info).not.toContain("Authorization");
    });
  });

  describe("Cursor info section", () => {
    it("uses HTML comment markers (Wave 18: cursor canonical destination is .cursor/rules/glasstrace.mdc which is Markdown-extension; prior hash markers were for the legacy .cursorrules file)", () => {
      const info = generateInfoSection(makeAgent("cursor"), ENDPOINT, SDK_VERSION);
      expect(info).toContain("<!-- glasstrace:mcp:start");
      expect(info).toContain("<!-- glasstrace:mcp:end -->");
    });

    it("does NOT contain any auth token", () => {
      const info = generateInfoSection(makeAgent("cursor"), ENDPOINT, SDK_VERSION);
      expect(info).not.toContain("Bearer");
      expect(info).not.toContain("Authorization");
    });
  });

  describe("exhaustive switch", () => {
    it("throws for an unknown agent name", () => {
      const unknownAgent = makeAgent("claude");
      (unknownAgent as { name: string }).name = "unknown-agent";
      expect(() =>
        generateInfoSection(unknownAgent as DetectedAgent, ENDPOINT, SDK_VERSION),
      ).toThrow(/Unknown agent/);
    });
  });

  describe("Wave 18: all agents now render an info section", () => {
    // Pre-Wave-18 the gemini/windsurf/generic branches returned ""
    // because the SDK had no canonical destination wired for them.
    // Wave 18 (DISC-1782) wires every agent to a 2026 canonical
    // destination (GEMINI.md / .windsurf/rules/glasstrace.md /
    // AGENTS.md) so generateInfoSection now returns content for all
    // six agents.
    it("renders the body for gemini wrapped in HTML markers", () => {
      const info = generateInfoSection(makeAgent("gemini"), ENDPOINT, SDK_VERSION);
      expect(info).toContain("<!-- glasstrace:mcp:start");
      expect(info).toContain("<!-- glasstrace:mcp:end -->");
      expect(info).toContain("Glasstrace MCP");
    });

    it("renders the body for windsurf wrapped in HTML markers", () => {
      const info = generateInfoSection(makeAgent("windsurf"), ENDPOINT, SDK_VERSION);
      expect(info).toContain("<!-- glasstrace:mcp:start");
      expect(info).toContain("<!-- glasstrace:mcp:end -->");
      expect(info).toContain("Glasstrace MCP");
    });

    it("renders the body for generic wrapped in HTML markers (universal AGENTS.md fallback)", () => {
      const info = generateInfoSection(makeAgent("generic"), ENDPOINT, SDK_VERSION);
      expect(info).toContain("<!-- glasstrace:mcp:start");
      expect(info).toContain("<!-- glasstrace:mcp:end -->");
      expect(info).toContain("Glasstrace MCP");
    });
  });

  // Wave 17 (2026-05-09): snapshot-style assertions on the rendered info
  // section for every target that emits content today (claude / codex /
  // cursor). The body is sourced from the new sibling
  // `agent-instruction-text.ts` module per Erik's 2026-05-09 Prompt 1
  // directive. Two load-bearing parts the prior SDK-050 / DISC-1593
  // paragraph did NOT have:
  //   1. Explicit `Call Glasstrace FIRST when:` / `SKIP Glasstrace when:`
  //      decision rules — give a frontier agent a cheap pre-tool-call
  //      heuristic before spending tokens on tool consideration.
  //   2. Explicit instruction to READ `closeMatches`, `recentRoutesSample`,
  //      and `recoveryActions` before pivoting to source — prevents the
  //      bail-to-source failure mode after an empty MCP result.
  //
  // (The prior SDK-050 acceptance-gate assertions for the cost-aware
  // decision paragraph have been retired in lockstep with the content
  // evolution; the marker / version-stamp contract from DISC-1592 +
  // DISC-1602 is preserved and asserted below.)
  describe("Wave 17 agent-instruction body + version stamp", () => {
    const TARGETS = [
      { name: "claude" as const, markerKind: "html" as const },
      { name: "codex" as const, markerKind: "html" as const },
      // Wave 18 (DISC-1782): Cursor's canonical destination changed
      // from `.cursorrules` (hash markers) to `.cursor/rules/
      // glasstrace.mdc` (Markdown-extension format with HTML markers).
      // The legacy `.cursorrules` transitional fallback retains hash
      // markers via `generateInfoSectionForCursorrulesLegacy`.
      { name: "cursor" as const, markerKind: "html" as const },
      { name: "gemini" as const, markerKind: "html" as const },
      { name: "windsurf" as const, markerKind: "html" as const },
      { name: "generic" as const, markerKind: "html" as const },
    ];

    for (const target of TARGETS) {
      describe(`target=${target.name}`, () => {
        it("renders the FIRST/SKIP decision rules", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          // Two load-bearing decision-rule headers that give a frontier
          // agent a cheap pre-tool-call heuristic.
          expect(info).toContain("### Call Glasstrace FIRST when:");
          expect(info).toContain("### SKIP Glasstrace when:");
          // At least one trigger and one skip indicator must be present.
          expect(info).toMatch(/role, locale, timezone/);
          expect(info).toMatch(/statically obvious from source/);
        });

        it("renders the Workflow step 1 as a symptom-keyed decision tree", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          expect(info).toContain("### Workflow");
          const workflowIdx = info.indexOf("### Workflow");
          // Step 1 is now a decision-tree header that routes to one of
          // three first calls by symptom (active failure /
          // known-route / historical exploration).
          const stepOneIdx = info.indexOf(
            "1. Pick the first call by symptom:",
            workflowIdx,
          );
          expect(stepOneIdx).toBeGreaterThan(-1);
          // All three first-call branches present and named.
          const stepOneSlice = info.slice(stepOneIdx, stepOneIdx + 1500);
          expect(stepOneSlice).toContain("Active failure");
          expect(stepOneSlice).toContain("`get_latest_error`");
          expect(stepOneSlice).toContain("Known route or procedure");
          expect(stepOneSlice).toContain("`find_trace_candidates`");
          expect(stepOneSlice).toContain("tight time window");
          expect(stepOneSlice).toContain("Historical exploration");
          expect(stepOneSlice).toContain("open window");
        });

        it("preserves the SDK-050 cost-aware framing alongside the decision-tree §1", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          // The decision tree is additive — the SDK-050 cost-aware
          // sections (Call Glasstrace FIRST when / SKIP Glasstrace
          // when) must remain present alongside the new Workflow §1
          // so the agent has both the symptom-class router (which
          // tool to pick first) and the cost-vs-skip guidance
          // (whether to call Glasstrace at all).
          expect(info).toContain("### Call Glasstrace FIRST when:");
          expect(info).toContain("### SKIP Glasstrace when:");
          // Both must appear BEFORE the Workflow section so an agent
          // reading top-to-bottom evaluates "should I call?" before
          // "which tool?". Pin both section positions so a future
          // content edit can't silently drift either one below the
          // Workflow header.
          const firstWhenIdx = info.indexOf("### Call Glasstrace FIRST when:");
          const skipWhenIdx = info.indexOf("### SKIP Glasstrace when:");
          const workflowIdx = info.indexOf("### Workflow");
          expect(firstWhenIdx).toBeLessThan(workflowIdx);
          expect(skipWhenIdx).toBeLessThan(workflowIdx);
          // Conventional ordering: Call FIRST before SKIP, both
          // before Workflow.
          expect(firstWhenIdx).toBeLessThan(skipWhenIdx);
        });

        it("references the empty-result envelope contract (closeMatches / recentRoutesSample / windowActivity / humanReadable / recoveryActions / diagnosticValue / recommendedNextStep / notAbsenceProof)", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          // Workflow §4 — load-bearing recovery contract from MCP-025 /
          // MCP-027 / DISC-1626 / DISC-1652 codified in
          // `wire-mcp.ts` ToolDiagnosticSchema + CandidateDiagnosticSchema.
          // Without these the agent bails to source on empty results —
          // the failure mode the parent wave fixes. Wave 17 follow-up
          // (post-PR-998) added windowActivity, humanReadable,
          // diagnosticValue, and recommendedNextStep alongside the
          // original closeMatches / recentRoutesSample / recoveryActions
          // because each disambiguates a different reason for the empty
          // result.
          expect(info).toContain("`closeMatches`");
          expect(info).toContain("`recentRoutesSample`");
          expect(info).toContain("`windowActivity`");
          expect(info).toContain("`humanReadable`");
          expect(info).toContain("`recoveryActions`");
          expect(info).toContain("`diagnosticValue`");
          expect(info).toContain("`recommendedNextStep`");
          expect(info).toContain("`notAbsenceProof: true`");
        });

        it("describes windowActivity's four-way distinguisher (Wave 17 follow-up — DISC-1652 Amendment 1 / DISC-1654)", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          // windowActivity is the load-bearing distinguisher between
          // "wrong vocabulary", "no traffic in window", "captureConfig-
          // blocked", and "no traces ever for this tenant" — the fields
          // the agent reads to disambiguate are totalTracesInWindow,
          // totalTracesInTenantEver, and captureConfigBlocksRequest.
          // Pin all three so the rendered text retains the four-way
          // explanation if a future content edit shortens it by accident.
          expect(info).toContain("totalTracesInWindow");
          expect(info).toContain("totalTracesInTenantEver");
          expect(info).toContain("captureConfigBlocksRequest");
        });

        it("references the side-effect evidence allowlist (sideEffectSummary + all 7 allowlisted keys)", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          // Workflow §3 — sideEffectSummary plus all seven allowlisted
          // keys. These keys live in the SDK `@glasstrace/protocol`
          // package (`packages/protocol/src/side-effect.ts`,
          // SIDE_EFFECT_SEMANTIC_FIELD_STABLE_CORE_KEYS: templateKey,
          // providerOperation, role, locale, timezone, status, phase) —
          // the SDK consumes the matching server-side vocabulary. These
          // are the ones that disambiguate payload bugs.
          expect(info).toContain("`sideEffectSummary`");
          expect(info).toContain("`templateKey`");
          expect(info).toContain("`providerOperation`");
          expect(info).toContain("`role`");
          expect(info).toContain("`locale`");
          expect(info).toContain("`timezone`");
          expect(info).toContain("`status`");
          expect(info).toContain("`phase`");
        });

        // Evidence-interpretation guidance: teach the agent to act on
        // returned trace evidence rather than skim past it, and to keep
        // using a trace when a follow-up tool comes back thin. Wording is
        // candidate-agnostic — the generic `*Holds` boolean-key pattern
        // and contract field/tool names only, never a specific domain
        // field or the validation candidate.
        it("frames side-effect evidence as first-class and `*Holds` keys as semantic booleans", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          expect(info).toContain("first-class runtime evidence");
          expect(info).toContain("`Holds`");
          expect(info).toMatch(/true\/false claim/);
        });

        it("distinguishes `sideEffectEvidence` (presence on candidates) from `sideEffectSummary` (values on get_latest_error / get_trace / get_root_cause)", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          expect(info).toContain("`sideEffectEvidence`");
          expect(info).toContain("`sideEffectSummary`");
          // The values come from all three carriers — naming get_latest_error
          // prevents the redundant-second-call behavior (an active-failure
          // agent enters via get_latest_error and already holds the values).
          expect(info).toContain("`get_latest_error`");
          // Presence on candidates is a signal to pull the trace, not a dead end.
          expect(info).toMatch(/signal to pull the trace/);
        });

        it("requires drill-down from `find_trace_candidates` before deciding because candidate rows can be semantically thin", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          expect(info).toContain("After `find_trace_candidates`");
          expect(info).toContain("inspect the highest-confidence candidate");
          expect(info).toContain("with `get_trace` or `get_root_cause` before deciding");
          expect(info).toContain("Candidate rows can locate the right trace without including every decisive semantic field");
          expect(info).toContain("`suggestedFollowups`");
          expect(info).toContain("drill-down tool");
        });

        it("teaches that categorical fields identify the operation and its state", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          expect(info).toMatch(/identify which operation ran and what state/);
        });

        it("tells the agent to cross-check trace facts against source and direct verification", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          expect(info).toMatch(/[Cc]ross-check/);
          expect(info).toContain("direct verification");
          expect(info).toContain("runtime evidence for the failing path");
          expect(info).toContain("not a patch recipe");
        });

        it("explains that an empty `get_span_attributes` result does not invalidate side-effect evidence", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          expect(info).toContain("`get_span_attributes`");
          expect(info).toMatch(/does NOT invalidate side-effect evidence/);
        });

        it("tells the agent to continue from trace evidence when `get_root_cause` is unavailable, without retrying or attaching recommendedNextStep", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          expect(info).toContain('`status: "unavailable"`');
          expect(info).toMatch(/rather than retrying the same call or discarding the trace/);
          // recommendedNextStep lives on the diagnostic/miss envelope (Workflow
          // §4), NOT on the unavailable get_root_cause payload — the §5 line must
          // not associate it with get_root_cause's unavailable response. Anchor
          // the slice on the §5 header and assert it exists first, so a renamed/
          // removed header fails loudly instead of making the guard pass on a
          // -1 slice.
          const followupsAnchor = info.indexOf("5. Follow-up tools");
          expect(
            followupsAnchor,
            "Workflow §5 'Follow-up tools' header must be present to anchor this guard",
          ).toBeGreaterThan(-1);
          const followups = info.slice(followupsAnchor);
          expect(followups).not.toContain("recommendedNextStep");
        });

        it("requires a trace-evidence checkpoint before editing and bounds the source layer", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          expect(info).toContain("After a relevant trace is found");
          expect(info).toContain("pause before editing");
          expect(info).toContain("the runtime fact");
          expect(info).toContain("the route/procedure/operation that produced it");
          expect(info).toContain("the likely source decision point");
          expect(info).toContain("the intended edit boundary");
          expect(info).toMatch(/smallest source path/);
          expect(info).toContain("owns the runtime decision");
          expect(info).toContain("Do not rewrite routing, batching, request transport, middleware, or sibling propagation");
          expect(info).toContain("unless the trace explicitly implicates that layer");
        });

        it("guides stale-state and categorical side-effect evidence without turning categories into patches", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          expect(info).toContain("For stale, cross-request, or cross-batch state");
          expect(info).toContain("do not simply forward the observed request or batch value");
          expect(info).toContain("durable authoritative state source");
          expect(info).toContain("decision function that consumed stale state");
          expect(info).toContain("Treat categorical side-effect fields as branch/location evidence, not patch instructions");
        });

        it("compares multiple traces for stateful bugs", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          expect(info).toMatch(/[Ss]tateful bugs/);
          expect(info).toMatch(/compare the relevant traces in sequence/);
        });

        // DISC-1955: a sparse candidate (compact summaries absent) is not
        // absence of evidence; the compact CATEGORY projections are the
        // budget/top-rank-gated ones, distinct from per-candidate
        // sideEffectEvidence (which carries a status + notAbsenceProof).
        it("teaches that a candidate with absent compact summaries is still evidence", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          // Assert the FULL closed set of four compact category projections,
          // so dropping/renaming any one is caught (the sentence's value is
          // naming the exact set the server emits).
          expect(info).toContain("`performanceQuerySummary`");
          expect(info).toContain("`dataShapeSummary`");
          expect(info).toContain("`raceConcurrencySummary`");
          expect(info).toContain("`contextBranchSummary`");
          expect(info).toMatch(/absence is normal, not absence of evidence/);
          // sideEffectEvidence status is per-candidate (not the gated projection set).
          expect(info).toMatch(/`missing` \/ `withheld` \/ `unsupported`/);
          expect(info).toContain("`notAbsenceProof`");
          // Anchor the operative remediation clause so dropping it fails loudly.
          expect(info).toContain("pull the trace with");
          expect(info).toContain("before concluding nothing happened");
        });

        it("retries or broadens when a plausible candidate lacks semantic evidence", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          expect(info).toContain("If a plausible candidate lacks semantic evidence");
          expect(info).toContain("pull the trace if possible");
          expect(info).toContain("retry or broaden the query");
          expect(info).toContain("before concluding MCP has no useful evidence");
        });

        it("teaches retry-by-procedure (the `{ procedure }` param form) and route-vs-URL comparison for a sparse search", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          // The param-object form (not just naming the `procedure` filter).
          expect(info).toMatch(/find_trace_candidates\(\{ procedure:/);
          expect(info).toMatch(/preferred over a vague route fragment/);
          expect(info).toMatch(/compare the candidate's `route` pattern against the URL/);
        });

        // Guard: the public, user-installed body must never leak the
        // validation-candidate specifics that motivated this guidance.
        it("does not leak candidate-specific terms into the installed body", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          for (const term of [
            "Rallly",
            "BetterAuth",
            "revalidateTag",
            "cache invalidation",
            "MFG-RLY",
            "same-batch",
            "pending-value",
            "author-profile",
            "validation harness",
            "benchmark",
            "Codex",
            "Claude",
          ]) {
            expect(info).not.toContain(term);
          }
        });

        it("uses the correct `suggestedFollowups` field name", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          // R13 vocabulary correction: the actual server contract field
          // is `suggestedFollowups` (NOT `suggestedFollowupArgs`).
          expect(info).toContain("`suggestedFollowups`");
          expect(info).not.toContain("suggestedFollowupArgs");
        });

        it(`emits a parseable v=<sdkVersion> stamp on the ${target.markerKind} start marker`, () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          if (target.markerKind === "html") {
            expect(info).toContain(`<!-- glasstrace:mcp:start v=${SDK_VERSION} -->`);
            // The end marker remains unstamped (DISC-1592 Required
            // Semantics Item 1: "the marker end (...mcp:end) does not
            // need a stamp").
            expect(info).toContain("<!-- glasstrace:mcp:end -->");
          } else {
            expect(info).toContain(`# glasstrace:mcp:start v=${SDK_VERSION}`);
            expect(info).toContain("# glasstrace:mcp:end");
          }
        });
      });
    }

    // Validation prompt PRE-FLIGHT 4 stamps `v=1.0.0` to simulate
    // staleness. The stamp must round-trip through different version
    // shapes — including canary pre-release strings — so the snapshot
    // tests don't silently drift when the SDK ships a canary.
    it("accepts canary semver strings as the stamp value", () => {
      const canary = "0.0.0-canary-20260508120000";
      const info = generateInfoSection(makeAgent("claude"), ENDPOINT, canary);
      expect(info).toContain(`<!-- glasstrace:mcp:start v=${canary} -->`);
    });

    it("rejects an empty sdkVersion", () => {
      expect(() =>
        generateInfoSection(makeAgent("claude"), ENDPOINT, ""),
      ).toThrow(/sdkVersion must not be empty/);
    });

    it("rejects a whitespace-only sdkVersion", () => {
      expect(() =>
        generateInfoSection(makeAgent("claude"), ENDPOINT, "   "),
      ).toThrow(/sdkVersion must not be empty/);
    });

    // SDK-050 Required Semantics Item 1: the stamp must not embed
    // user-controlled or environment-derived content, and must reject
    // characters that could smuggle terminal escape sequences or break
    // out of the HTML comment / hash marker.
    it("rejects an sdkVersion containing whitespace", () => {
      expect(() =>
        generateInfoSection(makeAgent("claude"), ENDPOINT, "1.4.0 evil"),
      ).toThrow(/sdkVersion must match/);
    });

    it("rejects an sdkVersion containing angle brackets", () => {
      expect(() =>
        generateInfoSection(makeAgent("claude"), ENDPOINT, "1.4.0>extra"),
      ).toThrow(/sdkVersion must match/);
    });

    it("rejects an sdkVersion containing a newline", () => {
      expect(() =>
        generateInfoSection(makeAgent("claude"), ENDPOINT, "1.4.0\ninjected"),
      ).toThrow(/sdkVersion must match/);
    });

    it("rejects an sdkVersion containing a control character", () => {
      // ESC (0x1B) is the leading byte of every ANSI terminal escape
      // sequence; the stamp must never carry one to the user's tty.
      expect(() =>
        generateInfoSection(makeAgent("claude"), ENDPOINT, "1.4.0[31m"),
      ).toThrow(/sdkVersion must match/);
    });
  });

  describe("Cursor direct render helpers", () => {
    it("renders the trace-evidence edit-boundary guidance into Cursor .mdc output", () => {
      const info = generateInfoSectionForCursorMdc(ENDPOINT, SDK_VERSION);
      expect(info).toContain("alwaysApply: true");
      expect(info).toContain(`<!-- glasstrace:mcp:start v=${SDK_VERSION} -->`);
      expect(info).toContain("After `find_trace_candidates`");
      expect(info).toContain("Candidate rows can locate the right trace without including every decisive semantic field");
      expect(info).toContain("pause before editing");
      expect(info).toContain("the intended edit boundary");
      expect(info).toContain("not a patch recipe");
      expect(info).toContain("do not simply forward the observed request or batch value");
      expect(info).toContain("Do not rewrite routing, batching, request transport, middleware, or sibling propagation");
    });

    it("renders the trace-evidence edit-boundary guidance into legacy .cursorrules output", () => {
      const info = generateInfoSectionForCursorrulesLegacy(ENDPOINT, SDK_VERSION);
      expect(info).toContain(`# glasstrace:mcp:start v=${SDK_VERSION}`);
      expect(info).toContain("After `find_trace_candidates`");
      expect(info).toContain("Candidate rows can locate the right trace without including every decisive semantic field");
      expect(info).toContain("pause before editing");
      expect(info).toContain("the intended edit boundary");
      expect(info).toContain("not a patch recipe");
      expect(info).toContain("do not simply forward the observed request or batch value");
      expect(info).toContain("Do not rewrite routing, batching, request transport, middleware, or sibling propagation");
    });
  });
});
