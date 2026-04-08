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
});
