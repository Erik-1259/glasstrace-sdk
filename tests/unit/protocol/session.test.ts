import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  deriveSessionId,
  SessionIdSchema,
} from "../../../packages/protocol/src/index.js";
import { sha256Hex } from "../../../packages/protocol/src/sha256.js";

describe("sha256Hex", () => {
  // NIST FIPS 180-4 test vectors.
  it("hashes the empty string to the known SHA-256 vector", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes 'abc' to the known SHA-256 vector", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes the 448-bit (56-byte) test vector", () => {
    expect(
      sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("matches node:crypto across varied inputs", () => {
    const cases = [
      "",
      "a",
      "hello world",
      "Glasstrace",
      "a".repeat(55), // one byte under the first padding boundary
      "a".repeat(56), // forces two-block padding
      "a".repeat(64), // exactly one block
      "a".repeat(119),
      "a".repeat(120),
      "Unicode: 🌈🦄漢字",
      String.fromCharCode(0, 127, 128, 255, 256, 1024, 65535),
    ];
    for (const input of cases) {
      expect(sha256Hex(input)).toBe(
        createHash("sha256").update(input, "utf8").digest("hex"),
      );
    }
  });
});

describe("deriveSessionId (protocol)", () => {
  it("produces deterministic output for same inputs", () => {
    const a = deriveSessionId("key1", "localhost:3000", "2026-03-22", 0);
    const b = deriveSessionId("key1", "localhost:3000", "2026-03-22", 0);
    expect(a).toBe(b);
  });

  it("returns a 16-character hex string", () => {
    const id = deriveSessionId("key1", "localhost:3000", "2026-03-22", 0);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("output parses successfully through SessionIdSchema", () => {
    const id = deriveSessionId("key1", "localhost:3000", "2026-03-22", 0);
    const parsed = SessionIdSchema.safeParse(id);
    expect(parsed.success).toBe(true);
  });

  it("equals SHA-256(JSON inputs) truncated to 16 hex chars", () => {
    // This is the exact wire contract: any consumer that hashes the same
    // JSON-encoded inputs through SHA-256 and truncates to 16 hex chars
    // gets the same session ID. The test uses node:crypto as an
    // independent reference to prove the pure-JS implementation matches.
    const input = JSON.stringify(["key1", "localhost:3000", "2026-03-22", 0]);
    const expected = createHash("sha256").update(input).digest("hex").slice(0, 16);
    const id = deriveSessionId("key1", "localhost:3000", "2026-03-22", 0);
    expect(id).toBe(expected);
  });

  it("ambiguous field boundaries produce different hashes", () => {
    // These inputs collapse to the same string under naive concatenation:
    // "key1" + "localhost:3000" + "2026-03-22" + "0"
    //  === "key" + "1localhost:3000" + "2026-03-22" + "0"
    // but produce different hashes when using JSON.stringify-based encoding.
    const a = deriveSessionId("key1", "localhost:3000", "2026-03-22", 0);
    const b = deriveSessionId("key", "1localhost:3000", "2026-03-22", 0);
    expect(a).not.toBe(b);
  });

  it("different API keys produce different session IDs", () => {
    const a = deriveSessionId("key1", "localhost:3000", "2026-03-22", 0);
    const b = deriveSessionId("key2", "localhost:3000", "2026-03-22", 0);
    expect(a).not.toBe(b);
  });

  it("different origins produce different session IDs", () => {
    const a = deriveSessionId("key1", "localhost:3000", "2026-03-22", 0);
    const b = deriveSessionId("key1", "localhost:4000", "2026-03-22", 0);
    expect(a).not.toBe(b);
  });

  it("different dates produce different session IDs", () => {
    const a = deriveSessionId("key1", "localhost:3000", "2026-03-22", 0);
    const b = deriveSessionId("key1", "localhost:3000", "2026-03-23", 0);
    expect(a).not.toBe(b);
  });

  it("different window indices produce different session IDs", () => {
    const a = deriveSessionId("key1", "localhost:3000", "2026-03-22", 0);
    const b = deriveSessionId("key1", "localhost:3000", "2026-03-22", 1);
    expect(a).not.toBe(b);
  });

  it("empty string inputs produce a deterministic hash without throwing", () => {
    expect(() => deriveSessionId("", "", "", 0)).not.toThrow();
    const a = deriveSessionId("", "", "", 0);
    const b = deriveSessionId("", "", "", 0);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});
