/**
 * F003 runtime-partition gate.
 *
 * Gate scope
 * ----------
 * The gate has two concentric parts:
 *
 *   - **Node-ESM resolvability probe (stage 1)** runs on EVERY bundle
 *     the SDK ships: the edge bundle AND the Node-side bundles
 *     (`dist/node-entry.js`, `dist/node-subpath.js`). DISC-1280's
 *     tsup pass-through quirk can break any of them the same way,
 *     and an unimportable Node bundle would surface late (at the
 *     SDK-030 subpath wire-up, or at consumer install) rather than
 *     in CI. Probing all three catches the regression in CI.
 *
 *   - **Edge-safe contract (stages 2 + 3)** runs only on the edge
 *     bundle (`dist/edge-entry.js` plus `dist/edge-entry.cjs` when
 *     present). These stages encode the F003 runtime contract, which
 *     is specific to the edge surface; the Node bundles are
 *     deliberately allowed to import Node APIs.
 *
 * Stages
 * ------
 *   1. **Resolvability probe (ESM only):** `import()` the emitted file
 *      through Node's loader. Catches references to sibling paths that
 *      tsup failed to rewrite into shared chunks (DISC-1280) — the
 *      closure scan alone cannot catch this because every dangling
 *      `./errors.js`-style reference is treated as external by
 *      esbuild and so appears "clean" in the metafile.
 *
 *   2. **Closure scan:** bundle with esbuild in `platform: neutral`
 *      mode, externalize every Node built-in specifier (the `node:`
 *      prefix forms, the bare forms, and the built-in sub-specifier
 *      forms like `fs/promises`) plus a small denylist of known
 *      Node-only npm packages, and scan the metafile's `imports[]`
 *      arrays for denylisted paths.
 *
 *   3. **`process` global scan:** re-bundle with esbuild's `define`
 *      option replacing every unbound `process` identifier with a
 *      sentinel (`__GT_PROCESS_GLOBAL__`), then regex-match the
 *      sentinel in the emitted output. Because `define` is scope-
 *      aware, locally-bound identifiers named `process` (e.g., Zod's
 *      `export function process`, a destructure, an import aliased
 *      to `process`) are left alone, so every hit is a true unbound
 *      reference to the Node global. This catches dot access, bracket
 *      access, optional chaining, destructuring, re-aliasing, and
 *      typeof guards uniformly — any of which would crash in Workers
 *      / Vercel Edge / browser runtimes where `process` is undefined.
 *
 * Exits non-zero when any step fails.
 *
 * This file is the single implementation of the gate. It is invoked
 * directly by `package.json#scripts.check:edge-bundle` so the postbuild
 * hook is cross-platform (no shell wrapper, which would break on
 * Windows' cmd.exe).
 *
 * Usage:
 *   node scripts/check-edge-bundle.mjs [path ...]
 *
 * With no arguments, the gate checks `dist/edge-entry.js` and
 * `dist/edge-entry.cjs` (the latter only when it exists). Any
 * explicit path argument replaces that default.
 *
 * Denylist construction
 * ---------------------
 * The denylist is the union of:
 *   1. Every entry in `require('module').builtinModules`, obtained at
 *      runtime so the gate tracks whatever Node version the build runs
 *      under (e.g., `node:sqlite` landed in Node 22). Not hardcoded.
 *   2. Every `node:<name>` specifier for each name in (1).
 *   3. Every sub-specifier `<builtin>/<anything>` (e.g., `fs/promises`,
 *      `path/posix`, `stream/web`) — not returned by `builtinModules`
 *      but still legitimate Node built-in specifiers.
 *   4. A hardcoded list of known Node-only npm packages: `@vercel/blob`,
 *      in both the bare form and the `<pkg>/*` sub-path form (so that
 *      e.g. `@vercel/blob/client` is externalized and therefore visible
 *      to the metafile scan — without the `/*` form it would resolve
 *      to a file path that no longer matches the denylist).
 *
 * Metafile inspection
 * -------------------
 * Every denylisted specifier is passed as `external` so esbuild
 * records it in `inputs[file].imports[].path` with `external: true`
 * instead of failing to resolve a virtual module. The gate then
 * walks every `imports[]` array; any path matching the denylist
 * (by prefix for `node:*` and `<builtin>/*`, by equality or prefix
 * for Node-only npm packages) is a violation.
 *
 * External-list completeness matters: if an edge-entry refactor ever
 * emits a bare `fs` or `fs/promises` specifier (without the `node:`
 * prefix), esbuild under `platform: neutral` would fail to resolve it
 * and crash the gate instead of reporting a clean violation. The
 * denylist is therefore fed into `external` in full, so every Node
 * built-in specifier — in any of its legitimate import forms —
 * surfaces as a scannable metafile entry.
 *
 * Node-version caveat
 * -------------------
 * `builtinModules` grows across Node versions. CI and developer
 * environments running different Node majors can produce different
 * accept/reject decisions. Align `engines.node` with the CI matrix;
 * do not paper over drift by editing the denylist.
 */

