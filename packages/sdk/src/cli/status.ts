import * as fs from "node:fs";
import * as path from "node:path";
import { NEXT_CONFIG_NAMES } from "./constants.js";

/**
 * JSON-based MCP config files that init may create.
 * Includes .glasstrace/mcp.json (CI/generic fallback) in addition to the
 * agent-specific files that uninit.ts handles.
 */
const MCP_JSON_FILES = [".mcp.json", ".cursor/mcp.json", ".gemini/settings.json", ".glasstrace/mcp.json"] as const;

/**
 * TOML-based MCP config files (Codex uses this format).
 */
const MCP_TOML_FILES = [".codex/config.toml"] as const;

/**
 * Agent info files that may contain glasstrace marker sections.
 */
const AGENT_INFO_FILES = [
  "CLAUDE.md",
  "codex.md",
  ".cursorrules",
] as const;

/**
 * Instrumentation file names in priority order.
 */
const INSTRUMENTATION_FILES = [
  "instrumentation.ts",
  "instrumentation.js",
  "instrumentation.mjs",
  "src/instrumentation.ts",
  "src/instrumentation.js",
  "src/instrumentation.mjs",
] as const;

/**
 * Machine-readable SDK configuration state.
 * This interface is the public contract for AI agents — fields may be added
 * but never removed or renamed without a major version bump.
 */
export interface StatusResult {
  /** Whether @glasstrace/sdk is in package.json dependencies or devDependencies. */
  installed: boolean;
  /** Whether the .glasstrace/ directory exists. */
  initialized: boolean;
  /** Whether an instrumentation file exists with registerGlasstrace(). */
  instrumentation: boolean;
  /** Whether next.config is wrapped with withGlasstraceConfig(). */
  configWrapped: boolean;
  /** Whether .glasstrace/anon_key exists. */
  anonKey: boolean;
  /** Whether any MCP config file has a glasstrace server entry. */
  mcpConfigured: boolean;
  /** Which agent info files have glasstrace marker sections. */
  agents: string[];
}

/**
 * Options for the status command.
 */
export interface StatusOptions {
  projectRoot: string;
}

/**
 * Checks SDK configuration state by reading filesystem markers.
 * This function is read-only — it never modifies files or creates directories.
 */
export function runStatus(options: StatusOptions): StatusResult {
  const root = options.projectRoot;

  return {
    installed: checkInstalled(root),
    initialized: checkInitialized(root),
    instrumentation: checkInstrumentation(root),
    configWrapped: checkConfigWrapped(root),
    anonKey: checkAnonKey(root),
    mcpConfigured: checkMcpConfigured(root),
    agents: checkAgents(root),
  };
}

function checkInstalled(root: string): boolean {
  try {
    const pkgPath = path.join(root, "package.json");
    const content = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(content) as Record<string, unknown>;
    const deps = pkg["dependencies"] as Record<string, unknown> | undefined;
    const devDeps = pkg["devDependencies"] as Record<string, unknown> | undefined;
    return (
      (deps != null && "@glasstrace/sdk" in deps) ||
      (devDeps != null && "@glasstrace/sdk" in devDeps)
    );
  } catch {
    return false;
  }
}

function checkInitialized(root: string): boolean {
  try {
    return fs.statSync(path.join(root, ".glasstrace")).isDirectory();
  } catch {
    return false;
  }
}

function checkInstrumentation(root: string): boolean {
  for (const name of INSTRUMENTATION_FILES) {
    try {
      const content = fs.readFileSync(path.join(root, name), "utf-8");
      if (content.includes("registerGlasstrace")) {
        return true;
      }
    } catch {
      // File doesn't exist or is unreadable — try next
    }
  }
  return false;
}

function checkConfigWrapped(root: string): boolean {
  for (const name of NEXT_CONFIG_NAMES) {
    try {
      const content = fs.readFileSync(path.join(root, name), "utf-8");
      if (content.includes("withGlasstraceConfig")) {
        return true;
      }
    } catch {
      // File doesn't exist or is unreadable — try next
    }
  }
  return false;
}

function checkAnonKey(root: string): boolean {
  try {
    return fs.statSync(path.join(root, ".glasstrace", "anon_key")).isFile();
  } catch {
    return false;
  }
}

function checkMcpConfigured(root: string): boolean {
  // Check JSON-based MCP config files
  for (const name of MCP_JSON_FILES) {
    try {
      const content = fs.readFileSync(path.join(root, name), "utf-8");
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const mcpServers = parsed["mcpServers"] as Record<string, unknown> | undefined;
      if (mcpServers && typeof mcpServers === "object" && "glasstrace" in mcpServers) {
        return true;
      }
    } catch {
      // File doesn't exist, is unreadable, or has invalid JSON — try next
    }
  }

  // Check TOML-based MCP config files (Codex)
  for (const name of MCP_TOML_FILES) {
    try {
      const content = fs.readFileSync(path.join(root, name), "utf-8");
      if (content.includes("[mcp_servers.glasstrace]")) {
        return true;
      }
    } catch {
      // File doesn't exist or is unreadable — try next
    }
  }

  return false;
}

function checkAgents(root: string): string[] {
  const found: string[] = [];
  for (const name of AGENT_INFO_FILES) {
    try {
      const content = fs.readFileSync(path.join(root, name), "utf-8");
      const hasHtmlMarkers =
        content.includes("<!-- glasstrace:mcp:start -->") &&
        content.includes("<!-- glasstrace:mcp:end -->");
      const hasHashMarkers =
        content.includes("# glasstrace:mcp:start") &&
        content.includes("# glasstrace:mcp:end");
      if (hasHtmlMarkers || hasHashMarkers) {
        found.push(name);
      }
    } catch {
      // File doesn't exist or is unreadable — skip
    }
  }
  return found;
}
