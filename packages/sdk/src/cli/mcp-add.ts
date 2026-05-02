import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  isAnonApiKey,
  identityFingerprint,
  readMcpMarker,
  resolveEffectiveMcpCredential,
  writeMcpMarker,
  type EffectiveMcpCredential,
} from "../mcp-runtime.js";
import { detectAgents } from "../agent-detection/detect.js";
import { generateMcpConfig, generateInfoSection } from "../agent-detection/configs.js";
import {
  writeMcpConfig,
  injectInfoSection,
  updateGitignore,
} from "../agent-detection/inject.js";
import type { DetectedAgent } from "../agent-detection/detect.js";
import { MCP_ENDPOINT, formatAgentName } from "./constants.js";

const execFileAsync = promisify(execFileCb);

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
 * **Anon keys only, by design.** This path passes the bearer token to
 * vendor CLIs (Claude, Gemini) as a process argument; on multi-user
 * hosts, process arguments are visible via `ps` and `/proc`. Anon keys
 * are non-secret project identifiers — exposing one in a process
 * listing is acceptable. A claimed dev/account key absolutely is not.
 *
 * Two layers of enforcement:
 *
 * 1. The `bearer` parameter is typed `string` rather than `AnonApiKey`
 *    only because the function is called through CLI plumbing where
 *    the brand is erased; callers must verify the source upstream.
 * 2. A runtime `isAnonApiKey` guard at the top of the function
 *    short-circuits with `false` if the value fails strict
 *    `AnonApiKeySchema` validation. This defends against accidental
 *    `string`-typed paths that erase the brand and against any
 *    future caller that forgets the upstream check.
 *
 * Codex's CLI registration does not embed the bearer (it writes
 * `bearer_token_env_var = "GLASSTRACE_API_KEY"` and reads the
 * actual token from the environment), so it is unaffected by this
 * constraint.
 */
