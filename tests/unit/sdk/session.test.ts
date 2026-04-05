import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  deriveSessionId,
  getOrigin,
  getDateString,
  SessionManager,
  _resetEnvCacheForTesting,
} from "../../../packages/sdk/src/session.js";

describe("deriveSessionId", () => {
  it("produces deterministic output for same inputs", () => {
    const a = deriveSessionId("key1", "localhost:3000", "2026-03-22", 0);
    const b = deriveSessionId("key1", "localhost:3000", "2026-03-22", 0);
    expect(a).toBe(b);
  });

  it("returns a 16-character hex string", () => {
    const id = deriveSessionId("key1", "localhost:3000", "2026-03-22", 0);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("computes SHA-256 truncated to 16 hex chars", () => {
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

  it("error case: empty string inputs produce a deterministic hash without throwing", () => {
    expect(() => deriveSessionId("", "", "", 0)).not.toThrow();
    const a = deriveSessionId("", "", "", 0);
    const b = deriveSessionId("", "", "", 0);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("getOrigin", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.PORT;
    delete process.env.GLASSTRACE_ENV;
    _resetEnvCacheForTesting();
  });

  afterEach(() => {
    process.env = originalEnv;
    _resetEnvCacheForTesting();
  });

  it("returns localhost:3000 by default", () => {
    expect(getOrigin()).toBe("localhost:3000");
  });

  it("reads PORT from process.env", () => {
    process.env.PORT = "8080";
    _resetEnvCacheForTesting();
    expect(getOrigin()).toBe("localhost:8080");
  });

  it("returns GLASSTRACE_ENV if set instead of hostname:port", () => {
    process.env.GLASSTRACE_ENV = "staging";
    _resetEnvCacheForTesting();
    expect(getOrigin()).toBe("staging");
  });

  it("GLASSTRACE_ENV takes precedence over PORT", () => {
    process.env.PORT = "8080";
    process.env.GLASSTRACE_ENV = "production";
    _resetEnvCacheForTesting();
    expect(getOrigin()).toBe("production");
  });
});

describe("getDateString", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns UTC date as YYYY-MM-DD", () => {
    vi.setSystemTime(new Date("2026-03-22T15:30:00Z"));
    expect(getDateString()).toBe("2026-03-22");
  });

  it("uses UTC, not local timezone", () => {
    // 11:30 PM UTC on March 22 — some timezones would be March 23
    vi.setSystemTime(new Date("2026-03-22T23:30:00Z"));
    expect(getDateString()).toBe("2026-03-22");
  });
});

describe("SessionManager", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T10:00:00Z"));
    originalEnv = { ...process.env };
    delete process.env.PORT;
    delete process.env.GLASSTRACE_ENV;
    _resetEnvCacheForTesting();
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = originalEnv;
    _resetEnvCacheForTesting();
  });

  it("starts with windowIndex 0", () => {
    const manager = new SessionManager();
    const id = manager.getSessionId("test-key");
    const expected = deriveSessionId("test-key", "localhost:3000", "2026-03-22", 0);
    expect(id).toBe(expected);
  });

  it("returns same session ID within 4-hour window", () => {
    const manager = new SessionManager();
    const id1 = manager.getSessionId("test-key");

    // Advance 3 hours 59 minutes
    vi.advanceTimersByTime(3 * 60 * 60 * 1000 + 59 * 60 * 1000);
    const id2 = manager.getSessionId("test-key");

    expect(id1).toBe(id2);
  });

  it("increments window index after 4-hour gap", () => {
    const manager = new SessionManager();
    const id1 = manager.getSessionId("test-key");

    // Advance past 4 hours
    vi.advanceTimersByTime(4 * 60 * 60 * 1000 + 1);
    const id2 = manager.getSessionId("test-key");

    expect(id2).not.toBe(id1);
    // Verify it's window index 1
    const expected = deriveSessionId("test-key", "localhost:3000", "2026-03-22", 1);
    expect(id2).toBe(expected);
  });

  it("boundary: exactly 4 hours of inactivity does not trigger new window", () => {
    const manager = new SessionManager();
    manager.getSessionId("test-key");

    // Advance exactly 4 hours
    vi.advanceTimersByTime(4 * 60 * 60 * 1000);
    const id2 = manager.getSessionId("test-key");

    // Exactly 4 hours should NOT trigger — spec says "more than 4 hours" (strictly greater)
    const expectedSameWindow = deriveSessionId("test-key", "localhost:3000", "2026-03-22", 0);
    expect(id2).toBe(expectedSameWindow);
  });

  it("multiple window increments work correctly", () => {
    const manager = new SessionManager();
    manager.getSessionId("test-key");

    // Gap 1: 5 hours (10:00 -> 15:00, still March 22)
    vi.advanceTimersByTime(5 * 60 * 60 * 1000);
    const id2 = manager.getSessionId("test-key");
    const expected1 = deriveSessionId("test-key", "localhost:3000", "2026-03-22", 1);
    expect(id2).toBe(expected1);

    // Gap 2: 5 hours (15:00 -> 20:00, still March 22)
    vi.advanceTimersByTime(5 * 60 * 60 * 1000);
    const id3 = manager.getSessionId("test-key");
    const expected2 = deriveSessionId("test-key", "localhost:3000", "2026-03-22", 2);
    expect(id3).toBe(expected2);
  });

  it("resets window index on new UTC day", () => {
    const manager = new SessionManager();
    manager.getSessionId("test-key");

    // Advance to just past midnight the next day (but within 4 hours)
    vi.setSystemTime(new Date("2026-03-23T00:30:00Z"));
    const id2 = manager.getSessionId("test-key");

    // Date changed, so window index should reset to 0 even if > 4 hours
    const expected = deriveSessionId("test-key", "localhost:3000", "2026-03-23", 0);
    expect(id2).toBe(expected);
  });

  it("recomputes session ID when API key changes", () => {
    const manager = new SessionManager();
    const id1 = manager.getSessionId("old-key");
    const id2 = manager.getSessionId("new-key");

    expect(id2).not.toBe(id1);
    // Should re-derive with same window index but new key
    const expected = deriveSessionId("new-key", "localhost:3000", "2026-03-22", 0);
    expect(id2).toBe(expected);
  });

  it("preserves window index across API key change", () => {
    const manager = new SessionManager();
    manager.getSessionId("old-key");

    // Advance past 4 hours to increment window
    vi.advanceTimersByTime(5 * 60 * 60 * 1000);
    manager.getSessionId("old-key"); // window index is now 1

    // Change API key — should keep window index 1
    const id = manager.getSessionId("new-key");
    const expected = deriveSessionId("new-key", "localhost:3000", "2026-03-22", 1);
    expect(id).toBe(expected);
  });

  it("updates lastActivityTimestamp on each call", () => {
    const manager = new SessionManager();
    manager.getSessionId("test-key");

    // Advance 3 hours, call again (still within window)
    vi.advanceTimersByTime(3 * 60 * 60 * 1000);
    manager.getSessionId("test-key");

    // Advance another 3 hours — now 6h from start, but only 3h from last call
    vi.advanceTimersByTime(3 * 60 * 60 * 1000);
    const id = manager.getSessionId("test-key");

    // Should still be window 0 because activity was refreshed 3h ago
    const expected = deriveSessionId("test-key", "localhost:3000", "2026-03-22", 0);
    expect(id).toBe(expected);
  });
});
