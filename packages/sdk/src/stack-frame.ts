/**
 * V8 stack-frame parsing for error-source attribution.
 *
 * The SDK stamps `glasstrace.source.file` and `glasstrace.source.line`
 * on the `glasstrace.error` span event recorded by `captureError()`.
 * Both values come from the top user-relevant frame of the captured
 * `Error.stack` string. Ingestion's source-map resolver then maps the
 * compiled-output `file:line` back to the original source via the
 * pre-uploaded source map manifest.
 *
 * V8 is the only stack format we parse. Node uses V8 (the SDK's
 * `engines.node` is `>=20`); the brief explicitly scopes Firefox /
 * Safari formats out for now (browser error capture is a separate
 * concern, and this module is Node-only via `capture-error.ts`'s
 * placement outside `edge-entry.ts`'s curated subset).
 *
 * @remarks
 * Pure module. No `process`, no `node:*`, no I/O. Safe to import from
 * any context, but practical use is gated to the Node bundle by
 * `capture-error.ts`'s placement. The parsing helpers live in their
 * own module so they can be unit-tested against synthetic stack
 * strings without faking the OTel mocks the `captureError` test
 * harness already needs.
 */

/**
 * A parsed top stack frame. `file` is the compiled-output path the V8
 * engine reported — exactly what the ingestion source-map resolver
 * expects, so we deliberately do not strip CWD or bundler prefixes.
 *
 * @public
 */
export interface ParsedStackFrame {
  /** Source file path as reported by V8 (compiled-output path). */
  readonly file: string;
  /** 1-based line number reported by V8. */
  readonly line: number;
}

/**
 * Match a V8 frame in the parenthesized form:
 * `    at <funcName> (file:line:col)`
 *
 * The function name segment is consumed but discarded; we only need
 * the location. Capture groups: file, line, col.
 *
 * Anchored to the start of the trimmed line via the `at ` literal.
 * Allows but does not require a function name before the parens
 * (a bare `    at (file:line:col)` is unusual but valid).
 *
 * The file-path capture group `[^()\s]+` excludes parenthesis and
 * whitespace characters. This deliberately rejects V8's nested
 * `eval` frame shape — `at eval (eval at <anonymous> (/file:1:1), <anonymous>:1:1)` —
 * which would otherwise greedy-match the whole inner expression and
 * stamp a non-resolvable pseudo-path as `glasstrace.source.file`.
 * Eval-origin frames have no real source location to report; the
 * parser skips them rather than emit a misleading attribute.
 */
const PAREN_FRAME = /^\s*at\s+(?:[^()]+\s+)?\(([^()\s]+):(\d+):(\d+)\)\s*$/;

/**
 * Match a V8 frame in the bare anonymous form:
 * `    at file:line:col`
 * `    at async file:line:col`
 *
 * V8 emits the bare shape when the frame has no function name to print
 * (top-level module evaluation, an anonymous arrow, a Promise rejection
 * handler that V8 cannot name). The optional `async` keyword appears
 * for top-level async frames inside an awaited Promise chain. After
 * the optional `async` token the next whitespace-delimited token is
 * the file path; line and column trail it.
 *
 * The file-path capture group `[^()\s]+` excludes the parenthesis
 * characters, so a parenthesized frame (with or without a function
 * name) will not match here — those land at {@link PAREN_FRAME}. A
 * malformed truncated frame like `    at fn (file:line:col` is
 * therefore rejected by both patterns rather than being misparsed.
 */
const BARE_FRAME = /^\s*at\s+(?:async\s+)?([^()\s]+):(\d+):(\d+)\s*$/;

