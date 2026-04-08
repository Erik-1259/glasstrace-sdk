import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { createBuildHash, type ImportGraphPayload } from "@glasstrace/protocol";

/** Maximum number of test files to process to prevent runaway in large projects */
const MAX_TEST_FILES = 5000;

/** Directories to exclude from test file discovery */
const EXCLUDED_DIRS = new Set(["node_modules", ".next", ".git", "dist", ".turbo"]);

/** Conventional test file patterns */
const DEFAULT_TEST_PATTERNS = [
  /\.test\.tsx?$/,
  /\.spec\.tsx?$/,
];

/**
 * Converts a glob pattern (e.g. "e2e/**\/*.ts") to an anchored RegExp.
 * Uses a placeholder to avoid `*` replacement corrupting the `**\/` output.
 *
 * @param glob - A file glob pattern such as "src/**\/*.test.ts".
 * @returns A RegExp that matches paths against the glob from start to end.
 */
function globToRegExp(glob: string): RegExp {
  const DOUBLE_STAR_PLACEHOLDER = "\0DSTAR\0";
  const regexStr = glob
    .replace(/\*\*\//g, DOUBLE_STAR_PLACEHOLDER) // protect **/ first
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&") // escape all regex metacharacters (except *)
    .replace(/\*/g, "[^/]+")
    .replace(new RegExp(DOUBLE_STAR_PLACEHOLDER.replace(/\0/g, "\\0"), "g"), "(?:.+/)?");
  return new RegExp("^" + regexStr + "$");
}

/**
 * Attempts to read include patterns from vitest.config.*, vite.config.*,
 * or jest.config.* files. Returns additional RegExp patterns extracted
 * from the config, or an empty array if no config is found or parsing fails.
 * This is best-effort — it reads the config as text and extracts patterns
 * via regex, without evaluating the JS.
 *
 * For Vitest/Vite configs, looks for `test.include` arrays.
 * For Jest configs, looks for `testMatch` arrays.
 * Does not support `testRegex` (string-based Jest pattern) — that is
 * left as future work.
 */
function loadCustomTestPatterns(projectRoot: string): RegExp[] {
  const configNames = [
    "vitest.config.ts",
    "vitest.config.js",
    "vitest.config.mts",
    "vitest.config.mjs",
    "vite.config.ts",
    "vite.config.js",
    "vite.config.mts",
    "vite.config.mjs",
    "jest.config.ts",
    "jest.config.js",
    "jest.config.mts",
    "jest.config.mjs",
  ];

  for (const name of configNames) {
    const configPath = path.join(projectRoot, name);
    let content: string;
    try {
      content = fsSync.readFileSync(configPath, "utf-8");
    } catch {
      // Config file does not exist at this path — try next candidate
      continue;
    }

    try {
      const isJest = name.startsWith("jest.");
      let includeMatch: RegExpExecArray | null = null;

      if (isJest) {
        // Jest: look for testMatch: [...]
        includeMatch = /testMatch\s*:\s*\[([^\]]*)\]/s.exec(content);
      } else {
        // Vitest/Vite: look for `test` block's `include` to avoid
        // matching `coverage.include` or other unrelated arrays.
        // Strategy: find `test` property, then look for `include` within
        // the next ~500 chars (heuristic to stay within the test block).
        const testBlockMatch = /\btest\s*[:{]\s*/s.exec(content);
        if (testBlockMatch) {
          const afterTest = content.slice(testBlockMatch.index, testBlockMatch.index + 500);
          includeMatch = /include\s*:\s*\[([^\]]*)\]/s.exec(afterTest);
        }
      }

      if (!includeMatch) {
        continue;
      }

      const arrayContent = includeMatch[1];
      const stringRegex = /['"]([^'"]+)['"]/g;
      const patterns: RegExp[] = [];
      let match: RegExpExecArray | null;
      match = stringRegex.exec(arrayContent);
      while (match !== null) {
        patterns.push(globToRegExp(match[1]));
        match = stringRegex.exec(arrayContent);
      }

      if (patterns.length > 0) {
        return patterns;
      }
    } catch {
      // Regex-based config parsing failed — fall through to next config file
      continue;
    }
  }

  return [];
}

/**
 * Discovers test files by scanning the project directory for conventional
 * test file patterns. Also reads vitest/jest config files for custom include
 * patterns and merges them with the defaults. Excludes node_modules/ and .next/.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @returns Relative POSIX paths from projectRoot, capped at {@link MAX_TEST_FILES}.
 */
