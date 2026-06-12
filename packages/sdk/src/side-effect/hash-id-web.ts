/**
 * Edge-safe identifier pseudonymization for the value-fidelity scalar
 * channel.
 *
 * `hashIdWeb` turns a raw identifier into the same stable, opaque
 * `gthid_<hex>` token as the Node {@link import("./hash-id.js").hashId},
 * but computes the HMAC via the Web Crypto API
 * (`globalThis.crypto.subtle`) instead of `node:crypto`. Web Crypto is
 * available in both Node (>=20) and edge runtimes, so this module imports
 * no Node builtins and can be reached from the root barrel without adding
 * a `node:crypto` dependency — letting the passive Prisma adapter
 * pseudonymize an `*Id` column with the same token the Node `hashId`
 * produces.
 *
 * The HMAC-SHA256 output is byte-identical to the Node `hashId` for the
 * same `(raw, key)` (both slice the digest to the shared protocol hex
 * length and prefix it), so a token produced here passes the SDK's strict
 * `*Id` validator and correlates with one produced Node-side.
 */

import {
  SIDE_EFFECT_HASHED_ID_HEX_LENGTH,
  SIDE_EFFECT_HASHED_ID_PREFIX,
} from "@glasstrace/protocol";

/** Lowercase-hex encode bytes without depending on Node's `Buffer`. */
function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Pseudonymize a raw identifier into a stable `gthid_<hex>` token using
 * HMAC-SHA256 keyed by `key`, via the Web Crypto API.
 *
 * Edge-safe and Node-safe (no `node:crypto`). Async because
 * `crypto.subtle` is promise-based.
 *
 * Fail-closed and non-throwing: resolves to `null` when `raw` or `key` is
 * missing or empty, or when the Web Crypto API is unavailable or errors —
 * so a misconfigured caller (or an exotic runtime without `crypto.subtle`)
 * emits no id rather than a raw or weakly keyed one, and the failure never
 * escapes. A `null` resolution routes the `*Id` scalar to the `unhashed_id`
 * omission counter at emit time.
 *
 * @param raw - The raw identifier to pseudonymize.
 * @param key - The per-account HMAC secret. Never logged or emitted.
 * @returns A `gthid_<hex>` token, or `null` if `raw`/`key` is empty.
 */
export async function hashIdWeb(
  raw: string,
  key: string,
): Promise<string | null> {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (typeof key !== "string" || key.length === 0) return null;
  try {
    const encoder = new TextEncoder();
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      "raw",
      encoder.encode(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await globalThis.crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      encoder.encode(raw),
    );
    const digest = bytesToHex(new Uint8Array(signature)).slice(
      0,
      SIDE_EFFECT_HASHED_ID_HEX_LENGTH,
    );
    return `${SIDE_EFFECT_HASHED_ID_PREFIX}${digest}`;
  } catch {
    // Fail-closed on any Web Crypto failure (e.g. a runtime where
    // `globalThis.crypto.subtle` is absent or rejects): resolve to null so
    // the caller records an `unhashed_id` omission rather than letting the
    // error escape and abort the surrounding projection loop.
    return null;
  }
}
