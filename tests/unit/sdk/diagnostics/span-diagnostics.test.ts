import { describe, it, expect, afterEach, vi } from "vitest";
import { SpanKind } from "@opentelemetry/api";
import type { ReadableSpan, Span } from "@opentelemetry/sdk-trace-base";
import { SpanDiagnosticsProcessor } from "../../../../packages/sdk/src/diagnostics/span-diagnostics-processor.js";
import type { DiagnosticRecord } from "../../../../packages/sdk/src/diagnostics/records.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const NAME = "POST /[locale]/control-panel/settings";
const ROUTE = "/[locale]/control-panel/settings";

// The pinned JSONL lines from the diagnostics record contract. The processor
// must serialize to these byte-for-byte (fields AND key order).
const PINNED_START =
  `{"ev":"start","t":1712664000000,"traceId":"${TRACE_ID}","spanId":"${SPAN_ID}",` +
  `"parentSpanId":"0000000000000000","name":"${NAME}","kind":"SERVER",` +
  `"route":"${ROUTE}","method":"POST"}`;
const PINNED_END =
  `{"ev":"end","t":1712664000123,"traceId":"${TRACE_ID}","spanId":"${SPAN_ID}",` +
  `"name":"${NAME}","kind":"SERVER","durationMs":123,"route":"${ROUTE}","method":"POST"}`;
const PINNED_UNENDED_SHUTDOWN =
  `{"ev":"unended","reason":"shutdown","t":1712664005000,"count":1,"droppedFromCap":0,` +
  `"spans":[{"traceId":"${TRACE_ID}","spanId":"${SPAN_ID}","name":"${NAME}","kind":"SERVER",` +
  `"route":"${ROUTE}","method":"POST","ageMs":5000}]}`;
const PINNED_RUN_SUMMARY =
  `{"ev":"run-summary","t":1712664005000,"started":1,"ended":0,"unended":1,` +
  `"droppedFromCap":0,"sweptAtTimeout":false,"ranShutdown":true}`;

function mockSpan(o?: {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind?: SpanKind;
  attributes?: Record<string, string | number | boolean>;
}): Span {
  const traceId = o?.traceId ?? TRACE_ID;
  const spanId = o?.spanId ?? SPAN_ID;
  return {
    name: o?.name ?? NAME,
    kind: o?.kind ?? SpanKind.SERVER,
    spanContext: () => ({ traceId, spanId, traceFlags: 1 }),
    parentSpanContext:
      o?.parentSpanId !== undefined
        ? { traceId, spanId: o.parentSpanId, traceFlags: 1 }
        : undefined,
    attributes: o?.attributes ?? { "http.route": ROUTE, "http.method": "POST" },
  } as unknown as Span;
}

const asEnded = (span: Span): ReadableSpan => span as unknown as ReadableSpan;

/** A collector sink plus a mutable injectable clock. */
function harness(clockStart = 1712664000000) {
  const records: DiagnosticRecord[] = [];
  const state = { clock: clockStart };
  const now = () => state.clock;
  const emit = (r: DiagnosticRecord) => records.push(r);
  return { records, state, now, emit };
}

const summaryOf = (records: DiagnosticRecord[]) =>
  records.filter((r) => r.ev === "run-summary");

