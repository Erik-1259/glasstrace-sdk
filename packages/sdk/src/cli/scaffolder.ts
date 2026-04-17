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
export type InstrumentationAction =
  | "created"
  | "injected"
  | "appended"
  | "already-registered"
  | "skipped"
  | "unrecognized"
  | "conflict";

/**
 * Layout detected by {@link resolveInstrumentationTarget}. `root` means
 * the project has no `src/` directory so instrumentation lives at the
 * project root; `src` means Next.js expects `src/instrumentation.ts`.
 */
export type InstrumentationLayout = "root" | "src";

/** Structured result from scaffoldInstrumentation. */
export interface ScaffoldInstrumentationResult {
  action: InstrumentationAction;
  /**
   * The instrumentation file path this scaffold step targeted. Absolute
   * path (e.g., `/abs/project/instrumentation.ts` or
   * `/abs/project/src/instrumentation.ts`). Present for every successful
   * action so callers (init.ts summary lines, rollback state) can report
   * and unwind without re-detecting the layout.
   *
   * For `"conflict"`, this is the recommended merge target — the `src/`
   * variant when both exist, because that's where Next.js loads from on
   * modern `src/`-layout projects. The competing path is available via
   * {@link ScaffoldInstrumentationResult.conflictingPath}.
   */
  filePath?: string;
  /** Layout the resolver chose. Always set for non-conflict actions. */
  layout?: InstrumentationLayout;
  /**
   * When `action === "conflict"`, the path of the other instrumentation
   * file whose presence Next.js treats as undefined. The recommended merge
   * target is {@link ScaffoldInstrumentationResult.filePath}.
   */
  conflictingPath?: string;
}

