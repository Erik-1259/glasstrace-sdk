/**
 * Postbuild gate: assert tsup's `define: { __SDK_VERSION__: pkg.version }`
 * substitution actually baked the *current* `package.json#version` into
 * the emitted `dist/` bundles.
 *
 * Why this gate exists (DISC-1602)
 * --------------------------------
 * The `release.yml` canary publish path used to run `npm run build`
 * BEFORE `npx changeset version --snapshot canary`. Because tsup's
 * `define` reads `pkg.version` from `package.json` *at build time*, the
 * built `dist/` shipped with the pre-snapshot stable version baked in.
 * `changeset publish --tag canary` then tagged the same artifact under
 * the new canary version, but the bundled `__SDK_VERSION__` literal
 * still lied about which version the package was published as. The
 * SDK-050 canary `0.0.0-canary-20260507174112` shipped this way:
 * `dist/cli/upgrade-instructions.cjs` contained `"1.4.0"` even though
 * the npm `dist-tag` resolved to `0.0.0-canary-...`.
 *
 * The structural fix landed in `release.yml`: snapshot now runs BEFORE
 * build. This script is the defensive gate that catches a future
 * reversion (someone reorders the workflow back, someone changes
 * `tsup.config.ts`'s `define` keying, or adds a build step that runs
 * before snapshot in any new release path).
 *
 * What this script does
 * ---------------------
 * 1. Reads `package.json` next to this script (resolved via
 *    `process.cwd()` at script invocation — `npm run` already cd's
 *    into the package dir).
 * 2. For each CJS CLI bundle that imports `__SDK_VERSION__` (the bin
 *    is `dist/cli/init.js`; the related CLIs all reference the same
 *    constant), reads the file and asserts the literal current
 *    `pkg.version` string appears at least once.
 * 3. Exits non-zero with a pointed error message when any expected
 *    bundle is missing the version literal.
 *
 * False-positive risk
 * -------------------
 * If `pkg.version` happens to coincidentally match an unrelated string
 * literal in the bundle (vanishingly unlikely for a unique semver),
 * the assertion would pass when it shouldn't. The check is one of two
 * defences (the structural workflow fix is the first); a unit-level
 * test that asserts `__SDK_VERSION__` resolves at runtime is out of
 * scope here because it would need to spawn the built CLI and parse
 * its output. The current literal-presence check has been sufficient
 * to catch the documented DISC-1602 failure mode and is cheap.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const PACKAGE_DIR = process.cwd();
const PKG_JSON_PATH = resolve(PACKAGE_DIR, "package.json");

let pkgVersion;
try {
  const pkg = JSON.parse(readFileSync(PKG_JSON_PATH, "utf-8"));
  pkgVersion = pkg.version;
} catch (err) {
  process.stderr.write(
    `[check-sdk-version-stamp] could not read ${PKG_JSON_PATH}: ${
      err instanceof Error ? err.message : String(err)
    }\n`,
  );
  process.exit(2);
}

if (typeof pkgVersion !== "string" || pkgVersion.length === 0) {
  process.stderr.write(
    `[check-sdk-version-stamp] package.json#version is missing or empty\n`,
  );
  process.exit(2);
}

// Bundles to check. These are the CLI entry points that reference
// `__SDK_VERSION__` (per `tsup.config.ts` and the `declare const
// __SDK_VERSION__: string` lines in the source). The CJS form is
// the form npm consumes by default and the easiest to grep.
const REQUIRED_BUNDLES = [
  "dist/cli/init.cjs",
  "dist/cli/mcp-add.cjs",
  "dist/cli/upgrade-instructions.cjs",
];

// We look for the literal version inside JS string quotes. tsup's
// `define` substitutes `__SDK_VERSION__` with `JSON.stringify(pkg.version)`
// (per `tsup.config.ts`), which lands in the bundle as a double-quoted
// literal. Single-quoted is unlikely but we accept either form for
// robustness in case esbuild's quote-style output changes.
const expectedDouble = `"${pkgVersion}"`;
const expectedSingle = `'${pkgVersion}'`;

let failed = false;
for (const rel of REQUIRED_BUNDLES) {
  const path = resolve(PACKAGE_DIR, rel);
  let content;
  try {
    content = readFileSync(path, "utf-8");
  } catch (err) {
    process.stderr.write(
      `[check-sdk-version-stamp] expected bundle ${rel} missing — tsup did not emit it: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    failed = true;
    continue;
  }

  if (!content.includes(expectedDouble) && !content.includes(expectedSingle)) {
    process.stderr.write(
      `[check-sdk-version-stamp] FAIL — ${rel} does not contain the literal ` +
        `version string ${expectedDouble} (current package.json#version=${pkgVersion}).\n` +
        `  Likely cause: build ran against a stale package.json before a snapshot/version ` +
        `bump, OR tsup's \`define: { __SDK_VERSION__: pkg.version }\` was changed/removed.\n` +
        `  See DISC-1602 for the historical incident.\n`,
    );
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

process.stdout.write(
  `[check-sdk-version-stamp] all ${String(REQUIRED_BUNDLES.length)} CJS CLI bundles ` +
    `contain the current package.json#version literal "${pkgVersion}"\n`,
);
