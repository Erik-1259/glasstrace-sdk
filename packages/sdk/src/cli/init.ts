#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  scaffoldInstrumentation,
  scaffoldNextConfig,
  scaffoldEnvLocal,
  scaffoldGitignore,
  scaffoldMcpMarker,
  addCoverageMapEnv,
  mcpConfigMatches,
  readEnvLocalApiKey,
  isDevApiKey,
  resolveInstrumentationTarget,
} from "./scaffolder.js";
import { buildImportGraph } from "../import-graph.js";
import { getOrCreateAnonKey, readAnonKey } from "../anon-key.js";
import { detectAgents } from "../agent-detection/detect.js";
import { generateMcpConfig, generateInfoSection } from "../agent-detection/configs.js";
import { writeMcpConfig, injectInfoSection, updateGitignore } from "../agent-detection/inject.js";
import type { DetectedAgent } from "../agent-detection/detect.js";
import { MCP_ENDPOINT, NEXT_CONFIG_NAMES, formatAgentName } from "./constants.js";
import { resolveProjectRoot } from "./monorepo.js";
import {
  isInitCreatedInstrumentation,
  removeRegisterGlasstrace,
  unwrapExport,
  unwrapCJSExport,
  removeGlasstraceConfigImport,
} from "./uninit.js";

/**
 * Returns true if the current Node.js major version meets the minimum requirement.
 * Exported for testability — the CLI entry point uses this to gate execution.
 */
export function meetsNodeVersion(minMajor: number): boolean {
  const [major] = process.versions.node.split(".").map(Number);
  return major >= minMajor;
}

/** Options for the init command (parsed from CLI args or passed programmatically). */
export interface InitOptions {
  projectRoot: string;
  yes: boolean;
  coverageMap: boolean;
  /**
   * When true, skip interactive confirmation and overwrite existing
   * MCP configuration files without prompting. Preservation of the
   * anonymous key, config cache, and developer API key still applies
   * regardless of this flag — `--force` only affects the MCP diff
   * prompt (DISC-1247 Scenario 2c). Defaults to `false`.
   */
  force?: boolean;
}

/** Result of running the init command. */
export interface InitResult {
  exitCode: number;
  summary: string[];
  warnings: string[];
  errors: string[];
}

/**
 * Decides whether the MCP config at `configPath` should be overwritten
 * during re-init. Returns the action to take.
 *
 * - `"write"` — file does not exist, or existing content already matches
 *   the expected content. Safe to write.
 * - `"skip"` — existing file differs AND the user chose to keep it, or
 *   we are in a non-interactive environment without `--force`.
 * - `"force-overwrite"` — `force === true` (or user accepted the prompt)
 *   and content differs; overwrite.
 *
 * The prompt is skipped entirely when `force` is true (non-interactive
 * overwrite) or when there is no existing file / content already matches.
 *
 * @internal Exported for unit testing only.
 */
export async function decideMcpConfigAction(options: {
  configPath: string | null;
  expectedContent: string;
  force: boolean;
  readFile?: (p: string) => string;
  existsSync?: (p: string) => boolean;
  prompt?: (question: string, defaultValue: boolean) => Promise<boolean>;
}): Promise<"write" | "skip" | "force-overwrite"> {
  const { configPath, expectedContent, force } = options;
  if (configPath === null) return "write";

  const exists = options.existsSync ?? fs.existsSync;
  const read = options.readFile ?? ((p: string) => fs.readFileSync(p, "utf-8"));
  const prompt = options.prompt ?? promptYesNo;

  if (!exists(configPath)) return "write";

  let existingContent: string;
  try {
    existingContent = read(configPath);
  } catch {
    // Unreadable — treat as "write" since we can't assess drift.
    // This preserves the pre-hardening behavior for corrupt or
    // permission-restricted files.
    return "write";
  }

  if (mcpConfigMatches(existingContent, expectedContent)) {
    return "write";
  }

  if (force) {
    return "force-overwrite";
  }

  const answer = await prompt(
    `Existing MCP config at ${configPath} differs from Glasstrace's template. Overwrite?`,
    false,
  );
  return answer ? "force-overwrite" : "skip";
}

