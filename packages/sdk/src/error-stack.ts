/**
 * Helpers for the `glasstrace.error.stack` span attribute.
 *
 * The exporter promotes an OTel `exception.stacktrace` (read from a span
 * event or, as a fallback, a span attribute) to the public
 * `glasstrace.error.stack` attribute. Before promotion the stack is:
 *
 *   1. Sanitized to redact absolute local paths, URL query strings and
 *      fragments, and well-known credential patterns. The same
 *      credential redactor as `error-response-body.ts` is reused so a
 *      stack-trace frame echoing a `Bearer …` header is treated
 *      identically to a response-body fragment carrying the same value.
 *   2. Truncated to a hard byte budget. Sanitization runs BEFORE
 *      truncation so a credential straddling the truncation boundary is
 *      still removed from the visible portion. Truncation respects
 *      UTF-8 codepoint boundaries via the same `TextEncoder` /
 *      `TextDecoder` walk used by `error-response-body.ts`.
 *
 * Two sibling boolean attributes accompany every emitted stack:
 *
 *   - `glasstrace.error.stack.truncated` — `true` iff truncation fired.
 *   - `glasstrace.error.stack.redacted` — `true` iff at least one
 *     sanitization rule (path normalization, URL query stripping, or
 *     credential redaction) produced a change.
 *
 * Design constraints (mirrored from `error-response-body.ts`):
 *   - Zero new runtime dependencies. Inline regex only.
 *   - Pure functions: easy to unit-test without span mocks.
 *   - Conservative: when in doubt, redact. False positives that
 *     replace an unusual abs path with a normalized form are
 *     acceptable; false negatives that leak a `/Users/<name>/` home
 *     prefix or an unredacted Bearer token are not.
 *
 * Out of scope for v1:
 *   - Parsed `StackFrameSummary[]` structured attribute output. The
 *     v1 contract is bounded `exception.stacktrace` input for the
 *     product-side stack-summary parser.
 *   - Source-map resolution to original source paths. The SDK already
 *     emits the top user-relevant frame's source via
 *     `glasstrace.source.{file,line,mapped}` on `captureError()` span
 *     events; that path is unchanged.
 *
 * @drift-check ../../glasstrace-product/docs/component-designs/agent-evidence-sdk-attribute-contract.md §5.5 (Error Evidence)
 */

import { sanitizeErrorResponseBody } from "./error-response-body.js";

/**
 * Maximum byte length for the captured stack.
 *
 * Set to 8192 bytes. Stacks are longer than typical error-response
 * bodies (each V8 frame is ~80–200 bytes; a 30-frame stack is
 * comfortably under 8 KB while a 100-frame deep async stack runs
 * past). Most agent-facing consumers care about the top 10–30 frames;
 * truncation past the budget is acceptable when accompanied by the
 * `truncated: true` sibling attribute so consumers do not interpret
 * the absence of a frame as proof it was not on the stack.
 */
export const ERROR_STACK_MAX_BYTES = 8192;

/**
 * Marker appended when the stack was truncated to fit the byte budget.
 * Distinct token from `error-response-body.ts`'s marker so consumers
 * can tell at a glance which evidence class produced the partial.
 */
export const ERROR_STACK_TRUNCATION_MARKER = "...[stack truncated]";

/**
 * Replacement token written in place of any normalized abs path.
 */
const PATH_REDACTED = "<path>";

/**
 * Path-prefix markers we keep when stripping abs paths. The first
 * occurrence of any marker (matched as `/<marker>/`) anchors the
 * relative form; everything before it is replaced with the
 * {@link PATH_REDACTED} sentinel. Order matters: the LAST marker we
 * see in left-to-right scan would normally win, but we anchor to the
 * RIGHTMOST occurrence so a path like
 * `/Users/erik/proj/node_modules/.pnpm/.../node_modules/foo/index.js`
 * keeps both `node_modules` segments — which is the structural truth
 * (the inner one is where the actual frame lives).
 *
 * Additions / removals here change agent-facing stack readability;
 * keep this set conservative and in sync with `tests/unit/sdk/error-stack.test.ts`.
 */
const PATH_KEEP_MARKERS: readonly string[] = [
  "node_modules",
  ".next",
  ".glasstrace",
  "src",
  "dist",
  "build",
  "lib",
  "app",
  "pages",
];

