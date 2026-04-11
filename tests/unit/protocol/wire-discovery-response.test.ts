import { describe, it, expect } from "vitest";
import { DiscoveryResponseSchema } from "../../../packages/protocol/src/index.js";
import type { AnonApiKey, SessionId } from "../../../packages/protocol/src/index.js";

const MOCK_ANON_KEY = ("gt_anon_" + "a".repeat(48)) as AnonApiKey;
const MOCK_SESSION_ID = "abcdef0123456789" as SessionId;

describe("DiscoveryResponseSchema", () => {
  it("accepts the base format (key + sessionId only)", () => {
    const result = DiscoveryResponseSchema.safeParse({
      key: MOCK_ANON_KEY,
      sessionId: MOCK_SESSION_ID,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.claimed).toBeUndefined();
      expect(result.data.accountHint).toBeUndefined();
    }
  });

  it("accepts claimed: true with accountHint", () => {
    const result = DiscoveryResponseSchema.safeParse({
      key: MOCK_ANON_KEY,
      sessionId: MOCK_SESSION_ID,
      claimed: true,
      accountHint: "er***@example.com",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.claimed).toBe(true);
      expect(result.data.accountHint).toBe("er***@example.com");
    }
  });

  it("accepts claimed: true without accountHint", () => {
    const result = DiscoveryResponseSchema.safeParse({
      key: MOCK_ANON_KEY,
      sessionId: MOCK_SESSION_ID,
      claimed: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.claimed).toBe(true);
      expect(result.data.accountHint).toBeUndefined();
    }
  });

  it("accepts claimed: false", () => {
    const result = DiscoveryResponseSchema.safeParse({
      key: MOCK_ANON_KEY,
      sessionId: MOCK_SESSION_ID,
      claimed: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.claimed).toBe(false);
    }
  });

  it("rejects claimed with non-boolean value", () => {
    const result = DiscoveryResponseSchema.safeParse({
      key: MOCK_ANON_KEY,
      sessionId: MOCK_SESSION_ID,
      claimed: "yes",
    });
    expect(result.success).toBe(false);
  });

  it("rejects accountHint with non-string value", () => {
    const result = DiscoveryResponseSchema.safeParse({
      key: MOCK_ANON_KEY,
      sessionId: MOCK_SESSION_ID,
      accountHint: 123,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing required key field", () => {
    const result = DiscoveryResponseSchema.safeParse({
      sessionId: MOCK_SESSION_ID,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing required sessionId field", () => {
    const result = DiscoveryResponseSchema.safeParse({
      key: MOCK_ANON_KEY,
    });
    expect(result.success).toBe(false);
  });
});
