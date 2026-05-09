import type { DetectedAgent } from "./detect.js";
import { buildAgentInstructionBody } from "./agent-instruction-text.js";

/**
 * Generates the MCP server configuration content for a given agent.
 *
 * The output is the full file content suitable for writing to the agent's
 * MCP config file. The bearer token is intentionally embedded here for
 * agents whose schemas inline the Authorization header — Codex is the
 * exception and uses `bearer_token_env_var` so the actual token never
 * appears in TOML.
 *
 * @param agent - The detected agent to generate config for.
 * @param endpoint - The Glasstrace MCP endpoint URL.
 * @param bearer - The credential to embed in the Authorization header
 *   (anon key or dev key, depending on the project's resolved
 *   credential source). Empty values throw.
 * @returns The formatted configuration string.
 * @throws If endpoint or bearer is empty.
 */
export function generateMcpConfig(
  agent: DetectedAgent,
  endpoint: string,
  bearer: string,
): string {
  if (!endpoint || endpoint.trim() === "") {
    throw new Error("endpoint must not be empty");
  }
  if (!bearer || bearer.trim() === "") {
    throw new Error("bearer must not be empty");
  }

  switch (agent.name) {
    case "claude":
      return JSON.stringify(
        {
          mcpServers: {
            glasstrace: {
              type: "http",
              url: endpoint,
              headers: {
                Authorization: `Bearer ${bearer}`,
              },
            },
          },
        },
        null,
        2,
      );

    case "codex": {
      // Escape TOML basic string special characters in the endpoint value.
      // TOML requires backslashes, quotes, and control characters to be escaped.
      const safeEndpoint = endpoint
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t");
      return [
        "[mcp_servers.glasstrace]",
        `url = "${safeEndpoint}"`,
        `bearer_token_env_var = "GLASSTRACE_API_KEY"`,
        "",
      ].join("\n");
    }

    case "gemini":
      return JSON.stringify(
        {
          mcpServers: {
            glasstrace: {
              httpUrl: endpoint,
              headers: {
                Authorization: `Bearer ${bearer}`,
              },
            },
          },
        },
        null,
        2,
      );

    case "cursor":
      return JSON.stringify(
        {
          mcpServers: {
            glasstrace: {
              type: "http",
              url: endpoint,
              headers: {
                Authorization: `Bearer ${bearer}`,
              },
            },
          },
        },
        null,
        2,
      );

    case "windsurf":
      return JSON.stringify(
        {
          mcpServers: {
            glasstrace: {
              type: "http",
              url: endpoint,
              headers: {
                Authorization: `Bearer ${bearer}`,
              },
            },
          },
        },
        null,
        2,
      );

    case "generic":
      return JSON.stringify(
        {
          mcpServers: {
            glasstrace: {
              type: "http",
              url: endpoint,
              headers: {
                Authorization: `Bearer ${bearer}`,
              },
            },
          },
        },
        null,
        2,
      );

    default: {
      const _exhaustive: never = agent.name;
      throw new Error(`Unknown agent: ${_exhaustive}`);
    }
  }
}

/**
 * Strict pattern accepted as the value substituted into a `v=<sdkVersion>`
 * marker stamp. Covers the SDK's own published versions
 * (e.g. `1.4.0`, `0.0.0-canary-20260508120000`, `1.4.0+build.42`) without
 * admitting whitespace, angle-brackets, or terminal control sequences
 * that could be smuggled into the agent instruction file via a
 * malformed callsite.
 *
 * The stamp is the SDK semver string and nothing else (DISC-1592 / SDK-050
 * Required Semantics Item 1: "the stamp encodes only the SDK semver
 * string ... it must not embed user-controlled or environment-derived
 * content"). Reject anything outside this charset at the render site
 * rather than relying on the upstream `__SDK_VERSION__` define being
 * well-formed.
 */
const SDK_VERSION_STAMP_PATTERN = /^[A-Za-z0-9.+-]+$/;

/**
 * Marker pair used to delimit the Glasstrace section in agent info files.
 */
interface MarkerPair {
  start: string;
  end: string;
}

function htmlMarkers(sdkVersion: string): MarkerPair {
  return {
    start: `<!-- glasstrace:mcp:start v=${sdkVersion} -->`,
    end: "<!-- glasstrace:mcp:end -->",
  };
}

