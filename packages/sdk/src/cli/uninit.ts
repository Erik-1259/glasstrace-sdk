import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NEXT_CONFIG_NAMES } from "./constants.js";

/**
 * Options for the uninit command.
 */
export interface UninitOptions {
  projectRoot: string;
  dryRun: boolean;
}

/**
 * Result of running the uninit command.
 */
export interface UninitResult {
  exitCode: number;
  summary: string[];
  warnings: string[];
  errors: string[];
}

/**
 * MCP config files that init may create.
 * These are JSON files containing `mcpServers.glasstrace`.
 */
const MCP_CONFIG_FILES = [".mcp.json", ".cursor/mcp.json", ".gemini/settings.json"] as const;

/**
 * Agent info files that may contain glasstrace marker sections.
 * Both HTML-style (`<!-- glasstrace:mcp:start -->`) and hash-style
 * (`# glasstrace:mcp:start`) markers are supported.
 */
const AGENT_INFO_FILES = [
  "CLAUDE.md",
  "codex.md",
  ".cursorrules",
] as const;

/**
 * Finds the matching closing parenthesis for an opening paren at the given
 * position, accounting for nested parentheses.
 *
 * @param text - The source text to search.
 * @param openPos - The index of the opening `(`.
 * @returns The index of the matching `)`, or -1 if not found.
 * @internal Exported for unit testing only.
 */
