import type { DetectedAgent } from "../agent-detection/detect.js";

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
