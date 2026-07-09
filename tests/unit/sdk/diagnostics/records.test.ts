import { describe, it, expect } from "vitest";
import { SpanKind } from "@opentelemetry/api";
import { spanKindToString } from "../../../../packages/sdk/src/diagnostics/records.js";

describe("spanKindToString", () => {
  it("maps every SpanKind to its contract string", () => {
    expect(spanKindToString(SpanKind.INTERNAL)).toBe("INTERNAL");
    expect(spanKindToString(SpanKind.SERVER)).toBe("SERVER");
    expect(spanKindToString(SpanKind.CLIENT)).toBe("CLIENT");
    expect(spanKindToString(SpanKind.PRODUCER)).toBe("PRODUCER");
    expect(spanKindToString(SpanKind.CONSUMER)).toBe("CONSUMER");
  });

  it("defaults an out-of-range numeric kind to INTERNAL", () => {
    expect(spanKindToString(99 as SpanKind)).toBe("INTERNAL");
  });
});
