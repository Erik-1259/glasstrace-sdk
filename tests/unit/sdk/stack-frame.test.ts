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
});
