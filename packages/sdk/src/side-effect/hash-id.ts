/**
 * Producer-side identifier pseudonymization for the value-fidelity
 * scalar channel.
 *
 * `hashId` turns a raw identifier into a stable, opaque `gthid_<hex>`
 * token that a producer can emit on an `*Id` scalar without leaking the
 * raw value. The SDK's `checkScalarField` rejects unhashed `*Id` values
 * under `strict`, so a producer that wants id correlation pre-hashes the
 * id with this helper.
 *
 * NODE-ONLY. This module imports `node:crypto` and is therefore exported
 * exclusively from the `@glasstrace/sdk/node` subpath, never the root
 * barrel — the root must stay edge-bundle-safe (no node builtins in the
 * edge closure). `*Id` capture is a server-side concern, so the
 * node-only placement does not reduce real coverage.
 */

import { createHmac } from "node:crypto";
import {
  SIDE_EFFECT_HASHED_ID_HEX_LENGTH,
  SIDE_EFFECT_HASHED_ID_PREFIX,
} from "@glasstrace/protocol";

// 32 hex = 128 bits of the HMAC-SHA256 output — not brute-forceable
// without the key, and compact. The length is shared with the SDK's
// strict `*Id` scalar validator (via the protocol constant) so the
// emitter and the admission check cannot drift.

/**
 * Pseudonymize a raw identifier into a stable `gthid_<hex>` token using
 * HMAC-SHA256 keyed by `key`.
 *
 * Node-only. Uses `node:crypto`, so it ships exclusively on the
 * `@glasstrace/sdk/node` subpath.
 *
 * Fail-closed: returns `null` when `raw` or `key` is missing or empty,
 * so a misconfigured caller emits no id rather than a raw or weakly
 * keyed one. A `null` return routes the `*Id` scalar to the
 * `unhashed_id` omission counter at emit time.
 *
 * The same `(raw, key)` always produces the same token, enabling
 * cross-trace correlation of the same entity. This is also the privacy
 * boundary's weak point:
 *
 *  - **Key rotation breaks correlation by design.** Tokens hashed under
 *    a new key do not match tokens hashed under the old one. If
 *    cross-rotation correlation is required, embed a key-id segment in
 *    the key-management layer and rotate deliberately.
 *  - **A leaked key de-pseudonymizes every id hashed under it** (an
 *    attacker can hash a candidate id space and match tokens). Treat the
 *    key as a secret; scope it per tenant.
 *  - **Stable tokens plus quasi-identifier scalars enable corpus-level
 *    re-identification / linkage**, bounded by per-tenant scope. Do not
 *    treat a `gthid_` token as anonymization.
 *
 * @param raw - The raw identifier to pseudonymize.
 * @param key - The per-tenant HMAC secret (e.g. from
 *   `GLASSTRACE_ATTR_HMAC_KEY`). Never logged or emitted.
 * @returns A `gthid_<32hex>` token, or `null` if `raw`/`key` is empty.
 */
export function hashId(raw: string, key: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (typeof key !== "string" || key.length === 0) return null;
  const digest = createHmac("sha256", key)
    .update(raw)
    .digest("hex")
    .slice(0, SIDE_EFFECT_HASHED_ID_HEX_LENGTH);
  return `${SIDE_EFFECT_HASHED_ID_PREFIX}${digest}`;
}
