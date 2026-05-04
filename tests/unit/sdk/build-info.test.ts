/**
 * Tests for build-info.ts — `GLASSTRACE_BUILD_HASH` env-var capture.
 *
 * The module captures the env var once at module load and caches the
 * value, so each test re-imports through `vi.resetModules()` to get a
 * fresh capture.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ORIGINAL_BUILD_HASH = process.env.GLASSTRACE_BUILD_HASH;

async function importFresh(): Promise<typeof import("../../../packages/sdk/src/build-info.js")> {
  vi.resetModules();
  return import("../../../packages/sdk/src/build-info.js");
}

describe("build-info", () => {
  beforeEach(() => {
    delete process.env.GLASSTRACE_BUILD_HASH;
  });

  afterEach(() => {
    if (ORIGINAL_BUILD_HASH === undefined) {
      delete process.env.GLASSTRACE_BUILD_HASH;
    } else {
      process.env.GLASSTRACE_BUILD_HASH = ORIGINAL_BUILD_HASH;
    }
  });

  it("returns undefined when GLASSTRACE_BUILD_HASH is unset", async () => {
    const mod = await importFresh();
    expect(mod.getBuildHash()).toBeUndefined();
  });

  it("returns the env value when set", async () => {
    process.env.GLASSTRACE_BUILD_HASH = "abc123def456";
    const mod = await importFresh();
    expect(mod.getBuildHash()).toBe("abc123def456");
  });

  it("returns undefined for an empty string", async () => {
    process.env.GLASSTRACE_BUILD_HASH = "";
    const mod = await importFresh();
    expect(mod.getBuildHash()).toBeUndefined();
  });

  it("returns undefined for a whitespace-only value", async () => {
    process.env.GLASSTRACE_BUILD_HASH = "   \t  \n  ";
    const mod = await importFresh();
    expect(mod.getBuildHash()).toBeUndefined();
  });

  it("trims surrounding whitespace from the env value", async () => {
    process.env.GLASSTRACE_BUILD_HASH = "  9afcede123  ";
    const mod = await importFresh();
    expect(mod.getBuildHash()).toBe("9afcede123");
  });

  it("captures the value at module load and ignores later env mutations", async () => {
    process.env.GLASSTRACE_BUILD_HASH = "first-value";
    const mod = await importFresh();
    expect(mod.getBuildHash()).toBe("first-value");

    process.env.GLASSTRACE_BUILD_HASH = "second-value";
    // Same module instance — must still report the captured value
    expect(mod.getBuildHash()).toBe("first-value");
  });

  it("accepts a 40-char git SHA-1", async () => {
    const sha = "9afcede0a1b2c3d4e5f60718293a4b5c6d7e8f90";
    process.env.GLASSTRACE_BUILD_HASH = sha;
    const mod = await importFresh();
    expect(mod.getBuildHash()).toBe(sha);
  });

  it("accepts a 64-char SHA-256 fallback", async () => {
    const hash = "a".repeat(64);
    process.env.GLASSTRACE_BUILD_HASH = hash;
    const mod = await importFresh();
    expect(mod.getBuildHash()).toBe(hash);
  });
});