function hashMarkers(sdkVersion: string): MarkerPair {
  return {
    start: `# glasstrace:mcp:start v=${sdkVersion}`,
    end: "# glasstrace:mcp:end",
  };
}

/**
 * Generates informational content for an agent's instruction file.
 *
 * This content is designed to be appended to or inserted into agent-specific
 * instruction files (CLAUDE.md, .cursorrules, codex.md). It contains a
 * tight, agent-facing decision policy + workflow + tool list — no
 * endpoint URL, no auth tokens, no setup instructions (those live in
 * the user's MCP config and the SDK README; the agent reads this file
 * to decide WHEN to call Glasstrace MCP and HOW to use the returned
 * evidence).
 *
 * The rendered block opens with explicit "Call Glasstrace FIRST when"
 * / "SKIP Glasstrace when" decision rules so a frontier agent has a
 * cheap pre-tool-call heuristic it can apply BEFORE spending tokens
 * on tool consideration. The Workflow section names
 * `find_trace_candidates` as the discovery entry point and instructs
 * the agent to READ `closeMatches` / `recentRoutesSample` /
 * `recoveryActions` before pivoting to source — that is the
 * load-bearing recovery contract from MCP-025 / MCP-027 (codified in
 * `wire-mcp.ts` `ToolDiagnosticSchema` / `CandidateDiagnosticSchema`)
 * and it prevents the bail-to-source failure mode that the prior
 * SDK-050 cost-aware decision paragraph did not surface.
 *
 * The body itself lives in a sibling module
 * (`agent-instruction-text.ts`) so future content evolutions are a
 * single-file edit and don't disturb the marker / version-stamp /
 * per-agent-format machinery in this file.
 *
 * The start marker carries a `v=<sdkVersion>` stamp (DISC-1592 /
 * SDK-050) so a later `glasstrace upgrade-instructions` run — and
 * the SDK's stale-section warning at init — can detect that the
 * file was rendered by an older SDK and refresh the block.
 *
 * @param agent - The detected agent to generate info for.
 * @param endpoint - The Glasstrace MCP endpoint URL. (Validated for
 *   non-emptiness here for backwards compatibility with the prior
 *   SDK-050 contract; not currently inlined in the body — agents
 *   reach Glasstrace via the MCP server name `glasstrace` configured
 *   separately in `.glasstrace/mcp.json` or per-agent native config.)
 * @param sdkVersion - The SDK semver string to embed in the start marker
 *   (e.g. `1.4.0`, `0.0.0-canary-20260508120000`). Must match
 *   `[A-Za-z0-9.+\-]+`; arbitrary or empty values throw.
 * @returns The formatted info section string, or empty string for agents without a supported info file format.
 * @throws If endpoint is empty, or if sdkVersion is empty or contains
 *   characters outside the accepted stamp charset.
 */
export function generateInfoSection(
  agent: DetectedAgent,
  endpoint: string,
  sdkVersion: string,
): string {
  if (!endpoint || endpoint.trim() === "") {
    throw new Error("endpoint must not be empty");
  }
  if (!sdkVersion || sdkVersion.trim() === "") {
    throw new Error("sdkVersion must not be empty");
  }
  if (!SDK_VERSION_STAMP_PATTERN.test(sdkVersion)) {
    throw new Error(
      "sdkVersion must match [A-Za-z0-9.+\\-]+ (semver-shaped, no whitespace, no angle brackets)",
    );
  }

  const content = buildAgentInstructionBody();

  switch (agent.name) {
    case "claude": {
      const m = htmlMarkers(sdkVersion);
      return `${m.start}\n${content}${m.end}\n`;
    }

    case "codex": {
      const m = htmlMarkers(sdkVersion);
      return `${m.start}\n${content}${m.end}\n`;
    }

    case "cursor": {
      const m = hashMarkers(sdkVersion);
      return `${m.start}\n${content}${m.end}\n`;
    }

    case "gemini":
    case "windsurf":
    case "generic":
      return "";

    default: {
      const _exhaustive: never = agent.name;
      throw new Error(`Unknown agent: ${_exhaustive}`);
    }
  }
}
