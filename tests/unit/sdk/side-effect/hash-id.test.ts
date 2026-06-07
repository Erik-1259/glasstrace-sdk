/**
 * Tests for `hashId` (SDK-054 value-fidelity identifier pseudonymization,
 * node-only `@glasstrace/sdk/node` subpath).
 *
 * Verifies the fixed `gthid_<32hex>` output shape, determinism, key
 * sensitivity, and fail-closed behavior. No raw identifier or key value
 * is asserted against a plaintext, only against the opaque token shape.
 */

import { describe, it, expect } from "vitest";
import { hashId } from "../../../../packages/sdk/src/side-effect/hash-id.js";
import { checkScalarField } from "../../../../packages/sdk/src/side-effect/allowlist.js";

const KEY = "test-hmac-secret-do-not-use-in-prod";
// Fixed-length lowercase-hex shape the SDK emits (stronger than the
// product's length-agnostic `^gthid_[0-9a-f]+$`).
const GTHID_FIXED = /^gthid_[0-9a-f]{32}$/;

describe("hashId", () => {
  it("produces a fixed-length lowercase gthid_ token", () => {
    const out = hashId("user-42", KEY);
    expect(out).not.toBeNull();
    expect(out).toMatch(GTHID_FIXED);
  });

  it("is deterministic for the same (raw, key)", () => {
    expect(hashId("user-42", KEY)).toBe(hashId("user-42", KEY));
  });

  it("matches a pinned known-answer vector (HMAC-SHA256, 32-hex slice)", () => {
    // Frozen vector — guards against a silent change of algorithm, key
    // ordering, or digest slice length. Recompute only on a deliberate
    // contract change.
    expect(hashId("entity-7", "kav-fixed-test-key")).toBe(
      "gthid_2a84851e28d3d1a9590a7a8d1e337837",
    );
  });

  it("differs when the raw id differs", () => {
    expect(hashId("user-42", KEY)).not.toBe(hashId("user-43", KEY));
  });

  it("differs when the key differs (rotation breaks correlation)", () => {
    expect(hashId("user-42", KEY)).not.toBe(hashId("user-42", `${KEY}-v2`));
  });

  it("fails closed (null) without a usable raw id or key", () => {
    expect(hashId("", KEY)).toBeNull();
    expect(hashId("user-42", "")).toBeNull();
    // @ts-expect-error exercising the runtime guard against non-strings
    expect(hashId(undefined, KEY)).toBeNull();
    // @ts-expect-error exercising the runtime guard against non-strings
    expect(hashId("user-42", undefined)).toBeNull();
  });

  it("emits a token accepted by the strict *Id scalar validator (length coupling)", () => {
    // The output must be admissible as a strict *Id scalar — this locks
    // the shared hex-length contract between `hashId` and
    // `checkScalarField`. A forged human-readable token is rejected.
    const out = hashId("actor-42", KEY);
    expect(out).toMatch(GTHID_FIXED);
    expect(checkScalarField("actorId", out)).toEqual({
      accepted: true,
      value: out,
    });
    expect(checkScalarField("actorId", "gthid_jsmith")).toEqual({
      accepted: false,
      reason: "unhashed_id",
    });
  });
});
