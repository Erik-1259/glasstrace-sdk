/**
 * Tests for `hashIdWeb` — the edge-safe Web Crypto twin of `hashId`.
 *
 * The load-bearing contract is that it produces the *same* `gthid_<32hex>`
 * token as the Node `hashId` for the same `(raw, key)`, so an identifier
 * pseudonymized inside the edge-safe Prisma adapter passes the strict `*Id`
 * scalar validator and correlates with a Node-hashed token. Also verifies
 * determinism, key sensitivity, and fail-closed behavior. No raw identifier
 * or key value is asserted against a plaintext, only the opaque token shape.
 */

import { describe, it, expect, vi } from "vitest";
import { hashIdWeb } from "../../../../packages/sdk/src/side-effect/hash-id-web.js";
import { hashId } from "../../../../packages/sdk/src/side-effect/hash-id.js";
import { checkScalarField } from "../../../../packages/sdk/src/side-effect/allowlist.js";

const KEY = "test-hmac-secret-do-not-use-in-prod";
const GTHID_FIXED = /^gthid_[0-9a-f]{32}$/;

describe("hashIdWeb", () => {
  it("produces a fixed-length lowercase gthid_ token", async () => {
    const out = await hashIdWeb("user-42", KEY);
    expect(out).not.toBeNull();
    expect(out).toMatch(GTHID_FIXED);
  });

  it("matches the same pinned known-answer vector as the Node hashId", async () => {
    // Identical frozen vector to hash-id.test.ts — locks the Web Crypto and
    // node:crypto implementations to byte-identical output. Recompute only on
    // a deliberate contract change.
    expect(await hashIdWeb("entity-7", "kav-fixed-test-key")).toBe(
      "gthid_2a84851e28d3d1a9590a7a8d1e337837",
    );
  });

  it("equals the Node hashId for the same (raw, key) across varied inputs", async () => {
    for (const raw of [
      "user-42",
      "550e8400-e29b-41d4-a716-446655440000",
      "x",
    ]) {
      expect(await hashIdWeb(raw, KEY)).toBe(hashId(raw, KEY));
    }
  });

  it("is deterministic and key-scoped (rotation / account isolation breaks correlation)", async () => {
    expect(await hashIdWeb("user-42", KEY)).toBe(
      await hashIdWeb("user-42", KEY),
    );
    expect(await hashIdWeb("user-42", KEY)).not.toBe(
      await hashIdWeb("user-42", `${KEY}-v2`),
    );
    expect(await hashIdWeb("user-42", KEY)).not.toBe(
      await hashIdWeb("user-43", KEY),
    );
  });

  it("fails closed (null) without a usable raw id or key", async () => {
    expect(await hashIdWeb("", KEY)).toBeNull();
    expect(await hashIdWeb("user-42", "")).toBeNull();
    // @ts-expect-error exercising the runtime guard against non-strings
    expect(await hashIdWeb(undefined, KEY)).toBeNull();
    // @ts-expect-error exercising the runtime guard against non-strings
    expect(await hashIdWeb("user-42", undefined)).toBeNull();
  });

  it("emits a token accepted by the strict *Id scalar validator", async () => {
    const out = await hashIdWeb("actor-42", KEY);
    expect(out).toMatch(GTHID_FIXED);
    expect(checkScalarField("actorId", out)).toEqual({
      accepted: true,
      value: out,
    });
  });

  it("fails closed (null), never throwing, when Web Crypto rejects", async () => {
    const spy = vi
      .spyOn(globalThis.crypto.subtle, "sign")
      .mockRejectedValue(new Error("subtle unavailable"));
    await expect(hashIdWeb("user-42", KEY)).resolves.toBeNull();
    spy.mockRestore();
  });
});
