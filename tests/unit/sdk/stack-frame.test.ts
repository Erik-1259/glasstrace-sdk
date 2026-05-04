/**
 * Tests for stack-frame.ts — V8 `Error.stack` parsing.
 *
 * Uses synthetic stack strings rather than real `new Error().stack` so
 * the assertions are deterministic across platforms and Node versions.
 */
import { describe, it, expect } from "vitest";
import { parseTopStackFrame } from "../../../packages/sdk/src/stack-frame.js";

describe("parseTopStackFrame", () => {
  it("parses a parenthesized V8 frame", () => {
    const stack = [
      "Error: boom",
      "    at handler (/Users/dev/project/src/server/users.ts:42:13)",
      "    at runHandler (/Users/dev/project/src/server/router.ts:88:5)",
    ].join("\n");
    expect(parseTopStackFrame(stack)).toEqual({
      file: "/Users/dev/project/src/server/users.ts",
      line: 42,
    });
  });

  it("parses a bare anonymous V8 frame", () => {
    const stack = [
      "TypeError: bad input",
      "    at /Users/dev/project/src/anon.ts:9:1",
    ].join("\n");
    expect(parseTopStackFrame(stack)).toEqual({
      file: "/Users/dev/project/src/anon.ts",
      line: 9,
    });
  });

  it("skips frames inside node:internal/*", () => {
    const stack = [
      "Error: timeout",
      "    at process.processTimers (node:internal/timers:512:7)",
      "    at Timeout._onTimeout (/app/handler.ts:17:9)",
    ].join("\n");
    expect(parseTopStackFrame(stack)).toEqual({
      file: "/app/handler.ts",
      line: 17,
    });
  });

  it("skips bare node: builtin frames", () => {
    const stack = [
      "Error: oops",
      "    at fs.readFileSync (node:fs:1234:5)",
      "    at loader (/app/loader.ts:5:5)",
    ].join("\n");
    expect(parseTopStackFrame(stack)).toEqual({
      file: "/app/loader.ts",
      line: 5,
    });
  });

  it("skips frames inside node_modules/@glasstrace/sdk", () => {
    const stack = [
      "Error: caught",
      "    at captureError (/app/node_modules/@glasstrace/sdk/dist/index.cjs:9876:5)",
      "    at userHandler (/app/src/handlers/users.ts:25:11)",
    ].join("\n");
    expect(parseTopStackFrame(stack)).toEqual({
      file: "/app/src/handlers/users.ts",
      line: 25,
    });
  });

  it("skips the SDK's own capture-error frame in dev/in-tree builds", () => {
    const stack = [
      "Error: caught",
      "    at Object.captureError (/repo/packages/sdk/src/capture-error.ts:36:21)",
      "    at userCode (/repo/app/src/route.ts:12:7)",
    ].join("\n");
    expect(parseTopStackFrame(stack)).toEqual({
      file: "/repo/app/src/route.ts",
      line: 12,
    });
  });

  it("skips the SDK's own stack-frame helper", () => {
    const stack = [
      "Error: caught",
      "    at parseTopStackFrame (/repo/packages/sdk/src/stack-frame.ts:140:21)",
      "    at userCode (/repo/app/src/route.ts:12:7)",
    ].join("\n");
    expect(parseTopStackFrame(stack)).toEqual({
      file: "/repo/app/src/route.ts",
      line: 12,
    });
  });

  it("returns null when every frame is internal", () => {
    const stack = [
      "Error: deep internal",
      "    at process.processTimers (node:internal/timers:512:7)",
      "    at fs.readFileSync (node:fs:1234:5)",
    ].join("\n");
    expect(parseTopStackFrame(stack)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseTopStackFrame("")).toBeNull();
  });

  it("returns null for a stack with no frames", () => {
    expect(parseTopStackFrame("Error: bare\n  no frames here")).toBeNull();
  });

  it("returns null for non-string input (defensive)", () => {
    // Defensive — runtime callers always pass strings, but the parser
    // must not throw if someone wires it up wrong.
    expect(parseTopStackFrame(undefined as unknown as string)).toBeNull();
    expect(parseTopStackFrame(null as unknown as string)).toBeNull();
  });

  it("handles Windows-style backslash paths", () => {
    const stack = [
      "Error: win32",
      "    at handler (C:\\Users\\dev\\project\\src\\server.ts:42:13)",
    ].join("\n");
    expect(parseTopStackFrame(stack)).toEqual({
      file: "C:\\Users\\dev\\project\\src\\server.ts",
      line: 42,
    });
  });

  it("handles file:// URLs (ESM stacks)", () => {
    const stack = [
      "Error: esm",
      "    at handler (file:///Users/dev/project/src/server.ts:42:13)",
    ].join("\n");
    expect(parseTopStackFrame(stack)).toEqual({
      file: "file:///Users/dev/project/src/server.ts",
      line: 42,
    });
  });

  it("handles a stack without the leading Error preamble", () => {
    const stack = "    at handler (/app/src/users.ts:42:13)";
    expect(parseTopStackFrame(stack)).toEqual({
      file: "/app/src/users.ts",
      line: 42,
    });
  });

  it("returns null when the line number is non-numeric", () => {
    // Synthetic malformed frame — should not match either regex
    const stack = "    at handler (/app/src/users.ts:NaN:13)";
    expect(parseTopStackFrame(stack)).toBeNull();
  });

  it("returns null when the line number is zero or negative", () => {
    const stack = "    at handler (/app/src/users.ts:0:1)";
    expect(parseTopStackFrame(stack)).toBeNull();
  });

  it("tolerates trailing whitespace on the frame line", () => {
    const stack = "    at handler (/app/src/users.ts:42:13)   ";
    expect(parseTopStackFrame(stack)).toEqual({
      file: "/app/src/users.ts",
      line: 42,
    });
  });

  it("handles a real Node v20+ Error.stack shape", () => {
    // Captured from a real Node 20 process for regression coverage.
    const stack = [
      "TypeError: Cannot read properties of undefined (reading 'foo')",
      "    at Object.<anonymous> (/repo/app/server.ts:14:23)",
      "    at Module._compile (node:internal/modules/cjs/loader:1376:14)",
      "    at Module._extensions..js (node:internal/modules/cjs/loader:1435:10)",
    ].join("\n");
    expect(parseTopStackFrame(stack)).toEqual({
      file: "/repo/app/server.ts",
      line: 14,
    });
  });

  it("handles a top-level bare async frame", () => {
    const stack = [
      "Error: nested",
      "    at async /repo/app/handler.ts:21:5",
      "    at async runRoute (/repo/app/router.ts:88:7)",
    ].join("\n");
    // V8 emits the `at async file:line:col` form for top-level async
    // frames in an awaited Promise chain. The bare pattern accepts the
    // optional `async` token so the parser surfaces the true top
    // frame instead of falling through to the next.
    expect(parseTopStackFrame(stack)).toEqual({
      file: "/repo/app/handler.ts",
      line: 21,
    });
  });

  it("handles a parenthesized async frame", () => {
    const stack = [
      "Error: nested",
      "    at async runRoute (/repo/app/router.ts:88:7)",
    ].join("\n");
    expect(parseTopStackFrame(stack)).toEqual({
      file: "/repo/app/router.ts",
      line: 88,
    });
  });

  it("returns null for completely malformed input", () => {
    expect(parseTopStackFrame("not a stack at all")).toBeNull();
    expect(parseTopStackFrame("at without leading whitespace")).toBeNull();
  });

  it("skips V8 eval-origin frames and surfaces the next user frame", () => {
    // V8 emits `at eval (eval at <anonymous> (/file.ts:10:3), <anonymous>:1:1)`
    // for code that ran inside an `eval()` call. The pseudo-path is not
    // a real file the source-map resolver can find; parsing it as the
    // top frame would stamp a misleading `glasstrace.source.file`.
    // Tightening PAREN_FRAME's file capture to `[^()\s]+` rejects the
    // eval shape so the parser walks past it to the next real frame.
    const stack = [
      "Error: from eval",
      "    at eval (eval at <anonymous> (/repo/app/runtime.ts:10:3), <anonymous>:1:1)",
      "    at userHandler (/repo/app/handler.ts:42:7)",
    ].join("\n");
    expect(parseTopStackFrame(stack)).toEqual({
      file: "/repo/app/handler.ts",
      line: 42,
    });
  });

  it("returns null when every frame is an eval-origin pseudo path", () => {
    const stack = [
      "Error: nested eval",
      "    at eval (eval at <anonymous> (/repo/app/runtime.ts:10:3), <anonymous>:1:1)",
    ].join("\n");
    expect(parseTopStackFrame(stack)).toBeNull();
  });

  // The Next.js App Router bundler emits webpack-internal URLs whose
  // path segment carries a parenthesized layer marker like `(rsc)`,
  // `(middleware)`, `(api)`, etc. for server components, route
  // handlers, and middleware files compiled in dev mode and
  // self-hosted production builds. The pre-fix parser silently
  // rejected every such frame because its file capture excluded
  // any `(`. These cases lock in the post-fix behavior.
  describe("Next.js webpack-internal App Router markers (DISC-1558)", () => {
    const NEXT_APP_ROUTER_MARKERS = [
      "rsc",
      "middleware",
      "api",
      "client",
      "server",
      "action",
      "app",
      "pages",
    ] as const;

    it.each(NEXT_APP_ROUTER_MARKERS)(
      "parses a parenthesized webpack-internal frame with the (%s) marker",
      (marker) => {
        const file = `webpack-internal:///(${marker})/./src/app/page.tsx`;
        const stack = [
          "Error: boom",
          `    at handler (${file}:42:13)`,
          "    at runHandler (/repo/app/router.ts:88:5)",
        ].join("\n");
        expect(parseTopStackFrame(stack)).toEqual({ file, line: 42 });
      },
    );

    it.each(NEXT_APP_ROUTER_MARKERS)(
      "parses a parenthesized webpack-internal frame with the (%s) marker — Node 20+ shape",
      (marker) => {
        // Real Node 20+ stack shape: `Error: <msg>\n    at <funcName>
        // (webpack-internal:///(<marker>)/<path>.tsx:line:col)\n    at
        // ...`. Same as the V8 parenthesized form on every supported
        // Node version, captured here separately so a future Node
        // stack-format change is caught by a named regression case.
        const file = `webpack-internal:///(${marker})/./src/app/route.ts`;
        const stack = [
          "TypeError: Cannot read properties of undefined (reading 'foo')",
          `    at GET (${file}:17:9)`,
          "    at AsyncLocalStorage.run (node:async_hooks:346:14)",
        ].join("\n");
        expect(parseTopStackFrame(stack)).toEqual({ file, line: 17 });
      },
    );

    it("parses a `(middleware)` frame whose path has no `./` prefix", () => {
      // Next emits `(middleware)/middleware.js` without the leading
      // `./` for the middleware bundle entry point. The file capture
      // must accept a marker followed directly by a non-dot
      // segment, not just `(marker)/./...`.
      const file = "webpack-internal:///(middleware)/middleware.js";
      const stack = [
        "Error: middleware boom",
        `    at runMiddleware (${file}:5:1)`,
      ].join("\n");
      expect(parseTopStackFrame(stack)).toEqual({ file, line: 5 });
    });

    it("parses a non-parenthesized webpack-internal path", () => {
      // Confirms the marker-aware pattern does not regress the
      // simpler shape the parser handled before the fix. A
      // webpack-internal URL with no `(<marker>)` chunk segment is
      // a plain non-paren path and parses through the file
      // capture's first segment.
      const file = "webpack-internal:///plain/module.js";
      const stack = [
        "Error: plain",
        `    at runModule (${file}:9:7)`,
      ].join("\n");
      expect(parseTopStackFrame(stack)).toEqual({ file, line: 9 });
    });

    it("parses a webpack-internal frame whose route-group folder name contains digits", () => {
      // Next App Router route-group folders are user-authored and
      // can carry any valid filesystem name, including digits. The
      // bundler embeds the route-group folder verbatim in the
      // module path, e.g. `app/(v2)/page.tsx` becomes
      // `webpack-internal:///(rsc)/./src/app/(v2)/page.tsx`. The
      // marker alphabet must include digits or the parser silently
      // drops the frame for any project using digit-bearing route
      // groups.
      const file =
        "webpack-internal:///(rsc)/./src/app/(v2)/page.tsx";
      const stack = [
        "Error: digit route group",
        `    at handler (${file}:42:13)`,
      ].join("\n");
      expect(parseTopStackFrame(stack)).toEqual({ file, line: 42 });
    });

    it.each(["(.)", "(..)", "(...)"])(
      "parses a webpack-internal frame containing the intercepting-route marker %s",
      (interceptMarker) => {
        // Next App Router intercepting routes use the shapes
        // `(.)`, `(..)`, and `(...)` to denote
        // same-level / parent-level / root-level intercepts. The
        // bundler embeds the folder name verbatim, so the V8
        // stack carries the marker exactly. The marker alphabet
        // must allow `.` or the parser silently drops the frame
        // for any project using intercepting routes.
        const file = `webpack-internal:///(rsc)/./src/app/@modal/${interceptMarker}photo/[id]/page.tsx`;
        const stack = [
          "Error: intercept",
          `    at handler (${file}:12:3)`,
        ].join("\n");
        expect(parseTopStackFrame(stack)).toEqual({ file, line: 12 });
      },
    );

    it("parses a webpack-internal frame whose route-group folder name mixes letters and digits", () => {
      // Edge case: a route group named `(beta-2)`. Confirms the
      // marker alphabet `[A-Za-z0-9_-]` accepts the full set of
      // characters Next allows in a route-group folder name.
      const file =
        "webpack-internal:///(rsc)/./src/app/(beta-2)/dashboard.tsx";
      const stack = [
        "Error: mixed route group",
        `    at handler (${file}:7:1)`,
      ].join("\n");
      expect(parseTopStackFrame(stack)).toEqual({ file, line: 7 });
    });

    it("parses a webpack-internal frame that chains multiple parenthesized markers", () => {
      // Defensive: should the bundler ever chain layer markers
      // (e.g., `(rsc)/(client)/page.tsx`), the file capture's
      // repeating group keeps each marker as a contiguous segment
      // of the path rather than rejecting the line.
      const file =
        "webpack-internal:///(rsc)/(client)/./src/app/page.tsx";
      const stack = [
        "Error: chained markers",
        `    at handler (${file}:1:1)`,
      ].join("\n");
      expect(parseTopStackFrame(stack)).toEqual({ file, line: 1 });
    });

    it("parses a parenthesized webpack-internal frame inside a `new` constructor", () => {
      // V8 emits `at new ClassName (...)` for constructor frames.
      // The function-name region must accept multi-token names
      // ending at the wrapper paren so the file capture starts
      // correctly.
      const file = "webpack-internal:///(rsc)/./src/app/Greeter.ts";
      const stack = [
        "Error: ctor",
        `    at new Greeter (${file}:7:9)`,
      ].join("\n");
      expect(parseTopStackFrame(stack)).toEqual({ file, line: 7 });
    });

    it("parses a parenthesized webpack-internal frame with a `Object.<anonymous>` function name", () => {
      // V8 emits `Object.<anonymous>` for top-level module
      // evaluation in CJS interop. The angle-bracket characters
      // in the function-name region must not break the wrapper
      // paren detection.
      const file = "webpack-internal:///(rsc)/./src/app/page.tsx";
      const stack = [
        "Error: top-level",
        `    at Object.<anonymous> (${file}:1:1)`,
      ].join("\n");
      expect(parseTopStackFrame(stack)).toEqual({ file, line: 1 });
    });

    it("still rejects the eval-origin pseudo path even when an inner frame is webpack-internal", () => {
      // Negative regression: the eval-frame guard must continue
      // rejecting the `at eval (eval at ...)` shape regardless of
      // whether the inner pseudo-path looks like a webpack-internal
      // URL with a marker. The pseudo-path is not source-mappable;
      // skipping it reaches the next real frame.
      const file = "webpack-internal:///(rsc)/./src/app/page.tsx";
      const stack = [
        "Error: eval-of-rsc",
        `    at eval (eval at <anonymous> (${file}:10:3), <anonymous>:1:1)`,
        `    at handler (${file}:42:7)`,
      ].join("\n");
      expect(parseTopStackFrame(stack)).toEqual({ file, line: 42 });
    });

    it(
      "does not match adversarially long input without a frame shape (no catastrophic backtracking)",
      { timeout: 5_000 },
      () => {
        // Performance regression guard. The pre-fix regex was
        // linear-time; the new file capture preserves that property
        // because each alternation is anchored on a literal `(` and
        // the inner repetition does not nest (`(a*)*`-style). A long
        // input that cannot match any frame shape must return null
        // promptly. The assertion is correctness only — null result;
        // the runtime bound is enforced by the test-options timeout
        // (5s), which Vitest aborts via its own scheduler rather
        // than a wall-clock comparison so the test stays stable on
        // slow or contended CI runners. A regression to exponential
        // backtracking would blow through the timeout.
        const adversarial =
          "    at " +
          "x".repeat(10_000) +
          "(rsc)".repeat(1_000) +
          " no closing paren or numbers";
        expect(parseTopStackFrame(adversarial)).toBeNull();
      },
    );

    it("handles a multi-frame Next App Router stack and surfaces the user frame", () => {
      // Integration-shaped fixture mirroring a real
      // `captureError(error)` call from a Next 16 dev-mode
      // runtime: the SDK's own frames sit on top, then a
      // framework frame, then the user's webpack-internal frame.
      // The parser must skip the SDK frames and stop at the user
      // frame.
      const userFile =
        "webpack-internal:///(rsc)/./src/app/users/route.ts";
      const stack = [
        "Error: failed to load user",
        "    at captureError (/app/node_modules/@glasstrace/sdk/dist/index.cjs:9876:5)",
        "    at parseTopStackFrame (/app/node_modules/@glasstrace/sdk/dist/index.cjs:1234:5)",
        `    at handler (${userFile}:42:13)`,
        "    at runRoute (webpack-internal:///(rsc)/./src/app/router.ts:88:5)",
      ].join("\n");
      expect(parseTopStackFrame(stack)).toEqual({
        file: userFile,
        line: 42,
      });
    });
  });
});
