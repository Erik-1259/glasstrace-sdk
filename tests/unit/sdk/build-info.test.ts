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
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.GLASSTRACE_BUILD_HASH;
    // Suppress and observe the SDK warning; sdkLog routes via console.warn.
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    if (ORIGINAL_BUILD_HASH === undefined) {
      delete process.env.GLASSTRACE_BUILD_HASH;
    } else {
      process.env.GLASSTRACE_BUILD_HASH = ORIGINAL_BUILD_HASH;
    }
    warnSpy.mockRestore();
  });

  describe("capture and normalization", () => {
    it("returns undefined when GLASSTRACE_BUILD_HASH is unset", async () => {
      const mod = await importFresh();
      expect(mod.getBuildHash()).toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("returns undefined for an empty string", async () => {
      process.env.GLASSTRACE_BUILD_HASH = "";
      const mod = await importFresh();
      expect(mod.getBuildHash()).toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("returns undefined for a whitespace-only value", async () => {
      process.env.GLASSTRACE_BUILD_HASH = "   \t  \n  ";
      const mod = await importFresh();
      expect(mod.getBuildHash()).toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("trims surrounding whitespace from the env value", async () => {
      process.env.GLASSTRACE_BUILD_HASH = "  9afcede123  ";
      const mod = await importFresh();
      expect(mod.getBuildHash()).toBe("9afcede123");
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("captures the value at module load and ignores later env mutations", async () => {
      // Use a SHA-shaped fixture so the validation branch does not
      // incidentally fire; the test asserts caching, not validation.
      process.env.GLASSTRACE_BUILD_HASH = "abc1234";
      const mod = await importFresh();
      expect(mod.getBuildHash()).toBe("abc1234");

      process.env.GLASSTRACE_BUILD_HASH = "def5678";
      // Same module instance — must still report the captured value
      expect(mod.getBuildHash()).toBe("abc1234");
    });
  });

  describe("shape validation — accepted SHA shapes (no warning)", () => {
    const accepted: Array<[label: string, value: string]> = [
      ["abbreviated SHA-1 (7 chars, lowercase)", "abc1234"],
      ["abbreviated SHA-1 (12 chars, mixed)", "abc123def456"],
      ["full SHA-1 (40 chars, lowercase)", "9afcede0a1b2c3d4e5f60718293a4b5c6d7e8f90"],
      ["full SHA-1 (40 chars, uppercase)", "9AFCEDE0A1B2C3D4E5F60718293A4B5C6D7E8F90"],
      ["full SHA-1 (40 chars, mixed case)", "9aFcEdE0A1b2C3d4E5f60718293A4b5c6D7e8F90"],
      ["full SHA-256 (64 chars, lowercase)", "a".repeat(64)],
      ["full SHA-256 (64 chars, uppercase)", "F".repeat(64)],
    ];

    for (const [label, value] of accepted) {
      it(`accepts ${label} without warning`, async () => {
        process.env.GLASSTRACE_BUILD_HASH = value;
        const mod = await importFresh();
        expect(mod.getBuildHash()).toBe(value);
        expect(warnSpy).not.toHaveBeenCalled();
      });
    }
  });

  describe("shape validation — mismatched values (warns, still returns)", () => {
    const mismatched: Array<[label: string, value: string]> = [
      ["non-hex (Vercel deployment ID)", "dpl_AbCdEf123"],
      ["non-hex (mixed letters and digits)", "version_2026.05.04"],
      ["too short (6 hex chars)", "abc123"],
      ["too long (65 hex chars)", "a".repeat(65)],
      ["far too long (1000 hex chars)", "a".repeat(1000)],
      ["internal whitespace", "abc def123"],
      ["internal newline", "abc\ndef123"],
      ["internal tab", "abc\tdef123"],
      ["control character (carriage return)", "abc1234\rdef"],
      ["control character (vertical tab)", "abc1234\vdef"],
      ["path-traversal shape", "../../etc/passwd"],
      ["path-traversal shape with hex prefix", "abc/../def"],
      ["leading zero-width space", "​abc1234"],
      ["Cyrillic homoglyph (а instead of a)", "аbc1234"],
      ["full-width digits", "１２３４５６７"],
      ["URL-shape", "https://example.com/build/abc1234"],
      ["JSON-like", '{"hash":"abc1234"}'],
      ["shell substitution leftover", "$(git rev-parse HEAD)"],
      ["out-of-charset hex letter (g)", "abc12g4"],
    ];

    for (const [label, value] of mismatched) {
      it(`warns once and still returns the value for: ${label}`, async () => {
        process.env.GLASSTRACE_BUILD_HASH = value;
        const mod = await importFresh();
        // The value still flows through — backward compatibility
        // requires that misshapen-but-set values reach ingestion so
        // build systems that emit non-SHA hashes (deliberately) keep
        // working. The warning is the user-visible diagnostic.
        expect(mod.getBuildHash()).toBe(value.trim());
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const message = String(warnSpy.mock.calls[0]?.[0] ?? "");
        expect(message).toContain("[glasstrace] warning: GLASSTRACE_BUILD_HASH=");
        expect(message).toContain("does not match expected SHA shape");
      });
    }
  });

  describe("warning redaction", () => {
    it("redacts short values to first 4 chars + ellipsis", async () => {
      process.env.GLASSTRACE_BUILD_HASH = "dpl_AbCd"; // 8 chars, non-hex
      const mod = await importFresh();
      expect(mod.getBuildHash()).toBe("dpl_AbCd");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(message).toContain("dpl_...");
      // The full value must NOT appear verbatim — defense in depth
      // against accidentally-set secrets.
      expect(message).not.toContain("dpl_AbCd ");
    });

    it("redacts long values to first 8 + last 4 with ellipsis", async () => {
      // 32 non-hex chars; sufficiently long that the redaction shape
      // shifts to the prefix...suffix form.
      const value = "secretvalue_with_no_hex_at_all_xxx";
      process.env.GLASSTRACE_BUILD_HASH = value;
      const mod = await importFresh();
      // Validation is lazy — calling getBuildHash() triggers the read.
      mod.getBuildHash();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0]?.[0] ?? "");
      // Prefix and suffix tokens appear; the middle never does.
      expect(message).toContain("secretva...");
      expect(message).toContain("_xxx");
      expect(message).not.toContain("with_no_hex_at_all");
    });

    it("does not echo a long mismatched value verbatim", async () => {
      const secretLike = "AKIAIOSFODNN7EXAMPLE_FAKE_KEY_VALUE";
      process.env.GLASSTRACE_BUILD_HASH = secretLike;
      const mod = await importFresh();
      expect(mod.getBuildHash()).toBe(secretLike);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0]?.[0] ?? "");
      // The middle of the secret must not appear in the warning.
      expect(message).not.toContain("IOSFODNN7EXAMPLE_FAKE");
    });

    it("sanitizes control bytes from the redacted prefix/suffix", async () => {
      // Env var containing newline, tab, carriage return, and a CSI
      // escape sequence — without sanitization these would corrupt
      // the warning log line or enable terminal control injection.
      const value = "abc\n\r\t\x1B[31mZZZZ_payload_marker_end\x07";
      process.env.GLASSTRACE_BUILD_HASH = value;
      const mod = await importFresh();
      expect(mod.getBuildHash()).toBe(value);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0]?.[0] ?? "");
      // Control bytes from the original value must not appear in the
      // emitted warning. A regression on the sanitizer would let any
      // of these bytes through and could break log formatting.
      // eslint-disable-next-line no-control-regex
      expect(message).not.toMatch(/[\x00-\x1F\x7F]/);
    });
  });

  describe("warning fires once per process", () => {
    it("emits at most one warning across multiple getBuildHash() calls", async () => {
      process.env.GLASSTRACE_BUILD_HASH = "not-a-sha";
      const mod = await importFresh();
      // Multiple calls into the cached getter must not re-emit the
      // warning — the read happens once at module load.
      mod.getBuildHash();
      mod.getBuildHash();
      mod.getBuildHash();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });
});
