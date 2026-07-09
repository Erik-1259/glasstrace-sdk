/**
 * Subpath-resolution gate for `@glasstrace/sdk` non-root entries.
 *
 * Runs at the `postbuild` hook (after `check:edge-bundle`) so a broken
 * `exports` map or a missing `dist/<subpath>.*` artifact fails the
 * build instead of shipping to npm. Two probes cover both module
 * systems consumers will use:
 *
 *   1. ESM probe — `await import("@glasstrace/sdk/<subpath>")`.
 *   2. CJS probe — `createRequire(import.meta.url)("@glasstrace/sdk/<subpath>")`.
 *
 * Each probe asserts the resolved module has at least one own key, so
 * an empty artifact (e.g. `module.exports = {}`) is caught in addition
 * to outright resolution failures.
 *
 * Subpaths covered: `@glasstrace/sdk/node`, `@glasstrace/sdk/trpc`,
 * `@glasstrace/sdk/middleware`, `@glasstrace/sdk/async-context`, and
 * `@glasstrace/sdk/diagnostics` — every Node-only or plain subpath added
 * since the gate was introduced.
 *
 * `@glasstrace/sdk/drizzle` is intentionally NOT probed here: the
 * Drizzle adapter shipped before the verify-subpath gate existed, and
 * its consumers exercise it through the full Drizzle Logger interface
 * in `tests/unit/sdk/drizzle-adapter.test.ts`. Adding it to this
 * script would not add coverage.
 *
 * The gate `chdir`s to the SDK package directory before probing. Node's
 * ESM `import()` and `createRequire(import.meta.url)` both resolve bare
 * specifiers from the importing file's location rather than from cwd,
 * so the `chdir` is not required for the subpath lookup to succeed;
 * it mirrors the `cd "$(dirname "$0")/.."` step of the bash script
 * this file replaces and keeps any future relative-path diagnostics
 * anchored to `packages/sdk/`.
 *
 * This file is the single implementation of the gate. It is invoked
 * directly by `package.json#scripts.verify:subpath` so the postbuild
 * hook is cross-platform (no shell wrapper, which would break on
 * Windows' cmd.exe).
 *
 * Usage:
 *   node scripts/verify-subpath-resolution.mjs
 */

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

/**
 * Each entry declares:
 *
 *   - `specifier`        — bare specifier the gate resolves under both
 *                          ESM and CJS.
 *   - `distHint`         — file pattern shown in the failure hint so the
 *                          first place a maintainer looks is the right
 *                          one.
 *   - `expectedExports`  — diagnostic-only string. Names runtime
 *                          (value) exports first, then notes any
 *                          type-only exports separately so a failed
 *                          gate hint cannot mislead a reader into
 *                          looking for type names in `Object.keys()`.
 *   - `requiredRuntime`  — list of runtime export names that MUST
 *                          appear on the resolved module. Used as the
 *                          tightening gate so a subpath that resolves
 *                          to a wrong-but-non-empty artifact (e.g. an
 *                          unrelated module that happens to export
 *                          something) still fails CI.
 */
const SUBPATHS = [
  {
    specifier: "@glasstrace/sdk/node",
    distHint: "dist/node-subpath.{js,cjs}",
    expectedExports:
      "10 Node-only runtime exports (discoverSourceMapFiles, " +
      "collectSourceMaps, computeBuildHash, uploadSourceMaps, " +
      "PRESIGNED_THRESHOLD_BYTES, uploadSourceMapsPresigned, " +
      "uploadSourceMapsAuto, discoverTestFiles, extractImports, " +
      "buildImportGraph) plus type-only exports (SourceMapFileInfo, " +
      "SourceMapEntry, BlobUploader, AutoUploadOptions) erased at " +
      "runtime — see src/node-subpath.ts",
    requiredRuntime: [
      "discoverSourceMapFiles",
      "collectSourceMaps",
      "computeBuildHash",
      "uploadSourceMaps",
      "PRESIGNED_THRESHOLD_BYTES",
      "uploadSourceMapsPresigned",
      "uploadSourceMapsAuto",
      "discoverTestFiles",
      "extractImports",
      "buildImportGraph",
    ],
  },
  {
    specifier: "@glasstrace/sdk/trpc",
    distHint: "dist/trpc/index.{js,cjs}",
    expectedExports:
      "the runtime export `tracedMiddleware` plus type-only exports " +
      "(MiddlewareFunction, TracedMiddlewareOptions) erased at runtime " +
      "— see src/trpc/index.ts",
    requiredRuntime: ["tracedMiddleware"],
  },
  {
    specifier: "@glasstrace/sdk/middleware",
    distHint: "dist/middleware/index.{js,cjs}",
    expectedExports:
      "the runtime export `tracedRequestMiddleware` plus type-only " +
      "exports (TracedRequestMiddlewareOptions, RequestMiddlewareFunction) " +
      "erased at runtime — see src/middleware/index.ts",
    requiredRuntime: ["tracedRequestMiddleware"],
  },
  {
    specifier: "@glasstrace/sdk/async-context",
    distHint: "dist/async-context/index.{js,cjs}",
    expectedExports:
      "the runtime export `withAsyncCausality` plus the type-only " +
      "export `WithAsyncCausalityOptions` erased at runtime — see " +
      "src/async-context/index.ts",
    requiredRuntime: ["withAsyncCausality"],
  },
  {
    specifier: "@glasstrace/sdk/diagnostics",
    distHint: "dist/diagnostics/index.{js,cjs}",
    expectedExports:
      "the runtime exports `createSpanDiagnostics` and " +
      "`SpanDiagnosticsProcessor` plus type-only exports " +
      "(SpanDiagnosticsOptions, SpanDiagnosticsProcessorOptions, " +
      "DiagnosticRecord, StartRecord, EndRecord, UnendedRecord, " +
      "UnendedSpanFact, RunSummaryRecord, SpanKindName) erased at runtime " +
      "— see src/diagnostics/index.ts",
    requiredRuntime: ["createSpanDiagnostics", "SpanDiagnosticsProcessor"],
  },
];
const LOG_PREFIX = "[verify-subpath]";

