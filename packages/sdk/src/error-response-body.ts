/**
 * Helpers for the `glasstrace.error.response_body` span attribute (DISC-1216).
 *
 * The exporter promotes an internal `glasstrace.internal.response_body`
 * attribute to the public `glasstrace.error.response_body` attribute when
 * three conditions hold:
 *
 *   1. The account-side `captureConfig.errorResponseBodies` flag is `true`.
 *   2. The HTTP status on the span is in the inclusive range `[400..599]`.
 *   3. The body is a non-empty string.
 *
 * Before promotion, the body is sanitized to strip well-known secret-ish
 * patterns and then truncated to a hard byte budget. Sanitization runs
 * BEFORE truncation so that secrets straddling the truncation boundary are
 * still redacted in the visible portion. Truncation respects UTF-8 codepoint
 * boundaries — slicing a JS string at a UTF-16 code unit can leave a lone
 * surrogate or split a multi-byte UTF-8 sequence in the encoded form, and
 * downstream consumers (the ingestion pipeline, the Glasstrace UI) re-encode
 * spans through a Buffer round-trip that does not tolerate malformed input.
 *
 * Design constraints:
 *   - Zero new runtime dependencies. Inline regex only.
 *   - Pure functions: easy to unit-test without span mocks.
 *   - Conservative redaction: when in doubt, redact. False positives that
 *     turn a JSON `password` field into `[REDACTED]` are acceptable; false
 *     negatives that leak a token are not.
 *
 * @drift-check DISC-1216 (Phase 2 — sanitize, status-gate, raise truncation cap).
 */

/**
 * Maximum byte length for the captured response body.
 *
 * Set to 4096 bytes to fit comfortably under typical OTel span attribute
 * size limits (commonly 8 KB) while leaving headroom for the rest of the
 * `glasstrace.*` attribute set on the same span. The Phase 1 cap was
 * 500 chars, which truncated typical tRPC error envelopes mid-payload.
 */
export const ERROR_RESPONSE_BODY_MAX_BYTES = 4096;

/**
 * Marker appended when the body was truncated to fit the byte budget.
 * Lets downstream consumers detect that the body is partial and avoid
 * parsing a partial JSON envelope as authoritative.
 */
export const ERROR_RESPONSE_BODY_TRUNCATION_MARKER = "...[truncated]";

/**
 * Replacement token written into the body in place of any matched secret.
 * Kept ASCII-only so it never inflates the byte count past truncation.
 */
const REDACTED = "[REDACTED]";

/**
 * Inclusive lower bound of the HTTP status range that triggers capture.
 */
export const ERROR_STATUS_MIN = 400;

/**
 * Inclusive upper bound of the HTTP status range that triggers capture.
 */
export const ERROR_STATUS_MAX = 599;

/**
 * Coerces an OTel attribute value to an HTTP status number, or returns
 * `undefined` when the value is not a finite numeric (or numeric-string)
 * representation of a status.
 *
 * The OpenTelemetry attribute spec allows
 * `string | number | boolean | (string | number | boolean)[]`. Several
 * real-world instrumentations (custom HTTP wrappers, edge runtimes that
 * round-trip headers verbatim, some community Node adapters) emit
 * `http.status_code` and `http.response.status_code` as strings (e.g.
 * `"500"`). The SDK exporter previously read these via TypeScript
 * `as number | undefined` casts that perform no runtime coercion, so a
 * string-shaped `"200"` would (a) flow verbatim into the public
 * `glasstrace.http.status_code` wire attribute (which downstream
 * ingestion expects to be numeric) and (b) fail the
 * `statusCode === 200` comparison that the Next.js timing-race
 * inference block (DISC-1134, DISC-1204) relies on. This helper closes
 * both gaps at the read site.
 *
 * Postel's Law: be liberal in what we accept. The behavior is identical
 * to {@link isHttpErrorStatus}'s coercion step (the latter delegates
 * here for symmetry), and `Number()`'s semantics determine string
 * acceptance:
 *
 *   - Numbers pass through when {@link Number.isFinite} is `true`.
 *     `NaN` and `±Infinity` return `undefined`.
 *   - Strings are trimmed and rejected when the trimmed value is
 *     empty (so `""`, `"   "`, `"\t\n"` all return `undefined`). The
 *     trimmed value is then coerced via `Number(value)` and accepted
 *     when the result is finite. `"500"`, `" 500 "`, `"5e2"`, `"0x1F4"`
 *     all yield `500`.
 *   - Empty / whitespace-only strings, non-numeric strings (`"foo"`,
 *     `"4xx"`), `null`, `undefined`, booleans, objects, arrays, and
 *     symbols all return `undefined`.
 *
 * The whitespace-only guard matters: `Number("   ") === 0`, so without
 * the trim check a whitespace-only attribute would (a) emit a numeric
 * `0` into the wire payload — masking a fallback to
 * `http.response.status_code` via `??` — and (b) trigger the
 * inference block's `statusCode === 0` discriminator, synthesizing a
 * 500 from blank input. Treat blank strings the same as the empty
 * string and the other invalid shapes.
 *
 * Note: this helper coerces to a numeric *type*; it does not validate
 * the value lies in any HTTP-status range. The caller is responsible
 * for any further range checks (e.g. {@link isHttpErrorStatus} for the
 * 4xx/5xx capture gate).
 */