export async function discoverTestFiles(
  projectRoot: string,
): Promise<string[]> {
  const customPatterns = loadCustomTestPatterns(projectRoot);
  const testPatterns = [...DEFAULT_TEST_PATTERNS, ...customPatterns];
  const results: string[] = [];

  try {
    await walkForTests(projectRoot, projectRoot, results, testPatterns);
  } catch {
    // Project root directory does not exist or is unreadable — return empty
    return [];
  }

  return results.slice(0, MAX_TEST_FILES);
}

/** Recursively walks directories, collecting test file paths into `results`. */
async function walkForTests(
  baseDir: string,
  currentDir: string,
  results: string[],
  testPatterns: RegExp[],
): Promise<void> {
  if (results.length >= MAX_TEST_FILES) {
    return;
  }

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    // Directory is unreadable (permissions, broken symlink) — skip subtree
    return;
  }

  for (const entry of entries) {
    if (results.length >= MAX_TEST_FILES) {
      return;
    }

    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }
      await walkForTests(baseDir, fullPath, results, testPatterns);
    } else if (entry.isFile()) {
      const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, "/");

      // Check if it matches test patterns or is in __tests__
      const isTestFile =
        testPatterns.some((p) => p.test(entry.name) || p.test(relativePath)) ||
        relativePath.includes("__tests__");

      if (isTestFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
        results.push(relativePath);
      }
    }
  }
}

/**
 * Extracts import paths from file content using regex.
 * Handles ES module imports, CommonJS requires, and dynamic imports.
 *
 * @param fileContent - The full text content of a TypeScript/JavaScript file.
 * @returns An array of import path strings as written in the source (e.g. "./foo", "react").
 */
export function extractImports(fileContent: string): string[] {
  const seen = new Set<string>();
  const imports: string[] = [];

  /** Adds a path to the result if not already present. */
  const addUnique = (importPath: string): void => {
    if (!seen.has(importPath)) {
      seen.add(importPath);
      imports.push(importPath);
    }
  };

  // ES module imports — split into two simple patterns to avoid
  // catastrophic backtracking (CodeQL ReDoS). The original single regex
  // used [\w*{}\s,]+ which overlapped with the surrounding \s+, causing
  // polynomial backtracking. These replacements use [^'"]+ which has
  // only one quantifier before the anchor, ensuring linear-time matching.
  // The [^'"]+ class supports multiline destructured imports (e.g.,
  // import {\n  foo,\n  bar\n} from 'path') since it does not exclude \n.
  //
  // 1. Named/default/namespace: import { x } from 'path'
  const esFromImportRegex = /\bimport\b[^'"]+\bfrom\s+['"]([^'"]+)['"]/g;
  // 2. Side-effect: import 'path'
  const esSideEffectRegex = /\bimport\s+['"]([^'"]+)['"]/g;

  let match: RegExpExecArray | null;

  match = esFromImportRegex.exec(fileContent);
  while (match !== null) {
    addUnique(match[1]);
    match = esFromImportRegex.exec(fileContent);
  }

  match = esSideEffectRegex.exec(fileContent);
  while (match !== null) {
    addUnique(match[1]);
    match = esSideEffectRegex.exec(fileContent);
  }

  // CommonJS: require('path')
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  match = requireRegex.exec(fileContent);
  while (match !== null) {
    addUnique(match[1]);
    match = requireRegex.exec(fileContent);
  }

  // Dynamic import: import('path')
  const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  match = dynamicImportRegex.exec(fileContent);
  while (match !== null) {
    addUnique(match[1]);
    match = dynamicImportRegex.exec(fileContent);
  }

  return imports;
}

/**
 * Builds an import graph mapping test file paths to their imported module paths.
 *
 * Discovers test files, reads each, extracts imports, and builds a graph.
 * Computes a deterministic buildHash from the serialized graph content.
 * Individual file read failures are silently skipped.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @returns An {@link ImportGraphPayload} containing the graph and a deterministic buildHash.
 */
export async function buildImportGraph(
  projectRoot: string,
): Promise<ImportGraphPayload> {
  const testFiles = await discoverTestFiles(projectRoot);
  const graph: Record<string, string[]> = {};

  for (const testFile of testFiles) {
    const fullPath = path.join(projectRoot, testFile);
    try {
      const content = await fs.readFile(fullPath, "utf-8");
      const imports = extractImports(content);
      graph[testFile] = imports;
    } catch {
      // File is unreadable (permissions, deleted between discovery and read) — skip
      continue;
    }
  }

  // Compute deterministic build hash from graph content
  const sortedKeys = Object.keys(graph).sort();
  const serialized = sortedKeys
    .map((key) => `${key}:${JSON.stringify(graph[key])}`)
    .join("\n");
  const hashHex = crypto
    .createHash("sha256")
    .update(serialized)
    .digest("hex");
  const buildHash = createBuildHash(hashHex);

  return { buildHash, graph };
}
