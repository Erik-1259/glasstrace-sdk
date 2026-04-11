import type { DetectedAgent } from "../agent-detection/detect.js";

/** Glasstrace MCP endpoint for agent configuration. */
export const MCP_ENDPOINT = "https://api.glasstrace.dev/mcp";

/** Next.js config file names in priority order. */
export const NEXT_CONFIG_NAMES = ["next.config.ts", "next.config.js", "next.config.mjs"] as const;

/** Maps internal agent name to a human-readable display name. */
export function formatAgentName(name: DetectedAgent["name"]): string {
  const displayNames: Record<DetectedAgent["name"], string> = {
    claude: "Claude Code",
    codex: "Codex",
    gemini: "Gemini",
    cursor: "Cursor",
    windsurf: "Windsurf",
    generic: "Generic",
  };
  return displayNames[name];
}
