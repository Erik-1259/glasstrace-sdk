import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { readAnonKey } from "../anon-key.js";
import { detectAgents } from "../agent-detection/detect.js";
import { generateMcpConfig, generateInfoSection } from "../agent-detection/configs.js";
import {
  writeMcpConfig,
  injectInfoSection,
  updateGitignore,
} from "../agent-detection/inject.js";
import { scaffoldMcpMarker } from "./scaffolder.js";
import type { DetectedAgent } from "../agent-detection/detect.js";

const execFileAsync = promisify(execFileCb);

/** Glasstrace MCP endpoint for agent configuration. */
const MCP_ENDPOINT = "https://api.glasstrace.dev/mcp";

/** Maps internal agent name to a human-readable display name. */
function formatAgentName(name: DetectedAgent["name"]): string {
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

/** Options for the mcp add command. */
export interface McpAddOptions {
  force?: boolean;
  dryRun?: boolean;
}

/** Result of the mcp add command. */
export interface McpAddResult {
  exitCode: number;
  results: AgentResult[];
  messages: string[];
}

/**
 * Result of a single agent registration attempt.
 */
interface AgentResult {
  agent: DetectedAgent["name"];
  success: boolean;
  method: "cli" | "file" | "skipped";
  message: string;
}

/**
 * Attempts CLI-based MCP registration for agents that support it.
 * Returns true if the CLI command succeeded.
 *
 * Note: anonymous keys are passed in process arguments for CLI registration.
 * This is acceptable because anon keys are non-secret identifiers (not
 * credentials) designed for semi-public use. They identify a project
 * but cannot be used to access user data.
 */
async function registerViaCli(
  agent: DetectedAgent,
  anonKey: string,
): Promise<boolean> {
  if (!agent.cliAvailable) {
    return false;
  }

  try {
    switch (agent.name) {
      case "claude": {
        const payload = JSON.stringify({
          type: "http",
          url: MCP_ENDPOINT,
          headers: { Authorization: `Bearer ${anonKey}` },
        });
        await execFileAsync("claude", [
          "mcp",
          "add-json",
          "glasstrace",
          payload,
          "--scope",
          "project",
        ]);
        return true;
      }

      case "codex": {
        await execFileAsync("codex", [
          "mcp",
          "add",
          "glasstrace",
          "--url",
          MCP_ENDPOINT,
        ]);
        // Ensure .codex/config.toml has bearer_token_env_var
        const configPath = agent.mcpConfigPath;
        if (configPath !== null && fs.existsSync(configPath)) {
          const content = fs.readFileSync(configPath, "utf-8");
          if (!content.includes("bearer_token_env_var")) {
            const appendContent =
              content.endsWith("\n") ? "" : "\n";
            fs.writeFileSync(
              configPath,
              content +
                appendContent +
                'bearer_token_env_var = "GLASSTRACE_API_KEY"\n',
              "utf-8",
            );
          }
        }
        process.stderr.write(
          "  Note: Set GLASSTRACE_API_KEY environment variable for Codex authentication.\n",
        );
        return true;
      }

      case "gemini": {
        await execFileAsync("gemini", [
          "mcp",
          "add",
          "--transport",
          "http",
          "--header",
          `Authorization: Bearer ${anonKey}`,
          "glasstrace",
          MCP_ENDPOINT,
        ]);
        return true;
      }

      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * Registers the Glasstrace MCP server with detected AI coding agents.
 *
 * For each agent, attempts native CLI registration first, then falls back
 * to file-based configuration. Creates a marker file on success to enable
 * idempotent re-runs.
 *
 * Returns a structured result instead of calling process.exit(), so the
 * CLI entry point can decide how to handle the outcome.
 *
 * @param options - Control flags for force and dry-run modes.
 */
export async function mcpAdd(options?: McpAddOptions): Promise<McpAddResult> {
  const force = options?.force ?? false;
  const dryRun = options?.dryRun ?? false;
  const projectRoot = process.cwd();
  const messages: string[] = [];

  // Step 1: Read anon key
  const anonKey = await readAnonKey(projectRoot);
  if (anonKey === null) {
    return {
      exitCode: 1,
      results: [],
      messages: ["Error: Run `glasstrace init` first to generate an API key."],
    };
  }

  // Step 2: Check marker file
  const markerPath = path.join(projectRoot, ".glasstrace", "mcp-connected");
  if (fs.existsSync(markerPath) && !force) {
    return {
      exitCode: 0,
      results: [],
      messages: ["MCP already configured. Use --force to reconfigure."],
    };
  }

  // Step 3: Detect agents
  const agents = await detectAgents(projectRoot);
  const detectedNonGeneric = agents.filter((a) => a.name !== "generic");

  // If no specific agents found, include the generic fallback so the command
  // still produces a usable .glasstrace/mcp.json (matching init behavior).
  const targetAgents =
    detectedNonGeneric.length > 0
      ? detectedNonGeneric
      : agents.filter((a) => a.name === "generic");

  if (dryRun) {
    messages.push("Dry run: would perform the following actions:", "");
    for (const agent of targetAgents) {
      const name = formatAgentName(agent.name);
      if (agent.cliAvailable) {
        messages.push(
          `  ${name}: Register via CLI (${agent.name} mcp add)`,
        );
      } else if (agent.mcpConfigPath !== null) {
        messages.push(
          `  ${name}: Write config to ${agent.mcpConfigPath}`,
        );
      }
      if (agent.infoFilePath !== null) {
        messages.push(
          `  ${name}: Inject info section into ${agent.infoFilePath}`,
        );
      }
    }
    messages.push(
      "",
      "  Update .gitignore with MCP config paths",
      "  Create .glasstrace/mcp-connected marker",
    );
    return { exitCode: 0, results: [], messages };
  }

  // Step 4: Register with each agent
  const results: AgentResult[] = [];

  for (const agent of targetAgents) {
    const name = formatAgentName(agent.name);

    // Try CLI registration first (not applicable for generic)
    if (agent.name !== "generic") {
      const cliSuccess = await registerViaCli(agent, anonKey);
      if (cliSuccess) {
        // Still inject info section if applicable
        const infoContent = generateInfoSection(agent, MCP_ENDPOINT);
        if (infoContent !== "") {
          await injectInfoSection(agent, infoContent, projectRoot);
        }
        results.push({
          agent: agent.name,
          success: true,
          method: "cli",
          message: `${name}: Registered via CLI`,
        });
        continue;
      }
    }

    // Fall back to file-based config
    if (agent.mcpConfigPath !== null) {
      try {
        const configContent = generateMcpConfig(agent, MCP_ENDPOINT, anonKey);
        await writeMcpConfig(agent, configContent, projectRoot);

        // Verify the config was written (writeMcpConfig swallows permission errors)
        if (fs.existsSync(agent.mcpConfigPath)) {
          const infoContent = generateInfoSection(agent, MCP_ENDPOINT);
          if (infoContent !== "") {
            await injectInfoSection(agent, infoContent, projectRoot);
          }
          results.push({
            agent: agent.name,
            success: true,
            method: "file",
            message: `${name}: Configured via ${agent.mcpConfigPath}`,
          });
          continue;
        }

        // writeMcpConfig returned without throwing but file doesn't exist
        // (permission denied handled gracefully inside writeMcpConfig)
        results.push({
          agent: agent.name,
          success: false,
          method: "file",
          message: `${name}: Failed to write config to ${agent.mcpConfigPath} (permission denied)`,
        });
        continue;
      } catch (err) {
        results.push({
          agent: agent.name,
          success: false,
          method: "file",
          message: `${name}: Failed - ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
    }

    results.push({
      agent: agent.name,
      success: false,
      method: "skipped",
      message: `${name}: No registration method available`,
    });
  }

  // Step 5: Update gitignore
  await updateGitignore(
    [".mcp.json", ".cursor/mcp.json", ".gemini/settings.json", ".codex/config.toml"],
    projectRoot,
  );

  // Step 6: Create marker file if at least one succeeded
  const anySuccess = results.some((r) => r.success);

  if (anySuccess) {
    await scaffoldMcpMarker(projectRoot, anonKey);
  }

  // Step 7: Build summary messages
  messages.push("", "MCP registration summary:");
  for (const result of results) {
    const icon = result.success ? "+" : "-";
    messages.push(`  [${icon}] ${result.message}`);
  }

  if (results.length === 0) {
    messages.push(
      "  No agents detected. Place agent marker files (e.g., CLAUDE.md, .cursor/) in your project.",
    );
  }

  if (!anySuccess && results.length > 0) {
    messages.push(
      "",
      "All agent registrations failed. Check errors above.",
    );
    return { exitCode: 1, results, messages };
  }

  if (anySuccess) {
    messages.push("", "MCP registration complete.");
  }

  return { exitCode: 0, results, messages };
}
