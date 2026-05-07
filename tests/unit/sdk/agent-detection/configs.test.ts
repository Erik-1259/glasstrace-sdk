import { describe, it, expect } from "vitest";
import {
  generateMcpConfig,
  generateInfoSection,
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
    it("uses url without type field", () => {
      const config = generateMcpConfig(
        makeAgent("cursor"),
        ENDPOINT,
        ANON_KEY,
      );
      const parsed = JSON.parse(config);
      expect(parsed.mcpServers.glasstrace.url).toBe(ENDPOINT);
      expect(parsed.mcpServers.glasstrace.type).toBeUndefined();
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
    it("uses serverUrl instead of url", () => {
      const config = generateMcpConfig(
        makeAgent("windsurf"),
        ENDPOINT,
        ANON_KEY,
      );
      const parsed = JSON.parse(config);
      expect(parsed.mcpServers.glasstrace.serverUrl).toBe(ENDPOINT);
      expect(parsed.mcpServers.glasstrace.url).toBeUndefined();
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

    it("contains endpoint URL", () => {
      const info = generateInfoSection(makeAgent("claude"), ENDPOINT, SDK_VERSION);
      expect(info).toContain(ENDPOINT);
    });

    it("does NOT contain any auth token", () => {
      const info = generateInfoSection(makeAgent("claude"), ENDPOINT, SDK_VERSION);
      expect(info).not.toContain(ANON_KEY);
      expect(info).not.toContain("Bearer");
      expect(info).not.toContain("Authorization");
      expect(info).not.toContain("gt_anon_");
      expect(info).not.toContain("gt_dev_");
    });

    it("contains tool descriptions", () => {
      const info = generateInfoSection(makeAgent("claude"), ENDPOINT, SDK_VERSION);
      expect(info).toContain("get_latest_error");
      expect(info).toContain("find_trace_candidates");
      expect(info).toContain("get_error_list");
      expect(info).toContain("get_trace");
      expect(info).toContain("get_root_cause");
      expect(info).toContain("get_test_suggestions");
      expect(info).toContain("get_session_timeline");
    });

    // SDK-048 Acceptance Gates 2 + 3: the SDK-rendered instruction file
    // must (a) name `find_trace_candidates` as the first-contact discovery
    // tool for route/procedure/URL fragments, and (b) frame candidate
    // discovery as candidate selection rather than root-cause proof so
    // agents cannot mistake a "no candidates" result for proof of absence.
    // Asserts the load-bearing substrings without locking the exact wording.
    it("describes find_trace_candidates as candidate selection, not root-cause proof", () => {
      const info = generateInfoSection(makeAgent("claude"), ENDPOINT, SDK_VERSION);
      // Match the bullet that *describes* find_trace_candidates (its name
      // token), not any bullet that merely mentions it as a follow-up.
      const line = info
        .split("\n")
        .find((l) => /^- `find_trace_candidates`/.test(l));
      expect(
        line,
        "expected a bullet describing find_trace_candidates",
      ).toBeDefined();
      const candidateLine = line as string;
      expect(candidateLine).toContain("route");
      expect(candidateLine).toMatch(/tRPC procedure|procedure/);
      expect(candidateLine).toContain("Candidate discovery, not root-cause proof");
    });

    // DISC-1536 SDK-side: the get_root_cause description rendered by
    // `generateInfoSection()` (and injected into agent instruction files
    // like CLAUDE.md / .cursorrules / codex.md by `glasstrace mcp add` and
    // `glasstrace init`) must name the required `traceId` parameter and
    // point the user's AI agent at a tool that supplies trace IDs. Without
    // this, agents call get_root_cause with no arguments and the MCP
    // server rejects the request. Asserts the required substrings without
    // locking the exact wording so the description can evolve.
    it("describes get_root_cause with required traceId and a trace-id source", () => {
      const info = generateInfoSection(makeAgent("claude"), ENDPOINT, SDK_VERSION);
      // Match the bullet that *describes* get_root_cause (i.e. the bullet
      // whose name token is `get_root_cause`), not any bullet that merely
      // mentions it as a follow-up. Other tools' descriptions reference
      // get_root_cause as a downstream call; the regex below pins on the
      // leading `- \`get_root_cause\`` token to avoid that collision.
      const line = info
        .split("\n")
        .find((l) => /^- `get_root_cause`/.test(l));
      expect(line, "expected a bullet describing get_root_cause").toBeDefined();
      const rootCauseLine = line as string;
      expect(rootCauseLine).toContain("traceId");
      const namesTraceIdSource =
        rootCauseLine.includes("get_latest_error") ||
        rootCauseLine.includes("get_error_list") ||
        rootCauseLine.includes("get_trace");
      expect(
        namesTraceIdSource,
        "get_root_cause description must reference at least one of get_latest_error, get_error_list, or get_trace as a traceId source",
      ).toBe(true);
    });

    it("contains npx setup command", () => {
      const info = generateInfoSection(makeAgent("claude"), ENDPOINT, SDK_VERSION);
      expect(info).toContain("npx glasstrace mcp add");
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
    it("uses hash comment markers", () => {
      const info = generateInfoSection(makeAgent("cursor"), ENDPOINT, SDK_VERSION);
      expect(info).toContain("# glasstrace:mcp:start");
      expect(info).toContain("# glasstrace:mcp:end");
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

  describe("agents with no info section", () => {
    it("returns empty string for gemini", () => {
      const info = generateInfoSection(makeAgent("gemini"), ENDPOINT, SDK_VERSION);
      expect(info).toBe("");
    });

    it("returns empty string for windsurf", () => {
      const info = generateInfoSection(makeAgent("windsurf"), ENDPOINT, SDK_VERSION);
      expect(info).toBe("");
    });

    it("returns empty string for generic", () => {
      const info = generateInfoSection(makeAgent("generic"), ENDPOINT, SDK_VERSION);
      expect(info).toBe("");
    });
  });

  // SDK-050 Acceptance Gate 5: snapshot-style assertions on the rendered
  // info section for every target that emits content today (claude /
  // codex / cursor). Each must contain the cost-aware decision paragraph
  // (DISC-1593), the cheapest-orientation routing references, the
  // absence-proof clause, and a parseable `v=<version>` stamp on the
  // start marker (DISC-1592).
  describe("SDK-050 decision paragraph + version stamp", () => {
    const TARGETS = [
      { name: "claude" as const, markerKind: "html" as const },
      { name: "codex" as const, markerKind: "html" as const },
      { name: "cursor" as const, markerKind: "hash" as const },
    ];

    for (const target of TARGETS) {
      describe(`target=${target.name}`, () => {
        it("renders the cost-aware decision paragraph before the per-tool bullet list", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          // Decision paragraph (DISC-1593 Required Semantics §1) load-bearing
          // claim: Glasstrace MCP is *conditionally* worth calling.
          expect(info).toContain(
            "runtime evidence would materially reduce uncertainty",
          );
          // Decision paragraph load-bearing claim §4: list of conditions
          // that justify calling Glasstrace MCP at all.
          expect(info).toContain("failing request");
          expect(info).toContain("stack trace");
          expect(info).toContain("race/data-flow symptom");
          expect(info).toContain("performance issue");

          // The paragraph must come BEFORE the bullet list so it shapes
          // cross-tool strategy first. Index in the rendered string is
          // the simplest correctness proof.
          const paragraphIdx = info.indexOf(
            "runtime evidence would materially reduce uncertainty",
          );
          const firstBulletIdx = info.indexOf("\n- `get_latest_error`");
          expect(paragraphIdx).toBeGreaterThan(-1);
          expect(firstBulletIdx).toBeGreaterThan(-1);
          expect(paragraphIdx).toBeLessThan(firstBulletIdx);
        });

        it("names cheapest-orientation routing for current-error vs route/procedure symptoms", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          // Decision paragraph load-bearing claim §2: cheapest-orientation
          // routing (current error → get_latest_error / get_error_list;
          // known route/procedure → find_trace_candidates).
          expect(info).toContain("get_latest_error");
          expect(info).toContain("get_error_list");
          expect(info).toContain("find_trace_candidates");
          // Brief Acceptance Gate 5: the paragraph mentions both
          // cheapest-orientation tools and the candidate-discovery tool.
          expect(info).toMatch(/cheapest orientation call/i);
        });

        it("contains the absence-proof clause", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          // Decision paragraph load-bearing claim §3: a no-candidates /
          // no_traces_found result is a scoped retrieval result, not
          // proof the bug is absent. Restates the MCP server's
          // `notAbsenceProof: true` framing in user-facing language.
          expect(info).toContain("not proof the bug is absent");
          expect(info).toContain("no_traces_found");
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
});
