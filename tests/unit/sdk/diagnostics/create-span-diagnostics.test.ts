import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SpanKind } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/sdk-trace-base";
import { createSpanDiagnostics } from "../../../../packages/sdk/src/diagnostics/index.js";
import type { DiagnosticRecord } from "../../../../packages/sdk/src/diagnostics/records.js";
import {
  setSpanDiagnosticsFlag,
  _resetSpanDiagnosticsFlagForTesting,
} from "../../../../packages/sdk/src/span-diagnostics-flag.js";

const ENV = "GLASSTRACE_SPAN_DIAGNOSTICS";
const ENV_OUT = "GLASSTRACE_SPAN_DIAGNOSTICS_OUT";

function serverSpan(spanId = "00f067aa0ba902b7"): Span {
  return {
    name: "GET /x",
    kind: SpanKind.SERVER,
    spanContext: () => ({ traceId: "t", spanId, traceFlags: 1 }),
    parentSpanContext: undefined,
    attributes: {},
  } as unknown as Span;
}

describe("createSpanDiagnostics", () => {
  const origEnabled = process.env[ENV];
  const origOut = process.env[ENV_OUT];

  beforeEach(() => {
    _resetSpanDiagnosticsFlagForTesting();
    delete process.env[ENV];
    delete process.env[ENV_OUT];
  });

  afterEach(() => {
    _resetSpanDiagnosticsFlagForTesting();
    if (origEnabled === undefined) delete process.env[ENV];
    else process.env[ENV] = origEnabled;
    if (origOut === undefined) delete process.env[ENV_OUT];
    else process.env[ENV_OUT] = origOut;
  });

  it("emits when enabled via option", () => {
    const records: DiagnosticRecord[] = [];
    const p = createSpanDiagnostics({ enabled: true, emit: (r) => records.push(r) });
    p.onStart(serverSpan());
    expect(records.some((r) => r.ev === "start")).toBe(true);
    void p.shutdown();
  });

  it("defaults enabled from the resolved flag", () => {
    setSpanDiagnosticsFlag(true);
    const records: DiagnosticRecord[] = [];
    const p = createSpanDiagnostics({ emit: (r) => records.push(r) });
    p.onStart(serverSpan());
    expect(records.length).toBeGreaterThan(0);
    void p.shutdown();
  });

  it("is a no-op when disabled and opens no sink", () => {
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      const p = createSpanDiagnostics({ enabled: false });
      p.onStart(serverSpan());
      void p.shutdown();
    } finally {
      spy.mockRestore();
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("writes [span-diag] JSONL to stdout when enabled with no custom sink or path", () => {
    setSpanDiagnosticsFlag(true);
    const chunks: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      });
    try {
      const p = createSpanDiagnostics();
      p.onStart(serverSpan());
      void p.shutdown();
    } finally {
      spy.mockRestore();
    }
    expect(chunks.some((c) => c.startsWith("[span-diag] "))).toBe(true);
  });

  it("an explicit emit overrides the default JSONL sink", () => {
    setSpanDiagnosticsFlag(true);
    const records: DiagnosticRecord[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      const p = createSpanDiagnostics({ emit: (r) => records.push(r) });
      p.onStart(serverSpan());
      void p.shutdown();
    } finally {
      spy.mockRestore();
    }
    expect(records.length).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();
  });
});
