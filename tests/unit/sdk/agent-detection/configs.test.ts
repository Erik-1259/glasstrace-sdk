import { describe, it, expect } from "vitest";
import {
  generateMcpConfig,
  generateInfoSection,
} from "../../../../packages/sdk/src/agent-detection/configs.js";
import type { DetectedAgent } from "../../../../packages/sdk/src/agent-detection/detect.js";

const ENDPOINT = "https://mcp.glasstrace.dev/v1";
const ANON_KEY = "gt_anon_test123";

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
      ).toThrow(/anonKey must not be empty/);
    });

    it("throws when anonKey is whitespace-only", () => {
      expect(() =>
        generateMcpConfig(makeAgent("generic"), ENDPOINT, "   "),
      ).toThrow(/anonKey must not be empty/);
    });

    it("throws when endpoint is valid but anonKey is empty (partial invalidity)", () => {
      expect(() =>
        generateMcpConfig(makeAgent("claude"), ENDPOINT, ""),
      ).toThrow(/anonKey must not be empty/);
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
  });
});

describe("generateInfoSection", () => {
  describe("input validation", () => {
    it("throws when endpoint is empty", () => {
      expect(() => generateInfoSection(makeAgent("claude"), "")).toThrow(
        /endpoint must not be empty/,
      );
    });

    it("throws when endpoint is whitespace-only", () => {
      expect(() =>
        generateInfoSection(makeAgent("claude"), "   "),
      ).toThrow(/endpoint must not be empty/);
    });
  });

  describe("Claude Code info section", () => {
    it("uses HTML comment markers", () => {
      const info = generateInfoSection(makeAgent("claude"), ENDPOINT);
      expect(info).toContain("<!-- glasstrace:mcp:start -->");
      expect(info).toContain("<!-- glasstrace:mcp:end -->");
    });

    it("contains endpoint URL", () => {
      const info = generateInfoSection(makeAgent("claude"), ENDPOINT);
      expect(info).toContain(ENDPOINT);
    });

    it("does NOT contain any auth token", () => {
      const info = generateInfoSection(makeAgent("claude"), ENDPOINT);
      expect(info).not.toContain(ANON_KEY);
      expect(info).not.toContain("Bearer");
      expect(info).not.toContain("Authorization");
      expect(info).not.toContain("gt_anon_");
      expect(info).not.toContain("gt_dev_");
    });

    it("contains tool descriptions", () => {
      const info = generateInfoSection(makeAgent("claude"), ENDPOINT);
      expect(info).toContain("get_latest_error");
      expect(info).toContain("get_trace");
      expect(info).toContain("get_root_cause");
      expect(info).toContain("get_test_suggestions");
      expect(info).toContain("get_session_timeline");
    });

    it("contains npx setup command", () => {
      const info = generateInfoSection(makeAgent("claude"), ENDPOINT);
      expect(info).toContain("npx glasstrace mcp add");
    });
  });

  describe("Codex info section", () => {
    it("uses HTML comment markers", () => {
      const info = generateInfoSection(makeAgent("codex"), ENDPOINT);
      expect(info).toContain("<!-- glasstrace:mcp:start -->");
      expect(info).toContain("<!-- glasstrace:mcp:end -->");
    });

    it("does NOT contain any auth token", () => {
      const info = generateInfoSection(makeAgent("codex"), ENDPOINT);
      expect(info).not.toContain("Bearer");
      expect(info).not.toContain("Authorization");
    });
  });

  describe("Cursor info section", () => {
    it("uses hash comment markers", () => {
      const info = generateInfoSection(makeAgent("cursor"), ENDPOINT);
      expect(info).toContain("# glasstrace:mcp:start");
      expect(info).toContain("# glasstrace:mcp:end");
    });

    it("does NOT contain any auth token", () => {
      const info = generateInfoSection(makeAgent("cursor"), ENDPOINT);
      expect(info).not.toContain("Bearer");
      expect(info).not.toContain("Authorization");
    });
  });

  describe("exhaustive switch", () => {
    it("throws for an unknown agent name", () => {
      const unknownAgent = makeAgent("claude");
      (unknownAgent as { name: string }).name = "unknown-agent";
      expect(() =>
        generateInfoSection(unknownAgent as DetectedAgent, ENDPOINT),
      ).toThrow(/Unknown agent/);
    });
  });

  describe("agents with no info section", () => {
    it("returns empty string for gemini", () => {
      const info = generateInfoSection(makeAgent("gemini"), ENDPOINT);
      expect(info).toBe("");
    });

    it("returns empty string for windsurf", () => {
      const info = generateInfoSection(makeAgent("windsurf"), ENDPOINT);
      expect(info).toBe("");
    });

    it("returns empty string for generic", () => {
      const info = generateInfoSection(makeAgent("generic"), ENDPOINT);
      expect(info).toBe("");
    });
  });
});
