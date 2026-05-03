import { describe, it, expect } from "vitest";
import {
  isHttpErrorStatus,
  sanitizeErrorResponseBody,
  truncateErrorResponseBody,
  prepareErrorResponseBody,
  ERROR_RESPONSE_BODY_MAX_BYTES,
  ERROR_RESPONSE_BODY_TRUNCATION_MARKER,
} from "../../../packages/sdk/src/error-response-body.js";

describe("error-response-body helpers (DISC-1216 Phase 2)", () => {
  describe("isHttpErrorStatus", () => {
    it("accepts the inclusive lower bound 400", () => {
      expect(isHttpErrorStatus(400)).toBe(true);
    });

    it("accepts the inclusive upper bound 599", () => {
      expect(isHttpErrorStatus(599)).toBe(true);
    });

    it("accepts mid-range 4xx and 5xx codes", () => {
      expect(isHttpErrorStatus(404)).toBe(true);
      expect(isHttpErrorStatus(422)).toBe(true);
      expect(isHttpErrorStatus(500)).toBe(true);
      expect(isHttpErrorStatus(503)).toBe(true);
    });

    it("rejects 2xx and 3xx success/redirect codes", () => {
      expect(isHttpErrorStatus(200)).toBe(false);
      expect(isHttpErrorStatus(204)).toBe(false);
      expect(isHttpErrorStatus(301)).toBe(false);
      expect(isHttpErrorStatus(399)).toBe(false);
    });

    it("rejects below-range and above-range numbers", () => {
      expect(isHttpErrorStatus(0)).toBe(false);
      expect(isHttpErrorStatus(99)).toBe(false);
      expect(isHttpErrorStatus(600)).toBe(false);
      expect(isHttpErrorStatus(1000)).toBe(false);
    });

    it("rejects non-finite and non-numeric values", () => {
      expect(isHttpErrorStatus(undefined)).toBe(false);
      expect(isHttpErrorStatus(null)).toBe(false);
      expect(isHttpErrorStatus(Number.NaN)).toBe(false);
      expect(isHttpErrorStatus(Number.POSITIVE_INFINITY)).toBe(false);
      expect(isHttpErrorStatus(true)).toBe(false);
    });

    it("coerces numeric-string inputs in the error range (Codex P2)", () => {
      // OTel attribute values are `string | number | boolean | array`.
      // Several instrumentations (custom HTTP wrappers, edge runtimes)
      // emit `http.status_code` / `http.response.status_code` as
      // strings. Without coercion the exporter would silently drop
      // `glasstrace.error.response_body` on those spans — a functional
      // regression versus the pre-gate behavior. Postel's Law: be
      // liberal in what we accept on the way in.
      expect(isHttpErrorStatus("400")).toBe(true);
      expect(isHttpErrorStatus("404")).toBe(true);
      expect(isHttpErrorStatus("500")).toBe(true);
      expect(isHttpErrorStatus("599")).toBe(true);
    });

    it("rejects numeric-string inputs outside the error range", () => {
      expect(isHttpErrorStatus("200")).toBe(false);
      expect(isHttpErrorStatus("301")).toBe(false);
      expect(isHttpErrorStatus("399")).toBe(false);
      expect(isHttpErrorStatus("600")).toBe(false);
      expect(isHttpErrorStatus("0")).toBe(false);
    });

    it("rejects non-numeric strings (Number-coerce yields NaN)", () => {
      expect(isHttpErrorStatus("foo")).toBe(false);
      expect(isHttpErrorStatus("4xx")).toBe(false);
      expect(isHttpErrorStatus("five hundred")).toBe(false);
      expect(isHttpErrorStatus("")).toBe(false);
    });

    it("accepts whitespace-padded numeric strings (Number ignores leading/trailing space)", () => {
      // `Number(" 500 ")` is `500`. Some instrumentations re-emit
      // header values verbatim including any incidental whitespace.
      expect(isHttpErrorStatus(" 500 ")).toBe(true);
      expect(isHttpErrorStatus("\t404\n")).toBe(true);
    });
  });

  describe("sanitizeErrorResponseBody", () => {
    it("redacts a Bearer token", () => {
      const out = sanitizeErrorResponseBody("Authorization: Bearer abc.def.ghi was rejected");
      expect(out).toBe("Authorization: [REDACTED] was rejected");
    });

    it("redacts a Bearer token regardless of scheme casing", () => {
      // HTTP frameworks and proxies round-trip the auth scheme with
      // inconsistent casing — `bearer` and `BEARER` are equally
      // common in real error bodies. A real token leaks just as
      // badly under any of them, so the regex is case-insensitive on
      // the scheme (Codex P1).
      expect(sanitizeErrorResponseBody("authorization: bearer abc.def.ghi rejected")).toBe(
        "authorization: [REDACTED] rejected",
      );
      expect(sanitizeErrorResponseBody("AUTHORIZATION: BEARER abc.def.ghi rejected")).toBe(
        "AUTHORIZATION: [REDACTED] rejected",
      );
    });

    it("redacts a JWT-shaped token", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      const out = sanitizeErrorResponseBody(`got ${jwt} expired`);
      expect(out).toContain("[REDACTED]");
      expect(out).not.toContain(jwt);
    });

    it("does NOT redact a 3-segment semantic version (no JWT false positive on dotted text)", () => {
      // Three short segments separated by dots; each segment is well
      // below the JWT minimum-segment size (16/8/8). A sample release
      // like "1.2.3" must pass through unredacted to avoid mangling
      // stack traces.
      const out = sanitizeErrorResponseBody("Error in package@1.2.3 module");
      expect(out).toBe("Error in package@1.2.3 module");
    });

    it("does NOT redact a stack-frame-shaped triple like react.dom.server", () => {
      // The first segment must be ≥16 base64url-chars to look like a
      // JWT header. Dotted module identifiers stay intact.
      const out = sanitizeErrorResponseBody("at react.dom.server in stack");
      expect(out).toBe("at react.dom.server in stack");
    });

    it("redacts a Glasstrace dev API key", () => {
      const key = "gt_dev_" + "a".repeat(48);
      const out = sanitizeErrorResponseBody(`key=${key} was bad`);
      expect(out).not.toContain(key);
      expect(out).toContain("[REDACTED]");
    });

    it("redacts a Glasstrace anon API key", () => {
      const key = "gt_anon_" + "B".repeat(32);
      const out = sanitizeErrorResponseBody(`anon=${key}`);
      expect(out).not.toContain(key);
      expect(out).toContain("[REDACTED]");
    });

    it("redacts an AWS long-lived (AKIA) access key", () => {
      const out = sanitizeErrorResponseBody("got AKIAIOSFODNN7EXAMPLE here");
      expect(out).toContain("[REDACTED]");
      expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });

    it("redacts an AWS session (ASIA) access key", () => {
      const out = sanitizeErrorResponseBody("got ASIAIOSFODNN7EXAMPLE here");
      expect(out).toContain("[REDACTED]");
      expect(out).not.toContain("ASIAIOSFODNN7EXAMPLE");
    });

    it("does NOT match an arbitrary 20-char alphanumeric token starting with letters", () => {
      // Only AKIA/ASIA prefixes match — random uppercase tokens stay intact.
      const out = sanitizeErrorResponseBody("ZZZZIOSFODNN7EXAMPLE is not a key");
      expect(out).toBe("ZZZZIOSFODNN7EXAMPLE is not a key");
    });

    it("redacts a key=value secret", () => {
      const out = sanitizeErrorResponseBody('api_key=sk-test-12345 failed');
      expect(out).toContain("[REDACTED]");
      expect(out).not.toContain("sk-test-12345");
    });

    it("redacts apiKey:value (camelCase, colon separator)", () => {
      const out = sanitizeErrorResponseBody('"apikey": "sk-deadbeef" rejected');
      expect(out).toContain("[REDACTED]");
      expect(out).not.toContain("sk-deadbeef");
    });

    it("redacts password=value", () => {
      const out = sanitizeErrorResponseBody('password="hunter2" was wrong');
      expect(out).toContain("[REDACTED]");
      expect(out).not.toContain("hunter2");
    });

    it("redacts a quoted multi-word password value through the closing quote", () => {
      // The bare-value variant stops at whitespace; a multi-word
      // value like `password="my secret phrase"` would otherwise leak
      // everything after the first space (Codex P1). The quoted
      // variant consumes through the closing `"`.
      const out = sanitizeErrorResponseBody('password="my secret phrase" rejected');
      expect(out).not.toContain("my secret phrase");
      expect(out).not.toContain("secret phrase");
      expect(out).toContain("[REDACTED]");
    });

    it("redacts a quoted multi-word secret with internal escapes", () => {
      const out = sanitizeErrorResponseBody('secret="don\\"t leak this" rejected');
      expect(out).not.toContain("don");
      expect(out).not.toContain("leak this");
      expect(out).toContain("[REDACTED]");
    });

    it("does NOT redact 'passwordless' (substring of 'password')", () => {
      const out = sanitizeErrorResponseBody("Use the passwordless flow");
      expect(out).toBe("Use the passwordless flow");
    });

    it("does NOT redact ordinary error text without secrets", () => {
      const ordinary = '{"error":{"code":"NOT_FOUND","message":"poll abc-123 not found"}}';
      const out = sanitizeErrorResponseBody(ordinary);
      expect(out).toBe(ordinary);
    });

    it("handles an empty string without throwing", () => {
      expect(sanitizeErrorResponseBody("")).toBe("");
    });

    it("redacts multiple distinct secret patterns in the same body", () => {
      const body =
        "Bearer token-xyz failed; api_key=sk-abc rejected; AKIAIOSFODNN7EXAMPLE seen";
      const out = sanitizeErrorResponseBody(body);
      expect(out).not.toContain("token-xyz");
      expect(out).not.toContain("sk-abc");
      expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(out.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("truncateErrorResponseBody", () => {
    it("returns the input unchanged when strictly within the byte budget", () => {
      const body = "x".repeat(ERROR_RESPONSE_BODY_MAX_BYTES - 100);
      expect(truncateErrorResponseBody(body)).toBe(body);
    });

    it("returns the input unchanged at exactly the byte budget (boundary)", () => {
      const body = "x".repeat(ERROR_RESPONSE_BODY_MAX_BYTES);
      const out = truncateErrorResponseBody(body);
      expect(out).toBe(body);
      expect(out.endsWith(ERROR_RESPONSE_BODY_TRUNCATION_MARKER)).toBe(false);
    });

    it("truncates a body that is one byte over the budget and appends the marker", () => {
      const body = "x".repeat(ERROR_RESPONSE_BODY_MAX_BYTES + 1);
      const out = truncateErrorResponseBody(body);
      expect(out.endsWith(ERROR_RESPONSE_BODY_TRUNCATION_MARKER)).toBe(true);
      expect(out.length).toBe(ERROR_RESPONSE_BODY_MAX_BYTES + ERROR_RESPONSE_BODY_TRUNCATION_MARKER.length);
    });

    it("does not split a 3-byte UTF-8 codepoint at the truncation boundary", () => {
      // CJK character 猫 is 3 bytes in UTF-8. With a 4096-byte budget,
      // 1366 chars × 3 bytes = 4098 bytes — 2 over the limit, landing
      // the cut inside a codepoint. The decoder must back off rather
      // than ship a U+FFFD.
      const cjk = "猫";
      const body = cjk.repeat(1366);
      const out = truncateErrorResponseBody(body);
      expect(out).not.toContain("�");
      expect(out.endsWith(ERROR_RESPONSE_BODY_TRUNCATION_MARKER)).toBe(true);
    });

    it("does not split a 4-byte UTF-8 codepoint (surrogate pair) at the boundary", () => {
      // U+1F4A1 (light bulb) encodes as 4 bytes in UTF-8 and 2 UTF-16
      // code units (a surrogate pair). 1024 chars × 4 bytes = 4096
      // bytes exactly; 1025 chars = 4100 bytes, putting the cut
      // mid-codepoint.
      const emoji = "💡";
      const body = emoji.repeat(1025);
      const out = truncateErrorResponseBody(body);
      expect(out).not.toContain("�");
      expect(out.endsWith(ERROR_RESPONSE_BODY_TRUNCATION_MARKER)).toBe(true);
      // The visible portion should still be a sequence of complete
      // emoji — every char prior to the marker is part of a valid pair.
      const visible = out.slice(0, -ERROR_RESPONSE_BODY_TRUNCATION_MARKER.length);
      expect(Array.from(visible).every((c) => c === emoji)).toBe(true);
    });

    it("appends the marker on a much-larger-than-budget input and the visible portion fits in the byte budget", () => {
      const body = "z".repeat(10_000);
      const out = truncateErrorResponseBody(body);
      expect(out.endsWith(ERROR_RESPONSE_BODY_TRUNCATION_MARKER)).toBe(true);
      const visible = out.slice(0, -ERROR_RESPONSE_BODY_TRUNCATION_MARKER.length);
      expect(new TextEncoder().encode(visible).byteLength).toBeLessThanOrEqual(
        ERROR_RESPONSE_BODY_MAX_BYTES,
      );
    });

    it("preserves a legitimate U+FFFD character when the body fits the budget", () => {
      // U+FFFD is 3 bytes in UTF-8 (EF BF BD). When the body is
      // already within budget, no slicing happens and the replacement
      // character must round-trip unchanged. The previous version of
      // the helper unconditionally stripped a trailing U+FFFD, which
      // would have lost the real character on truncation paths.
      const body = "error: parsed corrupt rune � here";
      expect(truncateErrorResponseBody(body)).toBe(body);
    });

    it("does not synthesize a U+FFFD when truncation lands on a multi-byte boundary", () => {
      // The codepoint-aware backoff means we never invoke
      // TextDecoder on a partial sequence. Encode + slice + decode
      // therefore produces no synthesized replacement character.
      const cjk = "猫";
      const body = cjk.repeat(1366);
      const out = truncateErrorResponseBody(body);
      expect(out).not.toContain("�");
    });
  });

  describe("prepareErrorResponseBody", () => {
    it("returns null for empty input", () => {
      expect(prepareErrorResponseBody("")).toBeNull();
    });

    it("returns null for whitespace-only input", () => {
      expect(prepareErrorResponseBody("   \n\t  ")).toBeNull();
    });

    it("sanitizes and returns non-empty input", () => {
      const out = prepareErrorResponseBody("Bearer abc.def.ghi");
      expect(out).toBe("[REDACTED]");
    });

    it("sanitizes BEFORE truncation so secrets straddling the boundary are removed", () => {
      // Place a Bearer token straddling the 4096-byte boundary; if
      // truncation happened first, the token would be cut and the
      // suffix after the cut would never be redacted (the input to
      // sanitization would lack the suffix). Sanitization-first
      // guarantees the full pattern is matched while the body is
      // intact. The space before `Bearer` is required for the
      // word-boundary anchor in the Bearer regex.
      const padding = "x".repeat(4079) + " ";
      const token = "Bearer secrettokenstraddling123456";
      const body = padding + token;
      const out = prepareErrorResponseBody(body);
      // After sanitize the token becomes [REDACTED]; the resulting
      // body fits comfortably under 4096 bytes so no truncation marker
      // is appended.
      expect(out).toContain("[REDACTED]");
      expect(out).not.toContain("secrettokenstraddling");
    });

    it("returns the sanitized + truncated body for an oversize input", () => {
      const huge = "Bearer abc.def.ghi " + "z".repeat(10_000);
      const out = prepareErrorResponseBody(huge);
      expect(out).not.toBeNull();
      expect(out!).toContain("[REDACTED]");
      expect(out!.endsWith(ERROR_RESPONSE_BODY_TRUNCATION_MARKER)).toBe(true);
    });
  });
});
