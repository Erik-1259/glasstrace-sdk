/**
 * `@glasstrace/sdk/node` subpath-resolution gate.
 *
 * Runs at the `postbuild` hook (after `check:edge-bundle`) so a broken
 * `exports` map or a missing `dist/node-subpath.*` artifact fails the
 * build instead of shipping to npm. Two probes cover both module
 * systems consumers will use:
 *
 *   1. ESM probe — `await import("@glasstrace/sdk/node")`.
 *   2. CJS probe — `createRequire(import.meta.url)("@glasstrace/sdk/node")`.
 *
 * Each probe asserts the resolved module has at least one own key, so
 * an empty artifact (e.g. `module.exports = {}`) is caught in addition
 * to outright resolution failures.
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

const SUBPATH = "@glasstrace/sdk/node";
const LOG_PREFIX = "[verify-subpath]";

/**
 * Emit a `[verify-subpath]`-prefixed failure message and a hint pointing
 * at the exports map, then exit non-zero. The hint is the same for
 * every failure mode because the fix is always to inspect the exports
 * map and the emitted `dist/node-subpath.*` artifacts.
 */
function fail(message) {
  process.stderr.write(
    `${LOG_PREFIX} ${message}\n` +
      `${LOG_PREFIX} Fix: inspect the \`exports\` map in packages/sdk/package.json ` +
      `and confirm \`dist/node-subpath.js\` + \`dist/node-subpath.cjs\` were emitted ` +
      `by tsup.\n`,
  );
  process.exit(1);
}

/**
 * Assert the resolved subpath module is a non-null object or function
 * with at least one own key.
 *
 * A null/undefined resolution or a non-object (e.g. `module.exports = 0`)
 * would indicate a broken artifact just as clearly as an empty object,
 * and must route through `fail()` rather than throwing an unhandled
 * `TypeError` from `Object.keys` — which would bypass the actionable
 * hint that points at the `exports` map.
 */
function assertNonEmpty(mod, loader) {
  if (mod === null || mod === undefined) {
    fail(
      `${loader} resolved \`${SUBPATH}\` to ${String(mod)} instead of a module object. ` +
        `Expected the 10 Node-only exports defined in src/node-subpath.ts.`,
    );
  }
  if (typeof mod !== "object" && typeof mod !== "function") {
    fail(
      `${loader} resolved \`${SUBPATH}\` to a non-object value of type ` +
        `\`${typeof mod}\`. Expected the 10 Node-only exports defined in src/node-subpath.ts.`,
    );
  }
  if (Object.keys(mod).length === 0) {
    fail(
      `${loader} resolved \`${SUBPATH}\` to an empty module. ` +
        `Expected the 10 Node-only exports defined in src/node-subpath.ts.`,
    );
  }
}

async function probeEsm() {
  let mod;
  try {
    mod = await import(SUBPATH);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`ESM resolution failed: ${message}`);
  }
  assertNonEmpty(mod, "ESM");
}

function probeCjs() {
  const require = createRequire(import.meta.url);
  let mod;
  try {
    mod = require(SUBPATH);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`CJS resolution failed: ${message}`);
  }
  assertNonEmpty(mod, "CJS");
}

async function main() {
  // Anchor cwd to packages/sdk/ for parity with the bash original's
  // `cd "$(dirname "$0")/.."` step. Bare-specifier resolution itself
  // does not depend on cwd (see the top-of-file JSDoc), but keeping
  // cwd pinned to the package root makes any future relative-path
  // diagnostics stable regardless of where `npm run build` is run.
  const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  process.chdir(packageDir);

  await probeEsm();
  probeCjs();

  process.stdout.write(
    `${LOG_PREFIX} ${SUBPATH} resolves under ESM and CJS\n`,
  );
}

await main();