describe("SpanDiagnosticsProcessor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits a `start` record byte-identical to the pinned contract", () => {
    const { records, now, emit } = harness();
    const p = new SpanDiagnosticsProcessor({ enabled: true, emit, now });
    p.onStart(mockSpan());
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records[0])).toBe(PINNED_START);
    void p.shutdown();
  });

  it("emits an `end` record byte-identical to the pinned contract (durationMs from the clock, no parentSpanId key)", () => {
    const { records, state, now, emit } = harness();
    const p = new SpanDiagnosticsProcessor({ enabled: true, emit, now });
    const span = mockSpan();
    p.onStart(span);
    state.clock = 1712664000123;
    p.onEnd(asEnded(span));
    const end = records.find((r) => r.ev === "end");
    expect(end).toBeDefined();
    expect(JSON.stringify(end)).toBe(PINNED_END);
    expect(end).not.toHaveProperty("parentSpanId");
    void p.shutdown();
  });

  it("uses the all-zero parentSpanId for a root span", () => {
    const { records, now, emit } = harness();
    const p = new SpanDiagnosticsProcessor({ enabled: true, emit, now });
    p.onStart(mockSpan({ parentSpanId: undefined }));
    expect((records[0] as { parentSpanId: string }).parentSpanId).toBe(
      "0000000000000000",
    );
    void p.shutdown();
  });

  it("carries the real parentSpanId when the span has a parent", () => {
    const { records, now, emit } = harness();
    const p = new SpanDiagnosticsProcessor({ enabled: true, emit, now });
    p.onStart(mockSpan({ parentSpanId: "aaaaaaaaaaaaaaaa" }));
    expect((records[0] as { parentSpanId: string }).parentSpanId).toBe(
      "aaaaaaaaaaaaaaaa",
    );
    void p.shutdown();
  });

  it("tracks SERVER and INTERNAL spans but not CLIENT/PRODUCER/CONSUMER", () => {
    const { records, now, emit } = harness();
    const p = new SpanDiagnosticsProcessor({ enabled: true, emit, now });
    p.onStart(mockSpan({ spanId: "1111111111111111", kind: SpanKind.SERVER }));
    p.onStart(mockSpan({ spanId: "2222222222222222", kind: SpanKind.INTERNAL }));
    p.onStart(mockSpan({ spanId: "3333333333333333", kind: SpanKind.CLIENT }));
    p.onStart(mockSpan({ spanId: "4444444444444444", kind: SpanKind.PRODUCER }));
    p.onStart(mockSpan({ spanId: "5555555555555555", kind: SpanKind.CONSUMER }));
    const started = records.filter((r) => r.ev === "start");
    expect(started.map((r) => (r as { kind: string }).kind).sort()).toEqual([
      "INTERNAL",
      "SERVER",
    ]);
    void p.shutdown();
  });

  it("reports a still-open span as unended at the timeout sweep and does not re-report it at shutdown", async () => {
    vi.useFakeTimers();
    const { records, state, now, emit } = harness(1000);
    const p = new SpanDiagnosticsProcessor({
      enabled: true,
      emit,
      now,
      leakTimeoutMs: 2000,
      sweepIntervalMs: 500,
    });
    p.onStart(mockSpan());
    state.clock = 3500; // age 2500 >= 2000
    vi.advanceTimersByTime(500); // fire the sweep once
    const timeouts = records.filter(
      (r) => r.ev === "unended" && r.reason === "timeout",
    );
    expect(timeouts).toHaveLength(1);
    expect((timeouts[0] as { count: number }).count).toBe(1);
    expect((timeouts[0] as { spans: { ageMs: number }[] }).spans[0].ageMs).toBe(
      2500,
    );
    await p.shutdown();
    const shutdownUnended = records.filter(
      (r) => r.ev === "unended" && r.reason === "shutdown",
    );
    expect(shutdownUnended).toHaveLength(0); // already reported, not repeated
    // The run-summary liveness flag records that a timeout sweep fired.
    expect(summaryOf(records)[0]).toMatchObject({ sweptAtTimeout: true });
  });

  it("surfaces droppedFromCap at shutdown even when the tracking table drained empty", async () => {
    const { records, state, now, emit } = harness(1000);
    const p = new SpanDiagnosticsProcessor({
      enabled: true,
      emit,
      now,
      maxTrackedSpans: 1,
    });
    const a = mockSpan({ spanId: "1111111111111111" });
    p.onStart(a); // tracked
    p.onStart(mockSpan({ spanId: "2222222222222222" })); // dropped by cap
    state.clock = 1010;
    p.onEnd(asEnded(a)); // table drains empty
    await p.shutdown();
    const shutdownUnended = records.find(
      (r) => r.ev === "unended" && r.reason === "shutdown",
    );
    expect(shutdownUnended).toBeDefined();
    expect(shutdownUnended).toMatchObject({ count: 0, droppedFromCap: 1, spans: [] });
    expect(summaryOf(records)[0]).toMatchObject({ droppedFromCap: 1 });
  });

  it("emits exactly one run-summary with the pinned shape", async () => {
    const { records, state, now, emit } = harness(1000);
    const p = new SpanDiagnosticsProcessor({ enabled: true, emit, now });
    const a = mockSpan({ spanId: "1111111111111111" });
    const b = mockSpan({ spanId: "2222222222222222" });
    p.onStart(a);
    p.onStart(b);
    state.clock = 1050;
    p.onEnd(asEnded(a));
    await p.shutdown();
    const summaries = summaryOf(records);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual({
      ev: "run-summary",
      t: expect.any(Number),
      started: 2,
      ended: 1,
      unended: 1, // b still open at shutdown
      droppedFromCap: 0,
      sweptAtTimeout: false,
      ranShutdown: true,
    });
  });

  it("emits byte-identical `unended` (shutdown) and `run-summary` records", async () => {
    const { records, state, now, emit } = harness();
    const p = new SpanDiagnosticsProcessor({ enabled: true, emit, now });
    p.onStart(mockSpan()); // default ids/name/route/method, root parent
    state.clock = 1712664005000;
    await p.shutdown();
    const unended = records.find((r) => r.ev === "unended");
    const summary = records.find((r) => r.ev === "run-summary");
    expect(JSON.stringify(unended)).toBe(PINNED_UNENDED_SHUTDOWN);
    expect(JSON.stringify(summary)).toBe(PINNED_RUN_SUMMARY);
  });

  it("is idempotent on shutdown and stops sweeping after it", async () => {
    vi.useFakeTimers();
    const { records, state, now, emit } = harness(1000);
    const p = new SpanDiagnosticsProcessor({
      enabled: true,
      emit,
      now,
      leakTimeoutMs: 1000,
      sweepIntervalMs: 500,
    });
    p.onStart(mockSpan());
    await p.shutdown();
    await p.shutdown(); // second call must be a no-op
    expect(summaryOf(records)).toHaveLength(1);
    const before = records.length;
    state.clock = 9999;
    vi.advanceTimersByTime(5000); // interval was cleared → no further records
    expect(records.length).toBe(before);
  });

  it("counts a span reported unended at a sweep and then ended in both tallies", async () => {
    vi.useFakeTimers();
    const { records, state, now, emit } = harness(1000);
    const p = new SpanDiagnosticsProcessor({
      enabled: true,
      emit,
      now,
      leakTimeoutMs: 2000,
      sweepIntervalMs: 500,
    });
    const span = mockSpan();
    p.onStart(span);
    state.clock = 4000;
    vi.advanceTimersByTime(500); // sweep reports it unended
    p.onEnd(asEnded(span)); // then it ends
    await p.shutdown();
    expect(records.some((r) => r.ev === "end")).toBe(true);
    expect(summaryOf(records)[0]).toMatchObject({ started: 1, ended: 1, unended: 1 });
  });

  it("is a silent no-op with no sink, and never lets a throwing sink escape a hook", async () => {
    const noSink = new SpanDiagnosticsProcessor({ enabled: true });
    expect(() => noSink.onStart(mockSpan())).not.toThrow();
    expect(() => noSink.onEnd(asEnded(mockSpan()))).not.toThrow();
    await expect(noSink.shutdown()).resolves.toBeUndefined();

    const thrower = new SpanDiagnosticsProcessor({
      enabled: true,
      emit: () => {
        throw new Error("sink exploded");
      },
    });
    const span = mockSpan();
    expect(() => thrower.onStart(span)).not.toThrow();
    expect(() => thrower.onEnd(asEnded(span))).not.toThrow();
    await expect(thrower.shutdown()).resolves.toBeUndefined();
  });

  it("does nothing when disabled — no records and no work", async () => {
    const { records, now, emit } = harness();
    const p = new SpanDiagnosticsProcessor({ enabled: false, emit, now });
    p.onStart(mockSpan());
    p.onEnd(asEnded(mockSpan()));
    await p.shutdown();
    expect(records).toHaveLength(0);
  });

  it("omits route/method when the span has no http.route/http.method", () => {
    const { records, now, emit } = harness();
    const p = new SpanDiagnosticsProcessor({ enabled: true, emit, now });
    p.onStart(mockSpan({ attributes: {} }));
    expect(records[0]).not.toHaveProperty("route");
    expect(records[0]).not.toHaveProperty("method");
    void p.shutdown();
  });

  it("falls back to http.request.method when http.method is absent", () => {
    const { records, now, emit } = harness();
    const p = new SpanDiagnosticsProcessor({ enabled: true, emit, now });
    p.onStart(mockSpan({ attributes: { "http.request.method": "PATCH" } }));
    expect((records[0] as { method?: string }).method).toBe("PATCH");
    void p.shutdown();
  });

  it("leaks no raw attribute value, url, header, or body into any record", () => {
    const SECRET = "SECRET-token-abc123";
    const { records, state, now, emit } = harness(1000);
    const p = new SpanDiagnosticsProcessor({
      enabled: true,
      emit,
      now,
      leakTimeoutMs: 1,
      maxTrackedSpans: 10,
    });
    const span = mockSpan({
      attributes: {
        "http.route": ROUTE,
        "http.method": "POST",
        "http.url": `https://x.test/settings?token=${SECRET}`,
        "url.full": `https://x.test/?t=${SECRET}`,
        "url.query": `token=${SECRET}`,
        "http.target": `/settings?token=${SECRET}`,
        "http.host": "x.test",
        "http.user_agent": SECRET,
        "http.request.header.authorization": `Bearer ${SECRET}`,
        "request.body": SECRET,
      },
    });
    p.onStart(span);
    // Force an unended record (which also carries structural facts) then end it.
    state.clock = 5000;
    void p.shutdown();
    const dump = JSON.stringify(records);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain("http.url");
    expect(dump).not.toContain("authorization");
  });

  it("keys tracking by traceId+spanId so concurrent traces sharing a spanId do not collide", async () => {
    const { records, now, emit } = harness();
    const p = new SpanDiagnosticsProcessor({ enabled: true, emit, now });
    const a = mockSpan({ traceId: "a".repeat(32), spanId: SPAN_ID });
    const b = mockSpan({ traceId: "b".repeat(32), spanId: SPAN_ID });
    p.onStart(a);
    p.onStart(b); // same spanId, different trace — must NOT overwrite a
    p.onEnd(asEnded(a)); // ends a only
    await p.shutdown();
    expect(records.filter((r) => r.ev === "start")).toHaveLength(2);
    const ends = records.filter((r) => r.ev === "end");
    expect(ends).toHaveLength(1);
    expect((ends[0] as { traceId: string }).traceId).toBe("a".repeat(32));
    expect(summaryOf(records)[0]).toMatchObject({ started: 2, ended: 1, unended: 1 });
  });

  it("clamps durationMs to 0 when the clock steps backward between start and end", () => {
    const { records, state, now, emit } = harness(5000);
    const p = new SpanDiagnosticsProcessor({ enabled: true, emit, now });
    const span = mockSpan();
    p.onStart(span); // startedAtMs = 5000
    state.clock = 1000; // clock steps BACKWARD (NTP correction / VM resume)
    p.onEnd(asEnded(span));
    expect((records.find((r) => r.ev === "end") as { durationMs: number }).durationMs).toBe(0);
    void p.shutdown();
  });

  it("clamps an unended ageMs to 0 when the clock steps backward before shutdown", async () => {
    const { records, state, now, emit } = harness(5000);
    const p = new SpanDiagnosticsProcessor({ enabled: true, emit, now });
    p.onStart(mockSpan());
    state.clock = 1000; // backward
    await p.shutdown();
    const unended = records.find((r) => r.ev === "unended");
    expect((unended as { spans: { ageMs: number }[] }).spans[0].ageMs).toBe(0);
  });

  it("never throws into the host when a span's getters throw (outer hook guards)", () => {
    const { records, now, emit } = harness();
    const p = new SpanDiagnosticsProcessor({ enabled: true, emit, now });
    // A span whose spanContext() throws — exercises the outer try/catch in both
    // onStart and onEnd (trackingKey is the first call in each).
    const badContext = {
      name: "bad",
      kind: SpanKind.SERVER,
      spanContext: () => {
        throw new Error("spanContext exploded");
      },
      parentSpanContext: undefined,
      attributes: {},
    } as unknown as Span;
    expect(() => p.onStart(badContext)).not.toThrow();
    expect(() => p.onEnd(asEnded(badContext))).not.toThrow();
    // A span whose attributes getter throws — exercises the outer catch around
    // the record build inside onStart.
    const badAttrs = {
      name: "bad2",
      kind: SpanKind.SERVER,
      spanContext: () => ({ traceId: TRACE_ID, spanId: "cccccccccccccccc", traceFlags: 1 }),
      parentSpanContext: undefined,
      get attributes(): Record<string, unknown> {
        throw new Error("attrs exploded");
      },
    } as unknown as Span;
    expect(() => p.onStart(badAttrs)).not.toThrow();
    // A subsequent good span is still handled — the processor is not wedged.
    expect(() => p.onStart(mockSpan())).not.toThrow();
    expect(records.some((r) => r.ev === "start")).toBe(true);
    void p.shutdown();
  });

  it("operates standalone — never touches an exporter, provider, or the breaker", () => {
    // The processor is observe-only; constructing and driving it requires no
    // provider/exporter wiring at all (a regression guard against it reaching
    // into the export path).
    const { records, now, emit } = harness();
    const p = new SpanDiagnosticsProcessor({ enabled: true, emit, now });
    expect(() => p.onStart(mockSpan())).not.toThrow();
    expect(records).toHaveLength(1);
    void p.shutdown();
  });
});
