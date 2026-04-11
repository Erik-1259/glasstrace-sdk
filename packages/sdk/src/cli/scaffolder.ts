import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { NEXT_CONFIG_NAMES } from "./constants.js";

/**
 * Computes a stable identity fingerprint for deduplication purposes.
 * This is NOT password hashing — the input is an opaque token used
 * as a marker identity, not a credential stored for authentication.
 *
 * @internal Exported for unit testing only.
 */
export function identityFingerprint(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

/**
 * Checks whether `content` contains a real (non-commented) `registerGlasstrace()` call.
 *
 * Strips single-line `// ...` comments before matching so that
 * `// registerGlasstrace()` is not treated as a real invocation.
 * Block comments are not stripped — block-commenting a function call
 * while keeping it syntactically valid is extremely unlikely in practice.
 *
 * @internal Exported for unit testing only.
 */
export function hasRegisterGlasstraceCall(content: string): boolean {
  return content.split("\n").some((line) => {
    const uncommented = line.replace(/\/\/.*$/, "");
    return /\bregisterGlasstrace\s*\(/.test(uncommented);
  });
}

/** Result of attempting to inject registerGlasstrace into an existing file. */
export interface InjectResult {
  content: string;
  injected: boolean;
}

/** Result of the instrumentation.ts scaffolding step. */
export type InstrumentationAction = "created" | "injected" | "already-registered" | "unrecognized";

/** Structured result from scaffoldInstrumentation. */
export interface ScaffoldInstrumentationResult {
  action: InstrumentationAction;
}

/** Result of attempting to wrap next.config with withGlasstraceConfig. */
export interface ScaffoldNextConfigResult {
  modified: boolean;
  reason?: "already-wrapped" | "empty-file" | "no-export";
}

/**
 * Injects `registerGlasstrace()` into an existing instrumentation.ts file.
 *
 * Strategy:
 * 1. If the file already contains a real `registerGlasstrace()` call — no-op
 *    (commented-out calls are ignored)
 * 2. Find `export [async] function register()` pattern
 * 3. Add `import { registerGlasstrace } from "@glasstrace/sdk"` at top
 *    (or extend existing `@glasstrace/sdk` import, skipping if already imported)
 * 4. Insert `registerGlasstrace()` as the first statement in the function body
 *
 * @param content - The existing file content
 * @returns The modified content if injection succeeded, or the original content
 *   with `injected: false` if the pattern was not recognized
 */
export function injectRegisterGlasstrace(content: string): InjectResult {
  // Already has a registerGlasstrace() call — no-op.
  // Uses a helper that strips single-line comments before matching
  // so that `// registerGlasstrace()` is not treated as a real call.
  if (hasRegisterGlasstraceCall(content)) {
    return { injected: false, content };
  }

  // Find the register() function: export [async] function register(...) {
  const registerFnRegex = /export\s+(?:async\s+)?function\s+register\s*\([^)]*\)\s*\{/;
  const match = registerFnRegex.exec(content);

  if (!match) {
    return { injected: false, content };
  }

  // Determine indentation from the function body by looking at the first
  // indented line after the opening brace. Only capture spaces and tabs
  // (not newlines) to avoid blank lines corrupting the detected indent.
  // Default to 2-space indent (matches the scaffolded template).
  const afterBrace = content.slice(match.index + match[0].length);
  const indentMatch = /\n([ \t]+)/.exec(afterBrace);
  const indent = indentMatch ? indentMatch[1] : "  ";

  // Build the import line
  const importLine = 'import { registerGlasstrace } from "@glasstrace/sdk";\n';

  // Check if the file already imports from @glasstrace/sdk
  const hasGlasstraceImport = content.includes("@glasstrace/sdk");

  // Insert registerGlasstrace() as the first statement in the function body
  const insertPoint = match.index + match[0].length;
  const callInjection = `\n${indent}// Glasstrace must be registered before other instrumentation\n${indent}registerGlasstrace();\n`;

  let modified: string;
  if (hasGlasstraceImport) {
    // File already imports from @glasstrace/sdk — check whether registerGlasstrace
    // is already among the specifiers to avoid producing a duplicate like
    // `import { registerGlasstrace, registerGlasstrace }`.
    const importRegex = /import\s*\{([^}]+)\}\s*from\s*["']@glasstrace\/sdk["']/;
    const importMatch = importRegex.exec(content);
    if (importMatch) {
      const specifiers = importMatch[1];
      const alreadyImported = specifiers
        .split(",")
        .some((s) => s.trim() === "registerGlasstrace");

      if (alreadyImported) {
        // Import already has registerGlasstrace — only inject the call
        modified = content.slice(0, insertPoint) + callInjection + content.slice(insertPoint);
      } else {
        // Add registerGlasstrace to existing import specifiers
        const existingImports = specifiers.trimEnd();
        const separator = existingImports.endsWith(",") ? " " : ", ";
        const updatedImport = `import { ${existingImports.trim()}${separator}registerGlasstrace } from "@glasstrace/sdk"`;
        modified = content.replace(importMatch[0], updatedImport);
        // Re-find the function in the shifted content and inject the call
        const newMatch = registerFnRegex.exec(modified);
        if (newMatch) {
          const newInsertPoint = newMatch.index + newMatch[0].length;
          modified = modified.slice(0, newInsertPoint) + callInjection + modified.slice(newInsertPoint);
        }
      }
    } else {
      // Non-destructured import (e.g., import * as sdk) — add a separate import
      modified = importLine + content;
      // Re-find the function in the shifted content and inject the call
      const newMatch = registerFnRegex.exec(modified);
      if (newMatch) {
        const newInsertPoint = newMatch.index + newMatch[0].length;
        modified = modified.slice(0, newInsertPoint) + callInjection + modified.slice(newInsertPoint);
      }
    }
  } else {
    // Add import at the top of the file and the call in the function body
    modified = importLine + content.slice(0, insertPoint) + callInjection + content.slice(insertPoint);
  }

  return { injected: true, content: modified };
}

/**
 * Ensures `instrumentation.ts` exists and contains a `registerGlasstrace()` call.
 *
 * - If the file does not exist, creates it with the standard template.
 * - If the file exists and already contains `registerGlasstrace`, skips it.
 * - If the file exists without `registerGlasstrace`, attempts to inject the
 *   call into the existing `register()` function.
 * - If injection fails (no recognizable `register()` function), returns
 *   `"unrecognized"` so the caller can display manual instructions.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @returns A structured result describing what action was taken.
 */
export async function scaffoldInstrumentation(
  projectRoot: string,
): Promise<ScaffoldInstrumentationResult> {
  const filePath = path.join(projectRoot, "instrumentation.ts");

  if (!fs.existsSync(filePath)) {
    const content = `import { registerGlasstrace } from "@glasstrace/sdk";

export async function register() {
  // Glasstrace must be registered before Prisma instrumentation
  // to ensure all ORM spans are captured correctly.
  // If you use @prisma/instrumentation, import it after this call.
  registerGlasstrace();
}
`;
    fs.writeFileSync(filePath, content, "utf-8");
    return { action: "created" };
  }

  // File exists — check whether registerGlasstrace() is already called.
  // Uses a helper that strips single-line comments before matching
  // so that `// registerGlasstrace()` is not treated as a real call.
  const existing = fs.readFileSync(filePath, "utf-8");

  if (hasRegisterGlasstraceCall(existing)) {
    return { action: "already-registered" };
  }

  // Attempt injection into the existing file
  const result = injectRegisterGlasstrace(existing);

  if (result.injected) {
    fs.writeFileSync(filePath, result.content, "utf-8");
    return { action: "injected" };
  }

  return { action: "unrecognized" };
}

/**
 * Detects `next.config.js`, `next.config.ts`, or `next.config.mjs` and wraps
 * with `withGlasstraceConfig()`. If the config already contains
 * `withGlasstraceConfig`, the file is not modified.
 *
 * For CJS `.js` configs, adds a `require()` call and wraps `module.exports`.
 * The SDK ships dual ESM/CJS builds via tsup + conditional exports, so
 * `require("@glasstrace/sdk")` resolves to the CJS entrypoint natively.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @returns A result object describing what happened, or `null` if no config
 *   file was found at all.
 */
export async function scaffoldNextConfig(
  projectRoot: string,
): Promise<ScaffoldNextConfigResult | null> {
  let configPath: string | undefined;
  let configName: string | undefined;

  for (const name of NEXT_CONFIG_NAMES) {
    const candidate = path.join(projectRoot, name);
    if (fs.existsSync(candidate)) {
      configPath = candidate;
      configName = name;
      break;
    }
  }

  if (configPath === undefined || configName === undefined) {
    return null;
  }

  const existing = fs.readFileSync(configPath, "utf-8");

  // Guard: empty or whitespace-only files have no export to wrap
  if (existing.trim().length === 0) {
    return { modified: false, reason: "empty-file" };
  }

  // Already wrapped — skip even in force mode to avoid double-wrapping
  if (existing.includes("withGlasstraceConfig")) {
    return { modified: false, reason: "already-wrapped" };
  }

  const isESM = configName.endsWith(".ts") || configName.endsWith(".mjs");

  if (isESM) {
    // ESM: static import at top of file, wrap the export
    const importLine = 'import { withGlasstraceConfig } from "@glasstrace/sdk";\n';
    const wrapResult = wrapExport(existing);
    if (!wrapResult.wrapped) {
      return { modified: false, reason: "no-export" };
    }
    const modified = importLine + "\n" + wrapResult.content;
    fs.writeFileSync(configPath, modified, "utf-8");
    return { modified: true };
  }

  // CJS (.js): require() the SDK (resolves to the CJS dist build) and
  // wrap the module.exports expression in place — no file renaming needed.
  const requireLine = 'const { withGlasstraceConfig } = require("@glasstrace/sdk");\n';
  const wrapResult = wrapCJSExport(existing);
  if (!wrapResult.wrapped) {
    return { modified: false, reason: "no-export" };
  }
  const modified = requireLine + "\n" + wrapResult.content;
  fs.writeFileSync(configPath, modified, "utf-8");
  return { modified: true };
}

/** @internal Exported for unit testing only. */
export interface WrapResult {
  content: string;
  wrapped: boolean;
}

/**
 * Wraps an ESM `export default` expression with `withGlasstraceConfig()`.
 *
 * Strategy: find the last `export default` in the file. Everything from
 * that statement to EOF is the exported expression. Strip optional trailing
 * semicolons/whitespace and wrap with `withGlasstraceConfig(...)`.
 *
 * @param content - The full file content containing an ESM default export.
 * @returns `{ wrapped: true, content }` on success, or `{ wrapped: false }` if
 *   no recognizable export pattern was found (content returned unchanged).
 * @internal Exported for unit testing only.
 */
export function wrapExport(content: string): WrapResult {
  // Find the last `export default` — use lastIndexOf for robustness
  const marker = "export default";
  const idx = content.lastIndexOf(marker);
  if (idx === -1) {
    return { content, wrapped: false };
  }

  const preamble = content.slice(0, idx);
  const exprRaw = content.slice(idx + marker.length);
  // Trim leading whitespace; strip trailing semicolon + whitespace
  const expr = exprRaw.trim().replace(/;?\s*$/, "");
  if (expr.length === 0) {
    return { content, wrapped: false };
  }

  return {
    content: preamble + `export default withGlasstraceConfig(${expr});\n`,
    wrapped: true,
  };
}

/**
 * Wraps a CJS `module.exports = expr` with `withGlasstraceConfig()`.
 *
 * Strategy: find the last `module.exports =` in the file. Everything from
 * that statement to EOF is the exported expression. Strip optional trailing
 * semicolons/whitespace and wrap with `module.exports = withGlasstraceConfig(...)`.
 *
 * @param content - The full CJS file content containing `module.exports = ...`.
 * @returns `{ wrapped: true, content }` on success, or `{ wrapped: false }` if
 *   no recognizable `module.exports` pattern was found (content returned unchanged).
 * @internal Exported for unit testing only.
 */
export function wrapCJSExport(content: string): WrapResult {
  const cjsMarker = "module.exports";
  const cjsIdx = content.lastIndexOf(cjsMarker);
  if (cjsIdx === -1) {
    return { content, wrapped: false };
  }

  const preamble = content.slice(0, cjsIdx);
  const afterMarker = content.slice(cjsIdx + cjsMarker.length);
  const eqMatch = /^\s*=\s*/.exec(afterMarker);
  if (!eqMatch) {
    return { content, wrapped: false };
  }

  const exprRaw = afterMarker.slice(eqMatch[0].length);
  const expr = exprRaw.trim().replace(/;?\s*$/, "");
  if (expr.length === 0) {
    return { content, wrapped: false };
  }

  return {
    content: preamble + `module.exports = withGlasstraceConfig(${expr});\n`,
    wrapped: true,
  };
}

/**
 * Creates `.env.local` with `GLASSTRACE_API_KEY=` placeholder, or appends
 * to an existing file if it does not already contain `GLASSTRACE_API_KEY`.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @returns True if the file was created or modified, false if already configured.
 */
export async function scaffoldEnvLocal(projectRoot: string): Promise<boolean> {
  const filePath = path.join(projectRoot, ".env.local");

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf-8");
    if (/^\s*#?\s*GLASSTRACE_API_KEY\s*=/m.test(existing)) {
      return false;
    }
    // Append with a newline separator if needed
    const separator = existing.endsWith("\n") ? "" : "\n";
    fs.writeFileSync(filePath, existing + separator + "# GLASSTRACE_API_KEY=your_key_here\n", "utf-8");
    return true;
  }

  fs.writeFileSync(filePath, "# GLASSTRACE_API_KEY=your_key_here\n", "utf-8");
  return true;
}

/**
 * Adds `GLASSTRACE_COVERAGE_MAP=true` to `.env.local`.
 * Creates the file if it does not exist. If the key is already present
 * with a value other than `true`, it is updated in place.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @returns True if the file was created or modified, false if already set to `true`.
 */
export async function addCoverageMapEnv(projectRoot: string): Promise<boolean> {
  const filePath = path.join(projectRoot, ".env.local");

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "GLASSTRACE_COVERAGE_MAP=true\n", "utf-8");
    return true;
  }

  const existing = fs.readFileSync(filePath, "utf-8");
  const keyRegex = /^(\s*GLASSTRACE_COVERAGE_MAP\s*=\s*)(.*)$/m;
  const keyMatch = keyRegex.exec(existing);

  if (keyMatch) {
    const currentValue = keyMatch[2].trim();
    if (currentValue === "true") {
      // Already set to true — nothing to do
      return false;
    }
    // Key exists but is not `true` — update in place
    const updated = existing.replace(keyRegex, `${keyMatch[1]}true`);
    fs.writeFileSync(filePath, updated, "utf-8");
    return true;
  }

  const separator = existing.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(filePath, existing + separator + "GLASSTRACE_COVERAGE_MAP=true\n", "utf-8");
  return true;
}

