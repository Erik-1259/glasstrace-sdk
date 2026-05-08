import type { DetectedAgent } from "./detect.js";

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
              serverUrl: endpoint,
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
 * instruction files (CLAUDE.md, .cursorrules, codex.md). It contains ONLY
 * the endpoint URL, tool descriptions, and setup instructions. Auth tokens
 * are NEVER included in this output.
 *
 * The rendered block opens with a cost-aware cross-tool decision paragraph
 * (DISC-1593 / SDK-050) telling the user's AI agent **when** Glasstrace
 * MCP is worth calling at all and **which** tool is the cheapest first
 * call for each symptom class. The start marker carries a `v=<sdkVersion>`
 * stamp (DISC-1592 / SDK-050) so a later `glasstrace upgrade-instructions`
 * run — and the SDK's stale-section warning at init — can detect that
 * the file was rendered by an older SDK and refresh the block.
 *
 * @param agent - The detected agent to generate info for.
 * @param endpoint - The Glasstrace MCP endpoint URL.
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

  // Cost-aware cross-tool decision paragraph (DISC-1593 / SDK-050
  // Required Semantics §1). Load-bearing semantics:
  //   1. Frame Glasstrace MCP as conditionally worth calling.
  //   2. Name cheapest-orientation routing per symptom class.
  //   3. Restate the no-candidates / no_traces_found "scoped retrieval
  //      result, not absence of the bug" contract.
  //   4. List the conditions that justify calling Glasstrace MCP at all.
  // Wording aligned with MCP-025's planned `recoveryActions` so the two
  // surfaces do not contradict each other.
  const content = [
    "",
    "## Glasstrace MCP Integration",
    "",
    `Glasstrace is configured as an MCP server at: ${endpoint}`,
    "",
    "Glasstrace MCP is available when runtime evidence would materially reduce uncertainty. Use it when there is a failing request, stack trace, unclear runtime behavior, race/data-flow symptom, side effect, or performance issue that source inspection alone does not explain. For a current error, `get_latest_error` or `get_error_list` is usually the cheapest orientation call. For a known route/procedure with no exact error, use `find_trace_candidates` and follow returned exact `get_trace` or `get_root_cause` arguments only if the candidates look relevant. Do not call trace tools for trivial source-local fixes. Treat **no candidates** or **no_traces_found** as a scoped retrieval result, not proof the bug is absent.",
    "",
    "Available tools:",
    "- `get_latest_error` - Get the most recent error trace from the current session",
    "- `find_trace_candidates` - First-contact route/procedure/URL candidate selection when you have a route fragment, tRPC procedure, method, status, or rough recent activity window but not the exact trace ID. Returns candidate traces plus suggested `get_trace` / `get_root_cause` follow-up call arguments. Candidate discovery, not root-cause proof.",
    "- `get_error_list` - List recent errors with filtering and pagination",
    "- `get_trace` - Get a specific trace by ID or URL pattern",
    "- `get_root_cause` - Get the root cause analysis for a specific error trace (requires a `traceId` from `get_latest_error`, `get_error_list`, or `get_trace`)",
    "- `get_test_suggestions` - Get test suggestions for a specific error trace (requires a `traceId` from `get_latest_error`, `get_error_list`, or `get_trace`)",
    "- `get_session_timeline` - Get the timeline of all traces in the current session",
    "",
    "To refresh this managed section after a `@glasstrace/sdk` upgrade, run: `npx glasstrace upgrade-instructions`. To reconfigure MCP credentials, run: `npx glasstrace mcp add`.",
    "",
  ].join("\n");

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
