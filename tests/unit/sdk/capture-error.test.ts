import { describe, it, expect, beforeEach, vi } from "vitest";

const mockMaybeShowMcpNudge = vi.fn();

/**
 * Sets up the @opentelemetry/api mock with a mock span that has an active context.
 */
function mockOtelWithActiveSpan() {
  const addEvent = vi.fn();
  const mockSpan = { addEvent };

  vi.doMock("@opentelemetry/api", () => ({
    trace: {
      getSpan: () => mockSpan,
    },
    context: {
      active: () => ({}),
    },
  }));

  return { mockSpan, addEvent };
}

function mockOtelWithNoActiveSpan() {
  vi.doMock("@opentelemetry/api", () => ({
    trace: {
      getSpan: () => undefined,
    },
    context: {
      active: () => ({}),
    },
  }));
}

function mockNudge() {
  vi.doMock("../../../packages/sdk/src/nudge/error-nudge.js", () => ({
    maybeShowMcpNudge: mockMaybeShowMcpNudge,
  }));
}

describe("captureError", () => {
  beforeEach(() => {
    vi.doUnmock("@opentelemetry/api");
    vi.doUnmock("../../../packages/sdk/src/nudge/error-nudge.js");
    vi.resetModules();
    mockMaybeShowMcpNudge.mockReset();
  });

  it("adds a span event when a span is active", async () => {
    const { addEvent } = mockOtelWithActiveSpan();
    mockNudge();

    const mod = await import("../../../packages/sdk/src/capture-error.js");
    mod._resetCaptureErrorForTesting();
    await mod._preloadOtelApi();
    mod.captureError(new TypeError("bad input"));

    expect(addEvent).toHaveBeenCalledOnce();
    const [eventName, attrs] = addEvent.mock.calls[0];
    expect(eventName).toBe("glasstrace.error");
    expect(attrs["error.message"]).toContain("TypeError");
    expect(attrs["error.message"]).toContain("bad input");
    expect(attrs["error.type"]).toBe("TypeError");
  });

  it("is a no-op when no span is active", async () => {
    mockOtelWithNoActiveSpan();
    mockNudge();

    const mod = await import("../../../packages/sdk/src/capture-error.js");
    mod._resetCaptureErrorForTesting();
    await mod._preloadOtelApi();
    expect(() => mod.captureError(new Error("orphan error"))).not.toThrow();
  });

  it("records error.stack attribute for Error instances", async () => {
    const { addEvent } = mockOtelWithActiveSpan();
    mockNudge();

    const mod = await import("../../../packages/sdk/src/capture-error.js");
    mod._resetCaptureErrorForTesting();
    await mod._preloadOtelApi();

    const error = new Error("test stack capture");
    mod.captureError(error);

    expect(addEvent).toHaveBeenCalledOnce();
    const [, attrs] = addEvent.mock.calls[0];
    expect(attrs["error.stack"]).toBeDefined();
    expect(attrs["error.stack"]).toContain("test stack capture");
    // Stack traces include the file path of the calling code
    expect(typeof attrs["error.stack"]).toBe("string");
  });

  it("does not include error.stack for non-Error values", async () => {
    const { addEvent } = mockOtelWithActiveSpan();
    mockNudge();

    const mod = await import("../../../packages/sdk/src/capture-error.js");
    mod._resetCaptureErrorForTesting();
    await mod._preloadOtelApi();
    mod.captureError("plain string error without stack");

    expect(addEvent).toHaveBeenCalledOnce();
    const [, attrs] = addEvent.mock.calls[0];
    expect(attrs["error.stack"]).toBeUndefined();
  });

  it("handles string errors", async () => {
    const { addEvent } = mockOtelWithActiveSpan();
    mockNudge();

    const mod = await import("../../../packages/sdk/src/capture-error.js");
    mod._resetCaptureErrorForTesting();
    await mod._preloadOtelApi();
    mod.captureError("plain string error");

    expect(addEvent).toHaveBeenCalledWith("glasstrace.error", {
      "error.message": "plain string error",
    });
  });

  it("handles numeric errors", async () => {
    const { addEvent } = mockOtelWithActiveSpan();
    mockNudge();

    const mod = await import("../../../packages/sdk/src/capture-error.js");
    mod._resetCaptureErrorForTesting();
    await mod._preloadOtelApi();
    mod.captureError(404);

    expect(addEvent).toHaveBeenCalledWith("glasstrace.error", {
      "error.message": "404",
    });
  });

  it("calls maybeShowMcpNudge with the error message", async () => {
    mockOtelWithActiveSpan();
    mockNudge();

    const mod = await import("../../../packages/sdk/src/capture-error.js");
    mod._resetCaptureErrorForTesting();
    await mod._preloadOtelApi();
    mod.captureError(new TypeError("connection refused"));

    expect(mockMaybeShowMcpNudge).toHaveBeenCalledOnce();
    expect(mockMaybeShowMcpNudge).toHaveBeenCalledWith(
      "TypeError: connection refused",
    );
  });

  it("silently swallows if maybeShowMcpNudge throws", async () => {
    const { addEvent } = mockOtelWithActiveSpan();
    mockNudge();
    mockMaybeShowMcpNudge.mockImplementation(() => {
      throw new Error("nudge boom");
    });

    const mod = await import("../../../packages/sdk/src/capture-error.js");
    mod._resetCaptureErrorForTesting();
    await mod._preloadOtelApi();

    // Should not throw — the outer try/catch protects the caller
    expect(() => mod.captureError(new Error("test"))).not.toThrow();
    // The span event should still have been recorded before the nudge threw
    expect(addEvent).toHaveBeenCalledOnce();
  });

  it("does not call maybeShowMcpNudge when no span is active", async () => {
    mockOtelWithNoActiveSpan();
    mockNudge();

    const mod = await import("../../../packages/sdk/src/capture-error.js");
    mod._resetCaptureErrorForTesting();
    await mod._preloadOtelApi();
    mod.captureError(new Error("orphan"));

    expect(mockMaybeShowMcpNudge).not.toHaveBeenCalled();
  });

  it("stamps glasstrace.source.file and glasstrace.source.line for parseable Error.stack", async () => {
    const { addEvent } = mockOtelWithActiveSpan();
    mockNudge();

    const mod = await import("../../../packages/sdk/src/capture-error.js");
    mod._resetCaptureErrorForTesting();
    await mod._preloadOtelApi();

    // Synthesize a stack-bearing error with a deterministic top frame
    // outside the SDK's internal-frame skip patterns.
    const error = new Error("source-stamp test");
    error.stack = [
      "Error: source-stamp test",
      "    at userHandler (/repo/app/src/users.ts:42:13)",
      "    at runHandler (/repo/app/src/router.ts:88:5)",
    ].join("\n");

    mod.captureError(error);

    expect(addEvent).toHaveBeenCalledOnce();
    const [, attrs] = addEvent.mock.calls[0];
    expect(attrs["glasstrace.source.file"]).toBe("/repo/app/src/users.ts");
    expect(attrs["glasstrace.source.line"]).toBe(42);
  });

  it("does not stamp source.file / source.line when stack has only internal frames", async () => {
    const { addEvent } = mockOtelWithActiveSpan();
    mockNudge();

    const mod = await import("../../../packages/sdk/src/capture-error.js");
    mod._resetCaptureErrorForTesting();
    await mod._preloadOtelApi();

    const error = new Error("internal-only stack");
    error.stack = [
      "Error: internal-only stack",
      "    at process.processTimers (node:internal/timers:512:7)",
      "    at fs.readFileSync (node:fs:1234:5)",
    ].join("\n");

    mod.captureError(error);

    expect(addEvent).toHaveBeenCalledOnce();
    const [, attrs] = addEvent.mock.calls[0];
    expect(attrs["glasstrace.source.file"]).toBeUndefined();
    expect(attrs["glasstrace.source.line"]).toBeUndefined();
    // The error.stack itself is still recorded for debugging
    expect(attrs["error.stack"]).toBeDefined();
  });

  it("does not stamp source.file / source.line for non-Error values", async () => {
    const { addEvent } = mockOtelWithActiveSpan();
    mockNudge();

    const mod = await import("../../../packages/sdk/src/capture-error.js");
    mod._resetCaptureErrorForTesting();
    await mod._preloadOtelApi();

    mod.captureError("string error has no stack");

    expect(addEvent).toHaveBeenCalledOnce();
    const [, attrs] = addEvent.mock.calls[0];
    expect(attrs["glasstrace.source.file"]).toBeUndefined();
    expect(attrs["glasstrace.source.line"]).toBeUndefined();
  });

  it("does not stamp source.file / source.line for an Error with no stack", async () => {
    const { addEvent } = mockOtelWithActiveSpan();
    mockNudge();

    const mod = await import("../../../packages/sdk/src/capture-error.js");
    mod._resetCaptureErrorForTesting();
    await mod._preloadOtelApi();

    const error = new Error("no stack");
    // Some custom error subclasses or sanitizers strip the stack
    Object.defineProperty(error, "stack", { value: undefined });

    mod.captureError(error);

    expect(addEvent).toHaveBeenCalledOnce();
    const [, attrs] = addEvent.mock.calls[0];
    expect(attrs["glasstrace.source.file"]).toBeUndefined();
    expect(attrs["glasstrace.source.line"]).toBeUndefined();
    expect(attrs["error.stack"]).toBeUndefined();
  });

  it("never throws when the stack is malformed", async () => {
    const { addEvent } = mockOtelWithActiveSpan();
    mockNudge();

    const mod = await import("../../../packages/sdk/src/capture-error.js");
    mod._resetCaptureErrorForTesting();
    await mod._preloadOtelApi();

    const error = new Error("malformed");
    error.stack = "this is not a real stack at all";

    expect(() => mod.captureError(error)).not.toThrow();
    expect(addEvent).toHaveBeenCalledOnce();
    const [, attrs] = addEvent.mock.calls[0];
    expect(attrs["glasstrace.source.file"]).toBeUndefined();
    expect(attrs["glasstrace.source.line"]).toBeUndefined();
  });
});