/**
 * Prompts the user with a yes/no question. Returns true for yes.
 * In non-interactive mode (no TTY), returns the default value.
 */
async function promptYesNo(question: string, defaultValue: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return defaultValue;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<boolean>((resolve) => {
    const suffix = defaultValue ? " [Y/n] " : " [y/N] ";
    rl.question(question + suffix, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "") {
        resolve(defaultValue);
        return;
      }
      resolve(trimmed === "y" || trimmed === "yes");
    });
  });
}

/**
 * Identifies a scaffolding step that can be reversed during rollback.
 * Steps are tracked in execution order and rolled back in reverse.
 */
type CompletedStep = "instrumentation" | "next-config" | "env-local" | "gitignore";

/**
 * Tracks state needed for accurate rollback of init steps.
 * Separating this from the step list allows rollback to restore
 * original file content rather than doing surgical removal.
 */
interface RollbackState {
  steps: CompletedStep[];
  /**
   * Absolute path of the instrumentation file that the scaffolder
   * wrote to. May be either `{root}/instrumentation.ts` or
   * `{root}/src/instrumentation.ts` depending on the project layout
   * (DISC-493 Issue 1). When absent, rollback falls back to the
   * root path for backward compatibility with callers that do not
   * populate this field.
   */
  instrumentationPath?: string;
  /** Original instrumentation.ts content saved before injection.
   *  When present, rollback restores this instead of using removeRegisterGlasstrace. */
  originalInstrumentationContent?: string;
}

/**
 * Removes leading blank lines that can appear after removing import lines.
 * Duplicated from uninit.ts to avoid exporting a trivial utility.
 */
function cleanLeadingBlankLines(content: string): string {
  return content.replace(/^\n{2,}/, "\n");
}

/**
 * Best-effort rollback of completed init steps in reverse order.
 * Each step is individually try/caught so that a failure in one
 * rollback does not prevent the remaining steps from being attempted.
 *
 * @internal Exported for unit testing only.
 */
export async function rollbackSteps(
  steps: CompletedStep[],
  projectRoot: string,
  state?: Omit<RollbackState, "steps">,
): Promise<void> {
  for (const step of [...steps].reverse()) {
    try {
      switch (step) {
        case "instrumentation": {
          // Prefer the exact path the scaffolder wrote to — the resolver
          // may have chosen `src/instrumentation.ts` on Next.js `src/`
          // layouts (DISC-493 Issue 1). Fall back to the root path for
          // callers that do not populate `instrumentationPath`.
          const instrPath =
            state?.instrumentationPath ?? path.join(projectRoot, "instrumentation.ts");
          if (fs.existsSync(instrPath)) {
            const content = fs.readFileSync(instrPath, "utf-8");
            if (isInitCreatedInstrumentation(content)) {
              fs.unlinkSync(instrPath);
            } else if (state?.originalInstrumentationContent !== undefined) {
              // Restore the exact original content to avoid removing
              // pre-existing imports that removeRegisterGlasstrace would strip.
              fs.writeFileSync(instrPath, state.originalInstrumentationContent, "utf-8");
            } else {
              const cleaned = removeRegisterGlasstrace(content);
              if (cleaned !== content) {
                fs.writeFileSync(instrPath, cleaned, "utf-8");
              }
            }
          }
          break;
        }
        case "next-config": {
          for (const name of NEXT_CONFIG_NAMES) {
            const configPath = path.join(projectRoot, name);
            if (!fs.existsSync(configPath)) {
              continue;
            }
            const content = fs.readFileSync(configPath, "utf-8");
            if (!content.includes("withGlasstraceConfig")) {
              continue;
            }
            const isESM = name.endsWith(".ts") || name.endsWith(".mjs");
            const unwrapResult = isESM
              ? unwrapExport(content)
              : unwrapCJSExport(content);
            if (unwrapResult.unwrapped) {
              const cleaned = removeGlasstraceConfigImport(unwrapResult.content);
              fs.writeFileSync(configPath, cleanLeadingBlankLines(cleaned), "utf-8");
            }
            break;
          }
          break;
        }
        case "env-local": {
          // Only remove GLASSTRACE_API_KEY lines — scaffoldEnvLocal (step 5)
          // only adds the API key. Removing GLASSTRACE_COVERAGE_MAP here would
          // delete a user's pre-existing coverage map setting if init fails
          // after step 5 but before the coverage map step.
          const envPath = path.join(projectRoot, ".env.local");
          if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, "utf-8");
            const lines = content.split("\n");
            const filtered = lines.filter((line) => {
              const trimmed = line.trim();
              return !/^\s*#?\s*GLASSTRACE_API_KEY\s*=/.test(trimmed);
            });
            if (filtered.length !== lines.length) {
              const result = filtered.join("\n");
              if (result.trim().length === 0) {
                fs.unlinkSync(envPath);
              } else {
                fs.writeFileSync(envPath, result, "utf-8");
              }
            }
          }
          break;
        }
        case "gitignore": {
          const gitignorePath = path.join(projectRoot, ".gitignore");
          if (fs.existsSync(gitignorePath)) {
            const content = fs.readFileSync(gitignorePath, "utf-8");
            const lines = content.split("\n");
            const filtered = lines.filter(
              (line) => line.trim() !== ".glasstrace/",
            );
            if (filtered.length !== lines.length) {
              const result = filtered.join("\n");
              if (result.trim().length === 0) {
                fs.unlinkSync(gitignorePath);
              } else {
                fs.writeFileSync(gitignorePath, result, "utf-8");
              }
            }
          }
          break;
        }
      }
    } catch {
      // Best-effort rollback — log nothing, continue with remaining steps
    }
  }
}