import { build } from "esbuild";
import { builtinModules } from "node:module";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const KNOWN_NODE_ONLY_PACKAGES = ["@vercel/blob"];
const BUILTINS = new Set(builtinModules);

/**
 * True when `p` is a Node built-in module specifier or a built-in
 * sub-specifier (e.g. `fs/promises`, `path/posix`, `node:stream/web`).
 */
function isNodeBuiltin(p) {
  if (p.startsWith("node:")) return true;
  if (BUILTINS.has(p)) return true;
  const slash = p.indexOf("/");
  if (slash === -1) return false;
  return BUILTINS.has(p.slice(0, slash));
}

/** True when `p` is a known Node-only npm package or one of its sub-paths. */
function isKnownNodeOnlyPackage(p) {
  return KNOWN_NODE_ONLY_PACKAGES.some(
    (name) => p === name || p.startsWith(name + "/"),
  );
}

/**
 * The full list of specifiers handed to esbuild's `external` option.
 * Includes both `node:*` + `node:<name>` + `node:<name>/*` forms and the
 * bare `<name>` + `<name>/*` forms, so any import style lands in the
 * metafile for scanning (and esbuild never crashes on resolution).
 */
function buildExternalList() {
  const entries = new Set(["node:*"]);
  for (const name of BUILTINS) {
    entries.add(name);
    entries.add(`${name}/*`);
  }
  // Node-only npm packages must have their subpath form externalized too:
  // a bare `@vercel/blob` import resolves to a different file than
  // `@vercel/blob/client`, and without the `/*` pattern esbuild would
  // bundle the subpath's resolved file and `isKnownNodeOnlyPackage()`
  // would no longer match the on-disk path, silently admitting a banned
  // package. Keep parity with the OTel block below.
  for (const pkg of KNOWN_NODE_ONLY_PACKAGES) {
    entries.add(pkg);
    entries.add(`${pkg}/*`);
  }
  // Also treat these as out-of-scope: the SDK inlines them via tsup
  // `noExternal`, so they should not appear in dist/edge-entry.*, but
  // externalizing keeps the gate robust to a future tsup change.
  for (const pkg of [
    "@opentelemetry/api",
    "@opentelemetry/sdk-trace-base",
    "@opentelemetry/exporter-trace-otlp-http",
    "@opentelemetry/core",
    "@glasstrace/protocol",
    "zod",
  ]) {
    entries.add(pkg);
    entries.add(`${pkg}/*`);
  }
  return [...entries];
}

/**
 * Bundle `entryPath` with esbuild and return the list of `{ from, to }`
 * violations found in its transitive import closure.
 */
async function scanBundle(entryPath, external) {
  const result = await build({
    entryPoints: [entryPath],
    bundle: true,
    metafile: true,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
    write: false,
    external,
  });

  const violations = [];
  for (const [from, info] of Object.entries(result.metafile.inputs)) {
    for (const imp of info.imports ?? []) {
      const to = imp.path;
      if (isKnownNodeOnlyPackage(to) || isNodeBuiltin(to)) {
        violations.push({ from, to });
      }
    }
  }
  return { violations, inputCount: Object.keys(result.metafile.inputs).length };
}