/**
 * Single-frame path candidate. Captures the entire path token plus
 * the trailing `:line[:col]` if present. The path body is permissive
 * (anything but whitespace, paren, and angle brackets) so we catch:
 *
 *   - POSIX abs:    `/Users/erik/proj/src/file.ts:10:5`
 *   - Windows abs:  `C:\Users\erik\proj\src\file.ts:10:5`
 *   - file:// URI:  `file:///Users/erik/proj/src/file.ts:10:5`
 *   - webpack:      `webpack-internal:///./src/file.ts:10:5`
 *   - node:         `node:internal/process/main_thread_only:75:7`
 *
 * The leading anchors `(?<=^|[\s(])` ensure we only match path tokens
 * preceded by whitespace, line start, or `(` (the V8 frame open paren).
 * That keeps us from over-matching inside arbitrary text that happens
 * to contain a path-shaped substring.
 */
const PATH_TOKEN_RE = /(?<=^|[\s(])(\/[^\s()<>]+|[A-Za-z]:\\[^\s()<>]+|file:\/\/\/[^\s()<>]+|webpack-internal:\/\/[^\s()<>]+|node:[^\s()<>]+)/g;

/**
 * URL with query/fragment. Strips `?...` and `#...` from URLs that
 * appear inside stack frames (rare, but happens for source maps
 * served behind tokens or Next.js route URLs echoed in errors).
 *
 * The capture group keeps the URL-prefix-up-to-`?-or-#` so a
 * replacement substitutes only the suffix.
 */
const URL_QUERY_FRAGMENT_RE = /(\bhttps?:\/\/[^\s?#()<>]+)([?#][^\s()<>]*)/g;

/**
 * Normalize a single path token. Returns the original if no
 * normalization was needed; otherwise returns the rewritten form.
 * The boolean second tuple element tells the caller whether a change
 * happened (for the `redacted: true` sibling attribute).
 */
function normalizePathToken(token: string): { token: string; changed: boolean } {
  // file:// URI prefix: drop the scheme so the underlying abs path
  // can be processed by the same logic.
  let work = token;
  if (work.startsWith("file:///")) {
    work = work.slice("file://".length);
  }

  // webpack-internal and node: schemes are already non-abs and
  // non-secret; pass through unchanged.
  if (work.startsWith("webpack-internal:") || work.startsWith("node:")) {
    return { token, changed: false };
  }

  // Detect abs (POSIX or Windows). Anything else is already relative
  // or non-path-shaped; leave alone.
  const isPosixAbs = work.startsWith("/");
  const isWinAbs = /^[A-Za-z]:\\/.test(work);
  if (!isPosixAbs && !isWinAbs) {
    return { token, changed: false };
  }

  // Find the rightmost `/<marker>/` anchor. We walk markers in
  // priority order but pick the highest start-index across all
  // matches so an inner package's frame (deepest under
  // node_modules) wins.
  const sep = isWinAbs ? "\\" : "/";
  // Walk markers in priority order; the FIRST marker with a match
  // wins. Within that marker, anchor at its rightmost occurrence so
  // deep paths like
  // `node_modules/.pnpm/.../node_modules/@trpc/server/dist/...`
  // keep the inner package's `node_modules/` (the structural truth
  // for where the frame lives) rather than getting truncated to
  // some lower-priority marker that happens to appear further right
  // (e.g. `/dist/`).
  let bestIdx = -1;
  for (const marker of PATH_KEEP_MARKERS) {
    const needle = `${sep}${marker}${sep}`;
    const idx = work.lastIndexOf(needle);
    if (idx >= 0) {
      bestIdx = idx;
      break;
    }
  }

  if (bestIdx >= 0) {
    // Keep from `<marker>/...` onward, prefixed with the redaction
    // sentinel so consumers can spot that a prefix was elided.
    const kept = work.slice(bestIdx + sep.length); // starts with marker
    const rebuilt = `${PATH_REDACTED}/${kept.replace(/\\/g, "/")}`;
    return { token: rebuilt, changed: true };
  }

  // No known marker — fall back to basename only. The colon-prefixed
  // tail (e.g. `:10:5`) is preserved because it is not part of the
  // path; PATH_TOKEN_RE matches the whole `path:line:col`, and we
  // split here on the LAST occurrence of `:` that's followed by a
  // digit to find the path body.
  const colonLineRe = /:\d+(?::\d+)?$/;
  const lineMatch = colonLineRe.exec(work);
  const pathBody = lineMatch ? work.slice(0, lineMatch.index) : work;
  const lineSuffix = lineMatch ? work.slice(lineMatch.index) : "";
  const lastSep = Math.max(pathBody.lastIndexOf("/"), pathBody.lastIndexOf("\\"));
  const basename = lastSep >= 0 ? pathBody.slice(lastSep + 1) : pathBody;
  const rebuilt = `${PATH_REDACTED}/${basename}${lineSuffix}`;
  return { token: rebuilt, changed: true };
}

/**
 * Sanitizes the stack: normalizes abs paths, strips URL query/fragments,
 * and applies the credential-redaction patterns from
 * `error-response-body.ts`.
 *
 * Returns the sanitized string and a boolean `redacted` indicating
 * whether at least one rule produced a change. Reference-equality is
 * not preserved when no change is made (the path-token replace runs
 * unconditionally and may reconstruct the same string), so the
 * `redacted` flag — not a `===` check — is the authoritative signal.
 */
export function sanitizeStack(stack: string): { stack: string; redacted: boolean } {
  let changed = false;

  // Step 1: normalize abs paths. The replace callback inspects each
  // token and reports back through `changed`.
  const pathNormalized = stack.replace(PATH_TOKEN_RE, (token) => {
    const out = normalizePathToken(token);
    if (out.changed) changed = true;
    return out.token;
  });

  // Step 2: strip URL query strings + fragments.
  const urlStripped = pathNormalized.replace(URL_QUERY_FRAGMENT_RE, (match, prefix: string) => {
    if (match !== prefix) changed = true;
    return prefix;
  });

  // Step 3: credential redaction (reuse the response-body redactor;
  // its rule set covers Bearer, JWT, gt_dev/anon keys, AWS access
  // keys, and key=value secrets). The redactor returns a new string
  // when a match fires but does not signal change, so we compare
  // refs to detect.
  const credentialRedacted = sanitizeErrorResponseBody(urlStripped);
  if (credentialRedacted !== urlStripped) changed = true;

  return { stack: credentialRedacted, redacted: changed };
}

/**
 * Truncates `stack` to at most {@link ERROR_STACK_MAX_BYTES} bytes
 * when encoded as UTF-8. Returns `{ stack, truncated }` so the caller
 * can set the sibling `glasstrace.error.stack.truncated` attribute.
 *
 * The truncation algorithm is the same UTF-8-codepoint-boundary walk
 * used by `truncateErrorResponseBody`. Marker is appended in
 * JS-string form and is NOT counted toward the byte budget so
 * consumers always see a clear "partial" signal at the worst case.
 */
export function truncateStack(stack: string): { stack: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(stack);
  if (encoded.byteLength <= ERROR_STACK_MAX_BYTES) {
    return { stack, truncated: false };
  }

  let cut = ERROR_STACK_MAX_BYTES;
  let scan = cut - 1;
  while (scan >= 0 && (encoded[scan] & 0xc0) === 0x80) {
    scan -= 1;
  }
  if (scan >= 0) {
    const leading = encoded[scan];
    let expected = 1;
    if ((leading & 0x80) === 0) {
      expected = 1;
    } else if ((leading & 0xe0) === 0xc0) {
      expected = 2;
    } else if ((leading & 0xf0) === 0xe0) {
      expected = 3;
    } else if ((leading & 0xf8) === 0xf0) {
      expected = 4;
    }
    if (scan + expected > cut) {
      cut = scan;
    }
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const sliced = encoded.subarray(0, cut);
  const decoded = decoder.decode(sliced);

  return { stack: decoded + ERROR_STACK_TRUNCATION_MARKER, truncated: true };
}

/**
 * End-to-end pipeline: sanitize, then truncate. Returns the
 * structured result ready for emission as the
 * `glasstrace.error.stack` family of attributes, or `null` if the
 * stack is unsuitable for capture (empty or whitespace-only after
 * the input check).
 *
 * Conservative empty-input guard: a stack that consists entirely of
 * a redacted secret yields `[REDACTED]` and IS still emitted (it
 * tells the operator that *something* stack-shaped came back). Only
 * literal empty / whitespace input returns `null`.
 */
export function prepareStack(stack: string): {
  stack: string;
  truncated: boolean;
  redacted: boolean;
} | null {
  if (stack.length === 0) return null;
  if (stack.trim().length === 0) return null;
  const sanitized = sanitizeStack(stack);
  const truncated = truncateStack(sanitized.stack);
  return {
    stack: truncated.stack,
    truncated: truncated.truncated,
    redacted: sanitized.redacted,
  };
}
