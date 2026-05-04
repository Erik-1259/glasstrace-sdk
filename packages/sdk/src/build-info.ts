/**
 * Build-time metadata plumbed to the runtime exporter.
 *
 * Today this module exposes a single value — the build hash — which the
 * SDK stamps on every server span as `glasstrace.build.hash`. The value
 * is read once from `process.env.GLASSTRACE_BUILD_HASH` at module load
 * and cached. The intended convention is for the deploy / build step to
 * set the env var to `git rev-parse HEAD` (or the equivalent CI commit
 * SHA) so the runtime span and the upload-time source-map manifest
 * agree on the same hash. Ingestion uses the value to construct the
 * sourcemap blob key (`sourcemaps/{accountId}/{buildHash}/{file}`); a
 * mismatched or missing hash means the dashboard cannot render mapped
 * frames for the affected traces.
 *
 * The captured value is shape-validated against the typical git SHA
 * pattern (7-64 hex characters, covering abbreviated SHA-1, full
 * SHA-1, and full SHA-256). On mismatch the SDK logs a one-shot
 * warning and continues startup — the build hash is informational
 * metadata, not a correctness requirement, so misconfiguration must
 * never prevent the SDK from starting.
 *
 * @remarks
 * Node-only. The read happens at module load on a Node process where
 * `process.env` is always defined — this module is imported only by
 * `enriching-exporter.ts`, which is itself excluded from the edge
 * bundle by the F003 runtime-partition gate (see
 * `scripts/check-edge-bundle.mjs`). Importing this file from an edge
 * bundle would crash at evaluation when the bundler resolves the
 * `process.env` access; the gate catches that as a build-time
 * regression.
 */

import { sdkLog } from "./console-capture.js";

/**
 * Sentinel value indicating the runtime did not provide a build hash.
 *
 * The exporter checks for this rather than `undefined` so a future
 * configuration mistake (e.g., setting the env var to an empty string)
 * is handled identically to "unset" — the attribute is omitted from
 * the span rather than written as a misleading empty value.
 */
const UNSET = "" as const;

/**
 * Regex matching the typical git build-hash shape: 7-64 hexadecimal
 * characters, case-insensitive. Covers:
 *
 *   - abbreviated SHA-1 (`git rev-parse --short HEAD` defaults to 7+)
 *   - full SHA-1 (40 chars)
 *   - full SHA-256 (64 chars; git supports SHA-256 since 2.29)
 *
 * Anchored at both ends so internal whitespace, path-traversal
 * characters, and non-hex bytes all trigger the mismatch warning.
 * The Latin-only `[0-9a-f]` character class deliberately excludes
 * Unicode homoglyphs (e.g., Cyrillic `а` U+0430), which would
 * otherwise pass a casual visual review but fail blob-key lookup.
 */
const SHA_SHAPE = /^[0-9a-f]{7,64}$/i;

/**
 * Redact a captured value for safe inclusion in a diagnostic warning.
 *
 * Mirrors the {@link maskKey} convention used by `register.ts` for
 * opaque tokens: short values become `xxxx...`; longer values become
 * `xxxxxxxx...yyyy`. A user who accidentally substitutes a secret
 * for the build-hash env var (e.g.,
 * `GLASSTRACE_BUILD_HASH=$SOME_SECRET`) sees at most a redacted
 * prefix in the SDK warning, never the full secret value.
 *
 * The build-hash itself is not sensitive, but defense-in-depth
 * dictates that any env-var value echoed back to logs is redacted —
 * the SDK cannot distinguish a legitimate non-SHA build identifier
 * from a misconfigured secret at the read site.
 *
 * Control bytes (`\x00`-`\x1F` and DEL `\x7F`) are replaced with `?`
 * before insertion into the warning. Without this, an env-var value
 * containing `\n` / `\r` / `\t` / `\x1B` (escape) would corrupt log
 * formatting, enable log-injection attacks against downstream log
 * aggregators, or hide the surrounding warning text under a terminal
 * control sequence.
 */
function redactBuildHash(value: string): string {
  // eslint-disable-next-line no-control-regex
  const sanitize = (s: string): string => s.replace(/[\x00-\x1F\x7F]/g, "?");
  if (value.length <= 12) return sanitize(value.slice(0, 4)) + "...";
  return sanitize(value.slice(0, 8)) + "..." + sanitize(value.slice(-4));
}

/**
 * Read `GLASSTRACE_BUILD_HASH` from the environment and normalize it.
 * Trim whitespace; an empty/whitespace-only string is indistinguishable
 * from unset. When the trimmed value does not match the typical SHA
 * shape, log a one-shot warning and still return the value — the SDK
 * never refuses to start over a metadata field.
 *
 * Called lazily from {@link getBuildHash} on first access (not at
 * module load). This avoids firing the diagnostic warning during
 * build-time entry points that incidentally evaluate this module
 * (e.g., `withGlasstraceConfig` running under `next build`); the
 * warning is reserved for the runtime exporter path.
 */
function readBuildHashFromEnv(): string {
  const raw = process.env.GLASSTRACE_BUILD_HASH;
  if (typeof raw !== "string") return UNSET;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return UNSET;
  if (!SHA_SHAPE.test(trimmed)) {
    sdkLog(
      "warn",
      `[glasstrace] warning: GLASSTRACE_BUILD_HASH=${redactBuildHash(trimmed)} ` +
        `does not match expected SHA shape (7-64 hex characters); ` +
        `source-map enrichment may not work as expected.`,
    );
  }
  return trimmed;
}

let cachedBuildHash: string | null = null;

/**
 * Returns the build hash captured from `process.env.GLASSTRACE_BUILD_HASH`
 * on first access, or `undefined` when the env var was unset, empty, or
 * whitespace-only.
 *
 * The value is captured once on the first call and cached for the
 * lifetime of the process: a deployment that rotates the env var
 * after the SDK starts cannot retroactively re-tag in-flight spans
 * with a value the source-map manifest does not know about. The
 * deferred read also keeps build-time entry points (config wrappers
 * that incidentally evaluate this module) from firing the SHA-shape
 * warning — the warning fires only when the runtime exporter
 * actually requests the hash.
 */
export function getBuildHash(): string | undefined {
  if (cachedBuildHash === null) {
    cachedBuildHash = readBuildHashFromEnv();
  }
  return cachedBuildHash === UNSET ? undefined : cachedBuildHash;
}
