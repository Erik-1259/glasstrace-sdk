import type { DetectedAgent } from "../agent-detection/detect.js";

// MCP_ENDPOINT moved to `../mcp-runtime.ts` so the runtime claim-refresh
// path can reach it without crossing the runtime/CLI boundary.
//
// TODO(remove-after-next-stable-release): drop this re-export once
// internal CLI callers migrate to `../mcp-runtime.js`.
export { MCP_ENDPOINT } from "../mcp-runtime.js";

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
    generic: "Generic helper",
  };
  return displayNames[name];
}
