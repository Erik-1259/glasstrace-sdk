import type { DetectedAgent } from "./detect.js";

/**
 * Generates the MCP server configuration content for a given agent.
 *
 * The output is the full file content suitable for writing to the agent's
 * MCP config file. Auth tokens are intentionally included here because
 * MCP config files are local-only and required for server authentication.
 *
 * @param agent - The detected agent to generate config for.
 * @param endpoint - The Glasstrace MCP endpoint URL.
 * @param anonKey - The anonymous API key for authentication.
 * @returns The formatted configuration string.
 * @throws If endpoint or anonKey is empty.
 */
export function generateMcpConfig(
  agent: DetectedAgent,
  endpoint: string,
  anonKey: string,
): string {
  if (!endpoint || endpoint.trim() === "") {
    throw new Error("endpoint must not be empty");
  }
  if (!anonKey || anonKey.trim() === "") {
    throw new Error("anonKey must not be empty");
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
                Authorization: `Bearer ${anonKey}`,
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
                Authorization: `Bearer ${anonKey}`,
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
                Authorization: `Bearer ${anonKey}`,
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
                Authorization: `Bearer ${anonKey}`,
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
              url: endpoint,
              headers: {
                Authorization: `Bearer ${anonKey}`,
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
 * Marker pair used to delimit the Glasstrace section in agent info files.
 */
interface MarkerPair {
  start: string;
  end: string;
}

function htmlMarkers(): MarkerPair {
  return {
    start: "<!-- glasstrace:mcp:start -->",
    end: "<!-- glasstrace:mcp:end -->",
  };
}

function hashMarkers(): MarkerPair {
  return {
    start: "# glasstrace:mcp:start",
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
 * @param agent - The detected agent to generate info for.
 * @param endpoint - The Glasstrace MCP endpoint URL.
 * @returns The formatted info section string, or empty string for agents without a supported info file format.
 * @throws If endpoint is empty.
 */
export function generateInfoSection(
  agent: DetectedAgent,
  endpoint: string,
): string {
  if (!endpoint || endpoint.trim() === "") {
    throw new Error("endpoint must not be empty");
  }

  const content = [
    "",
    "## Glasstrace MCP Integration",
    "",
    `Glasstrace is configured as an MCP server at: ${endpoint}`,
    "",
    "Available tools:",
    "- `get_latest_error` - Get the most recent error trace from the current session",
    "- `get_error_list` - List recent errors with filtering and pagination",
    "- `get_trace` - Get a specific trace by ID or URL pattern",
    "- `get_root_cause` - Get the full span tree and root cause analysis for an error",
    "- `get_test_suggestions` - Get test suggestions based on recent errors",
    "- `get_session_timeline` - Get the timeline of all traces in the current session",
    "",
    "To reconfigure, run: `npx glasstrace mcp add`",
    "",
  ].join("\n");

  switch (agent.name) {
    case "claude": {
      const m = htmlMarkers();
      return `${m.start}\n${content}${m.end}\n`;
    }

    case "codex": {
      const m = htmlMarkers();
      return `${m.start}\n${content}${m.end}\n`;
    }

    case "cursor": {
      const m = hashMarkers();
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