/** Options for {@link scaffoldInstrumentation}. */
export interface ScaffoldInstrumentationOptions {
  /**
   * When `true`, skip the merge-confirmation prompt and write changes
   * without asking. Matches the DISC-1247 Scenario 2c `--force` behavior
   * already used for MCP config overwrites. Defaults to `false`.
   */
  force?: boolean;
  /**
   * Interactive prompt callback. When omitted, `scaffoldInstrumentation`
   * uses a TTY readline prompt and defaults to `false` (skip the change)
   * in non-interactive shells — the same pattern `decideMcpConfigAction`
   * follows. Exposed for testing.
   */
  prompt?: (question: string, defaultValue: boolean) => Promise<boolean>;
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

/** Instrumentation filename variants Next.js recognizes, in priority order. */
const INSTRUMENTATION_FILENAMES = [
  "instrumentation.ts",
  "instrumentation.js",
  "instrumentation.mjs",
] as const;

/**
 * Result of {@link resolveInstrumentationTarget}. When the project has no
 * conflict, `target` identifies the file the scaffolder should create or
 * merge into. When both root and `src/` variants already exist, `target`
 * is `null` and both detected paths are returned so the caller can surface
 * a clear error — Next.js's loader behavior is undefined in that state
 * (DISC-493 Issue 1).
 */
export interface InstrumentationTarget {
  /** Absolute path of the chosen file, or null when a conflict exists. */
  target: string | null;
  /** Which layout was chosen. Null mirrors `target === null`. */
  layout: InstrumentationLayout | null;
  /**
   * Absolute paths of any existing instrumentation files detected. Includes
   * the chosen `target` when it exists, plus the competing file when there
   * is a conflict. Empty when the project has no instrumentation file yet.
   */
  existing: string[];
  /**
   * Absolute paths of root-level instrumentation files (e.g.,
   * `{projectRoot}/instrumentation.ts`). Tracked separately from `existing`
   * so callers can distinguish root from `src/` without string matching on
   * paths that may legitimately contain `src` elsewhere in their ancestry
   * (e.g., `/home/user/src/project/`).
   */
  rootExisting: string[];
  /**
   * Absolute paths of `src/`-level instrumentation files (e.g.,
   * `{projectRoot}/src/instrumentation.ts`). See `rootExisting` for the
   * rationale for tracking these separately.
   */
  srcExisting: string[];
  /**
   * When both a root and `src/` instrumentation file are present, Next.js's
   * behavior is not defined. The scaffolder refuses to create a third
   * competing file and asks the user to merge manually into the preferred
   * target (the `src/` variant when the project uses `src/` layout).
   */
  conflict: boolean;
}

/**
 * Detects whether the project uses Next.js's `src/` directory layout and
 * picks the instrumentation file path the scaffolder should create or
 * merge into.
 *
 * Selection rules (DISC-493 Issue 1):
 *
 * 1. Prefer an existing file. If `src/instrumentation.{ts,js,mjs}` exists,
 *    it wins; otherwise the root variant wins. This preserves user intent
 *    (they already chose a location) and matches what Next.js loads.
 * 2. When no instrumentation file exists yet, use `src/` when the project
 *    has a `src/` directory at its root — the common Next.js convention.
 * 3. When both a root and a `src/` instrumentation file exist, return
 *    `conflict: true`. Next.js's loader behavior is undefined in that
 *    state and scaffolding a third write would mask whichever file Next.js
 *    ultimately ignores.
 *
 * The resolver is pure: it reads the filesystem but writes nothing and
 * never throws. Callers can invoke it repeatedly (e.g., for validation).
 *
 * @param projectRoot - Absolute path to the project root directory.
 */
export function resolveInstrumentationTarget(
  projectRoot: string,
): InstrumentationTarget {
  const rootExisting: string[] = [];
  const srcExisting: string[] = [];

  for (const name of INSTRUMENTATION_FILENAMES) {
    const rootPath = path.join(projectRoot, name);
    if (isRegularFile(rootPath)) {
      rootExisting.push(rootPath);
    }
    const srcPath = path.join(projectRoot, "src", name);
    if (isRegularFile(srcPath)) {
      srcExisting.push(srcPath);
    }
  }

  const existing = [...rootExisting, ...srcExisting];

  // Conflict: a file from each layout exists. Next.js's behavior is
  // undefined (DISC-493 Issue 1). The caller surfaces an error.
  if (rootExisting.length > 0 && srcExisting.length > 0) {
    return {
      target: null,
      layout: null,
      existing,
      rootExisting,
      srcExisting,
      conflict: true,
    };
  }

  // Prefer whichever layout already has an instrumentation file — the
  // user has already committed to that location and Next.js loads from it.
  if (srcExisting.length > 0) {
    return {
      target: srcExisting[0],
      layout: "src",
      existing,
      rootExisting,
      srcExisting,
      conflict: false,
    };
  }
  if (rootExisting.length > 0) {
    return {
      target: rootExisting[0],
      layout: "root",
      existing,
      rootExisting,
      srcExisting,
      conflict: false,
    };
  }

  // No file exists yet — default to `src/` when a `src/` directory is
  // present. Many Next.js apps use this layout and the bug in
  // DISC-493 was scaffolding to the root when Next.js ignores it.
  const srcDir = path.join(projectRoot, "src");
  const layout: InstrumentationLayout = isDirectory(srcDir) ? "src" : "root";
  const target = layout === "src"
    ? path.join(projectRoot, "src", "instrumentation.ts")
    : path.join(projectRoot, "instrumentation.ts");

  return {
    target,
    layout,
    existing,
    rootExisting,
    srcExisting,
    conflict: false,
  };
}

/** Returns true when `p` is a directory. Never throws. */
function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Returns true when `p` is a regular file (not a directory, not missing).
 * Uses `lstatSync` so symlinks are evaluated as-is — a symlink to a file
 * counts, a symlink to a directory does not. Never throws.
 */
function isRegularFile(p: string): boolean {
  try {
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink()) {
      // Follow the symlink so we correctly classify links to real files.
      return fs.statSync(p).isFile();
    }
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Appends a new `export async function register()` to a file that has no
 * recognizable register function. Used when `src/instrumentation.ts`
 * exists (e.g., Sentry scaffolded it with only a top-level side-effect
 * import) but has no register hook yet.
 *
 * @internal Exported for unit testing only.
 */
export function appendRegisterFunction(content: string): string {
  const importLine = 'import { registerGlasstrace } from "@glasstrace/sdk";\n';
  const functionBlock =
    "\n" +
    "export async function register() {\n" +
    "  // Glasstrace must be registered before Prisma instrumentation\n" +
    "  // to ensure all ORM spans are captured correctly.\n" +
    "  // If you use @prisma/instrumentation, import it after this call.\n" +
    "  registerGlasstrace();\n" +
    "}\n";

  // Avoid a duplicate import if the file already pulls from @glasstrace/sdk.
  // When multiple specifiers are imported, splice registerGlasstrace in
  // rather than adding a second import line (mirrors injectRegisterGlasstrace).
  let withImport = content;
  const hasGlasstraceImport = content.includes("@glasstrace/sdk");
  if (!hasGlasstraceImport) {
    withImport = importLine + content;
  } else {
    const importRegex = /import\s*\{([^}]+)\}\s*from\s*["']@glasstrace\/sdk["']/;
    const importMatch = importRegex.exec(content);
    if (importMatch) {
      const specifiers = importMatch[1];
      const alreadyImported = specifiers
        .split(",")
        .some((s) => s.trim() === "registerGlasstrace");
      if (!alreadyImported) {
        const existingImports = specifiers.trimEnd();
        const separator = existingImports.endsWith(",") ? " " : ", ";
        const updatedImport = `import { ${existingImports.trim()}${separator}registerGlasstrace } from "@glasstrace/sdk"`;
        withImport = content.replace(importMatch[0], updatedImport);
      }
    } else {
      // Non-destructured `import * as sdk from "@glasstrace/sdk"` form —
      // add a separate destructured import for registerGlasstrace so we
      // never depend on reading the namespace alias.
      withImport = importLine + content;
    }
  }

  // Ensure the file ends with a single newline before appending.
  const trailingNewline = withImport.endsWith("\n") ? "" : "\n";
  return withImport + trailingNewline + functionBlock;
}

/**
 * Default `confirm`-style prompt used when `scaffoldInstrumentation` is
 * called without a `prompt` callback. Mirrors `init.ts#promptYesNo`:
 * returns the default value when stdin is not a TTY so non-interactive
 * shells do not hang.
 */
async function defaultInstrumentationPrompt(
  question: string,
  defaultValue: boolean,
): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultValue;
  const readline = await import("node:readline");
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
 * Ensures an instrumentation file exists and contains a `registerGlasstrace()`
 * call, merging into the user's existing file rather than overwriting it.
 *
 * Behavior (DISC-493 Issue 1):
 *
 * - Detects `src/`-layout projects via {@link resolveInstrumentationTarget}
 *   and targets `src/instrumentation.ts` instead of the root when a `src/`
 *   directory is present.
 * - When both `instrumentation.ts` and `src/instrumentation.ts` already
 *   exist, returns `action: "conflict"` so the caller can emit a clear
 *   error. Next.js's loader behavior is undefined in that state and
 *   writing a third file would silently mask the one Next.js ignores.
 * - When the target does not exist, creates it with the standard template.
 * - When the target exists but has no `registerGlasstrace()` call:
 *   - If it exposes an `export function register()`, injects the call as
 *     the first statement (and imports `registerGlasstrace` if needed).
 *   - If it has no register function, appends a new `export async function
 *     register()` that calls `registerGlasstrace()` — this matches the
 *     Sentry / Datadog / custom-instrumentation case where `register()`
 *     hasn't been created yet.
 *   - Before either mutation, prompts the user unless `force: true` is
 *     passed (DISC-1247 Scenario 2c re-init safety).
 * - When the target already contains `registerGlasstrace()`, returns
 *   `action: "already-registered"` (idempotent).
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param options - Prompt and force flags for merge-safe re-init.
 */
export async function scaffoldInstrumentation(
  projectRoot: string,
  options: ScaffoldInstrumentationOptions = {},
): Promise<ScaffoldInstrumentationResult> {
  const target = resolveInstrumentationTarget(projectRoot);

  if (target.conflict) {
    return {
      action: "conflict",
      // Point the user at the `src/` variant — modern Next.js apps with a
      // `src/` directory load from there, so that's the merge target. The
      // competing path is reported separately for the error message.
      filePath: target.srcExisting[0],
      conflictingPath: target.rootExisting[0],
    };
  }

  const filePath = target.target;
  const layout = target.layout;
  // Defensive: resolver always sets these in the non-conflict path.
  if (filePath === null || layout === null) {
    return { action: "unrecognized" };
  }

  const force = options.force === true;
  const prompt = options.prompt ?? defaultInstrumentationPrompt;

  if (!fs.existsSync(filePath)) {
    const content = `import { registerGlasstrace } from "@glasstrace/sdk";

export async function register() {
  // Glasstrace must be registered before Prisma instrumentation
  // to ensure all ORM spans are captured correctly.
  // If you use @prisma/instrumentation, import it after this call.
  registerGlasstrace();
}
`;
    // Ensure the target directory exists (e.g., `src/` when the project
    // has the `src/` layout but no src/ folder somehow — defensive).
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
    return { action: "created", filePath, layout };
  }

  // File exists — check whether registerGlasstrace() is already called.
  // Uses a helper that strips single-line comments before matching
  // so that `// registerGlasstrace()` is not treated as a real call.
  const existing = fs.readFileSync(filePath, "utf-8");

  if (hasRegisterGlasstraceCall(existing)) {
    return { action: "already-registered", filePath, layout };
  }

  // The file is going to change. Before writing, confirm with the user
  // unless --force was passed — otherwise a second init on a custom
  // instrumentation file would silently rewrite it. Non-interactive
  // shells (no TTY) skip the merge by default; pass `force: true` to
  // proceed without prompting, which the CLI does for `--yes`/`--force`.
  if (!force) {
    const approved = await prompt(
      `Merge registerGlasstrace() into ${path.relative(projectRoot, filePath)}?`,
      false,
    );
    if (!approved) {
      return { action: "skipped", filePath, layout };
    }
  }

  // Attempt injection into the existing register() function first.
  const injectResult = injectRegisterGlasstrace(existing);
  if (injectResult.injected) {
    fs.writeFileSync(filePath, injectResult.content, "utf-8");
    return { action: "injected", filePath, layout };
  }

  // No register() function present — append a fresh one. This is the
  // Sentry/Datadog case where `src/instrumentation.ts` exists with only
  // a top-level import or empty body.
  const appended = appendRegisterFunction(existing);
  fs.writeFileSync(filePath, appended, "utf-8");
  return { action: "appended", filePath, layout };
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
 * Extracts the value of `GLASSTRACE_API_KEY` from a `.env.local`-style
 * string. Returns the raw (unquoted) value, or `null` if the key is
 * absent, commented out, or empty.
 *
 * Only uncommented assignments are considered — a `# GLASSTRACE_API_KEY=...`
 * placeholder is treated as if the key is not set.
 *
 * When multiple uncommented assignments are present, the **last**
 * effective value wins — matching typical `.env` override semantics
 * (later lines override earlier ones when loaded by dotenv-style
 * loaders). Placeholder values (empty or `your_key_here`) are skipped
 * so a trailing placeholder does not mask a real earlier value.
 *
 * @internal Exported for unit testing only.
 */
export function readEnvLocalApiKey(content: string): string | null {
  let last: string | null = null;
  const regex = /^\s*GLASSTRACE_API_KEY\s*=\s*(.*)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const raw = match[1].trim();
    if (raw === "") continue;
    const unquoted = raw.replace(/^(['"])(.*)\1$/, "$2");
    if (unquoted === "" || unquoted === "your_key_here") continue;
    last = unquoted;
  }
  return last;
}

/**
 * Returns true when the given API key value is a claimed developer key
 * (prefix `gt_dev_`). Defensive against leading/trailing whitespace.
 *
 * @internal Exported for unit testing only.
 */
export function isDevApiKey(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  return value.trim().startsWith("gt_dev_");
}

/**
 * Creates `.env.local` with `GLASSTRACE_API_KEY=` placeholder, or appends
 * to an existing file if it does not already contain `GLASSTRACE_API_KEY`.
 *
 * Preservation behavior (DISC-1247 Scenario 6): if an existing `.env.local`
 * already defines a developer key (`gt_dev_*`), the file is left untouched
 * so re-running `init` after an account claim does not overwrite the
 * claimed dev key.
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
 * Compares an existing MCP config file against the content init would
 * write. Returns `true` when they are semantically equal (JSON configs
 * are parsed and compared deeply; TOML configs use trimmed string
 * comparison). Returns `false` on parse errors or mismatch.
 *
 * Used by `init` to detect manually-edited MCP configs before
 * overwriting them (DISC-1247 Scenario 2c).
 *
 * @internal Exported for unit testing only.
 */
export function mcpConfigMatches(
  existingContent: string,
  expectedContent: string,
): boolean {
  const trimmedExpected = expectedContent.trim();

  // Attempt JSON comparison first — init writes JSON for most agents.
  try {
    const existingParsed: unknown = JSON.parse(existingContent);
    const expectedParsed: unknown = JSON.parse(trimmedExpected);
    return JSON.stringify(canonicalize(existingParsed)) === JSON.stringify(canonicalize(expectedParsed));
  } catch {
    // Fall through to text comparison for TOML and other non-JSON formats.
  }

  return existingContent.trim() === trimmedExpected;
}

/**
 * Sorts object keys recursively to produce a canonical form suitable
 * for structural equality comparison via JSON.stringify.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = canonicalize(obj[key]);
    }
    return sorted;
  }
  return value;
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