export function findMatchingParen(text: string, openPos: number): number {
  let depth = 0;
  for (let i = openPos; i < text.length; i++) {
    if (text[i] === "(") {
      depth++;
    } else if (text[i] === ")") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Removes the `withGlasstraceConfig(...)` wrapper from an ESM default export,
 * restoring the inner expression.
 *
 * Before: `export default withGlasstraceConfig(innerExpr);`
 * After:  `export default innerExpr;`
 *
 * @internal Exported for unit testing only.
 */
export function unwrapExport(content: string): { content: string; unwrapped: boolean } {
  const pattern = /export\s+default\s+withGlasstraceConfig\s*\(/;
  const match = pattern.exec(content);
  if (!match) {
    return { content, unwrapped: false };
  }

  // Find the opening paren of withGlasstraceConfig(
  const openParenIdx = match.index + match[0].length - 1;
  const closeParenIdx = findMatchingParen(content, openParenIdx);
  if (closeParenIdx === -1) {
    return { content, unwrapped: false };
  }

  const innerExpr = content.slice(openParenIdx + 1, closeParenIdx).trim();
  if (innerExpr.length === 0) {
    return { content, unwrapped: false };
  }

  // Everything before `export default ...`
  const before = content.slice(0, match.index);
  // Everything after the closing `)` (skip optional semicolon and trailing whitespace)
  const afterClose = content.slice(closeParenIdx + 1);
  const trailing = afterClose.replace(/^;?\s*/, "");

  const result = before + `export default ${innerExpr};\n` + trailing;

  return { content: result, unwrapped: true };
}

/**
 * Removes the `withGlasstraceConfig(...)` wrapper from a CJS module.exports,
 * restoring the inner expression.
 *
 * Before: `module.exports = withGlasstraceConfig(innerExpr);`
 * After:  `module.exports = innerExpr;`
 *
 * @internal Exported for unit testing only.
 */
export function unwrapCJSExport(content: string): { content: string; unwrapped: boolean } {
  const pattern = /module\.exports\s*=\s*withGlasstraceConfig\s*\(/;
  const match = pattern.exec(content);
  if (!match) {
    return { content, unwrapped: false };
  }

  const openParenIdx = match.index + match[0].length - 1;
  const closeParenIdx = findMatchingParen(content, openParenIdx);
  if (closeParenIdx === -1) {
    return { content, unwrapped: false };
  }

  const innerExpr = content.slice(openParenIdx + 1, closeParenIdx).trim();
  if (innerExpr.length === 0) {
    return { content, unwrapped: false };
  }

  const before = content.slice(0, match.index);
  const afterClose = content.slice(closeParenIdx + 1);
  const trailing = afterClose.replace(/^;?\s*/, "");

  const result = before + `module.exports = ${innerExpr};\n` + trailing;

  return { content: result, unwrapped: true };
}

/**
 * Removes the `import { withGlasstraceConfig } from "@glasstrace/sdk"` line
 * from file content. If `withGlasstraceConfig` is the only imported specifier,
 * the entire import line is removed. If other specifiers exist, only
 * `withGlasstraceConfig` is removed from the specifier list.
 *
 * @internal Exported for unit testing only.
 */
export function removeGlasstraceConfigImport(content: string): string {
  // ESM: import { withGlasstraceConfig } from "@glasstrace/sdk"
  const esmSoleImport =
    /import\s*\{\s*withGlasstraceConfig\s*\}\s*from\s*["']@glasstrace\/sdk["']\s*;?\s*\n?/;
  if (esmSoleImport.test(content)) {
    return content.replace(esmSoleImport, "");
  }

  // ESM with multiple specifiers — remove withGlasstraceConfig from the list
  const esmMultiImport =
    /import\s*\{([^}]*)\}\s*from\s*["']@glasstrace\/sdk["']/;
  const multiMatch = esmMultiImport.exec(content);
  if (multiMatch) {
    const specifiers = multiMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "" && s !== "withGlasstraceConfig");
    if (specifiers.length === 0) {
      // All specifiers were withGlasstraceConfig — remove entire import
      return content.replace(
        /import\s*\{[^}]*\}\s*from\s*["']@glasstrace\/sdk["']\s*;?\s*\n?/,
        "",
      );
    }
    const newImport = `import { ${specifiers.join(", ")} } from "@glasstrace/sdk"`;
    return content.replace(multiMatch[0], newImport);
  }

  // CJS: const { withGlasstraceConfig } = require("@glasstrace/sdk")
  const cjsSoleRequire =
    /const\s*\{\s*withGlasstraceConfig\s*\}\s*=\s*require\s*\(\s*["']@glasstrace\/sdk["']\s*\)\s*;?\s*\n?/;
  if (cjsSoleRequire.test(content)) {
    return content.replace(cjsSoleRequire, "");
  }

  // CJS with multiple specifiers
  const cjsMultiRequire =
    /const\s*\{([^}]*)\}\s*=\s*require\s*\(\s*["']@glasstrace\/sdk["']\s*\)/;
  const cjsMultiMatch = cjsMultiRequire.exec(content);
  if (cjsMultiMatch) {
    const specifiers = cjsMultiMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "" && s !== "withGlasstraceConfig");
    if (specifiers.length === 0) {
      return content.replace(
        /const\s*\{[^}]*\}\s*=\s*require\s*\(\s*["']@glasstrace\/sdk["']\s*\)\s*;?\s*\n?/,
        "",
      );
    }
    const newRequire = `const { ${specifiers.join(", ")} } = require("@glasstrace/sdk")`;
    return content.replace(cjsMultiMatch[0], newRequire);
  }

  return content;
}

/**
 * Removes blank lines that appear consecutively (more than one empty line
 * in a row) at the top of a file, which can occur after removing import lines.
 */
function cleanLeadingBlankLines(content: string): string {
  return content.replace(/^\n{2,}/, "\n");
}

/**
 * Determines whether an instrumentation.ts file was created by `glasstrace init`
 * (i.e., contains only the standard template with no user-added code).
 *
 * A file is considered init-created if:
 * - The only import from any package is `@glasstrace/sdk`
 * - The only meaningful statement in `register()` is `registerGlasstrace()`
 * - There are no other top-level statements, exports, or declarations outside
 *   the register function (prevents deleting files where users added their own code)
 *
 * @internal Exported for unit testing only.
 */
export function isInitCreatedInstrumentation(content: string): boolean {
  const lines = content.split("\n");

  // Check that all imports are from @glasstrace/sdk
  const importLines = lines.filter(
    (l) => /^\s*import\s/.test(l) && !l.trim().startsWith("//"),
  );
  const nonGlasstraceImports = importLines.filter(
    (l) => !l.includes("@glasstrace/sdk"),
  );
  if (nonGlasstraceImports.length > 0) {
    return false;
  }

  // Check that the register() function body only contains registerGlasstrace()
  // and comments — no other meaningful statements
  const registerFnRegex = /export\s+(?:async\s+)?function\s+register\s*\([^)]*\)\s*\{/;
  const match = registerFnRegex.exec(content);
  if (!match) {
    // No register function — not a standard init template
    return false;
  }

  // Extract the function body
  const afterBrace = content.slice(match.index + match[0].length);
  const closingBraceIdx = findMatchingBrace(content, match.index + match[0].length - 1);
  if (closingBraceIdx === -1) {
    return false;
  }

  const body = afterBrace.slice(0, closingBraceIdx - (match.index + match[0].length));
  const bodyLines = body.split("\n");

  // Filter out comments and blank lines — only meaningful statements remain
  const statements = bodyLines.filter((l) => {
    const trimmed = l.trim();
    return trimmed !== "" && !trimmed.startsWith("//");
  });

  // The only statement should be registerGlasstrace()
  if (statements.length !== 1) {
    return false;
  }
  if (!/^\s*registerGlasstrace\s*\(\s*\)\s*;?\s*$/.test(statements[0])) {
    return false;
  }

  // Verify no other top-level code exists outside imports and the register function.
  // Extract everything that isn't an import line or inside the register() function.
  const beforeFn = content.slice(0, match.index);
  const afterFn = content.slice(closingBraceIdx + 1);

  const topLevelBefore = beforeFn.split("\n").filter((l) => {
    const trimmed = l.trim();
    return (
      trimmed !== "" &&
      !trimmed.startsWith("//") &&
      !trimmed.startsWith("import ") &&
      !trimmed.startsWith("import{")
    );
  });

  const topLevelAfter = afterFn.split("\n").filter((l) => {
    const trimmed = l.trim();
    return trimmed !== "" && !trimmed.startsWith("//");
  });

  return topLevelBefore.length === 0 && topLevelAfter.length === 0;
}

/**
 * Finds the matching closing brace for an opening brace at the given position.
 */
function findMatchingBrace(text: string, openPos: number): number {
  let depth = 0;
  for (let i = openPos; i < text.length; i++) {
    if (text[i] === "{") {
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Removes the `registerGlasstrace()` call and its `@glasstrace/sdk` import
 * from an instrumentation.ts file, preserving all other code.
 *
 * @internal Exported for unit testing only.
 */
export function removeRegisterGlasstrace(content: string): string {
  let result = content;

  // Remove all comment-block + registerGlasstrace() call pairs.
  // The init template creates a multi-line comment block before the call:
  //   // Glasstrace must be registered before Prisma instrumentation
  //   // to ensure all ORM spans are captured correctly.
  //   // If you use @prisma/instrumentation, import it after this call.
  //   registerGlasstrace();
  // Use global flag to handle multiple occurrences.
  result = result.replace(
    /[ \t]*\/\/\s*Glasstrace must be registered[^\n]*\n(?:[ \t]*\/\/[^\n]*\n)*[ \t]*registerGlasstrace\s*\(\s*\)\s*;?\s*\n?/g,
    "",
  );

  // Remove any remaining standalone registerGlasstrace() calls (global)
  result = result.replace(
    /[ \t]*registerGlasstrace\s*\(\s*\)\s*;?\s*\n?/g,
    "",
  );

  // Remove the import line for registerGlasstrace from @glasstrace/sdk
  // If it's the sole import, remove the whole line
  const soleImportPattern =
    /import\s*\{\s*registerGlasstrace\s*\}\s*from\s*["']@glasstrace\/sdk["']\s*;?\s*\n?/;
  if (soleImportPattern.test(result)) {
    result = result.replace(soleImportPattern, "");
  } else {
    // Multiple specifiers — remove only registerGlasstrace
    const multiImportPattern =
      /import\s*\{([^}]*)\}\s*from\s*["']@glasstrace\/sdk["']/;
    const multiMatch = multiImportPattern.exec(result);
    if (multiMatch) {
      const specifiers = multiMatch[1]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "" && s !== "registerGlasstrace");
      if (specifiers.length === 0) {
        result = result.replace(
          /import\s*\{[^}]*\}\s*from\s*["']@glasstrace\/sdk["']\s*;?\s*\n?/,
          "",
        );
      } else {
        const newImport = `import { ${specifiers.join(", ")} } from "@glasstrace/sdk"`;
        result = result.replace(multiMatch[0], newImport);
      }
    }
  }

  return cleanLeadingBlankLines(result);
}

/**
 * Removes content between glasstrace marker comments from a file.
 * Supports both HTML markers (`<!-- glasstrace:mcp:start/end -->`) and
 * hash markers (`# glasstrace:mcp:start/end`).
 *
 * @internal Exported for unit testing only.
 */
export function removeMarkerSection(content: string): { content: string; removed: boolean } {
  const lines = content.split("\n");
  let startIdx = -1;
  let endIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (
      trimmed === "<!-- glasstrace:mcp:start -->" ||
      trimmed === "# glasstrace:mcp:start"
    ) {
      startIdx = i;
    } else if (
      (trimmed === "<!-- glasstrace:mcp:end -->" ||
        trimmed === "# glasstrace:mcp:end") &&
      startIdx !== -1
    ) {
      endIdx = i;
      break;
    }
  }

  if (startIdx === -1 || endIdx === -1) {
    return { content, removed: false };
  }

  const before = lines.slice(0, startIdx);
  const after = lines.slice(endIdx + 1);

  // Remove trailing blank line that may have preceded the marker block
  while (before.length > 0 && before[before.length - 1].trim() === "") {
    before.pop();
  }

  const result = [...before, ...after].join("\n");
  // Ensure file ends with newline if it has content
  const trimmedResult = result.trimEnd();
  return {
    content: trimmedResult.length > 0 ? trimmedResult + "\n" : "",
    removed: true,
  };
}

/**
 * Removes the `glasstrace` key from an MCP config JSON file's `mcpServers`
 * object. Only deletes the file when `mcpServers` is the sole top-level key
 * and `glasstrace` is the only server entry. When other top-level keys exist
 * (e.g., `$schema`, metadata), the `mcpServers` key is removed (if empty)
 * and the file is preserved.
 *
 * @returns `"removed-key"` if the key was removed (other data remains),
 *          `"deleted"` if the file should be deleted (no other data),
 *          or `"skipped"` if no glasstrace config was found.
 * @internal Exported for unit testing only.
 */
export function processJsonMcpConfig(content: string): {
  action: "removed-key" | "deleted" | "skipped";
  content?: string;
} {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return { action: "skipped" };
  }

  const mcpServers = parsed["mcpServers"] as Record<string, unknown> | undefined;
  if (!mcpServers || typeof mcpServers !== "object" || !("glasstrace" in mcpServers)) {
    return { action: "skipped" };
  }

  const remainingServers = Object.keys(mcpServers).filter((k) => k !== "glasstrace");
  const otherTopLevelKeys = Object.keys(parsed).filter((k) => k !== "mcpServers");

  if (remainingServers.length === 0 && otherTopLevelKeys.length === 0) {
    // mcpServers.glasstrace is the only data in the file — safe to delete
    return { action: "deleted" };
  }

  // Remove the glasstrace key, keep other servers
  const { glasstrace: _, ...rest } = mcpServers;
  // Suppress unused variable lint — the destructuring intentionally discards glasstrace
  void _;

  if (remainingServers.length > 0) {
    // Other servers remain — keep mcpServers with glasstrace removed
    parsed["mcpServers"] = rest;
  } else {
    // No servers remain but other top-level keys exist — remove mcpServers entirely
    delete parsed["mcpServers"];
  }

  return { action: "removed-key", content: JSON.stringify(parsed, null, 2) + "\n" };
}

/**
 * Removes the `[mcp_servers.glasstrace]` section from a TOML config file.
 * Since TOML parsing without a dependency is complex, this uses a line-based
 * approach that handles the standard format written by init.
 *
 * @returns `"removed-section"` if the glasstrace section was removed,
 *          `"deleted"` if the entire file should be deleted (only contained
 *          glasstrace config), or `"skipped"` if no glasstrace config found.
 * @internal Exported for unit testing only.
 */
export function processTomlMcpConfig(content: string): {
  action: "removed-section" | "deleted" | "skipped";
  content?: string;
} {
  if (!content.includes("[mcp_servers.glasstrace]")) {
    return { action: "skipped" };
  }

  const lines = content.split("\n");
  const startIdx = lines.findIndex(
    (l) => l.trim() === "[mcp_servers.glasstrace]",
  );
  if (startIdx === -1) {
    return { action: "skipped" };
  }

  // Find the end of the glasstrace section: next section header or end of file
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }

  // Remove the section and any trailing blank lines
  const before = lines.slice(0, startIdx);
  const after = lines.slice(endIdx);

  // Trim trailing blank lines from the before section
  while (before.length > 0 && before[before.length - 1].trim() === "") {
    before.pop();
  }

  const result = [...before, ...after].join("\n").trimEnd();

  // Check if there are any remaining sections
  if (result.trim().length === 0) {
    return { action: "deleted" };
  }

  return { action: "removed-section", content: result + "\n" };
}

/**
 * Reverses every step of `glasstrace init`, cleanly removing all SDK artifacts
 * from a project.
 *
 * Steps (in order):
 * 1. Unwrap `withGlasstraceConfig` from next.config
 * 2. Remove `registerGlasstrace` from instrumentation.ts (or delete if init-created)
 * 3. Remove `.glasstrace/` directory
 * 4. Remove `GLASSTRACE_*` entries from `.env.local`
 * 5. Remove `.glasstrace/` from `.gitignore`
 * 6. Remove MCP config entries
 * 7. Remove info sections from agent files
 *
 * @param options - Configuration for the uninit command.
 * @returns A structured result describing what actions were taken.
 */
export async function runUninit(options: UninitOptions): Promise<UninitResult> {
  const { projectRoot, dryRun } = options;
  const summary: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const prefix = dryRun ? "[dry run] " : "";

  // Step 1: Unwrap withGlasstraceConfig from next.config
  try {
    let configHandled = false;
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
        const final = cleanLeadingBlankLines(cleaned);
        if (!dryRun) {
          fs.writeFileSync(configPath, final, "utf-8");
        }
        summary.push(`${prefix}Unwrapped withGlasstraceConfig from ${name}`);
        configHandled = true;
        break;
      } else {
        warnings.push(
          `${name} contains withGlasstraceConfig but could not be automatically unwrapped. ` +
            "Please remove withGlasstraceConfig() manually.",
        );
        configHandled = true;
        break;
      }
    }
    if (!configHandled) {
      // No next.config with withGlasstraceConfig found — nothing to do
    }
  } catch (err) {
    errors.push(
      `Failed to process next.config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Step 2: Remove registerGlasstrace from instrumentation.ts
  try {
    const instrPath = path.join(projectRoot, "instrumentation.ts");
    if (fs.existsSync(instrPath)) {
      const content = fs.readFileSync(instrPath, "utf-8");
      if (content.includes("registerGlasstrace") || content.includes("@glasstrace/sdk")) {
        if (isInitCreatedInstrumentation(content)) {
          if (!dryRun) {
            fs.unlinkSync(instrPath);
          }
          summary.push(`${prefix}Deleted instrumentation.ts (init-created)`);
        } else {
          const cleaned = removeRegisterGlasstrace(content);
          if (cleaned !== content) {
            if (!dryRun) {
              fs.writeFileSync(instrPath, cleaned, "utf-8");
            }
            summary.push(
              `${prefix}Removed registerGlasstrace() from instrumentation.ts`,
            );
          }
        }
      }
    }
  } catch (err) {
    errors.push(
      `Failed to process instrumentation.ts: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Step 3: Remove .glasstrace/ directory
  try {
    const glasstraceDir = path.join(projectRoot, ".glasstrace");
    if (fs.existsSync(glasstraceDir)) {
      if (!dryRun) {
        fs.rmSync(glasstraceDir, { recursive: true, force: true });
      }
      summary.push(`${prefix}Removed .glasstrace/ directory`);
    }
  } catch (err) {
    errors.push(
      `Failed to remove .glasstrace/: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Step 4: Remove GLASSTRACE entries from .env.local
  try {
    const envPath = path.join(projectRoot, ".env.local");
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      const lines = content.split("\n");
      const filtered = lines.filter((line) => {
        const trimmed = line.trim();
        // Match both commented and uncommented GLASSTRACE_ lines
        return !(
          /^\s*#?\s*GLASSTRACE_API_KEY\s*=/.test(trimmed) ||
          /^\s*#?\s*GLASSTRACE_COVERAGE_MAP\s*=/.test(trimmed)
        );
      });

      if (filtered.length !== lines.length) {
        const result = filtered.join("\n");
        // If the file is now empty (only newlines), don't write it
        if (result.trim().length === 0) {
          if (!dryRun) {
            fs.unlinkSync(envPath);
          }
          summary.push(`${prefix}Deleted .env.local (no remaining entries)`);
        } else {
          if (!dryRun) {
            fs.writeFileSync(envPath, result, "utf-8");
          }
          summary.push(`${prefix}Removed GLASSTRACE entries from .env.local`);
        }
      }
    }
  } catch (err) {
    errors.push(
      `Failed to process .env.local: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Step 5: Remove .glasstrace/ from .gitignore
  try {
    const gitignorePath = path.join(projectRoot, ".gitignore");
    if (fs.existsSync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath, "utf-8");
      const lines = content.split("\n");

      // Remove lines that are exactly ".glasstrace/" or MCP config file entries
      // added by init (e.g., ".mcp.json", ".cursor/mcp.json", ".gemini/settings.json",
      // ".codex/config.toml")
      const mcpGitignoreEntries = new Set([
        ".glasstrace/",
        ".mcp.json",
        ".cursor/mcp.json",
        ".gemini/settings.json",
        ".codex/config.toml",
      ]);

      const filtered = lines.filter(
        (line) => !mcpGitignoreEntries.has(line.trim()),
      );

      if (filtered.length !== lines.length) {
        const result = filtered.join("\n");
        if (result.trim().length === 0) {
          if (!dryRun) {
            fs.unlinkSync(gitignorePath);
          }
          summary.push(`${prefix}Deleted .gitignore (no remaining entries)`);
        } else {
          if (!dryRun) {
            fs.writeFileSync(gitignorePath, result, "utf-8");
          }
          summary.push(`${prefix}Removed Glasstrace entries from .gitignore`);
        }
      }
    }
  } catch (err) {
    errors.push(
      `Failed to process .gitignore: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Step 6: Remove MCP config entries
  try {
    for (const configFile of MCP_CONFIG_FILES) {
      const configPath = path.join(projectRoot, configFile);
      if (!fs.existsSync(configPath)) {
        continue;
      }

      const content = fs.readFileSync(configPath, "utf-8");
      const result = processJsonMcpConfig(content);

      if (result.action === "deleted") {
        if (!dryRun) {
          fs.unlinkSync(configPath);
        }
        summary.push(`${prefix}Deleted ${configFile}`);
      } else if (result.action === "removed-key" && result.content !== undefined) {
        if (!dryRun) {
          fs.writeFileSync(configPath, result.content, "utf-8");
        }
        summary.push(`${prefix}Removed glasstrace from ${configFile}`);
      }
    }
    // Handle Codex TOML config separately
    const codexConfigPath = path.join(projectRoot, ".codex", "config.toml");
    if (fs.existsSync(codexConfigPath)) {
      const content = fs.readFileSync(codexConfigPath, "utf-8");
      const tomlResult = processTomlMcpConfig(content);

      if (tomlResult.action === "deleted") {
        if (!dryRun) {
          fs.unlinkSync(codexConfigPath);
        }
        summary.push(`${prefix}Deleted .codex/config.toml`);
      } else if (tomlResult.action === "removed-section" && tomlResult.content !== undefined) {
        if (!dryRun) {
          fs.writeFileSync(codexConfigPath, tomlResult.content, "utf-8");
        }
        summary.push(`${prefix}Removed glasstrace from .codex/config.toml`);
      }
    }

    // Handle Windsurf global config at ~/.codeium/windsurf/mcp_config.json
    // Only process if the project has Windsurf markers, to avoid touching
    // global config for non-Windsurf projects
    const hasWindsurfMarkers =
      fs.existsSync(path.join(projectRoot, ".windsurfrules")) ||
      fs.existsSync(path.join(projectRoot, ".windsurf"));
    if (hasWindsurfMarkers) {
      const windsurfConfigPath = path.join(
        os.homedir(),
        ".codeium",
        "windsurf",
        "mcp_config.json",
      );
      if (fs.existsSync(windsurfConfigPath)) {
        const content = fs.readFileSync(windsurfConfigPath, "utf-8");
        const windsurfResult = processJsonMcpConfig(content);

        if (windsurfResult.action === "deleted") {
          if (!dryRun) {
            fs.unlinkSync(windsurfConfigPath);
          }
          summary.push(`${prefix}Deleted Windsurf MCP config`);
        } else if (
          windsurfResult.action === "removed-key" &&
          windsurfResult.content !== undefined
        ) {
          if (!dryRun) {
            fs.writeFileSync(windsurfConfigPath, windsurfResult.content, "utf-8");
          }
          summary.push(`${prefix}Removed glasstrace from Windsurf MCP config`);
        }
      }
    }
  } catch (err) {
    errors.push(
      `Failed to process MCP config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Step 7: Remove info sections from agent files
  try {
    for (const infoFile of AGENT_INFO_FILES) {
      const filePath = path.join(projectRoot, infoFile);
      if (!fs.existsSync(filePath)) {
        continue;
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const result = removeMarkerSection(content);

      if (result.removed) {
        if (result.content.trim().length === 0) {
          // File is now empty after removing the marker section —
          // only delete if the file was solely glasstrace content
          if (!dryRun) {
            fs.unlinkSync(filePath);
          }
          summary.push(`${prefix}Deleted ${infoFile} (only contained Glasstrace section)`);
        } else {
          if (!dryRun) {
            fs.writeFileSync(filePath, result.content, "utf-8");
          }
          summary.push(`${prefix}Removed Glasstrace section from ${infoFile}`);
        }
      }
    }
  } catch (err) {
    errors.push(
      `Failed to process agent info files: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (summary.length === 0 && errors.length === 0) {
    summary.push("No Glasstrace artifacts found — nothing to do.");
  }

  return { exitCode: errors.length > 0 ? 1 : 0, summary, warnings, errors };
}
