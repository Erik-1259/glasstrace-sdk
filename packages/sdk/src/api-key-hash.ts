/**
 * SHA-256 hash helper for API-key rotation detection.
 *
 * Memo §Decision 7 calls for a stable hash of the resolved API key
 * that can be compared on every `_setCurrentConfig` /
 * `setResolvedApiKey` call to detect rotation. We hash with SHA-256
 * and truncate to the first 16 bytes (32 hex chars). The truncation
 * is documentary — full-length collision search is computationally
 * infeasible regardless — and keeps the cached value compact.
 *
 * The hash is held in module state at the call sites (e.g.,
 * `otel-config.ts`); the raw key is already in module state in the
 * SDK, so the hash adds no new exposure surface. The hash is **not**
 * logged or surfaced in `runtime-state.json`.
 *
 * The implementation uses `node:crypto` synchronously and emits a
 * SHA-256 hex digest prefixed with `sha256:`. Falls back to an FNV-1a
 * 32-bit hash prefixed with `fnv:` if `node:crypto` is not available
 * (non-Node runtimes — Edge, Workers, browsers); the fallback is
 * intentional — detecting rotation via FNV-1a is a degraded but
 * correct equivalent (collision-resistant for the rotation-detection
 * use case, which only needs key inequality, not security). The two
 * algorithms are mutually exclusive at runtime — the same process
 * always uses the same algorithm — so a hash from one is never
 * compared against a hash from the other.
 */

let cryptoModule: typeof import("node:crypto") | null | undefined;

function loadCrypto(): typeof import("node:crypto") | null {
  if (cryptoModule !== undefined) return cryptoModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, glasstrace/no-unguarded-node-require -- guarded by surrounding try/catch; non-Node runtimes (Edge, Workers) trigger the catch and fall back to identity compare. Same pattern as runtime-state.ts (DISC-1555).
    cryptoModule = require("node:crypto") as typeof import("node:crypto");
  } catch {
    cryptoModule = null;
  }
  return cryptoModule;
}

/**
 * Returns a SHA-256-derived stable identifier for the supplied API
 * key, truncated to 32 hex characters (16 bytes). When `node:crypto`
 * is not available (non-Node runtime), returns a length-prefixed
 * raw-string fallback that is still stable and equality-comparable.
 *
 * Empty / non-string input returns the empty string so callers can
 * safely diff against an initial unset state.
 */
export function hashApiKey(key: string | undefined | null): string {
  if (typeof key !== "string" || key.length === 0) return "";
  const crypto = loadCrypto();
  if (crypto !== null) {
    return crypto.createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32);
  }
  // Non-Node fallback: FNV-1a 32-bit hash. NOT cryptographically
  // secure (collisions can be constructed) but adequate for the only
  // call site that needs the hash — comparing two keys for equality
  // — because rotation is an honest path, not an adversarial input.
  // Importantly, the fallback never echoes raw key bytes; it returns
  // a fixed-length hex digest that is safe to keep in module state
  // alongside the SHA-256 path.
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    // FNV prime 0x01000193 — multiplication via shifts and adds keeps
    // the result inside 32-bit range without `Math.imul`-only
    // semantics in any specific runtime.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  // 8-hex-char digest, prefixed with `fnv:` so the call-site debug
  // output makes the algorithm obvious if it ever leaks into logs.
  return `fnv:${hash.toString(16).padStart(8, "0")}`;
}