export function coerceHttpStatus(value: unknown): number | undefined {
  let numeric: number;
  if (typeof value === "number") {
    numeric = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    numeric = Number(trimmed);
  } else {
    return undefined;
  }
  return Number.isFinite(numeric) ? numeric : undefined;
}

/**
 * Returns `true` when the supplied status code is an HTTP error status
 * (4xx or 5xx). Non-finite, non-numeric, and out-of-range values yield
 * `false`. The status comes from OTel attribute values which are typed
 * `unknown`-ish in practice (string | number | boolean | array), so the
 * caller may pass anything and rely on this guard.
 *
 * Numeric strings (e.g. `"500"`) are coerced via {@link coerceHttpStatus}
 * before the range check. The OTel attribute spec allows
 * `string | number | boolean | array`, and several real-world
 * instrumentations (custom HTTP wrappers, edge runtimes that round-trip
 * headers verbatim) emit `http.status_code` and
 * `http.response.status_code` as strings. Without coercion the exporter
 * would silently drop `glasstrace.error.response_body` on those spans,
 * which is a false negative — Postel's Law: be liberal in what we accept.
 * `Number(non-numeric)` returns `NaN`, which fails the
 * `Number.isFinite` check, so `"foo"` still yields `false`. Empty and
 * whitespace-only strings are rejected by `coerceHttpStatus` before
 * reaching the range check, so they cannot coerce to `0` and trigger an
 * out-of-range `false` via the numeric path.
 */
export function isHttpErrorStatus(status: unknown): boolean {
  const numeric = coerceHttpStatus(status);
  if (numeric === undefined) return false;
  return numeric >= ERROR_STATUS_MIN && numeric <= ERROR_STATUS_MAX;
}

/**
 * Redaction patterns applied in order. Each entry's regex is global so
 * `String.replace` substitutes every match. Patterns are intentionally
 * narrow enough that ordinary error text (e.g. a stack trace, an SQL
 * query echoed back in the error envelope) is not over-redacted.
 *
 * Pattern provenance:
 *   - `Bearer`: HTTP Authorization header echoed in error responses.
 *   - JWT: any 3-segment base64url-encoded token, common in OAuth/OIDC
 *     misconfiguration errors.
 *   - `gt_dev_*` / `gt_anon_*`: Glasstrace API key prefixes; these MUST
 *     never reach the ingestion pipeline because the pipeline keys auth
 *     on the same prefix.
 *   - AWS access keys: `AKIA…` (long-lived) and `ASIA…` (session) are
 *     fixed 20-char identifiers.
 *   - `key=value` style: any of `api_key`, `apikey`, `secret`, `password`,
 *     `token` followed by `:` or `=`. The trailing capture is non-greedy
 *     and stops at whitespace, comma, semicolon, or closing brace/bracket
 *     so we do not redact past the value into surrounding context.
 */
const REDACTION_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // Order matters: redact specific token shapes BEFORE the generic
  // key=value catcher so a literal `Bearer eyJ…` collapses into a single
  // [REDACTED] and the JWT regex does not separately match the suffix.
  {
    name: "bearer",
    // Case-insensitive on the scheme: HTTP frameworks and proxies
    // round-trip the auth scheme with inconsistent casing
    // (`Bearer`, `bearer`, `BEARER`), and a real token leaks just as
    // badly under any of them.
    pattern: /\bBearer\s+[A-Za-z0-9._\-+/=]+/gi,
  },
  {
    name: "jwt",
    // Three base64url segments separated by dots. Real JWTs encode at
    // minimum a small JSON header in the first segment, which alone is
    // typically ≥10 chars after base64url; a 16-char floor avoids false
    // positives on dotted text like a stack-trace frame
    // (`react.dom.server`) while still catching every real JWT we have
    // seen in the wild. Anchored with word boundaries on both sides so
    // a 3-dot semantic version like "next@15.4.1.2" does not match.
    pattern: /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    name: "glasstrace-api-key",
    // gt_dev_* and gt_anon_* keys are >=24 chars of [A-Za-z0-9].
    pattern: /\bgt_(?:dev|anon)_[A-Za-z0-9]{16,}\b/g,
  },
  {
    name: "aws-access-key",
    // 20-char prefix-fixed identifier.
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    name: "key-value-secret-quoted",
    // Quoted-string variant: (key) [:=] "<value>". The value runs to
    // the next unescaped closing quote so a multi-word secret like
    // `password="my secret phrase"` is fully consumed instead of
    // splitting at the first space and leaving the tail visible.
    // The leading `(?<![A-Za-z0-9_])` prevents matching inside
    // identifiers like `passwordless`. The trailing `"?` after the
    // keyword absorbs the closing quote in JSON-style `"apikey":
    // "value"` so the colon is still seen as the separator.
    pattern: /(?<![A-Za-z0-9_])(?:api[_-]?key|apikey|secret|password|token)"?\s*[:=]\s*"(?:[^"\\]|\\.)*"/gi,
  },
  {
    name: "key-value-secret-bare",
    // Unquoted variant: (key) [:=] <bare-value>. The bare value
    // capture stops at common JSON/text delimiters so we redact only
    // the value, not surrounding structure. Listed AFTER the quoted
    // variant so a quoted value's surrounding `"` are consumed by
    // the first pattern and we never fall through here for a quoted
    // secret.
    pattern: /(?<![A-Za-z0-9_])(?:api[_-]?key|apikey|secret|password|token)"?\s*[:=]\s*[^\s,;}\]"]+/gi,
  },
];

