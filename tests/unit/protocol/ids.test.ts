import { describe, it, expect } from "vitest";
import {
  DevApiKeySchema,
  AnonApiKeySchema,
  SessionIdSchema,
  BuildHashSchema,
  createAnonApiKey,
  createBuildHash,
} from "../../../packages/protocol/src/ids.js";

describe("DevApiKeySchema", () => {
  it("accepts a valid dev key", () => {
    const key = "gt_dev_" + "a".repeat(48);
    const result = DevApiKeySchema.safeParse(key);
    expect(result.success).toBe(true);
  });

  it("rejects wrong prefix", () => {
    const key = "gt_anon_" + "a".repeat(48);
    const result = DevApiKeySchema.safeParse(key);
    expect(result.success).toBe(false);
  });

  it("rejects wrong length (too short)", () => {
    const key = "gt_dev_" + "a".repeat(47);
    const result = DevApiKeySchema.safeParse(key);
    expect(result.success).toBe(false);
  });

  it("rejects wrong length (too long)", () => {
    const key = "gt_dev_" + "a".repeat(49);
    const result = DevApiKeySchema.safeParse(key);
    expect(result.success).toBe(false);
  });

  it("rejects uppercase hex chars", () => {
    const key = "gt_dev_" + "A".repeat(48);
    const result = DevApiKeySchema.safeParse(key);
    expect(result.success).toBe(false);
  });

  it("rejects non-hex chars", () => {
    const key = "gt_dev_" + "g".repeat(48);
    const result = DevApiKeySchema.safeParse(key);
    expect(result.success).toBe(false);
  });

  it("rejects empty string", () => {
    const result = DevApiKeySchema.safeParse("");
    expect(result.success).toBe(false);
  });
});

describe("AnonApiKeySchema", () => {
  it("accepts a valid anon key", () => {
    const key = "gt_anon_" + "b".repeat(48);
    const result = AnonApiKeySchema.safeParse(key);
    expect(result.success).toBe(true);
  });

  it("rejects dev prefix", () => {
    const key = "gt_dev_" + "b".repeat(48);
    const result = AnonApiKeySchema.safeParse(key);
    expect(result.success).toBe(false);
  });

  it("rejects wrong length", () => {
    const key = "gt_anon_" + "b".repeat(10);
    const result = AnonApiKeySchema.safeParse(key);
    expect(result.success).toBe(false);
  });
});

describe("SessionIdSchema", () => {
  it("accepts a valid 16-char hex string", () => {
    const result = SessionIdSchema.safeParse("abcdef0123456789");
    expect(result.success).toBe(true);
  });

  it("rejects wrong length", () => {
    const result = SessionIdSchema.safeParse("abcdef012345678");
    expect(result.success).toBe(false);
  });

  it("rejects uppercase", () => {
    const result = SessionIdSchema.safeParse("ABCDEF0123456789");
    expect(result.success).toBe(false);
  });

  it("rejects non-hex", () => {
    const result = SessionIdSchema.safeParse("zzzzzzzzzzzzzzzz");
    expect(result.success).toBe(false);
  });
});

describe("BuildHashSchema", () => {
  it("accepts a valid git SHA", () => {
    const result = BuildHashSchema.safeParse("abc123def456");
    expect(result.success).toBe(true);
  });

  it("accepts alphanumeric with dots, underscores, hyphens, plus", () => {
    const result = BuildHashSchema.safeParse("v1.2.3-beta+build.42");
    expect(result.success).toBe(true);
  });

  it("rejects empty string", () => {
    const result = BuildHashSchema.safeParse("");
    expect(result.success).toBe(false);
  });

  it("rejects string over 128 chars", () => {
    const result = BuildHashSchema.safeParse("a".repeat(129));
    expect(result.success).toBe(false);
  });

  it("accepts string of exactly 128 chars", () => {
    const result = BuildHashSchema.safeParse("a".repeat(128));
    expect(result.success).toBe(true);
  });

  it("rejects path traversal with '..'", () => {
    const result = BuildHashSchema.safeParse("foo..bar");
    expect(result.success).toBe(false);
  });

  it("rejects single dot", () => {
    const result = BuildHashSchema.safeParse(".");
    expect(result.success).toBe(false);
  });

  it("rejects double dot", () => {
    const result = BuildHashSchema.safeParse("..");
    expect(result.success).toBe(false);
  });

  it("rejects slashes", () => {
    const result = BuildHashSchema.safeParse("foo/bar");
    expect(result.success).toBe(false);
  });
});

describe("createAnonApiKey", () => {
  it("produces a valid AnonApiKey", () => {
    const key = createAnonApiKey();
    const result = AnonApiKeySchema.safeParse(key);
    expect(result.success).toBe(true);
  });

  it("produces unique keys on successive calls", () => {
    const key1 = createAnonApiKey();
    const key2 = createAnonApiKey();
    expect(key1).not.toBe(key2);
  });
});

describe("createBuildHash", () => {
  it("parses and brands a valid hash", () => {
    const hash = createBuildHash("abc123");
    const result = BuildHashSchema.safeParse(hash);
    expect(result.success).toBe(true);
  });

  it("throws on invalid input", () => {
    expect(() => createBuildHash("")).toThrow();
  });

  it("throws on path traversal", () => {
    expect(() => createBuildHash("..")).toThrow();
  });
});
