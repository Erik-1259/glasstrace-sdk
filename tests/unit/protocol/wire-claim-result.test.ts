import { describe, it, expect } from "vitest";
import { SdkInitResponseSchema } from "../../../packages/protocol/src/index.js";

/** Minimal valid SdkInitResponse fixture (no claimResult). */
const validBaseResponse = {
  config: {
    requestBodies: false,
    queryParamValues: false,
    envVarValues: false,
    fullConsoleOutput: false,
    importGraph: false,
  },
  subscriptionStatus: "active",
  minimumSdkVersion: "0.1.0",
  apiVersion: "2026-04-01",
  tierLimits: {
    tracesPerMinute: 100,
    storageTtlHours: 72,
    maxTraceSizeBytes: 1_048_576,
    maxConcurrentSessions: 10,
  },
};

const validClaimResult = {
  newApiKey: "gt_dev_c1a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5",
  accountId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  // Use a relative timestamp (1 hour from now) instead of a hardcoded value
  // to prevent this test from failing after the hardcoded date passes.
  graceExpiresAt: Date.now() + 3_600_000,
};

describe("SdkInitResponseSchema — claimResult", () => {
  it("parses a valid response without claimResult (backward compat)", () => {
    const result = SdkInitResponseSchema.safeParse(validBaseResponse);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.claimResult).toBeUndefined();
    }
  });

  it("parses a valid response with claimResult", () => {
    const result = SdkInitResponseSchema.safeParse({
      ...validBaseResponse,
      claimResult: validClaimResult,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.claimResult).toBeDefined();
      expect(result.data.claimResult!.accountId).toBe(validClaimResult.accountId);
      expect(result.data.claimResult!.graceExpiresAt).toBe(validClaimResult.graceExpiresAt);
    }
  });

  it("rejects claimResult with invalid newApiKey (wrong prefix)", () => {
    const result = SdkInitResponseSchema.safeParse({
      ...validBaseResponse,
      claimResult: {
        ...validClaimResult,
        newApiKey: "gt_anon_c1a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects claimResult with invalid accountId (not UUID)", () => {
    const result = SdkInitResponseSchema.safeParse({
      ...validBaseResponse,
      claimResult: {
        ...validClaimResult,
        accountId: "not-a-uuid",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects claimResult with invalid graceExpiresAt (negative number)", () => {
    const result = SdkInitResponseSchema.safeParse({
      ...validBaseResponse,
      claimResult: {
        ...validClaimResult,
        graceExpiresAt: -1,
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects claimResult with missing required fields", () => {
    const result = SdkInitResponseSchema.safeParse({
      ...validBaseResponse,
      claimResult: {
        newApiKey: validClaimResult.newApiKey,
        // missing accountId and graceExpiresAt
      },
    });
    expect(result.success).toBe(false);
  });
});
