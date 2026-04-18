import { describe, it, expect, vi, afterEach } from "vitest";
import { trace, type Span } from "@opentelemetry/api";
import { captureCorrelationId } from "../../../packages/sdk/src/correlation-id.js";

const CORRELATION_ATTR = "glasstrace.correlation.id";
const TEST_CID = "cid_01HXYZABCD";

type MockSpan = { setAttribute: ReturnType<typeof vi.fn> };

/**
 * Installs a mock span as the "active span" by stubbing
 * `trace.getActiveSpan()` for the duration of the callback.
 *
 * We mock at the public API boundary (`trace.getActiveSpan`) rather than
 * spin up a full tracer provider + context manager because the helper's
 * observable behavior is: "read header, call setAttribute on the active
 * span". The OTel wiring is exercised end-to-end by integration suites
 * elsewhere in the SDK.
 */
function withActiveSpan<T>(fn: (span: MockSpan) => T): T {
  const span: MockSpan = { setAttribute: vi.fn() };
  const stub = vi
    .spyOn(trace, "getActiveSpan")
    .mockReturnValue(span as unknown as Span);
  try {
    return fn(span);
  } finally {
    stub.mockRestore();
  }
}

describe("captureCorrelationId (DISC-1253)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sets glasstrace.correlation.id from Fetch-API Request headers", () => {
    withActiveSpan((span) => {
      const req = new Request("https://example.com/login", {
        method: "POST",
        headers: { "x-gt-cid": TEST_CID },
      });

      captureCorrelationId(req);

      expect(span.setAttribute).toHaveBeenCalledWith(CORRELATION_ATTR, TEST_CID);
    });
  });

  it("is case-insensitive on Fetch-API header lookup", () => {
    withActiveSpan((span) => {
      // Fetch Headers already normalizes to lower-case on get() — this
      // test guarantees the helper relies on that normalization and
      // does not case-sensitively miss the header.
      const req = new Request("https://example.com/login", {
        method: "POST",
        headers: { "X-GT-CID": TEST_CID },
      });

      captureCorrelationId(req);

      expect(span.setAttribute).toHaveBeenCalledWith(CORRELATION_ATTR, TEST_CID);
    });
  });

  it("sets attribute from a Node IncomingMessage-like headers dict", () => {
    withActiveSpan((span) => {
      const req = {
        headers: { "x-gt-cid": TEST_CID },
      };

      captureCorrelationId(req);

      expect(span.setAttribute).toHaveBeenCalledWith(CORRELATION_ATTR, TEST_CID);
    });
  });

  it("is case-insensitive on Node-style headers dict", () => {
    withActiveSpan((span) => {
      const req = {
        headers: { "X-GT-CID": TEST_CID },
      };

      captureCorrelationId(req);

      expect(span.setAttribute).toHaveBeenCalledWith(CORRELATION_ATTR, TEST_CID);
    });
  });

  it("uses the first value from an array header (Node duplicates)", () => {
    withActiveSpan((span) => {
      const req = {
        headers: { "x-gt-cid": [TEST_CID, "cid_other"] as string[] },
      };

      captureCorrelationId(req);

      expect(span.setAttribute).toHaveBeenCalledWith(CORRELATION_ATTR, TEST_CID);
      expect(span.setAttribute).toHaveBeenCalledTimes(1);
    });
  });

  it("skips empty string values and falls back to next non-empty in array", () => {
    withActiveSpan((span) => {
      const req = {
        headers: { "x-gt-cid": ["", " ", TEST_CID] as string[] },
      };

      captureCorrelationId(req);

      expect(span.setAttribute).toHaveBeenCalledWith(CORRELATION_ATTR, TEST_CID);
    });
  });

  it("does NOT set attribute when header is absent", () => {
    withActiveSpan((span) => {
      const req = { headers: {} };

      captureCorrelationId(req);

      expect(span.setAttribute).not.toHaveBeenCalled();
    });
  });

  it("does NOT set attribute when header value is empty string", () => {
    withActiveSpan((span) => {
      const req = { headers: { "x-gt-cid": "" } };

      captureCorrelationId(req);

      expect(span.setAttribute).not.toHaveBeenCalled();
    });
  });

  it("trims surrounding whitespace from header value", () => {
    withActiveSpan((span) => {
      const req = { headers: { "x-gt-cid": `  ${TEST_CID}  ` } };

      captureCorrelationId(req);

      expect(span.setAttribute).toHaveBeenCalledWith(CORRELATION_ATTR, TEST_CID);
    });
  });

  it("rejects absurdly long header values to prevent payload ballooning", () => {
    withActiveSpan((span) => {
      const oversized = "x".repeat(10_000);
      const req = { headers: { "x-gt-cid": oversized } };

      captureCorrelationId(req);

      expect(span.setAttribute).not.toHaveBeenCalled();
    });
  });

  it("is a no-op (no throw) when no active span is present", () => {
    // Explicitly stub getActiveSpan to return undefined so the helper
    // can observe "no active span" regardless of global tracer state.
    const stub = vi.spyOn(trace, "getActiveSpan").mockReturnValue(undefined);
    try {
      const req = { headers: { "x-gt-cid": TEST_CID } };
      expect(() => captureCorrelationId(req)).not.toThrow();
    } finally {
      stub.mockRestore();
    }
  });

  it("is a no-op on null/undefined input", () => {
    withActiveSpan((span) => {
      expect(() => captureCorrelationId(null)).not.toThrow();
      expect(() => captureCorrelationId(undefined)).not.toThrow();

      expect(span.setAttribute).not.toHaveBeenCalled();
    });
  });

  it("is a no-op on malformed headers shape (no throw)", () => {
    withActiveSpan((span) => {
      // headers field missing entirely
      expect(() =>
        captureCorrelationId({ headers: undefined } as unknown as {
          headers: Record<string, string>;
        }),
      ).not.toThrow();

      // headers is a primitive — `.get` is not callable and Object.keys
      // on a wrapped primitive yields an empty array, so the helper
      // silently falls through without throwing.
      expect(() =>
        captureCorrelationId({
          headers: 42 as unknown as Record<string, string>,
        }),
      ).not.toThrow();

      expect(span.setAttribute).not.toHaveBeenCalled();
    });
  });

  it("is a no-op when header.get() throws", () => {
    withActiveSpan((span) => {
      const req = {
        headers: {
          get: () => {
            throw new Error("hostile header impl");
          },
        },
      };

      expect(() => captureCorrelationId(req)).not.toThrow();
      expect(span.setAttribute).not.toHaveBeenCalled();
    });
  });
});