/**
 * Re-bundle `entryPath` with no externals and scan the resulting flat
 * JS for any reference to the `process` global, which is the most
 * common edge-runtime incompatibility that escapes the import-closure
 * scan. Modules that read `process.env.X` at top level crash on import
 * in Workers / Vercel Edge / browsers; modules that touch `process`
 * inside function bodies crash when the function is called (the
 * consumer can mitigate that with a `process` shim, but the SDK should
 * prefer not to make that a requirement of the edge-safe contract).
 *
 * The implementation uses esbuild's `define` option — the only way to
 * get scope-aware identifier substitution without shipping a full JS
 * parser. Three define entries together replace every route to the
 * Node global with a single sentinel:
 *
 *   - `process`:            bare unbound identifier. esbuild honors
 *     lexical scope: shadowed locals (e.g. `export function process`
 *     in Zod's `to-json-schema` module; a `const { process } = x`
 *     destructure; an import aliased to `process`) are left alone.
 *   - `globalThis.process`: property-path access through `globalThis`,
 *     which Edge runtimes DO provide (so this reach is available and
 *     therefore tempting) but which does NOT carry a `process`
 *     property in Workers / Vercel Edge / browsers.
 *   - `global.process`:     property-path access through the legacy
 *     Node `global` alias. Not present in Edge/browser runtimes.
 *
 * A subsequent `\b__GT_PROCESS_GLOBAL__\b` scan then matches every
 * form the older `\bprocess\s*\.` regex missed:
 *
 *   - member access:        `process.env.X`
 *   - optional chaining:    `process?.env`
 *   - bracket notation:     `process["env"]`
 *   - destructuring source: `const { env } = process`
 *   - re-aliasing:          `const p = process`
 *   - global-container:     `globalThis.process.env.X`, `global.process`
 *   - `typeof` guards:      `typeof process !== "undefined"`
 *     — these ARE caught by the scan, which is intentional: an edge-
 *     safe module should never need a typeof guard because it should
 *     never reach for `process` at all. If a future refactor needs to
 *     re-admit such a module to the edge surface, the contract change
 *     is a review-level decision, not something the gate should let
 *     slide silently.
 *
 * Because the substitution is scope-aware, a scan for the sentinel
 * has no false positives: any match is a real, unbound reference to
 * the Node `process` global.
 *
 * Returns an array of violation excerpts (at most 5, with surrounding
 * context). Empty array means no usage detected.
 */
const PROCESS_SENTINEL = "__GT_PROCESS_GLOBAL__";

async function scanGlobalProcessUsage(entryPath) {
  const result = await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
    write: false,
    // Let esbuild inline every external so the output reflects the
    // full bundle closure. Only Node built-ins are externalized to
    // keep esbuild from crashing; their absence in the output is
    // already enforced by `scanBundle`.
    external: buildNodeBuiltinExternals(),
    // Substitute every route to the Node `process` global with the
    // sentinel. Three keys are needed:
    //
    //   - `process`:              bare identifier. esbuild honors
    //     lexical scope here: shadowed locals (function/const/let/var
    //     or import bindings named `process`) are NOT substituted.
    //   - `globalThis.process`:   property-path replacement for code
    //     that reaches the global through `globalThis` — which Edge
    //     runtimes do provide, but `globalThis.process` itself is
    //     still undefined there, so its use is a violation.
    //   - `global.process`:       same rationale for the legacy Node
    //     `global` alias.
    //
    // esbuild treats these property-path entries as literal member-
    // access substitutions rather than scoped identifiers, which is
    // what we want: `process` alone is caught by the bare binding
    // (and correctly skipped for shadowed locals), while the global-
    // via-container forms are always the Node global and always a
    // violation.
    define: {
      process: PROCESS_SENTINEL,
      "globalThis.process": PROCESS_SENTINEL,
      "global.process": PROCESS_SENTINEL,
    },
  });

  const output = result.outputFiles[0]?.text ?? "";
  const pattern = new RegExp(`\\b${PROCESS_SENTINEL}\\b`, "g");
  const found = [];
  let match;
  while ((match = pattern.exec(output)) !== null && found.length < 5) {
    const start = Math.max(0, match.index - 40);
    const end = Math.min(output.length, match.index + 40);
    found.push(
      output
        .slice(start, end)
        .replace(new RegExp(PROCESS_SENTINEL, "g"), "process")
        .replace(/\s+/g, " ")
        .trim(),
    );
  }
  return found;
}

