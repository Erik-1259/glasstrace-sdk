import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Static import-graph guard.
 *
 * The runtime path of the SDK loads into user processes at app boot.
 * It must not pull `cli/*` (CLI scaffolding, agent registration) or
 * `agent-detection/*` (filesystem scanners) into the runtime bundle —
 * those modules add cold-start cost and surface area for a code path
 * that only matters at the moment of an account claim.
 *
 * This test parses the static and dynamic imports of `init-client.ts`
 * and `mcp-runtime.ts` (and everything they transitively import inside
 * `packages/sdk/src/`) and asserts the closure does not intersect the
 * forbidden directories.
 *
 * Self-verifying: the test ships with a fixture that deliberately
 * imports `agent-detection/`. The walker is run against the fixture,
 * and the test asserts the violation IS detected. If the fixture
 * check is silent the production assertion is presumed broken and the
 * whole test fails.
 */

const SRC_DIR = path.resolve(__dirname, "../../../packages/sdk/src");

const STATIC_IMPORT_RE = /^\s*import\s+(?:[^'";]+\s+from\s+)?["']([^"']+)["']/gm;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']/g;
// Covers `export { a, b } from "..."`, `export type { ... } from "..."`,
// `export * from "..."`, and `export * as ns from "..."`.
const RE_EXPORT_RE =
  /^\s*export\s+(?:type\s+)?(?:\{[^}]+\}|\*(?:\s+as\s+\w+)?)\s+from\s+["']([^"']+)["']/gm;

// Patterns are POSIX-form. Resolved file paths are normalised to POSIX
// before being matched (Windows paths use `\\` natively). Without the
// normalisation, the guard would silently miss violations on Windows.
const FORBIDDEN_PATTERNS: ReadonlyArray<RegExp> = [
  /\/agent-detection(\/|$)/,
  /\/cli(\/|$)/,
];

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function resolveImport(specifier: string, fromFile: string): string | null {
  // Skip external packages, scoped packages, and node built-ins.
  if (!specifier.startsWith(".")) return null;

  const fromDir = path.dirname(fromFile);
  // Drop `.js` suffix (TS-style import path) and try `.ts`, then `.tsx`,
  // then index variants. We never traverse into `node_modules/`.
  const base = path.resolve(fromDir, specifier).replace(/\.js$/, "");
  const candidates = [
    base + ".ts",
    base + ".tsx",
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function collectImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  for (const re of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE, RE_EXPORT_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

interface ClosureResult {
  files: Set<string>;
  violations: Array<{ from: string; to: string }>;
}

function buildImportClosure(entryFiles: string[]): ClosureResult {
  const visited = new Set<string>();
  const violations: ClosureResult["violations"] = [];
  const queue = [...entryFiles];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    let content: string;
    try {
      content = fs.readFileSync(current, "utf-8");
    } catch {
      continue;
    }

    for (const specifier of collectImportSpecifiers(content)) {
      const resolved = resolveImport(specifier, current);
      if (resolved === null) continue;

      // Only walk inside the SDK src tree; we don't care about other workspaces.
      if (!resolved.startsWith(SRC_DIR + path.sep)) continue;

      const resolvedPosix = toPosix(resolved);
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(resolvedPosix)) {
          violations.push({ from: current, to: resolved });
        }
      }

      if (!visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  return { files: visited, violations };
}

describe("runtime-bundle import-graph guard", () => {
  it("init-client.ts and mcp-runtime.ts do not transitively import cli/* or agent-detection/*", () => {
    const initClient = path.join(SRC_DIR, "init-client.ts");
    const mcpRuntime = path.join(SRC_DIR, "mcp-runtime.ts");

    expect(fs.existsSync(initClient)).toBe(true);
    expect(fs.existsSync(mcpRuntime)).toBe(true);

    const result = buildImportClosure([initClient, mcpRuntime]);

    if (result.violations.length > 0) {
      const formatted = result.violations
        .map((v) => `  ${path.relative(SRC_DIR, v.from)} -> ${path.relative(SRC_DIR, v.to)}`)
        .join("\n");
      throw new Error(
        `Runtime bundle reaches into forbidden directories:\n${formatted}`,
      );
    }
    expect(result.violations).toEqual([]);

    // Sanity check: the closure should be non-trivial. If something
    // breaks the walker so it visits zero files, we want this test to
    // fail loudly rather than silently pass.
    expect(result.files.size).toBeGreaterThan(1);
  });

  it("self-verifies: deliberately forbidden export-star re-exports ARE detected", () => {
    // Exercises the RE_EXPORT_RE branch covering `export * from ...`.
    // If the regex regresses, an `export *` re-export of a forbidden
    // module would slip through the production assertion silently.
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "import-guard-fixture-"));
    const fixtureSrc = path.join(fixtureDir, "fixture-export-star.ts");
    const targetInsideSrc = path.join(SRC_DIR, "agent-detection", "configs.ts");
    // ESM import specifiers must use forward slashes regardless of
    // platform; `path.relative` produces backslashes on Windows.
    const relativeToTarget = toPosix(
      path.relative(fixtureDir, targetInsideSrc),
    ).replace(/\.ts$/, ".js");

    fs.writeFileSync(
      fixtureSrc,
      `export * from "${relativeToTarget}";\n`,
      "utf-8",
    );

    try {
      const result = buildImportClosure([fixtureSrc]);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(
        result.violations.some((v) => /\/agent-detection\//.test(v.to)),
      ).toBe(true);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("self-verifies: deliberately forbidden imports ARE detected by the same walker", () => {
    // Create a fixture file outside the source tree that imports a
    // forbidden module. Use a sibling fixture inside SRC_DIR so the
    // walker's "only walk inside SRC_DIR" filter doesn't drop it.
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "import-guard-fixture-"));
    const fixtureName = "fixture-with-forbidden-import.ts";
    const fixtureSrc = path.join(fixtureDir, fixtureName);
    const targetInsideSrc = path.join(SRC_DIR, "agent-detection", "configs.ts");

    // The walker only follows imports that resolve INSIDE SRC_DIR. To
    // exercise the violation path, the fixture needs to import a real
    // file inside the forbidden directory using a relative specifier.
    // Use an absolute path written as a file:// URL won't work; use a
    // computed relative path from the fixture location.
    // ESM import specifiers must use forward slashes regardless of
    // platform; `path.relative` produces backslashes on Windows.
    const relativeToTarget = toPosix(
      path.relative(fixtureDir, targetInsideSrc),
    ).replace(/\.ts$/, ".js");

    fs.writeFileSync(
      fixtureSrc,
      `import { generateMcpConfig } from "${relativeToTarget}";\nexport const x = generateMcpConfig;\n`,
      "utf-8",
    );

    try {
      const result = buildImportClosure([fixtureSrc]);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(
        result.violations.some((v) => /\/agent-detection\//.test(v.to)),
      ).toBe(true);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