/**
 * Applies redaction patterns to `body`, returning a new string. The original
 * is never mutated. If no pattern matches, the input is returned unchanged
 * (reference-equal where possible — `String.replace` returns the same
 * string instance when no replacement is applied).
 */
export function sanitizeErrorResponseBody(body: string): string {
  let out = body;
  for (const { pattern } of REDACTION_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Truncates `body` to at most {@link ERROR_RESPONSE_BODY_MAX_BYTES} bytes
 * when encoded as UTF-8. Bodies already within the budget are returned
 * unchanged. When truncation fires, the result is the longest valid
 * UTF-8 prefix that fits within the budget, followed by the truncation
 * marker. The marker is appended in JS-string form and is NOT counted
 * toward the byte budget so consumers always see a clear "partial"
 * signal even at the worst case.
 *
 * The implementation uses `TextEncoder` / `TextDecoder` rather than
 * `Buffer` because `String.prototype.slice` operates on UTF-16 code
 * units; a naive slice can split a 4-byte codepoint at a surrogate pair
 * or a multi-byte UTF-8 sequence at a non-leading byte. We slice the
 * encoded byte array on a UTF-8 codepoint boundary by walking the
 * cut backward past any continuation bytes (`10xxxxxx`) before
 * decoding, so we never present a body that ends in a synthesized
 * U+FFFD. A real U+FFFD in the original body is encoded as the
 * 3-byte sequence `EF BF BD` and is preserved unchanged.
 *
 * `TextEncoder` and `TextDecoder` are globals on every supported runtime
 * (Node ≥18, all edge runtimes, all modern browsers), so this helper
 * does not pin the enclosing module to the Node-only side of the
 * F003 runtime gate by itself.
 */
export function truncateErrorResponseBody(body: string): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(body);
  if (encoded.byteLength <= ERROR_RESPONSE_BODY_MAX_BYTES) {
    return body;
  }

  // Adjust `cut` so the slice lands on a UTF-8 codepoint boundary.
  // UTF-8 byte classes:
  //   0xxxxxxx — ASCII (1-byte codepoint).
  //   10xxxxxx — continuation byte (0x80–0xBF).
  //   110xxxxx — leading byte of a 2-byte codepoint.
  //   1110xxxx — leading byte of a 3-byte codepoint.
  //   11110xxx — leading byte of a 4-byte codepoint.
  // Strategy: walk backward from `cut - 1` past continuation bytes
  // until we find a leading or ASCII byte; that is the start of the
  // codepoint that may straddle the boundary. If the codepoint's
  // expected length runs past `cut`, drop it (set `cut` to the
  // leading byte's index). Otherwise leave `cut` alone — the
  // codepoint is fully contained and the slice is clean.
  let cut = ERROR_RESPONSE_BODY_MAX_BYTES;
  let scan = cut - 1;
  while (scan >= 0 && (encoded[scan] & 0xc0) === 0x80) {
    scan -= 1;
  }
  if (scan >= 0) {
    const leading = encoded[scan];
    let expected = 1;
    if ((leading & 0x80) === 0) {
      expected = 1; // ASCII
    } else if ((leading & 0xe0) === 0xc0) {
      expected = 2;
    } else if ((leading & 0xf0) === 0xe0) {
      expected = 3;
    } else if ((leading & 0xf8) === 0xf0) {
      expected = 4;
    }
    if (scan + expected > cut) {
      // Codepoint runs past the cut — drop it entirely.
      cut = scan;
    }
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const sliced = encoded.subarray(0, cut);
  const decoded = decoder.decode(sliced);

  return decoded + ERROR_RESPONSE_BODY_TRUNCATION_MARKER;
}

/**
 * End-to-end pipeline: sanitize, then truncate. Returns the string ready
 * to attach as `glasstrace.error.response_body`, or `null` if the body
 * is unsuitable for capture (empty or whitespace-only after redaction).
 *
 * The empty-after-sanitize guard is conservative: a body that consists
 * entirely of a redacted secret yields `[REDACTED]` and IS still
 * captured (it tells the operator that *something* error-shaped came
 * back). Only literal empty string / whitespace returns `null`.
 */
export function prepareErrorResponseBody(body: string): string | null {
  if (body.length === 0) return null;
  if (body.trim().length === 0) return null;
  const sanitized = sanitizeErrorResponseBody(body);
  return truncateErrorResponseBody(sanitized);
}