/**
 * Adds `.glasstrace/` to `.gitignore`, or creates `.gitignore` if missing.
 * Does not add duplicate entries.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @returns True if the file was created or modified, false if already configured.
 */
export async function scaffoldGitignore(projectRoot: string): Promise<boolean> {
  const filePath = path.join(projectRoot, ".gitignore");

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf-8");
    // Check line-by-line to avoid false positive partial matches
    const lines = existing.split("\n").map((l) => l.trim());
    if (lines.includes(".glasstrace/")) {
      return false;
    }
    const separator = existing.endsWith("\n") ? "" : "\n";
    fs.writeFileSync(filePath, existing + separator + ".glasstrace/\n", "utf-8");
    return true;
  }

  fs.writeFileSync(filePath, ".glasstrace/\n", "utf-8");
  return true;
}

/**
 * Creates the `.glasstrace/mcp-connected` marker file, or overwrites it
 * if the key has changed (key rotation).
 *
 * The marker file records a SHA-256 fingerprint of the anonymous key and
 * the ISO 8601 timestamp when it was written. It is used by the nudge
 * system to suppress "MCP not configured" prompts.
 *
 * If the marker already exists with the same key fingerprint, this is a
 * no-op (the timestamp is NOT refreshed).
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param anonKey - The anonymous API key to fingerprint.
 * @returns True if the marker was created or updated, false if it already
 *   exists with the same key fingerprint.
 */
export async function scaffoldMcpMarker(
  projectRoot: string,
  anonKey: string,
): Promise<boolean> {
  const dirPath = path.join(projectRoot, ".glasstrace");
  const markerPath = path.join(dirPath, "mcp-connected");
  const keyHash = identityFingerprint(anonKey);

  // Check if marker already exists with the same key hash
  if (fs.existsSync(markerPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as {
        keyHash?: string;
      };
      if (existing.keyHash === keyHash) {
        return false;
      }
    } catch {
      // Corrupted marker — overwrite
    }
  }

  // Create directory with restricted permissions
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });

  const marker = JSON.stringify(
    { keyHash, configuredAt: new Date().toISOString() },
    null,
    2,
  );

  fs.writeFileSync(markerPath, marker, { mode: 0o600 });

  // Ensure permissions even if file pre-existed (writeFile mode only
  // applies on creation on some platforms)
  fs.chmodSync(markerPath, 0o600);

  return true;
}
