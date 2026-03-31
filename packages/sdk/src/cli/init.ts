#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  scaffoldInstrumentation,
  scaffoldNextConfig,
  scaffoldEnvLocal,
  scaffoldGitignore,
  addCoverageMapEnv,
} from "./scaffolder.js";
import { buildImportGraph } from "../import-graph.js";

/** Options for the init command (parsed from CLI args or passed programmatically). */
export interface InitOptions {
  projectRoot: string;
  yes: boolean;
  coverageMap: boolean;
}

/** Result of running the init command. */
export interface InitResult {
  exitCode: number;
  summary: string[];
  warnings: string[];
  errors: string[];
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
 * Core init logic. Exported for testability — the CLI entry point at the
 * bottom calls this function and translates the result to process.exit().
 */
export async function runInit(options: InitOptions): Promise<InitResult> {
  const { projectRoot, yes, coverageMap } = options;
  const summary: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  // Step 1: Detect package.json
  const packageJsonPath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    errors.push("No package.json found. Run this command from a Node.js project root.");
    return { exitCode: 1, summary, warnings, errors };
  }

  // Step 2 + 3: Generate instrumentation.ts
  const instrumentationPath = path.join(projectRoot, "instrumentation.ts");
  const instrumentationExists = fs.existsSync(instrumentationPath);
  let shouldWriteInstrumentation = true;

  if (instrumentationExists && !yes) {
    shouldWriteInstrumentation = await promptYesNo(
      "instrumentation.ts already exists. Overwrite?",
      false,
    );
  } else if (instrumentationExists && yes) {
    // Non-interactive: never overwrite (idempotent)
    shouldWriteInstrumentation = false;
  }

  try {
    const created = await scaffoldInstrumentation(projectRoot, shouldWriteInstrumentation && instrumentationExists);
    if (created) {
      summary.push("Created instrumentation.ts");
    } else if (instrumentationExists) {
      summary.push("Skipped instrumentation.ts (already exists)");
    }
  } catch (err) {
    errors.push(`Failed to write instrumentation.ts: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 1, summary, warnings, errors };
  }

  // Step 4: Detect and wrap next.config.*
  try {
    const wrapped = await scaffoldNextConfig(projectRoot);
    if (wrapped) {
      summary.push("Wrapped next.config with withGlasstraceConfig()");
    } else {
      // Check if it was skipped because file already wrapped vs not found
      const hasNextConfig = ["next.config.ts", "next.config.js", "next.config.mjs"].some(
        (name) => fs.existsSync(path.join(projectRoot, name)),
      );
      if (hasNextConfig) {
        summary.push("Skipped next.config (already contains withGlasstraceConfig)");
      } else {
        warnings.push("No next.config.* found. You may need to create one for Next.js projects.");
      }
    }
  } catch (err) {
    errors.push(`Failed to modify next.config: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 1, summary, warnings, errors };
  }

  // Step 5: Update .env.local
  try {
    const envCreated = await scaffoldEnvLocal(projectRoot);
    if (envCreated) {
      summary.push("Updated .env.local with GLASSTRACE_API_KEY placeholder");
    } else {
      summary.push("Skipped .env.local (GLASSTRACE_API_KEY already present)");
    }
  } catch (err) {
    errors.push(`Failed to update .env.local: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 1, summary, warnings, errors };
  }

  // Step 6: Update .gitignore
  try {
    const gitignoreUpdated = await scaffoldGitignore(projectRoot);
    if (gitignoreUpdated) {
      summary.push("Updated .gitignore with .glasstrace/");
    } else {
      summary.push("Skipped .gitignore (.glasstrace/ already listed)");
    }
  } catch (err) {
    errors.push(`Failed to update .gitignore: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 1, summary, warnings, errors };
  }

  // Step 7: Coverage map opt-in
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

    // Step 8: Run initial import graph scan
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

  for (const arg of args) {
    if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg === "--coverage-map") {
      coverageMap = true;
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
        process.stderr.write("  1. Set your GLASSTRACE_API_KEY in .env.local\n");
        process.stderr.write("  2. Start your Next.js dev server\n");
        process.stderr.write("  3. Glasstrace will begin capturing traces automatically\n\n");
      }
      process.exit(result.exitCode);
    })
    .catch((err: unknown) => {
      process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
