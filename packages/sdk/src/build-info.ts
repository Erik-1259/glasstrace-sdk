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
 * Read `GLASSTRACE_BUILD_HASH` from the environment exactly once and
 * normalize it. Trim whitespace; an empty/whitespace-only string is
 * indistinguishable from unset.
 */
function readBuildHashFromEnv(): string {
  const raw = process.env.GLASSTRACE_BUILD_HASH;
  if (typeof raw !== "string") return UNSET;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : UNSET;
}

const cachedBuildHash: string = readBuildHashFromEnv();

/**
 * Returns the build hash captured from `process.env.GLASSTRACE_BUILD_HASH`
 * at module load, or `undefined` when the env var was unset, empty, or
 * whitespace-only.
 *
 * The value is intentionally captured once at module load rather than
 * read on every call so a deployment that rotates the env var after
 * the SDK starts cannot retroactively re-tag in-flight spans with a
 * value the source-map manifest does not know about.
 */
export function getBuildHash(): string | undefined {
  return cachedBuildHash === UNSET ? undefined : cachedBuildHash;
}
