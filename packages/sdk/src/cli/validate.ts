import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A single artifact-state inconsistency detected by `sdk init --validate`.
 */
export interface ValidationIssue {
  /** Stable machine-readable identifier for the issue class. */
  code:
    | "glasstrace-dir-without-register-import"
    | "sdk-import-without-glasstrace-dir"
    | "mcp-marker-without-configs"
    | "mcp-configs-without-marker";
  /** Human-readable message describing the inconsistency. */
  message: string;
  /** Suggested command or manual action to resolve the issue. */
  fix: string;
}

/** Options for `runValidate`. */
export interface ValidateOptions {
  projectRoot: string;
}

/** Structured result of running the validator. */
export interface ValidateResult {
  /** Zero when no issues; non-zero when any issue is detected. */
  exitCode: number;
  /** Ordered lines of human-friendly summary output. */
  summary: string[];
  /** Detailed per-issue findings. */
  issues: ValidationIssue[];
}

/** MCP config files init may create. Used to detect stale state. */
const MCP_CONFIG_CANDIDATES = [
  ".mcp.json",
  ".cursor/mcp.json",
  ".gemini/settings.json",
  ".codex/config.toml",
] as const;

/**
 * Returns true when the given instrumentation file imports
 * `@glasstrace/sdk` (which includes the `registerGlasstrace` import
 * emitted by `sdk init`).
 *
 * @internal Exported for unit testing only.
 */
export function hasGlasstraceImport(content: string): boolean {
  return /@glasstrace\/sdk/.test(content);
}

/**
 * Returns true when the file imports `registerGlasstrace` specifically
 * (as opposed to other named exports such as `withGlasstraceConfig`).
 *
 * @internal Exported for unit testing only.
 */
export function hasRegisterGlasstraceImport(content: string): boolean {
  // Single- or multi-specifier imports from @glasstrace/sdk that include
  // `registerGlasstrace` as a named export.
  const match = /import\s*\{([^}]+)\}\s*from\s*["']@glasstrace\/sdk["']/;
  const importMatch = match.exec(content);
  if (!importMatch) return false;
  return importMatch[1]
    .split(",")
    .map((s) => s.trim())
    .includes("registerGlasstrace");
}

/**
 * Validates consistency between the filesystem artifacts that `sdk init`
 * produces (DISC-1247 Scenario 4). Detects four classes of inconsistency:
 *
 * 1. `.glasstrace/` exists but `instrumentation.ts` does not import
 *    `registerGlasstrace` from `@glasstrace/sdk`.
 * 2. `.glasstrace/` is missing but `instrumentation.ts` still imports
 *    from `@glasstrace/sdk`.
 * 3. `.glasstrace/mcp-connected` marker exists but no MCP config files.
 * 4. MCP config files exist but no `.glasstrace/mcp-connected` marker.
 *
 * Each issue includes a stable `code`, a message, and a suggested fix.
 * Exit code is non-zero whenever any issue is detected so CI pipelines
 * can gate on `sdk init --validate`.
 *
 * @param options - Configuration for the validator.
 * @returns A structured result describing detected inconsistencies.
 */
export function runValidate(options: ValidateOptions): ValidateResult {
  const { projectRoot } = options;
  const issues: ValidationIssue[] = [];

  const glasstraceDir = path.join(projectRoot, ".glasstrace");
  const instrumentationPath = path.join(projectRoot, "instrumentation.ts");
  const markerPath = path.join(glasstraceDir, "mcp-connected");

  const glasstraceDirExists = isDirectorySafe(glasstraceDir);
  const instrumentationExists = fs.existsSync(instrumentationPath);
  const instrumentationContent = instrumentationExists
    ? safeReadFile(instrumentationPath)
    : null;
  const markerExists = fs.existsSync(markerPath);

  const mcpConfigsPresent = MCP_CONFIG_CANDIDATES.filter((rel) =>
    fs.existsSync(path.join(projectRoot, rel)),
  );

  // 1. .glasstrace/ present but instrumentation missing the SDK import
  if (glasstraceDirExists) {
    if (
      instrumentationContent === null ||
      !hasRegisterGlasstraceImport(instrumentationContent)
    ) {
      issues.push({
        code: "glasstrace-dir-without-register-import",
        message:
          ".glasstrace/ exists but instrumentation.ts is missing the registerGlasstrace import.",
        fix: "Run `npx glasstrace init` to re-scaffold instrumentation.ts, or remove .glasstrace/ if the SDK is no longer in use.",
      });
    }
  }

  // 2. .glasstrace/ missing but instrumentation still imports the SDK
  if (!glasstraceDirExists && instrumentationContent !== null) {
    if (hasGlasstraceImport(instrumentationContent)) {
      issues.push({
        code: "sdk-import-without-glasstrace-dir",
        message:
          "instrumentation.ts imports from @glasstrace/sdk but .glasstrace/ is missing.",
        fix: "Run `npx glasstrace init` to recreate .glasstrace/, or `npx glasstrace uninit` to fully remove the SDK.",
      });
    }
  }

  // 3. MCP marker present but no MCP config files exist
  if (markerExists && mcpConfigsPresent.length === 0) {
    issues.push({
      code: "mcp-marker-without-configs",
      message:
        ".glasstrace/mcp-connected marker is present but no MCP config files were found.",
      fix: "Run `npx glasstrace mcp add --force` to regenerate MCP configs, or delete .glasstrace/mcp-connected.",
    });
  }

  // 4. MCP config files exist but no marker
  if (!markerExists && mcpConfigsPresent.length > 0) {
    issues.push({
      code: "mcp-configs-without-marker",
      message: `MCP config files exist (${mcpConfigsPresent.join(", ")}) but .glasstrace/mcp-connected marker is missing.`,
      fix: "Run `npx glasstrace init` to re-register the marker, or `npx glasstrace uninit` to fully remove MCP configuration.",
    });
  }

  const summary: string[] = [];
  if (issues.length === 0) {
    summary.push("Glasstrace install state is consistent.");
  } else {
    summary.push(
      `Detected ${issues.length} inconsistenc${issues.length === 1 ? "y" : "ies"} in Glasstrace install state:`,
    );
  }

  return {
    exitCode: issues.length > 0 ? 1 : 0,
    summary,
    issues,
  };
}

/**
 * Reads a file as UTF-8, returning `null` if the file cannot be read.
 */
function safeReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Returns true when the path exists and is a directory. Returns false
 * when the path is missing, is not a directory, or when `statSync`
 * throws (permission denied, TOCTOU race between existsSync and
 * statSync, etc). Validation is best-effort and must not throw — a
 * crash here would turn a reporting tool into a hard failure.
 */
function isDirectorySafe(dirPath: string): boolean {
  try {
    if (!fs.existsSync(dirPath)) return false;
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}