/**
 * Emit a `[verify-subpath]`-prefixed failure message and a hint pointing
 * at the exports map, then exit non-zero. The hint is the same for
 * every failure mode because the fix is always to inspect the exports
 * map and the emitted `dist/<subpath>.*` artifacts.
 */
function fail(message, distHint) {
  process.stderr.write(
    `${LOG_PREFIX} ${message}\n` +
      `${LOG_PREFIX} Fix: inspect the \`exports\` map in packages/sdk/package.json ` +
      `and confirm \`${distHint}\` were emitted by tsup.\n`,
  );
  process.exit(1);
}

/**
 * Assert the resolved subpath module is a non-null object or function
 * that exposes the runtime exports declared on the entry.
 *
 * A null/undefined resolution or a non-object (e.g. `module.exports = 0`)
 * would indicate a broken artifact and must route through `fail()`
 * rather than throwing an unhandled `TypeError` from `Object.keys` —
 * which would bypass the actionable hint that points at the `exports`
 * map.
 *
 * Beyond the non-empty check, the gate asserts each name in
 * `entry.requiredRuntime` is present and resolves to a non-`undefined`
 * value. This catches a second failure mode that a plain non-empty
 * check misses: a subpath that resolves to the wrong artifact but
 * happens to export some unrelated symbol (e.g. an accidental
 * `exports` map collision that points the subpath at a different
 * module). In that case `Object.keys(mod).length > 0` is true but the
 * required runtime names are absent.
 */
function assertResolvesToExpected(mod, loader, entry) {
  if (mod === null || mod === undefined) {
    fail(
      `${loader} resolved \`${entry.specifier}\` to ${String(mod)} instead of ` +
        `a module object. Expected ${entry.expectedExports}.`,
      entry.distHint,
    );
  }
  if (typeof mod !== "object" && typeof mod !== "function") {
    fail(
      `${loader} resolved \`${entry.specifier}\` to a non-object value of ` +
        `type \`${typeof mod}\`. Expected ${entry.expectedExports}.`,
      entry.distHint,
    );
  }
  if (Object.keys(mod).length === 0) {
    fail(
      `${loader} resolved \`${entry.specifier}\` to an empty module. ` +
        `Expected ${entry.expectedExports}.`,
      entry.distHint,
    );
  }
  const missing = entry.requiredRuntime.filter(
    (name) => mod[name] === undefined,
  );
  if (missing.length > 0) {
    fail(
      `${loader} resolved \`${entry.specifier}\` to a module missing ` +
        `required runtime export(s): ${missing.join(", ")}. ` +
        `Expected ${entry.expectedExports}.`,
      entry.distHint,
    );
  }
}

async function probeEsm(entry) {
  let mod;
  try {
    mod = await import(entry.specifier);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`ESM resolution of \`${entry.specifier}\` failed: ${message}`, entry.distHint);
  }
  assertResolvesToExpected(mod, "ESM", entry);
}

function probeCjs(entry) {
  const require = createRequire(import.meta.url);
  let mod;
  try {
    mod = require(entry.specifier);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`CJS resolution of \`${entry.specifier}\` failed: ${message}`, entry.distHint);
  }
  assertResolvesToExpected(mod, "CJS", entry);
}

async function main() {
  // Anchor cwd to packages/sdk/ for parity with the bash original's
  // `cd "$(dirname "$0")/.."` step. Bare-specifier resolution itself
  // does not depend on cwd (see the top-of-file JSDoc), but keeping
  // cwd pinned to the package root makes any future relative-path
  // diagnostics stable regardless of where `npm run build` is run.
  const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  process.chdir(packageDir);

  for (const entry of SUBPATHS) {
    await probeEsm(entry);
    probeCjs(entry);
    process.stdout.write(
      `${LOG_PREFIX} ${entry.specifier} resolves under ESM and CJS\n`,
    );
  }

  process.stdout.write(
    `${LOG_PREFIX} all ${String(SUBPATHS.length)} subpaths verified\n`,
  );
}

await main();