/**
 * V8 internal-frame prefixes that should be skipped when looking for
 * the user's top frame. These are emitted for frames inside Node's
 * built-in modules (`node:internal/...`) and frames inside the SDK
 * itself when `captureError()` was reached via SDK code (the SDK
 * stack walker should report the *caller* of `captureError`, not
 * the call inside `captureError` itself).
 *
 * The SDK-self patterns target two on-disk shapes: the published
 * package path `node_modules/@glasstrace/sdk/` (where the SDK lives
 * inside a consumer project) and the in-repo source path
 * `packages/sdk/src/{capture-error,stack-frame}.{ts,js,...}` (used by
 * dogfooding and in-tree tests). Together they cover both the
 * consumed-as-published path and the in-tree development path.
 * Tightening the second to the two specific source files (rather
 * than the directory) keeps the matcher narrow: a user-side file
 * happening to live at `packages/sdk/src/...` in their own project
 * would not be incorrectly skipped.
 */
const INTERNAL_FRAME_PATTERNS: readonly RegExp[] = [
  /^node:/,
  /^node:internal\//,
  /[/\\]node_modules[/\\]@glasstrace[/\\]sdk[/\\]/,
  /[/\\]packages[/\\]sdk[/\\]src[/\\]capture-error\./,
  /[/\\]packages[/\\]sdk[/\\]src[/\\]stack-frame\./,
];

/**
 * Returns true when the candidate file path looks like an internal
 * frame the SDK should skip while walking the stack.
 */
function isInternalFrame(file: string): boolean {
  return INTERNAL_FRAME_PATTERNS.some((re) => re.test(file));
}

/**
 * Parses a V8 `Error.stack` string and returns the topmost
 * user-attributable `{ file, line }` pair, or `null` when no frame
 * matches. The first line of the stack — the `Error: <message>`
 * preamble — is discarded; subsequent `at` lines are scanned in order
 * and the first non-internal match wins.
 *
 * Robustness posture: on any malformed input (empty string, missing
 * frames, non-numeric line, frames that are all internal) the function
 * returns `null` so the caller can silently skip stamping rather than
 * propagating a parse error to the OTel span. The caller in
 * `capture-error.ts` further wraps the call in its own `try/catch` so
 * even an unexpected input shape (e.g., a future engine version
 * changing the stack format) cannot crash the export pipeline.
 *
 * @param stack - The raw `Error.stack` string. May include the
 *   `Error: <message>` first line (V8 default) or omit it (some
 *   engines / custom serializers).
 * @returns The first user-attributable `{ file, line }`, or `null`.
 *
 * @public
 */
export function parseTopStackFrame(stack: string): ParsedStackFrame | null {
  if (typeof stack !== "string" || stack.length === 0) return null;

  // Walk lines without an explicit split so a 50-frame stack does not
  // pay the O(n) cost of building an intermediate array. `\n` is the
  // V8-emitted separator on every supported platform; `\r\n` (Windows)
  // is normalized by Node before reaching here, but we tolerate it
  // anyway by treating `\r` as whitespace at the regex anchor level.
  let cursor = 0;
  while (cursor < stack.length) {
    const newlineAt = stack.indexOf("\n", cursor);
    const lineEnd = newlineAt === -1 ? stack.length : newlineAt;
    const line = stack.slice(cursor, lineEnd);
    cursor = lineEnd + 1;

    // Skip the leading `Error: ...` preamble and any other lines that
    // do not look like a frame.
    if (!/^\s*at\s/.test(line)) continue;

    let file: string | undefined;
    let lineStr: string | undefined;

    const parenMatch = PAREN_FRAME.exec(line);
    if (parenMatch) {
      file = parenMatch[1];
      lineStr = parenMatch[2];
    } else {
      const bareMatch = BARE_FRAME.exec(line);
      if (bareMatch) {
        file = bareMatch[1];
        lineStr = bareMatch[2];
      }
    }

    if (!file || !lineStr) continue;
    if (isInternalFrame(file)) continue;

    const lineNum = Number.parseInt(lineStr, 10);
    if (!Number.isFinite(lineNum) || lineNum <= 0) continue;

    return { file, line: lineNum };
  }

  return null;
}
