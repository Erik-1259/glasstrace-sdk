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
/** Runtime state snapshot read from .glasstrace/runtime-state.json. */
export interface RuntimeStateSnapshot {
  /** Whether the runtime state file exists and was readable. */
  available: boolean;
  /** Whether the process that wrote the state is likely still running. */
  stale: boolean;
  /** Core lifecycle state (e.g., "ACTIVE", "KEY_PENDING", "SHUTDOWN"). */
  coreState: string | null;
  /** Auth lifecycle state (e.g., "ANONYMOUS", "AUTHENTICATED"). */
  authState: string | null;
  /** OTel coexistence state (e.g., "OWNS_PROVIDER", "AUTO_ATTACHED"). */
  otelState: string | null;
  /** OTel scenario (e.g., "A", "B-auto"). */
  otelScenario: string | null;
  /** When the state was last written. */
  updatedAt: string | null;
  /** PID of the process that wrote the state. */
  pid: number | null;
}

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
  /** Runtime state from the running SDK process (if available). */
  runtime: RuntimeStateSnapshot;
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
    runtime: readRuntimeState(root),
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

const STALE_THRESHOLD_MS = 30_000; // 30 seconds

function readRuntimeState(root: string): RuntimeStateSnapshot {
  const empty: RuntimeStateSnapshot = {
    available: false,
    stale: false,
    coreState: null,
    authState: null,
    otelState: null,
    otelScenario: null,
    updatedAt: null,
    pid: null,
  };

  try {
    const filePath = path.join(root, ".glasstrace", "runtime-state.json");
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content) as Record<string, unknown>;

    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : null;
    const pid = typeof parsed.pid === "number" ? parsed.pid : null;
    const core = parsed.core as Record<string, unknown> | undefined;
    const auth = parsed.auth as Record<string, unknown> | undefined;
    const otel = parsed.otel as Record<string, unknown> | undefined;

    const coreState = typeof core?.state === "string" ? core.state : null;
    const authState = typeof auth?.state === "string" ? auth.state : null;
    const otelState = typeof otel?.state === "string" ? otel.state : null;
    const otelScenario = typeof otel?.scenario === "string" ? otel.scenario : null;

    // Staleness detection
    let stale = false;
    if (coreState === "SHUTDOWN") {
      stale = false; // Clean shutdown — not stale, just finished
    } else if (updatedAt) {
      const updatedMs = new Date(updatedAt).getTime();
      const age = Number.isFinite(updatedMs) ? Date.now() - updatedMs : Infinity;
      if (age > STALE_THRESHOLD_MS) {
        // Check if the process is still running
        if (pid && pid > 0) {
          try {
            process.kill(pid, 0); // Signal 0 = existence check
            // If we get here, process exists. EPERM would also throw,
            // but with code "EPERM" — meaning the process exists but
            // we lack permission. Both mean "not stale."
            stale = false;
          } catch (err: unknown) {
            const code = (err as { code?: string })?.code;
            if (code === "EPERM") {
              stale = false; // Process exists, we just can't signal it
            } else {
              stale = true; // ESRCH or other — process gone
            }
          }
        } else {
          stale = true; // No valid PID — can't verify
        }
      }
    }

    return {
      available: true,
      stale,
      coreState,
      authState,
      otelState,
      otelScenario,
      updatedAt,
      pid,
    };
  } catch {
    return empty;
  }
}
