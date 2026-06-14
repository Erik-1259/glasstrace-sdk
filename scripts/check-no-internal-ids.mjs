/**
 * Public-surface guard: assert that internal tracking identifiers never
 * appear on any surface that ships to npm consumers.
 *
 * Why this guard exists
 * ---------------------
 * The team tracks work internally with short identifiers built from a
 * fixed set of project prefixes followed by a number (for example
 * `SDK-49`, `DISC-1257`, `SCHEMA-036`). Those identifiers are meaningful
 * only inside the private planning repo — to an external consumer they
 * are noise at best and a leak of internal process at worst. Two classes
 * of published surface can carry them into a consumer's editor or
 * `node_modules`:
 *
 *   1. The published README of each workspace package. This monorepo
 *      ships a *per-package* README — `packages/sdk/README.md` and
 *      `packages/protocol/README.md` — via each package's `files` list,
 *      and those are what render on the respective npm package pages. The
 *      repo-root `README.md` is not part of any published tarball, so the
 *      scan reads each package manifest's `files` field and includes the
 *      README that each package actually publishes.
 *   2. The generated TypeScript declaration files (`*.d.ts` / `*.d.cts`)
 *      under each package's `dist/`. JSDoc written on an *exported*
 *      symbol propagates verbatim into the emitted declarations, where
 *      it surfaces in consumers' editor tooltips on hover.
 *
 * Non-exported source comments (`//` lines, JSDoc on internal helpers)
 * do NOT reach either surface and are intentionally out of scope here —
 * they ship only inside source maps, a separate concern.
 *
 * What this guard does
 * --------------------
 * Greps both classes of published surface — every workspace package's
 * published README and every emitted declaration file — for the
 * identifier pattern, and exits non-zero with a pointed report listing
 * every offending `file:line` when any match is found. Wired into CI (a
 * dedicated step after Build) and mirrored by a unit test so it also runs
 * in the local `npm run test` gate.
 *
 * The script derives all paths from its own location via `import.meta.url`
 * so it is invariant to `process.cwd()` — it works whether invoked via
 * `npm run check:no-internal-ids` from the repo root or `node` directly.
 */

import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  realpathSync,
} from "node:fs";
import { dirname, resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The closed set of project prefixes the team uses for internal tracking
// identifiers. Kept explicit — rather than a generic `[A-Z]+-\d+` — so
// unrelated hyphenated tokens that legitimately appear on public surfaces
// (`SHA-256`, `UTF-8`, `BCP-47`, `IEEE-754`, `ISO-8601`, `ES2020`) never
// match. Add a prefix here when a new internal tracking series is
// introduced.
const INTERNAL_ID_PREFIXES = [
  "ACCT",
  "DISC",
  "ING",
  "MCP",
  "SCHEMA",
  "SDK",
  "TEST",
  "VAL",
  "WAVE",
];

// Match an internal tracking identifier: one of the explicit prefixes
// above, a hyphen, then at least one digit (e.g. `SDK-49`, `DISC-1257`,
// `SCHEMA-036`). The leading `\b` anchors the prefix to a word boundary so
// a longer token that merely ends in one of these prefixes (`FOOSDK-1`)
// does not match; the trailing `\b` after the digits stops a partial match
// inside a longer alphanumeric run.
const INTERNAL_ID_PATTERN = new RegExp(
  String.raw`\b(?:${INTERNAL_ID_PREFIXES.join("|")})-\d+\b`,
  "g",
);

/**
 * Recursively collect declaration files (`.d.ts` / `.d.cts`) under `dir`.
 * Returns an empty array when `dir` does not exist so the caller can
 * decide whether a missing `dist/` is a hard error.
 */
function collectDeclarationFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectDeclarationFiles(full));
    } else if (full.endsWith(".d.ts") || full.endsWith(".d.cts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Resolve the README file(s) a workspace package publishes to npm.
 *
 * npm always includes a top-level `README` (any case/extension) in the
 * published tarball regardless of the manifest's `files` list, so the
 * package-root README is the authoritative published-README surface.
 * When the manifest's `files` list names additional README paths, those
 * are honored too. Returns absolute paths to every README that exists;
 * an empty array when the package ships none.
 */
function collectPublishedReadmes(pkgDir) {
  const found = new Set();

  // npm's implicit rule: the first top-level file matching /^readme/i is
  // always published. Mirror that by scanning the package root.
  for (const entry of readdirSync(pkgDir)) {
    if (/^readme(\.|$)/i.test(entry)) {
      const full = join(pkgDir, entry);
      if (statSync(full).isFile()) found.add(full);
    }
  }

  // Honor any README paths explicitly declared in `files`, in case a
  // package ships a README from a non-root location.
  const manifestPath = join(pkgDir, "package.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (Array.isArray(manifest.files)) {
      for (const pattern of manifest.files) {
        if (typeof pattern !== "string") continue;
        if (!/readme/i.test(pattern)) continue;
        const full = join(pkgDir, pattern);
        if (existsSync(full) && statSync(full).isFile()) found.add(full);
      }
    }
  }

  return [...found].sort();
}

/**
 * Scan a single file for internal identifiers. Returns an array of
 * `{ file, line, text, id }` violation records (empty when clean).
 */
function scanFile(absPath) {
  const violations = [];
  const content = readFileSync(absPath, "utf-8");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const matches = lines[i].match(INTERNAL_ID_PATTERN);
    if (matches) {
      for (const id of matches) {
        violations.push({
          file: relative(REPO_ROOT, absPath),
          line: i + 1,
          text: lines[i].trim(),
          id,
        });
      }
    }
  }
  return violations;
}