/** @internal Exported for unit testing of the runtime anon-only guard. */
export async function registerViaCli(
  agent: DetectedAgent,
  bearer: string,
): Promise<boolean> {
  if (!agent.cliAvailable) {
    return false;
  }

  // Layer 2: runtime guard. If the bearer is not a strictly-valid
  // anon key, refuse to put it in process arguments. The caller is
  // expected to fall through to the file-config path, which writes
  // 0o600 files and never exposes the bearer to other processes.
  if (agent.name !== "codex" && !isAnonApiKey(bearer)) {
    return false;
  }

  try {
    switch (agent.name) {
      case "claude": {
        const payload = JSON.stringify({
          type: "http",
          url: MCP_ENDPOINT,
          headers: { Authorization: `Bearer ${bearer}` },
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
          `Authorization: Bearer ${bearer}`,
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
 * Returns whether the on-disk marker describes the same underlying
 * credential as the resolver's effective credential.
 *
 * Compares on `credentialHash` only — the credential identity, not
 * the on-disk *source* it was loaded from. The source can shift
 * without the key actually changing (e.g., a user copies the same
 * key from `.glasstrace/claimed-key` into `.env.local`, or vice
 * versa), and treating that shift as a credential change would
 * falsely trigger the claim-transition refresh on a project whose
 * `mcp.json` already embeds the correct bearer.
 *
 * Treats `unknown-version` and `corrupted` markers as not-matching
 * (forces a re-run that overwrites them with v2). Treats `absent`
 * markers as not-matching too — the caller's existing
 * `fs.existsSync(markerPath)` short-circuit catches that case before
 * calling here, so this branch only fires when a marker read itself
 * failed.
 */
async function markerMatchesEffective(
  projectRoot: string,
  effective: EffectiveMcpCredential,
): Promise<boolean> {
  const state = await readMcpMarker(projectRoot);
  if (state.status !== "valid") return false;
  return state.credentialHash === identityFingerprint(effective.key);
}

/**
 * Registers the Glasstrace MCP server with detected AI coding agents.
 *
 * For each agent, attempts native CLI registration first (anon keys
 * only, see {@link registerViaCli}), then falls back to file-based
 * configuration. The marker file at `.glasstrace/mcp-connected`
 * records the effective credential's source and identity fingerprint
 * so a later run can detect a project that has transitioned from
 * anon to account/dev-key and prompt a refresh.
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

  // Step 1: Resolve the effective credential. Replaces the prior
  // anon-only `readAnonKey` path; dev-key-only projects (no
  // .glasstrace/anon_key on disk) now run too.
  const resolved = await resolveEffectiveMcpCredential(projectRoot);
  if (resolved.effective === null) {
    return {
      exitCode: 1,
      results: [],
      messages: ["Error: Run `glasstrace init` first to generate an API key."],
    };
  }

  // Optional: surface the claimed-key-only warning so the user knows
  // to copy the key into .env.local for normal use.
  if (resolved.warnings.includes("claimed-key-only")) {
    messages.push(
      "Note: dev key was loaded from .glasstrace/claimed-key. Copy it into .env.local so your app and Codex pick it up automatically.",
    );
  }

  // Step 2: Marker check.
  //
  // Two short-circuits:
  // - Marker absent and not --force: the legacy "MCP already
  //   configured" message is no longer applicable here, but absence
  //   of the marker means we proceed to register. (The original
  //   behaviour was to short-circuit if the marker existed; the
  //   short-circuit now also requires the marker to actually match
  //   the effective credential.)
  // - Marker present, matches effective credential, and not --force:
  //   already configured for this credential, no work to do.
  // - Marker present, mismatches effective credential, regardless of
  //   --force: the project has transitioned credentials; treat as
  //   unconfigured and re-register.
  const markerPath = path.join(projectRoot, ".glasstrace", "mcp-connected");
  if (fs.existsSync(markerPath) && !force) {
    if (await markerMatchesEffective(projectRoot, resolved.effective)) {
      return {
        exitCode: 0,
        results: [],
        messages: ["MCP already configured. Use --force to reconfigure."],
      };
    }
    // Mismatch: project has transitioned credentials. Fall through to
    // re-register so MCP queries see the same scope as ingestion.
    messages.push(
      "Detected a credential change since MCP was last configured. Refreshing MCP config so queries use the current account credential.",
    );
  }

  // Step 3: Detect agents
  const agents = await detectAgents(projectRoot);
  const detectedNonGeneric = agents.filter((a) => a.name !== "generic");

  // The generic helper backs `.glasstrace/mcp.json`, the file
  // validation/debug tooling reads directly. ALWAYS include it in the
  // target list — when non-generic agents like Claude/Cursor are
  // detected, the helper used to be silently dropped, which left the
  // generic config stale after a credential change. `detectAgents`
  // contract guarantees the generic entry is always appended last
  // (see `agent-detection/detect.ts`), so we rely on that here rather
  // than synthesising a fallback.
  const genericAgent = agents.find((a) => a.name === "generic");
  const targetAgents: DetectedAgent[] = genericAgent
    ? [...detectedNonGeneric, genericAgent]
    : detectedNonGeneric;

  if (dryRun) {
    messages.push("Dry run: would perform the following actions:", "");
    for (const agent of targetAgents) {
      const name = formatAgentName(agent.name);
      if (agent.cliAvailable && resolved.effective.source === "anon") {
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

  // Step 4: Register with each agent. The bearer used in the embedded
  // configs and in vendor CLI invocations is the resolver's effective
  // credential. registerViaCli is anon-only by design (see its
  // docstring); when the effective credential is a dev key, that path
  // returns false and the file-config branch takes over.
  const results: AgentResult[] = [];
  const bearer = resolved.effective.key;

  for (const agent of targetAgents) {
    const name = formatAgentName(agent.name);

    // Try CLI registration first (not applicable for generic)
    if (agent.name !== "generic") {
      const cliSuccess = await registerViaCli(agent, bearer);
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
        const configContent = generateMcpConfig(agent, MCP_ENDPOINT, bearer);
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

  // Step 6: Update marker if at least one succeeded. Marker records
  // the effective credential's source and fingerprint (raw key never
  // touches disk via this path), so a later run can detect a
  // credential change.
  const anySuccess = results.some((r) => r.success);

  if (anySuccess) {
    await writeMcpMarker(projectRoot, {
      credentialSource: resolved.effective.source,
      credentialHash: identityFingerprint(resolved.effective.key),
    });
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

  // Exit code reflects whether the originally-detected non-generic
  // agents succeeded. The generic helper is always in `results` now —
  // letting its success alone mask a complete failure of the agents
  // the user actually has installed would silently break automation
  // that bisects on `mcp add` exit code. Preserves the pre-fix
  // contract: a run where Claude/Cursor failed still exits non-zero,
  // even when the generic helper write succeeded.
  const detectedNonGenericResults = results.filter((r) =>
    detectedNonGeneric.some((a) => a.name === r.agent),
  );
  const allDetectedNonGenericFailed =
    detectedNonGeneric.length > 0 &&
    !detectedNonGenericResults.some((r) => r.success);

  if (allDetectedNonGenericFailed) {
    messages.push(
      "",
      "All detected agent registrations failed. Check errors above.",
    );
    return { exitCode: 1, results, messages };
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