/**
 * Core init logic. Exported for testability — the CLI entry point at the
 * bottom calls this function and translates the result to process.exit().
 */
export async function runInit(options: InitOptions): Promise<InitResult> {
  const { yes, coverageMap } = options;
  const summary: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  // Step 0: Resolve the correct project root (monorepo awareness)
  let projectRoot: string;
  try {
    const classification = resolveProjectRoot(options.projectRoot);
    projectRoot = classification.projectRoot;
    if (classification.isMonorepo && classification.appRelativePath) {
      summary.push(`Found Next.js app at ${classification.appRelativePath} — installing there`);
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    return { exitCode: 1, summary, warnings, errors };
  }

  // Step 1: Detect package.json
  const packageJsonPath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    errors.push("No package.json found. Run this command from a Node.js project root.");
    return { exitCode: 1, summary, warnings, errors };
  }

  // Track completed steps so we can roll them back if a later step fails.
  // Only steps that modify the filesystem are tracked — pre-existing state
  // (e.g., "already-registered") is never rolled back.
  const rollbackState: RollbackState = { steps: [] };

  // Step 2: Ensure the instrumentation file has registerGlasstrace().
  // DISC-493 Issue 1: detect `src/` layout and merge into the existing file
  // rather than overwriting the project root.
  try {
    // Pre-resolve the target so we can save the original content (for
    // faithful rollback) and record the path for the rollback state.
    const preResolved = resolveInstrumentationTarget(projectRoot);
    if (!preResolved.conflict && preResolved.target !== null) {
      rollbackState.instrumentationPath = preResolved.target;
      if (fs.existsSync(preResolved.target)) {
        rollbackState.originalInstrumentationContent = fs.readFileSync(
          preResolved.target,
          "utf-8",
        );
      }
    }

    const instrResult = await scaffoldInstrumentation(projectRoot, {
      // `--yes` implies non-interactive automation and must not hang on a
      // merge confirmation prompt. `--force` skips the prompt explicitly
      // (DISC-1247 Scenario 2c parity).
      force: options.force === true || options.yes,
    });
    // Record the exact path the scaffolder wrote to, in case the resolver
    // and scaffolder ever disagree (symlinks, TOCTOU) — rollback is more
    // accurate when it targets the file that was actually mutated.
    if (instrResult.filePath !== undefined) {
      rollbackState.instrumentationPath = instrResult.filePath;
    }
    const relativePath =
      instrResult.filePath !== undefined
        ? path.relative(projectRoot, instrResult.filePath)
        : "instrumentation.ts";
    switch (instrResult.action) {
      case "created":
        summary.push(`Created ${relativePath}`);
        rollbackState.steps.push("instrumentation");
        break;
      case "injected":
        summary.push(`Added registerGlasstrace() to existing ${relativePath}`);
        rollbackState.steps.push("instrumentation");
        break;
      case "appended":
        summary.push(
          `Appended register() with registerGlasstrace() to ${relativePath}`,
        );
        rollbackState.steps.push("instrumentation");
        break;
      case "already-registered":
        summary.push(`Skipped ${relativePath} (registerGlasstrace already present)`);
        break;
      case "skipped":
        // User declined the merge prompt (DISC-1247 Scenario 2c parity).
        // Emit a warning so re-init output makes clear nothing changed.
        // "--force" here only bypasses the confirmation — the scaffolder
        // merges rather than overwriting, so the wording is deliberate.
        warnings.push(
          `Preserved ${relativePath} (merge declined; re-run with --force to apply the merge without prompting)`,
        );
        break;
      case "conflict": {
        // Both root and src/ instrumentation files exist — Next.js's
        // loader behavior is undefined (DISC-493 Issue 1). Refuse to
        // write a third competing file; point the user at the file to
        // merge into and tell them to remove the other.
        const primary =
          instrResult.filePath !== undefined
            ? path.relative(projectRoot, instrResult.filePath)
            : "src/instrumentation.ts";
        const competing =
          instrResult.conflictingPath !== undefined
            ? path.relative(projectRoot, instrResult.conflictingPath)
            : "instrumentation.ts";
        await rollbackSteps(rollbackState.steps, projectRoot, rollbackState);
        errors.push(
          `Both ${primary} and ${competing} exist. Next.js's loader behavior is undefined when both are present.\n` +
            `Merge your instrumentation into ${primary} and remove ${competing}, then re-run init.`,
        );
        return { exitCode: 1, summary, warnings, errors };
      }
      case "unrecognized":
        warnings.push(
          `${relativePath} exists but has no recognizable register() function.\n` +
            "Add this import at the top of your file:\n\n" +
            '  import { registerGlasstrace } from "@glasstrace/sdk";\n\n' +
            "Then add this as the first statement in your register() function:\n\n" +
            "  registerGlasstrace();\n",
        );
        break;
    }
  } catch (err) {
    await rollbackSteps(rollbackState.steps, projectRoot, rollbackState);
    errors.push(`Failed to write instrumentation file: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 1, summary, warnings, errors };
  }

  // Step 4: Detect and wrap next.config.*
  try {
    const configResult = await scaffoldNextConfig(projectRoot);
    if (configResult?.modified) {
      summary.push("Wrapped next.config with withGlasstraceConfig()");
      rollbackState.steps.push("next-config");
    } else if (configResult === null) {
      warnings.push("No next.config.* found. You may need to create one for Next.js projects.");
    } else if (configResult.reason === "already-wrapped") {
      summary.push("Skipped next.config (already contains withGlasstraceConfig)");
    } else if (configResult.reason === "empty-file") {
      warnings.push("next.config is empty — add a Next.js configuration export to enable wrapping");
    } else {
      warnings.push("next.config has no recognizable export pattern — add withGlasstraceConfig() manually");
    }
  } catch (err) {
    await rollbackSteps(rollbackState.steps, projectRoot, rollbackState);
    errors.push(`Failed to modify next.config: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 1, summary, warnings, errors };
  }

  // Step 5: Update .env.local
  // DISC-1247 Scenario 6: if .env.local already defines a claimed
  // developer key (gt_dev_*), scaffoldEnvLocal preserves it and this
  // step reports the preservation so the user knows re-init did not
  // overwrite their claim.
  try {
    const envPathForCheck = path.join(projectRoot, ".env.local");
    let existingDevKey = false;
    if (fs.existsSync(envPathForCheck)) {
      const existingContent = fs.readFileSync(envPathForCheck, "utf-8");
      existingDevKey = isDevApiKey(readEnvLocalApiKey(existingContent));
    }
    const envCreated = await scaffoldEnvLocal(projectRoot);
    if (envCreated) {
      summary.push("Updated .env.local with Glasstrace configuration");
      rollbackState.steps.push("env-local");
    } else if (existingDevKey) {
      summary.push(
        "Preserved existing .env.local (GLASSTRACE_API_KEY contains a claimed dev key)",
      );
    } else {
      summary.push("Skipped .env.local (GLASSTRACE_API_KEY already configured)");
    }
  } catch (err) {
    await rollbackSteps(rollbackState.steps, projectRoot, rollbackState);
    errors.push(`Failed to update .env.local: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 1, summary, warnings, errors };
  }

  // Step 6: Update .gitignore
  try {
    const gitignoreUpdated = await scaffoldGitignore(projectRoot);
    if (gitignoreUpdated) {
      summary.push("Updated .gitignore with .glasstrace/");
      rollbackState.steps.push("gitignore");
    } else {
      summary.push("Skipped .gitignore (.glasstrace/ already listed)");
    }
  } catch (err) {
    await rollbackSteps(rollbackState.steps, projectRoot, rollbackState);
    errors.push(`Failed to update .gitignore: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 1, summary, warnings, errors };
  }

  // Step 7: MCP auto-configuration
  // Use CI env vars (not TTY check) to distinguish automated builds from
  // manual CLI usage. TTY state is unreliable — piped output, test runners,
  // and IDE terminals all report isTTY=false despite being user-initiated.
  // Accept any truthy CI value (GitHub Actions, GitLab, CircleCI, Travis,
  // etc.) and also check GITHUB_ACTIONS specifically.
  const ciEnv = process.env["CI"];
  const isCI =
    (typeof ciEnv === "string" &&
      ciEnv.trim() !== "" &&
      ciEnv.toLowerCase() !== "false" &&
      ciEnv.trim() !== "0") ||
    process.env["GITHUB_ACTIONS"] === "true";

  try {
    // DISC-1247 Scenario 2a: preserve any existing anonymous key.
    // getOrCreateAnonKey already reads an existing key if present, so
    // re-running init never overwrites a key that may be linked to an
    // account. We explicitly check first so we can report the preservation
    // in the summary — without this, users have no feedback that re-init
    // respected their existing claim linkage.
    const preExistingAnonKey = await readAnonKey(projectRoot);
    const anonKey = await getOrCreateAnonKey(projectRoot);
    if (preExistingAnonKey !== null) {
      summary.push("Preserved existing .glasstrace/anon_key");
    }
    let anyConfigWritten = false;

    if (isCI) {
      // Non-interactive: write only the generic .glasstrace/mcp.json.
      // CI uses `force: true` for MCP diff decisions because there's no
      // interactive terminal to prompt on — existing configs in CI
      // workspaces are rare and safe to overwrite.
      const genericAgent: DetectedAgent = {
        name: "generic",
        mcpConfigPath: path.join(projectRoot, ".glasstrace", "mcp.json"),
        infoFilePath: null,
        cliAvailable: false,
        registrationCommand: null,
      };
      const genericConfig = generateMcpConfig(genericAgent, MCP_ENDPOINT, anonKey);
      const decision = await decideMcpConfigAction({
        configPath: genericAgent.mcpConfigPath,
        expectedContent: genericConfig,
        force: true,
      });
      if (decision !== "skip") {
        await writeMcpConfig(genericAgent, genericConfig, projectRoot);
      }
      if (genericAgent.mcpConfigPath !== null && fs.existsSync(genericAgent.mcpConfigPath)) {
        anyConfigWritten = true;
        summary.push("Created .glasstrace/mcp.json (CI mode)");
      }
    } else {
      // Interactive: detect agents and configure each
      let agents: DetectedAgent[];
      try {
        agents = await detectAgents(projectRoot);
      } catch (detectErr) {
        warnings.push(
          `Agent detection failed: ${detectErr instanceof Error ? detectErr.message : String(detectErr)}. Writing generic config only.`,
        );
        // Fall back to generic-only config
        const genericAgent: DetectedAgent = {
          name: "generic",
          mcpConfigPath: path.join(projectRoot, ".glasstrace", "mcp.json"),
          infoFilePath: null,
          cliAvailable: false,
          registrationCommand: null,
        };
        const genericConfig = generateMcpConfig(genericAgent, MCP_ENDPOINT, anonKey);
        await writeMcpConfig(genericAgent, genericConfig, projectRoot);
        if (genericAgent.mcpConfigPath !== null && fs.existsSync(genericAgent.mcpConfigPath)) {
          anyConfigWritten = true;
        }
        agents = [];
      }

      const configuredNames: string[] = [];

      for (const agent of agents) {
        try {
          const configContent = generateMcpConfig(agent, MCP_ENDPOINT, anonKey);

          // Diff-aware MCP write (DISC-1247 Scenario 2c): if the existing
          // config differs from what init would write, prompt before
          // overwriting. `--force` (or --yes in non-interactive mode)
          // skips the prompt.
          const decision = await decideMcpConfigAction({
            configPath: agent.mcpConfigPath,
            expectedContent: configContent,
            force: options.force === true || options.yes,
          });

          if (decision === "skip") {
            summary.push(
              `Preserved existing ${agent.mcpConfigPath ?? agent.name} (user declined overwrite)`,
            );
            if (agent.mcpConfigPath !== null && fs.existsSync(agent.mcpConfigPath)) {
              // Count existing user-edited config as "present" so the
              // marker file still gets written — otherwise nudges would
              // nag the user about MCP setup they consciously preserved.
              anyConfigWritten = true;
            }
            continue;
          }

          await writeMcpConfig(agent, configContent, projectRoot);

          // Verify the config file was actually written (writeMcpConfig
          // swallows permission errors and returns void)
          const configExists = agent.mcpConfigPath !== null && fs.existsSync(agent.mcpConfigPath);
          if (!configExists) {
            continue;
          }

          anyConfigWritten = true;

          const infoContent = generateInfoSection(agent, MCP_ENDPOINT);
          if (infoContent !== "") {
            await injectInfoSection(agent, infoContent, projectRoot);
          }

          if (agent.name !== "generic") {
            configuredNames.push(formatAgentName(agent.name));
          }
        } catch (agentErr) {
          warnings.push(
            `Failed to configure MCP for ${agent.name}: ${agentErr instanceof Error ? agentErr.message : String(agentErr)}`,
          );
        }
      }

      if (configuredNames.length > 0) {
        summary.push(`Configured MCP for: ${configuredNames.join(", ")}`);
      } else if (anyConfigWritten) {
        summary.push("Created .glasstrace/mcp.json (generic config)");
      }
    }

    // Add MCP config files to .gitignore
    await updateGitignore(
      [".mcp.json", ".cursor/mcp.json", ".gemini/settings.json", ".codex/config.toml"],
      projectRoot,
    );

    // Create marker file only if at least one config was successfully written.
    // Without this gate, a failed MCP setup would suppress future nudges,
    // leaving users stuck without MCP configuration.
    if (anyConfigWritten) {
      const markerCreated = await scaffoldMcpMarker(projectRoot, anonKey);
      if (markerCreated) {
        summary.push("Created .glasstrace/mcp-connected marker");
      }
    }
  } catch (mcpErr) {
    warnings.push(
      `MCP auto-configuration failed: ${mcpErr instanceof Error ? mcpErr.message : String(mcpErr)}`,
    );
  }

  // Step 8: Coverage map opt-in
  let enableCoverageMap = coverageMap;
  if (!yes && !coverageMap) {
    if (process.stdin.isTTY) {
      enableCoverageMap = await promptYesNo(
        "Would you like to enable test coverage mapping?",
        false,
      );
    }
  }

  if (enableCoverageMap) {
    try {
      const added = await addCoverageMapEnv(projectRoot);
      if (added) {
        summary.push("Added GLASSTRACE_COVERAGE_MAP=true to .env.local");
      }
    } catch (err) {
      warnings.push(`Failed to add coverage map env: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Step 9: Run initial import graph scan
    try {
      await buildImportGraph(projectRoot);
      summary.push("Completed initial import graph scan");
    } catch (err) {
      warnings.push(`Import graph scan failed: ${err instanceof Error ? err.message : String(err)}. You can run it later.`);
    }
  }

  return { exitCode: 0, summary, warnings, errors };
}

/**
 * Parses CLI arguments into InitOptions.
 */
function parseArgs(argv: string[]): InitOptions {
  const args = argv.slice(2); // skip node + script path
  let yes = false;
  let coverageMap = false;
  let force = false;

  for (const arg of args) {
    if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg === "--coverage-map") {
      coverageMap = true;
    } else if (arg === "--force") {
      force = true;
    }
  }

  // Auto-detect non-interactive
  if (!process.stdin.isTTY) {
    yes = true;
  }

  return {
    projectRoot: process.cwd(),
    yes,
    coverageMap,
    force,
  };
}

/**
 * CLI entry point. Only runs when this module is executed directly
 * (not when imported for testing).
 */
const scriptPath =
  typeof process !== "undefined" && process.argv[1] !== undefined
    ? process.argv[1].replace(/\\/g, "/")
    : undefined;

const scriptBasename = scriptPath !== undefined ? path.basename(scriptPath) : undefined;

const isDirectExecution =
  scriptPath !== undefined &&
  (scriptPath.endsWith("/cli/init.js") ||
    scriptPath.endsWith("/cli/init.ts") ||
    scriptBasename === "glasstrace");

if (isDirectExecution) {
  // Enforce minimum Node.js version before any command processing.
  // The engines field in package.json is advisory — npm does not enforce
  // it by default, so this provides a clear error for users on older runtimes.
  if (!meetsNodeVersion(20)) {
    process.stderr.write(
      `Error: @glasstrace/sdk requires Node.js >= 20. Current version: ${process.version}\n`,
    );
    process.exit(1);
  }

  const subcommand = process.argv[2];

  if (subcommand === "mcp") {
    if (process.argv[3] === "add") {
      // Parse --force and --dry-run from remaining args
      const remainingArgs = process.argv.slice(4);
      const force = remainingArgs.includes("--force");
      const dryRun = remainingArgs.includes("--dry-run");

      import("./mcp-add.js")
        .then(({ mcpAdd }) => mcpAdd({ force, dryRun }))
        .then((result) => {
          for (const msg of result.messages) {
            process.stderr.write(msg + "\n");
          }
          process.exit(result.exitCode);
        })
        .catch((err: unknown) => {
          process.stderr.write(
            `Fatal error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exit(1);
        });
    } else {
      process.stderr.write(
        `Unknown mcp subcommand: ${process.argv[3] ?? "(none)"}\n\n` +
          "Usage: glasstrace mcp add [--force] [--dry-run]\n",
      );
      process.exit(1);
    }
  } else if (subcommand === undefined || subcommand === "init" || subcommand.startsWith("-")) {
    // Default: run init (handles `glasstrace`, `glasstrace init`, `glasstrace --yes`)
    const forwardedArgs = process.argv.slice(subcommand === "init" ? 3 : 2);

    // `--validate` is an init sub-mode that checks artifact consistency
    // without scaffolding (DISC-1247 Scenario 4). We dispatch to a
    // dedicated module so the main init path stays unburdened.
    //
    // Resolve the app root via the same monorepo-aware logic that
    // `runInit` and `runStatus` use so validation in a monorepo root
    // inspects the actual Next.js app directory rather than the empty
    // workspace root (addresses Codex P2 review feedback).
    if (forwardedArgs.includes("--validate")) {
      let validateProjectRoot = process.cwd();
      try {
        validateProjectRoot = resolveProjectRoot(validateProjectRoot).projectRoot;
      } catch {
        // Fall back to cwd if the monorepo resolver can't find an app —
        // validate can still report orphan-artifact issues at the raw
        // cwd and will exit non-zero rather than hiding the problem.
      }
      import("./validate.js")
        .then(({ runValidate }) => runValidate({ projectRoot: validateProjectRoot }))
        .then((result) => {
          for (const line of result.summary) {
            process.stderr.write(`${line}\n`);
          }
          for (const issue of result.issues) {
            process.stderr.write(`  - ${issue.message}\n`);
            if (issue.fix) {
              process.stderr.write(`      Fix: ${issue.fix}\n`);
            }
          }
          process.exit(result.exitCode);
        })
        .catch((err: unknown) => {
          process.stderr.write(
            `Fatal error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exit(1);
        });
    } else {
      const options = parseArgs(process.argv);

      runInit(options)
        .then((result) => {
          if (result.errors.length > 0) {
            for (const err of result.errors) {
              process.stderr.write(`Error: ${err}\n`);
            }
          }
          if (result.warnings.length > 0) {
            for (const warn of result.warnings) {
              process.stderr.write(`Warning: ${warn}\n`);
            }
          }
          if (result.summary.length > 0) {
            process.stderr.write("\nGlasstrace initialized successfully!\n\n");
            for (const line of result.summary) {
              process.stderr.write(`  - ${line}\n`);
            }
            process.stderr.write("\nNext steps:\n");
            process.stderr.write("  1. Start your Next.js dev server\n");
            process.stderr.write(
              "  2. Glasstrace works immediately in anonymous mode\n",
            );
            process.stderr.write(
              "  3. To link to your account, set GLASSTRACE_API_KEY in .env.local\n\n",
            );
          }
          process.exit(result.exitCode);
        })
        .catch((err: unknown) => {
          process.stderr.write(
            `Fatal error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exit(1);
        });
    }
  } else if (subcommand === "uninit") {
    const remainingArgs = process.argv.slice(3);
    const dryRun = remainingArgs.includes("--dry-run");
    const force = remainingArgs.includes("--force");

    import("./uninit.js")
      .then(({ runUninit }) => runUninit({ projectRoot: process.cwd(), dryRun, force }))
      .then((result) => {
        if (result.errors.length > 0) {
          for (const err of result.errors) {
            process.stderr.write(`Error: ${err}\n`);
          }
        }
        if (result.warnings.length > 0) {
          for (const warn of result.warnings) {
            process.stderr.write(`Warning: ${warn}\n`);
          }
        }
        if (result.summary.length > 0) {
          process.stderr.write("\n");
          for (const line of result.summary) {
            process.stderr.write(`  ${line}\n`);
          }
          process.stderr.write("\n");
        }
        process.exit(result.exitCode);
      })
      .catch((err: unknown) => {
        process.stderr.write(
          `Fatal error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      });
  } else if (subcommand === "status") {
    const remainingArgs = process.argv.slice(3);
    const json = remainingArgs.includes("--json");

    Promise.all([import("./status.js"), import("./monorepo.js")])
      .then(([{ runStatus }, { resolveProjectRoot: resolve }]) => {
        let projectRoot = process.cwd();
        try {
          projectRoot = resolve(projectRoot).projectRoot;
        } catch {
          // Fall back to cwd if monorepo resolution fails
        }
        const result = runStatus({ projectRoot });
        if (json) {
          process.stdout.write(JSON.stringify(result) + "\n");
        } else {
          const checks = [
            ["Installed", result.installed],
            ["Initialized", result.initialized],
            ["Instrumentation", result.instrumentation],
            ["Config wrapped", result.configWrapped],
            ["Anon key", result.anonKey],
            ["MCP configured", result.mcpConfigured],
          ] as const;
          for (const [label, ok] of checks) {
            process.stderr.write(`  ${ok ? "+" : "-"} ${label}\n`);
          }
          if (result.agents.length > 0) {
            process.stderr.write(`  + Agents: ${result.agents.join(", ")}\n`);
          } else {
            process.stderr.write("  - Agents\n");
          }
        }
        process.exit(0);
      })
      .catch((err: unknown) => {
        process.stderr.write(
          `Fatal error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      });
  } else {
    process.stderr.write(
      `Unknown command: ${subcommand}\n\n` +
        "Usage:\n" +
        "  glasstrace init [--yes] [--coverage-map] [--force] [--validate]\n" +
        "  glasstrace uninit [--dry-run] [--force]\n" +
        "  glasstrace status [--json]\n" +
        "  glasstrace mcp add [--force] [--dry-run]\n",
    );
    process.exit(1);
  }
}
