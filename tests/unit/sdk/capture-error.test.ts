import { describe, it, expect, beforeEach, vi } from "vitest";

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

describe("captureError", () => {
  beforeEach(() => {
    vi.doUnmock("@opentelemetry/api");
    vi.resetModules();
  });

  it("adds a span event when a span is active", async () => {
    const { addEvent } = mockOtelWithActiveSpan();

    const mod = await import("../../../packages/sdk/src/capture-error.js");
    mod._resetCaptureErrorForTesting();
    await mod._preloadOtelApi();
    mod.captureError(new TypeError("bad input"));

    expect(addEvent).toHaveBeenCalledWith("glasstrace.error", {
      "error.message": "TypeError: bad input",
      "error.type": "TypeError",
    });
  });

  it("is a no-op when no span is active", async () => {
    mockOtelWithNoActiveSpan();

    const mod = await import("../../../packages/sdk/src/capture-error.js");
    mod._resetCaptureErrorForTesting();
    await mod._preloadOtelApi();
    expect(() => mod.captureError(new Error("orphan error"))).not.toThrow();
  });

  it("handles string errors", async () => {
    const { addEvent } = mockOtelWithActiveSpan();

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

    const mod = await import("../../../packages/sdk/src/capture-error.js");
    mod._resetCaptureErrorForTesting();
    await mod._preloadOtelApi();
    mod.captureError(404);

    expect(addEvent).toHaveBeenCalledWith("glasstrace.error", {
      "error.message": "404",
    });
  });
});