function buildNodeBuiltinExternals() {
  const entries = new Set(["node:*"]);
  for (const name of BUILTINS) {
    entries.add(name);
    entries.add(`${name}/*`);
  }
  return [...entries];
}

/**
 * ESM-only resolvability probe.
 *
 * `scanBundle` externalizes every Node built-in plus a denylist of
 * Node-only npm packages, so esbuild reports the closure as clean even
 * when a sibling path in the bundle (e.g., `./errors.js`) fails to
 * resolve on disk. That class of bug — observed in tsup's ESM output
 * for pure `export ... from` entries, see DISC-1280 — ships a
 * syntactically clean bundle that crashes on first import.
 *
 * This function imports the emitted ESM bundle through Node's own
 * loader. An `ERR_MODULE_NOT_FOUND` here means the bundle references a
 * sibling path that was never emitted; the gate turns that into a
 * clear F003 failure instead of deferring the crash to consumer apps.
 * Only `.js` ESM bundles are probed — `.cjs` requires a different
 * resolver and is out of scope for the F003 edge contract (edge
 * runtimes are ESM-only).
 */
async function probeNodeImport(entryPath) {
  if (!entryPath.endsWith(".js")) return null;
  try {
    await import(pathToFileURL(entryPath).href);
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Stage 1 on its own: confirm the emitted ESM bundle at `entryPath`
 * is importable through Node's loader. This is run against every
 * bundle the SDK ships (edge-entry, node-entry, node-subpath) so a
 * DISC-1280-style tsup pass-through regression in any of them fails
 * the build, not only in the edge bundle. Stages 2 and 3 remain
 * edge-entry-only: they encode the F003 edge-safe contract, which
 * is meaningless for the Node bundles.
 */
async function probeOne(entryPath) {
  if (!existsSync(entryPath)) {
    process.stderr.write(
      `[check-edge-bundle] ${entryPath} missing — tsup did not emit it. ` +
        `Check tsup.config.ts entries.\n`,
    );
    return 2;
  }

  // Stage 1 is ESM-only; CJS bundles need a different resolver and
  // are out of scope for the DISC-1280 pass-through regression (the
  // quirk is ESM-specific). Silently pass CJS through here so `main`
  // can continue to stages 2/3 for the edge CJS variant.
  if (!entryPath.endsWith(".js")) return 0;

  const importError = await probeNodeImport(entryPath);
  if (importError) {
    process.stderr.write(
      `[check-edge-bundle] gate failed — ${entryPath} is not resolvable ` +
        `under Node ESM:\n  ${importError.message}\n\n` +
        `Fix: see DISC-1280. A pure \`export { X } from "./mod.js"\` entry ` +
        `can emit pass-through references that tsup does not rewrite to ` +
        `shared-chunk paths. Rewrite the entry file as ` +
        `\`import { X } from "./mod.js"; export { X };\`.\n`,
    );
    return 1;
  }

  process.stdout.write(
    `[check-edge-bundle] ${entryPath} resolvable under Node ESM\n`,
  );
  return 0;
}

/**
 * Edge-only stages 2 and 3: closure scan for Node-built-in /
 * denylisted-package imports, then scope-aware `process` global scan.
 * The stage-1 probe is NOT re-run here; `main()` runs it for every
 * bundle up-front. A bundle that fails this function is always
 * failing a contract that applies only to the edge surface.
 */
async function checkEdgeContract(entryPath, external) {
  const { violations, inputCount } = await scanBundle(entryPath, external);

  if (violations.length > 0) {
    process.stderr.write(
      `[check-edge-bundle] F003 gate failed — ${entryPath} closure contains Node-only specifiers:\n`,
    );
    for (const { from, to } of violations) {
      process.stderr.write(`  ${to}   <-  ${from}\n`);
    }
    process.stderr.write(
      `\nFix: either remove the offending re-export from src/edge-entry.ts, ` +
        `or refactor the transitively-imported module to lazy-load the Node API.\n`,
    );
    return 1;
  }

  const processUsage = await scanGlobalProcessUsage(entryPath);
  if (processUsage.length > 0) {
    process.stderr.write(
      `[check-edge-bundle] F003 gate failed — ${entryPath} references the Node ` +
        `\`process\` global, which is not available in Workers / Vercel Edge / ` +
        `browser runtimes. First ${String(processUsage.length)} occurrence(s):\n`,
    );
    for (const excerpt of processUsage) {
      process.stderr.write(`  …${excerpt}…\n`);
    }
    process.stderr.write(
      `\nFix: either remove the offending re-export from src/edge-entry.ts, ` +
        `or refactor the transitively-imported module to read \`process.env\` ` +
        `lazily inside a function body (and guard for \`typeof process !== ` +
        `"undefined"\`). See DISC-1281 for the session.ts / fetch-classifier.ts ` +
        `refactor that blocks the full edge surface.\n`,
    );
    return 1;
  }

  process.stdout.write(
    `[check-edge-bundle] ${entryPath} closure clean (${String(inputCount)} inputs, ` +
      `denylist: ${String(BUILTINS.size + KNOWN_NODE_ONLY_PACKAGES.length)} entries, ` +
      `no \`process\` usage)\n`,
  );
  return 0;
}

async function main() {
  const args = process.argv.slice(2);

  // Default targets:
  //
  //   - edgeTargets: the edge bundle(s). The full three-stage gate runs
  //     against these. Both ESM and CJS variants are checked when
  //     present (brief Requirement 7).
  //   - nodeProbeTargets: the Node-side bundles. Only stage 1 (the
  //     ESM-resolvability probe) runs against these — stages 2 + 3
  //     encode the F003 edge contract and are meaningless here. This
  //     extension was added in response to PR #176 round-4 feedback
  //     that DISC-1280's dangling-sibling regression could land in
  //     `node-entry.js` / `node-subpath.js` without being caught,
  //     because those files use the same `export ... from` pattern
  //     that triggers the tsup quirk.
  //
  // A caller can still override everything by passing explicit paths,
  // in which case every passed path gets the full three-stage gate.
  const explicitTargets = args.map((p) => resolve(p));
  const edgeTargets =
    explicitTargets.length > 0
      ? explicitTargets
      : [
          resolve("dist/edge-entry.js"),
          ...(existsSync(resolve("dist/edge-entry.cjs"))
            ? [resolve("dist/edge-entry.cjs")]
            : []),
        ];
  // Node-side probe targets are required when the gate runs with
  // default arguments (the CI / postbuild path). If either file is
  // missing, `probeOne` returns exit code 2, which propagates to
  // `worstExit` and fails the build — filtering missing entries would
  // silently drop a tsup emission regression. (When the caller passes
  // explicit paths, `nodeProbeTargets` is empty, and the explicit
  // paths get the full edge contract via `edgeTargets`.)
  const nodeProbeTargets =
    explicitTargets.length > 0
      ? []
      : [
          resolve("dist/node-entry.js"),
          resolve("dist/node-subpath.js"),
        ];

  const external = buildExternalList();

  let worstExit = 0;

  // Stage 1 on every Node-side bundle: catches DISC-1280 regressions.
  for (const entry of nodeProbeTargets) {
    const code = await probeOne(entry);
    if (code > worstExit) worstExit = code;
  }

  // Edge bundles: probe, then full F003 contract.
  for (const entry of edgeTargets) {
    if (!existsSync(entry)) {
      process.stderr.write(
        `[check-edge-bundle] ${entry} missing — tsup did not emit it. ` +
          `Check tsup.config.ts entries.\n`,
      );
      if (worstExit < 2) worstExit = 2;
      continue;
    }
    const probeCode = await probeOne(entry);
    if (probeCode !== 0) {
      if (probeCode > worstExit) worstExit = probeCode;
      continue; // Don't run stages 2/3 against an unloadable bundle.
    }
    const contractCode = await checkEdgeContract(entry, external);
    if (contractCode > worstExit) worstExit = contractCode;
  }

  process.exit(worstExit);
}

await main();