/**
 * Run the full scan across every published surface.
 *
 * @returns {{ violations: Array, scannedFileCount: number, distMissing: string[] }}
 */
export function checkNoInternalIds() {
  const surfaces = [];

  // Walk every workspace package and add the surfaces it actually
  // publishes:
  //
  //   1. The README declared in the package's `files` list. This
  //      monorepo publishes a per-package README (the repo-root
  //      `README.md` is not part of any tarball), so the published
  //      README surface is derived from each manifest rather than
  //      assumed to be the root README. A package that does not ship a
  //      README contributes no README surface.
  //   2. The built declaration files (`.d.ts` / `.d.cts`) under the
  //      package's `dist/`. A missing `dist/` is reported separately so
  //      callers (the CLI entry, the unit test) can treat "not built
  //      yet" appropriately for their context rather than silently
  //      passing on an unbuilt tree.
  const packagesDir = resolve(REPO_ROOT, "packages");
  const distMissing = [];
  if (existsSync(packagesDir)) {
    // Sort so the scanned-surface order is deterministic across
    // platforms (readdir order is filesystem-dependent).
    for (const pkg of readdirSync(packagesDir).sort()) {
      const pkgDir = join(packagesDir, pkg);
      if (!statSync(pkgDir).isDirectory()) continue;

      for (const readme of collectPublishedReadmes(pkgDir)) {
        surfaces.push(readme);
      }

      const distDir = join(pkgDir, "dist");
      if (!existsSync(distDir)) {
        distMissing.push(relative(REPO_ROOT, distDir));
        continue;
      }
      surfaces.push(...collectDeclarationFiles(distDir).sort());
    }
  }

  const violations = [];
  for (const surface of surfaces) {
    violations.push(...scanFile(surface));
  }

  return { violations, scannedFileCount: surfaces.length, distMissing };
}

// CLI entry: run the scan and exit non-zero on any violation. Detect
// direct invocation by comparing the script path to argv[1] so the
// module can also be imported by the unit test without side effects.
// Both paths are passed through `realpathSync` first: on macOS the repo
// frequently lives under `/tmp` (a symlink to `/private/tmp`), so
// `import.meta.url` and `argv[1]` can spell the same file differently. A
// naive string compare would then mark a genuine `node scripts/...` run
// as "imported" and silently skip the entire check.
function canonical(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
const invokedDirectly =
  process.argv[1] &&
  canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const { violations, scannedFileCount, distMissing } = checkNoInternalIds();

  if (distMissing.length > 0) {
    process.stderr.write(
      `[check-no-internal-ids] declaration files not found for: ${distMissing.join(
        ", ",
      )}\n` +
        `  Run \`npm run build\` first — this guard scans the generated ` +
        `.d.ts / .d.cts files that ship to consumers.\n`,
    );
    process.exit(2);
  }

  if (violations.length > 0) {
    process.stderr.write(
      `[check-no-internal-ids] FAIL — internal tracking identifiers found ` +
        `on ${String(violations.length)} published-surface line(s):\n\n`,
    );
    for (const v of violations) {
      process.stderr.write(`  ${v.file}:${String(v.line)}  (${v.id})\n`);
      process.stderr.write(`    ${v.text}\n`);
    }
    process.stderr.write(
      `\n  Internal tracking IDs must not appear in a published package ` +
        `README or in exported JSDoc that propagates into the published ` +
        `.d.ts / .d.cts files (it surfaces in consumers' editor tooltips). ` +
        `Rewrite the reference in plain language. Non-exported source ` +
        `comments are fine.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `[check-no-internal-ids] OK — no internal tracking identifiers on ` +
      `${String(scannedFileCount)} published-surface file(s).\n`,
  );
}
