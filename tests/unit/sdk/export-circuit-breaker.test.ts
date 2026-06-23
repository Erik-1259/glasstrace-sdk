/**
 * Export-Path Circuit Breaker — DISC-1568 / Wave 15C-impl regression tests.
 *
 * Implements the 12-scenario test matrix from the design memo
 * (`glasstrace-product/docs/task-briefs/SDK-circuit-breaker-design.md`
 * §Decision 8) end-to-end. Two surfaces are exercised:
 *
 *   1. The pure-logic state machine via {@link createExportCircuitBreaker}
 *      with a captured event sink and a stub `recordDropped` hook.
 *   2. The integration with `GlasstraceExporter` using a mock
 *      `SpanExporter` injected through the constructor's `createDelegate`
 *      factory. This proves the production wiring (export() →
 *      shouldExport() → recordSuccess/recordFailure) works end-to-end
 *      and surfaces lifecycle events through the SDK's lifecycle bus.
 *
 * Both surfaces use Vitest fake timers so probe scheduling is
 * deterministic and tests never wait on real wall-clock time.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { ExportResult } from "@opentelemetry/core";
import type { CaptureConfig } from "@glasstrace/protocol";
import { GLASSTRACE_ATTRIBUTE_NAMES } from "@glasstrace/protocol";
import {
  createExportCircuitBreaker,
  classifyExportFailure,
  INITIAL_BACKOFF_MS,
  BACKOFF_FACTOR,
  MAX_BACKOFF_MS,
  FAILURE_THRESHOLD,
  MAX_TRACKED_TRACES,
  MAX_EXCEPTIONS_PER_TRACE,
  TRACE_ERROR_TTL_MS,
  type ExportCircuitBreaker,
  type ExportCircuitEventSink,
  type ExportCircuitOpenedPayload,
  type ExportCircuitHalfOpenPayload,
  type ExportCircuitClosedPayload,
  _resetExportCircuitBreakerForTesting,
  peekExportCircuitBreaker,
} from "../../../packages/sdk/src/export-circuit-breaker.js";
import { GlasstraceExporter, API_KEY_PENDING } from "../../../packages/sdk/src/enriching-exporter.js";
import { SessionManager } from "../../../packages/sdk/src/session.js";
import * as lifecycle from "../../../packages/sdk/src/lifecycle.js";
import {
  startRuntimeStateWriter,
  _resetRuntimeStateForTesting,
} from "../../../packages/sdk/src/runtime-state.js";
import type { RuntimeState } from "../../../packages/sdk/src/runtime-state.js";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_CONFIG: CaptureConfig = {
  requestBodies: false,
  queryParamValues: false,
  envVarValues: false,
  fullConsoleOutput: false,
  importGraph: false,
};
const TEST_API_KEY = "gt_dev_" + "a".repeat(48);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Captures every event emitted by the breaker so tests can assert on
 * the full payload shape and ordering.
 */
interface RecordedEvents {
  opened: ExportCircuitOpenedPayload[];
  halfOpen: ExportCircuitHalfOpenPayload[];
  closed: ExportCircuitClosedPayload[];
  sink: ExportCircuitEventSink;
}

function makeEventSink(): RecordedEvents {
  const opened: ExportCircuitOpenedPayload[] = [];
  const halfOpen: ExportCircuitHalfOpenPayload[] = [];
  const closed: ExportCircuitClosedPayload[] = [];
  return {
    opened,
    halfOpen,
    closed,
    sink: {
      emitOpened: (p) => opened.push(p),
      emitHalfOpen: (p) => halfOpen.push(p),
      emitClosed: (p) => closed.push(p),
    },
  };
}

function makeBreaker(events: RecordedEvents, dropped: number[]): ExportCircuitBreaker {
  return createExportCircuitBreaker({
    events: events.sink,
    recordDropped: (count) => dropped.push(count),
  });
}

function createMockSpan(): ReadableSpan {
  return {
    name: "GET /api/test",
    kind: SpanKind.SERVER,
    spanContext: () => ({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: 1,
    }),
    parentSpanId: undefined,
    startTime: [1700000000, 0],
    endTime: [1700000000, 100_000_000],
    status: { code: SpanStatusCode.OK },
    attributes: { "http.method": "GET", "http.route": "/api/test", "http.status_code": 200 },
    links: [],
    events: [],
    duration: [0, 100_000_000],
    ended: true,
    resource: { attributes: {} },
    instrumentationScope: { name: "test", version: "1.0.0" },
    instrumentationLibrary: { name: "test", version: "1.0.0" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan;
}

/**
 * Mock delegate exporter whose `export()` outcome is dictated by the
 * test through `nextResult`. The default outcome is success
 * (`{ code: 0 }`).
 */
interface MockDelegate extends SpanExporter {
  exportedBatches: number;
  setNextResult: (r: ExportResult) => void;
  setNextResults: (results: ExportResult[]) => void;
}

function createMockDelegate(): MockDelegate {
  let queue: ExportResult[] = [];
  let fallback: ExportResult = { code: 0 };
  const delegate: MockDelegate = {
    exportedBatches: 0,
    export(_spans, resultCallback) {
      delegate.exportedBatches += 1;
      const next = queue.shift() ?? fallback;
      resultCallback(next);
    },
    shutdown: vi.fn().mockResolvedValue(undefined),
    forceFlush: vi.fn().mockResolvedValue(undefined),
    setNextResult(r: ExportResult) {
      fallback = r;
    },
    setNextResults(results: ExportResult[]) {
      queue = [...results];
    },
  };
  return delegate;
}

// ---------------------------------------------------------------------------
// Pure-logic suite — drives the breaker directly without GlasstraceExporter
// ---------------------------------------------------------------------------

describe("ExportCircuitBreaker — pure logic", () => {
  let events: RecordedEvents;
  let dropped: number[];
  let breaker: ExportCircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    events = makeEventSink();
    dropped = [];
    breaker = makeBreaker(events, dropped);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Scenario 1: CLOSED → OPEN under N consecutive failures
  it("trips OPEN after exactly N consecutive failures and emits otel:circuit_opened once", () => {
    expect(breaker.getState()).toBe("CLOSED");
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      breaker.recordFailure({ status: 500 });
      expect(breaker.getState()).toBe("CLOSED");
      expect(events.opened).toHaveLength(0);
    }
    breaker.recordFailure({ status: 500 });
    expect(breaker.getState()).toBe("OPEN");
    expect(events.opened).toHaveLength(1);
    expect(events.opened[0]).toMatchObject({
      category: "server_error",
      consecutiveFailures: FAILURE_THRESHOLD,
      nextProbeMs: INITIAL_BACKOFF_MS,
    });
    expect(events.opened[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(events.opened[0].message).toContain(`${FAILURE_THRESHOLD} consecutive failures`);

    // Subsequent shouldExport() returns false, drops are counted.
    expect(breaker.shouldExport()).toBe(false);
    breaker.onSpansDropped(7);
    breaker.onSpansDropped(3);
    expect(dropped).toEqual([7, 3]);
  });

  // Scenario 2: OPEN → HALF_OPEN after timer T expires
  it("transitions to HALF_OPEN after the backoff timer expires and emits otel:circuit_half_open", () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) breaker.recordFailure({ status: 500 });
    expect(breaker.getState()).toBe("OPEN");
    expect(events.halfOpen).toHaveLength(0);

    vi.advanceTimersByTime(INITIAL_BACKOFF_MS);
    expect(breaker.getState()).toBe("HALF_OPEN");
    expect(events.halfOpen).toHaveLength(1);
    expect(events.halfOpen[0].previousTimerMs).toBe(INITIAL_BACKOFF_MS);
    expect(events.halfOpen[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(breaker.shouldExport()).toBe(true);
  });

  // Scenario 3: HALF_OPEN → CLOSED on success
  it("closes the circuit when the HALF_OPEN probe succeeds and reports outage duration", async () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) breaker.recordFailure({ status: 500 });
    vi.advanceTimersByTime(INITIAL_BACKOFF_MS);
    expect(breaker.getState()).toBe("HALF_OPEN");

    breaker.recordSuccess();
    expect(breaker.getState()).toBe("CLOSED");
    expect(events.closed).toHaveLength(1);
    expect(events.closed[0].outageDurationMs).toBeGreaterThanOrEqual(INITIAL_BACKOFF_MS);

    // Counter reset — a single failure post-recovery is not enough to
    // re-trip; we must accumulate FAILURE_THRESHOLD again.
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) breaker.recordFailure({ status: 500 });
    expect(breaker.getState()).toBe("CLOSED");
  });

  // Scenario 4: HALF_OPEN → OPEN on failure with doubled timer
  it("re-opens with a doubled timer when the HALF_OPEN probe fails, capped at T_MAX", () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) breaker.recordFailure({ status: 500 });
    let expectedBackoff = INITIAL_BACKOFF_MS;
    // Six successive HALF_OPEN→OPEN cycles to reach the T_MAX cap.
    // INITIAL=30s, BACKOFF×2 each cycle, capped at MAX=1800s.
    for (let cycle = 1; cycle <= 7; cycle++) {
      vi.advanceTimersByTime(expectedBackoff);
      expect(breaker.getState()).toBe("HALF_OPEN");
      breaker.recordFailure({ status: 500 });
      expectedBackoff = Math.min(expectedBackoff * BACKOFF_FACTOR, MAX_BACKOFF_MS);
      expect(breaker.getState()).toBe("OPEN");
    }
    // After 7 cycles the timer should be capped at MAX_BACKOFF_MS.
    expect(expectedBackoff).toBe(MAX_BACKOFF_MS);
    // Only the first OPEN transition emits otel:circuit_opened — not
    // subsequent re-opens within the same outage.
    expect(events.opened).toHaveLength(1);
  });

  // Scenario 5: Reset on credential rotation
  it("resets to CLOSED on credential rotation regardless of state", () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) breaker.recordFailure({ status: 401 });
    expect(breaker.getState()).toBe("OPEN");
    const generationBefore = breaker.getGeneration();

    breaker.resetForKeyRotation();
    expect(breaker.getState()).toBe("CLOSED");
    expect(breaker.getGeneration()).toBe(generationBefore + 1);
    expect(events.closed).toHaveLength(1);

    // Counter is reset — a single new failure post-rotation does not re-trip.
    breaker.recordFailure({ status: 401 });
    expect(breaker.getState()).toBe("CLOSED");
  });

  // Scenario 6: Bounded behavior under sustained failure
  it("drops every span via recordDropped without growing internal state", () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) breaker.recordFailure({ status: 500 });
    expect(breaker.getState()).toBe("OPEN");
    // 100k iterations (representative of the memo's "100,000 spans
    // during 30-minute outage" assertion) — each call is O(1) and the
    // breaker should not grow any data structure.
    for (let i = 0; i < 1000; i++) {
      breaker.onSpansDropped(100);
    }
    expect(dropped).toHaveLength(1000);
    expect(dropped.reduce((a, b) => a + b, 0)).toBe(100_000);
    // State unchanged; only one OPEN event emitted.
    expect(events.opened).toHaveLength(1);
    expect(events.halfOpen).toHaveLength(0);
    expect(events.closed).toHaveLength(0);
  });

  // Scenario 8: Lifecycle event payload coverage
  it("emits payloads with the contracted shape and no extra keys", () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) breaker.recordFailure({ status: 500 });
    expect(Object.keys(events.opened[0]).sort()).toEqual(
      ["category", "consecutiveFailures", "message", "nextProbeMs", "timestamp"].sort(),
    );
    vi.advanceTimersByTime(INITIAL_BACKOFF_MS);
    expect(Object.keys(events.halfOpen[0]).sort()).toEqual(["previousTimerMs", "timestamp"].sort());
    breaker.recordSuccess();
    expect(Object.keys(events.closed[0]).sort()).toEqual(["outageDurationMs", "timestamp"].sort());
    // No PII fields — the payloads must NOT include URLs, headers, or error messages
    // surfaced from the underlying transport.
    expect(events.opened[0].message).not.toMatch(/http|bearer|authorization/i);
  });

  // Scenario 9: Failure-category routing
  it("routes each known failure shape to the correct category enum", () => {
    expect(classifyExportFailure({ status: 401 })).toBe("auth");
    expect(classifyExportFailure({ status: 403 })).toBe("auth");
    expect(classifyExportFailure({ status: 429 })).toBe("rate_limit");
    expect(classifyExportFailure({ status: 500 })).toBe("server_error");
    expect(classifyExportFailure({ status: 503 })).toBe("server_error");
    expect(classifyExportFailure({ status: 404 })).toBe("client_error");
    expect(classifyExportFailure({ status: 422 })).toBe("client_error");
    expect(classifyExportFailure({})).toBe("network");
    expect(classifyExportFailure({ error: { code: "ECONNREFUSED" } })).toBe("network");
    // String-shaped status (some Node versions surface status as string)
    expect(classifyExportFailure({ error: { status: "401" } })).toBe("auth");
    // Nested status under response.status (alternate OTLP exporter shape)
    expect(classifyExportFailure({ error: { response: { status: 503 } } })).toBe("server_error");
  });

  // Scenario 10: 4xx-other counted as failure
  it("counts non-401/403/429/2xx HTTP statuses toward the threshold", () => {
    breaker.recordFailure({ status: 400 });
    breaker.recordFailure({ status: 404 });
    breaker.recordFailure({ status: 413 });
    breaker.recordFailure({ status: 414 });
    expect(breaker.getState()).toBe("CLOSED");
    breaker.recordFailure({ status: 422 });
    expect(breaker.getState()).toBe("OPEN");
    expect(events.opened[0].category).toBe("client_error");
  });

  // Scenario 11: 2xx resets counter to 0 mid-streak
  it("resets the consecutive-failure counter on success mid-streak", () => {
    breaker.recordFailure({ status: 500 });
    breaker.recordFailure({ status: 500 });
    breaker.recordFailure({ status: 500 });
    breaker.recordSuccess();
    // Counter reset — three more failures should not be enough to trip.
    breaker.recordFailure({ status: 500 });
    breaker.recordFailure({ status: 500 });
    breaker.recordFailure({ status: 500 });
    breaker.recordFailure({ status: 500 });
    expect(breaker.getState()).toBe("CLOSED");
    breaker.recordFailure({ status: 500 });
    expect(breaker.getState()).toBe("OPEN");
  });

  // Scenario 12: Generation-counter guard for probe-during-rotation race
  it("invalidates an in-flight probe via generation-counter mismatch on rotation", () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) breaker.recordFailure({ status: 401 });
    vi.advanceTimersByTime(INITIAL_BACKOFF_MS);
    expect(breaker.getState()).toBe("HALF_OPEN");
    const generationAtProbeIssue = breaker.getGeneration();

    // Rotation fires while probe is in flight.
    breaker.resetForKeyRotation();
    expect(breaker.getState()).toBe("CLOSED");
    expect(breaker.getGeneration()).toBe(generationAtProbeIssue + 1);

    // The exporter would now observe a generation mismatch and skip
    // recording the probe's outcome. We simulate that here by checking
    // that the consumer (via the comparison `breaker.getGeneration() !==
    // generationAtIssue`) detects the mismatch.
    expect(breaker.getGeneration() !== generationAtProbeIssue).toBe(true);
  });

  // Generic: shouldExport semantics across each state
  it("only blocks export in OPEN state and admits exactly one probe in HALF_OPEN", () => {
    expect(breaker.shouldExport()).toBe(true);
    for (let i = 0; i < FAILURE_THRESHOLD; i++) breaker.recordFailure({ status: 500 });
    expect(breaker.shouldExport()).toBe(false);
    vi.advanceTimersByTime(INITIAL_BACKOFF_MS);
    expect(breaker.getState()).toBe("HALF_OPEN");
    // First HALF_OPEN caller is admitted as the single probe.
    expect(breaker.shouldExport()).toBe(true);
    // Subsequent concurrent callers (before the first probe records)
    // are blocked — single-probe contract per the design memo §5
    // and the Codex P1 finding 2026-05-08.
    expect(breaker.shouldExport()).toBe(false);
    expect(breaker.shouldExport()).toBe(false);
    breaker.recordSuccess();
    // After probe success → CLOSED → all callers admitted again.
    expect(breaker.getState()).toBe("CLOSED");
    expect(breaker.shouldExport()).toBe(true);
    expect(breaker.shouldExport()).toBe(true);
  });

  it("re-admits a single probe on each HALF_OPEN re-entry after a failed probe", () => {
    // Trip OPEN.
    for (let i = 0; i < FAILURE_THRESHOLD; i++) breaker.recordFailure({ status: 500 });
    expect(breaker.getState()).toBe("OPEN");

    // First HALF_OPEN window: admit one probe, fail it, back to OPEN.
    vi.advanceTimersByTime(INITIAL_BACKOFF_MS);
    expect(breaker.getState()).toBe("HALF_OPEN");
    expect(breaker.shouldExport()).toBe(true);
    expect(breaker.shouldExport()).toBe(false); // gate held
    breaker.recordFailure({ status: 500 });
    expect(breaker.getState()).toBe("OPEN");

    // Second HALF_OPEN window (doubled timer): gate is reset and one
    // probe is admitted again. This proves the gate clears on every
    // state transition, not just on success/close.
    vi.advanceTimersByTime(INITIAL_BACKOFF_MS * 2);
    expect(breaker.getState()).toBe("HALF_OPEN");
    expect(breaker.shouldExport()).toBe(true);
    expect(breaker.shouldExport()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-trace boundary-masked error store (hosted on the breaker singleton)
// ---------------------------------------------------------------------------

describe("ExportCircuitBreaker — per-trace boundary-masked error store", () => {
  let nowMs: number;

  function makeStoreBreaker(): ExportCircuitBreaker {
    return createExportCircuitBreaker({
      events: { emitOpened() {}, emitHalfOpen() {}, emitClosed() {} },
      recordDropped: () => {},
      now: () => nowMs,
    });
  }

  beforeEach(() => {
    nowMs = 1_700_000_000_000;
  });

  it("expires entries older than the TTL on the next operation (TTL-first sweep)", () => {
    const breaker = makeStoreBreaker();
    const store = breaker.traceErrors;
    const key = "a".repeat(32) + "#sess";
    store.recordParentLink(key, "span", undefined, nowMs);
    expect(store.size()).toBe(1);

    // Advance past the TTL, then touch a different key to drive a sweep.
    nowMs += TRACE_ERROR_TTL_MS + 1;
    store.recordParentLink("b".repeat(32) + "#sess", "span2", undefined, nowMs);
    // The first (now-stale) entry is evicted; only the fresh one remains.
    expect(store.peek(key)).toBeUndefined();
    expect(store.getCounters().evictions).toBe(1);
  });

  it("consult() evicts a stale entry on access and reports no lineage (no false promotion on key reuse after TTL)", () => {
    const breaker = makeStoreBreaker();
    const store = breaker.traceErrors;
    const key = "a".repeat(32) + "#sess";

    // An old request records a descendant exception under this trace+session.
    store.recordException(
      key,
      { spanId: "old-exc", parentSpanId: "srv", startTimeMs: 1 },
      nowMs,
    );
    expect(store.peek(key)?.lineageBySpanId.size).toBe(1);

    // The SAME key is reused after the TTL (a traceId collision, a long-delayed
    // retry, or a deterministic fixture) with NO intervening new-key insert to
    // drive a sweep. The read path the promotion uses must NOT return the stale
    // lineage — it evicts on access and reports nothing (fail-open), so an aged
    // exception can never promote a fresh server span (a false 500).
    nowMs += TRACE_ERROR_TTL_MS + 1;
    expect(store.consult(key, nowMs)).toBeUndefined();
    expect(store.getCounters().evictions).toBe(1);
    expect(store.peek(key)).toBeUndefined();
  });

  it("getOrCreate() starts fresh when a write reuses a key after the TTL (aged lineage dropped, not resurrected)", () => {
    const breaker = makeStoreBreaker();
    const store = breaker.traceErrors;
    const key = "1".repeat(32) + "#sess";

    store.recordException(
      key,
      { spanId: "old-exc", parentSpanId: "srv", startTimeMs: 1 },
      nowMs,
    );
    expect(store.peek(key)?.lineageBySpanId.has("old-exc")).toBe(true);

    // A write reuses the same key after the TTL, again with no sweep. The aged
    // entry is evicted on access and a fresh state is started, so the new
    // request's lineage never contains the old exception.
    nowMs += TRACE_ERROR_TTL_MS + 1;
    store.recordException(
      key,
      { spanId: "new-exc", parentSpanId: "srv2", startTimeMs: 1 },
      nowMs,
    );
    const state = store.peek(key)!;
    expect(state.lineageBySpanId.has("old-exc")).toBe(false);
    expect(state.lineageBySpanId.has("new-exc")).toBe(true);
    expect(state.lineageBySpanId.size).toBe(1);
    expect(store.getCounters().evictions).toBe(1);
  });

  it("evicts by LRU (least-recently-accessed) when over the cap, tie-broken by oldest-inserted", () => {
    const breaker = makeStoreBreaker();
    const store = breaker.traceErrors;
    // Insert exactly the cap; each gets a distinct, increasing access time.
    for (let i = 0; i < MAX_TRACKED_TRACES; i++) {
      const traceId = i.toString(16).padStart(32, "0");
      store.recordParentLink(`${traceId}#s`, "x", undefined, nowMs++);
    }
    expect(store.size()).toBe(MAX_TRACKED_TRACES);

    // Touch the FIRST-inserted (oldest LRU) so it is no longer the victim.
    const firstKey = (0).toString(16).padStart(32, "0") + "#s";
    store.consult(firstKey, nowMs++);

    // Insert one more → over cap → LRU evicts the least-recently-accessed,
    // which is now the SECOND-inserted entry (index 1), not the freshly
    // touched first one.
    const overflowTrace = (MAX_TRACKED_TRACES).toString(16).padStart(32, "0");
    store.recordParentLink(`${overflowTrace}#s`, "x", undefined, nowMs++);

    expect(store.size()).toBe(MAX_TRACKED_TRACES);
    const secondKey = (1).toString(16).padStart(32, "0") + "#s";
    expect(store.peek(secondKey)).toBeUndefined(); // LRU victim
    expect(store.peek(firstKey)).toBeDefined(); // touched, survives
    expect(store.getCounters().evictions).toBeGreaterThan(0);
  });

  it("clearTraceErrors() and resetForKeyRotation() both empty the store", () => {
    const breaker = makeStoreBreaker();
    const store = breaker.traceErrors;
    store.recordParentLink("c".repeat(32) + "#s", "x", undefined, nowMs);
    store.recordParentLink("d".repeat(32) + "#s", "y", undefined, nowMs);
    expect(store.size()).toBe(2);

    breaker.clearTraceErrors();
    expect(store.size()).toBe(0);

    store.recordParentLink("e".repeat(32) + "#s", "z", undefined, nowMs);
    expect(store.size()).toBe(1);
    breaker.resetForKeyRotation();
    expect(store.size()).toBe(0);
  });

  it("records the deterministic earliest exception (smallest startTimeMs; tie-break smallest spanId)", () => {
    const breaker = makeStoreBreaker();
    const store = breaker.traceErrors;
    const key = "f".repeat(32) + "#s";
    store.recordException(
      key,
      { spanId: "late", parentSpanId: "p", startTimeMs: 100 },
      nowMs,
    );
    store.recordException(
      key,
      { spanId: "early", parentSpanId: "p", startTimeMs: 50 },
      nowMs,
    );
    store.recordException(
      key,
      { spanId: "aaa", parentSpanId: "p", startTimeMs: 50 },
      nowMs,
    );
    const state = store.peek(key)!;
    // startTime 50 wins over 100; among the two 50s, "aaa" < "early".
    expect(state.firstExceptionSpanId).toBe("aaa");
  });

  it("caps lineageBySpanId at MAX_EXCEPTIONS_PER_TRACE; overflow drops new spanIds and bumps the counter", () => {
    const breaker = makeStoreBreaker();
    const store = breaker.traceErrors;
    const key = "1".repeat(32) + "#s";
    // Insert exactly the cap with distinct spanIds.
    for (let i = 0; i < MAX_EXCEPTIONS_PER_TRACE; i++) {
      const spanId = i.toString(16).padStart(16, "0");
      store.recordException(key, { spanId, parentSpanId: "p", startTimeMs: i }, nowMs);
    }
    const state = store.peek(key)!;
    expect(state.lineageBySpanId.size).toBe(MAX_EXCEPTIONS_PER_TRACE);
    expect(state.lineageOverflow).toBe(false);
    expect(store.getCounters().lineageOverflow).toBe(0);

    // One distinct spanId past the cap is dropped, not admitted.
    const overflowSpanId = "f".repeat(16);
    store.recordException(
      key,
      { spanId: overflowSpanId, parentSpanId: "p", startTimeMs: 999 },
      nowMs,
    );
    expect(state.lineageBySpanId.size).toBe(MAX_EXCEPTIONS_PER_TRACE);
    expect(state.lineageBySpanId.has(overflowSpanId)).toBe(false);
    expect(state.lineageOverflow).toBe(true);
    expect(store.getCounters().lineageOverflow).toBe(1);

    // Re-recording an already-tracked spanId overwrites in place — it never
    // counts against the cap.
    const existingSpanId = (0).toString(16).padStart(16, "0");
    store.recordException(
      key,
      { spanId: existingSpanId, parentSpanId: "p", startTimeMs: 0, message: "updated" },
      nowMs,
    );
    expect(state.lineageBySpanId.size).toBe(MAX_EXCEPTIONS_PER_TRACE);
    expect(state.lineageBySpanId.get(existingSpanId)?.message).toBe("updated");
    expect(store.getCounters().lineageOverflow).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cross-batch boundary-masked hoist — pass-1 lineage recording is hoisted
// ABOVE the OPEN-drop gate in BOTH entry points (export() and flushPending()),
// so a descendant batch dropped while the breaker is OPEN still contributes
// the lineage a later parent batch needs to promote. A revert of either hoist
// must fail this suite.
// ---------------------------------------------------------------------------

describe("ExportCircuitBreaker — cross-batch boundary-masked hoist over OPEN gate", () => {
  const ATTR = GLASSTRACE_ATTRIBUTE_NAMES;
  const XB_TRACE = "22222222222222222222222222222222";
  const XB_SERVER = "1212121212121212";
  const XB_RENDER = "3434343434343434";

  interface CapturingDelegate extends SpanExporter {
    exportedSpans: ReadableSpan[][];
    exportedBatches: number;
    setNextResult: (r: ExportResult) => void;
  }

  function createCapturingDelegate(): CapturingDelegate {
    let fallback: ExportResult = { code: 0 };
    const delegate: CapturingDelegate = {
      exportedSpans: [],
      exportedBatches: 0,
      export(spans, resultCallback) {
        delegate.exportedBatches += 1;
        delegate.exportedSpans.push(spans);
        resultCallback(fallback);
      },
      shutdown: vi.fn().mockResolvedValue(undefined),
      forceFlush: vi.fn().mockResolvedValue(undefined),
      setNextResult(r: ExportResult) {
        fallback = r;
      },
    };
    return delegate;
  }

  function xbServerSpan(): ReadableSpan {
    return {
      name: "GET /[locale]/dashboard",
      kind: SpanKind.SERVER,
      spanContext: () => ({ traceId: XB_TRACE, spanId: XB_SERVER, traceFlags: 1 }),
      parentSpanContext: undefined,
      startTime: [1700000000, 0],
      endTime: [1700000000, 150_000_000],
      status: { code: SpanStatusCode.UNSET },
      attributes: { "http.method": "GET", "http.route": "/[locale]/dashboard", "http.status_code": 200 },
      links: [],
      events: [],
      duration: [0, 150_000_000],
      ended: true,
      resource: { attributes: {} },
      instrumentationScope: { name: "test", version: "1.0.0" },
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    } as unknown as ReadableSpan;
  }

  function xbRenderDescendant(): ReadableSpan {
    return {
      name: "render route (app) /[locale]/dashboard",
      kind: SpanKind.INTERNAL,
      spanContext: () => ({ traceId: XB_TRACE, spanId: XB_RENDER, traceFlags: 1 }),
      parentSpanContext: { traceId: XB_TRACE, spanId: XB_SERVER, traceFlags: 1 },
      startTime: [1700000000, 50_000_000],
      endTime: [1700000000, 120_000_000],
      status: { code: SpanStatusCode.ERROR },
      attributes: { "next.span_type": "AppRender.getBodyResult" },
      links: [],
      events: [
        {
          time: [1700000000, 50_000_000],
          name: "exception",
          attributes: {
            "exception.type": "PrismaClientKnownRequestError",
            "exception.message": "Can't reach database server (P1001)",
          },
        },
      ],
      duration: [0, 70_000_000],
      ended: true,
      resource: { attributes: {} },
      instrumentationScope: { name: "test", version: "1.0.0" },
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    } as unknown as ReadableSpan;
  }

  function findServer(delegate: CapturingDelegate, batchIdx: number): ReadableSpan {
    return delegate.exportedSpans[batchIdx].find(
      (s) => s.spanContext().spanId === XB_SERVER,
    )!;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    lifecycle.resetLifecycleForTesting();
    _resetExportCircuitBreakerForTesting();
    lifecycle.initLifecycle({ logger: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetExportCircuitBreakerForTesting();
    lifecycle.resetLifecycleForTesting();
  });

  // Reads the shared production singleton's state through the public peek API.
  function peekState(): string {
    const b = peekExportCircuitBreaker();
    return b ? b.getState() : "CLOSED";
  }

  function tripBreakerOpen(exporter: GlasstraceExporter, delegate: CapturingDelegate): void {
    delegate.setNextResult({ code: 1, error: Object.assign(new Error("boom"), { status: 500 }) });
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      exporter.export([createMockSpan()], vi.fn());
    }
    expect(peekState()).toBe("OPEN");
  }

  it("export(): descendant batch dropped while OPEN still lets a later parent batch promote (both hoisted)", async () => {
    const delegate = createCapturingDelegate();
    const exporter = new GlasstraceExporter({
      getApiKey: () => TEST_API_KEY,
      sessionManager: new SessionManager(),
      getConfig: () => DEFAULT_CONFIG,
      environment: "test",
      endpointUrl: "https://api.glasstrace.dev/v1/traces",
      createDelegate: () => delegate,
    });

    tripBreakerOpen(exporter, delegate);
    const batchesAfterTrip = delegate.exportedBatches;

    // Descendant batch arrives while OPEN: pass-1 hoist records its lineage,
    // but the OPEN gate drops it from export (no delegate call).
    exporter.export([xbRenderDescendant()], vi.fn());
    expect(delegate.exportedBatches).toBe(batchesAfterTrip);

    // Recover the breaker: advance past the backoff so the probe is admitted,
    // then a successful export closes it.
    delegate.setNextResult({ code: 0 });
    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS);
    exporter.export([createMockSpan()], vi.fn()); // probe → close
    expect(peekState()).toBe("CLOSED");

    // The parent SERVER batch arrives later. Even though the descendant batch
    // was dropped, its hoisted lineage promotes the parent.
    exporter.export([xbServerSpan()], vi.fn());
    const enriched = findServer(delegate, delegate.exportedSpans.length - 1);
    expect(enriched.attributes[ATTR.HTTP_STATUS_CODE]).toBe(500);
    expect(enriched.attributes[ATTR.HTTP_BOUNDARY_MASKED_SCOPE]).toBe("descendant");
  });

  it("export(): reverse order (parent before descendant) leaves the parent at 200 (fail-open miss, no false 500)", () => {
    const delegate = createCapturingDelegate();
    const exporter = new GlasstraceExporter({
      getApiKey: () => TEST_API_KEY,
      sessionManager: new SessionManager(),
      getConfig: () => DEFAULT_CONFIG,
      environment: "test",
      endpointUrl: "https://api.glasstrace.dev/v1/traces",
      createDelegate: () => delegate,
    });

    // Parent first (no lineage yet) → stays 200. Descendant later → too late.
    exporter.export([xbServerSpan()], vi.fn());
    const enrichedParent = findServer(delegate, delegate.exportedSpans.length - 1);
    expect(enrichedParent.attributes[ATTR.HTTP_STATUS_CODE]).toBe(200);
    expect(enrichedParent.attributes[ATTR.HTTP_BOUNDARY_MASKED_SCOPE]).toBeUndefined();

    exporter.export([xbRenderDescendant()], vi.fn());
  });

  it("flushPending(): descendant buffered while key pending + breaker OPEN still lets a later parent promote", async () => {
    let apiKey = API_KEY_PENDING;
    const delegate = createCapturingDelegate();
    const exporter = new GlasstraceExporter({
      getApiKey: () => apiKey,
      sessionManager: new SessionManager(),
      getConfig: () => DEFAULT_CONFIG,
      environment: "test",
      endpointUrl: "https://api.glasstrace.dev/v1/traces",
      createDelegate: () => delegate,
    });

    // Buffer the descendant batch while the key is pending (no enrichment yet).
    exporter.export([xbRenderDescendant()], vi.fn());
    expect(delegate.exportedBatches).toBe(0);

    // Resolve the key and trip the breaker OPEN BEFORE flushing.
    apiKey = TEST_API_KEY;
    tripBreakerOpen(exporter, delegate);

    // Flush: the per-batch pass-1 hoist records the buffered descendant's
    // lineage even though the OPEN gate drops the batch from export.
    const batchesAfterTrip = delegate.exportedBatches;
    exporter.notifyKeyResolved();
    expect(delegate.exportedBatches).toBe(batchesAfterTrip);

    // Recover and export the parent later → promotes via the hoisted lineage.
    delegate.setNextResult({ code: 0 });
    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS);
    exporter.export([createMockSpan()], vi.fn()); // probe → close
    expect(peekState()).toBe("CLOSED");

    exporter.export([xbServerSpan()], vi.fn());
    const enriched = findServer(delegate, delegate.exportedSpans.length - 1);
    expect(enriched.attributes[ATTR.HTTP_STATUS_CODE]).toBe(500);
    expect(enriched.attributes[ATTR.HTTP_BOUNDARY_MASKED_SCOPE]).toBe("descendant");
  });
});

// ---------------------------------------------------------------------------
// Integration suite — drives GlasstraceExporter with the production breaker
// ---------------------------------------------------------------------------

describe("ExportCircuitBreaker — GlasstraceExporter integration", () => {
  let tempDir: string;
  let delegate: MockDelegate;
  let exporter: GlasstraceExporter;
  let openedEvents: unknown[];
  let halfOpenEvents: unknown[];
  let closedEvents: unknown[];

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    tempDir = await mkdtemp(join(tmpdir(), "glasstrace-circuit-"));
    lifecycle.resetLifecycleForTesting();
    _resetRuntimeStateForTesting();
    _resetExportCircuitBreakerForTesting();
    lifecycle.initLifecycle({ logger: vi.fn() });

    delegate = createMockDelegate();
    exporter = new GlasstraceExporter({
      getApiKey: () => TEST_API_KEY,
      sessionManager: new SessionManager(),
      getConfig: () => DEFAULT_CONFIG,
      environment: "test",
      endpointUrl: "https://api.glasstrace.dev/v1/traces",
      createDelegate: () => delegate,
    });

    openedEvents = [];
    halfOpenEvents = [];
    closedEvents = [];
    lifecycle.onLifecycleEvent("otel:circuit_opened", (p) => openedEvents.push(p));
    lifecycle.onLifecycleEvent("otel:circuit_half_open", (p) => halfOpenEvents.push(p));
    lifecycle.onLifecycleEvent("otel:circuit_closed", (p) => closedEvents.push(p));
  });

  afterEach(async () => {
    vi.useRealTimers();
    _resetRuntimeStateForTesting();
    _resetExportCircuitBreakerForTesting();
    lifecycle.resetLifecycleForTesting();
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("drops spans via recordSpansDropped when OPEN and surfaces lifecycle events", () => {
    delegate.setNextResult({ code: 1, error: Object.assign(new Error("auth"), { status: 401 }) });
    const span = createMockSpan();
    const cb = vi.fn();

    // Five failures to trip
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      exporter.export([span], cb);
    }
    expect(openedEvents).toHaveLength(1);
    const opened = openedEvents[0] as { category: string; consecutiveFailures: number };
    expect(opened.category).toBe("auth");
    expect(opened.consecutiveFailures).toBe(FAILURE_THRESHOLD);

    // Sixth call: breaker OPEN → spans dropped, no delegate call, callback success.
    const batchesBefore = delegate.exportedBatches;
    const dropCb = vi.fn();
    exporter.export([span, span, span], dropCb);
    expect(delegate.exportedBatches).toBe(batchesBefore);
    expect(dropCb).toHaveBeenCalledWith({ code: 0 });
  });

  // Scenario 7: Shutdown does not block while OPEN
  it("shuts down promptly even mid-OPEN", async () => {
    delegate.setNextResult({ code: 1, error: new Error("transport") });
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      exporter.export([createMockSpan()], vi.fn());
    }
    expect(openedEvents).toHaveLength(1);

    const shutdownPromise = exporter.shutdown();
    // Shutdown should resolve without advancing the probe timer.
    await expect(shutdownPromise).resolves.toBeUndefined();
    expect(delegate.shutdown).toHaveBeenCalled();
  });

  it("persists lastError to runtime-state.json on circuit open and clears on close", async () => {
    startRuntimeStateWriter({ projectRoot: tempDir, sdkVersion: "1.5.0" });
    // Ensure the SDK is in ACTIVE so the FSM hooks can transition to ACTIVE_DEGRADED.
    lifecycle.setCoreState(lifecycle.CoreState.REGISTERING);
    lifecycle.setCoreState(lifecycle.CoreState.KEY_PENDING);
    lifecycle.setCoreState(lifecycle.CoreState.KEY_RESOLVED);
    lifecycle.setCoreState(lifecycle.CoreState.ACTIVE);

    delegate.setNextResult({ code: 1, error: Object.assign(new Error("boom"), { status: 500 }) });
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      exporter.export([createMockSpan()], vi.fn());
    }

    // Drain the runtime-state writer's debounce so lastError reaches disk.
    await vi.advanceTimersByTimeAsync(1100);
    const filePath = join(tempDir, ".glasstrace", "runtime-state.json");
    const content = JSON.parse(readFileSync(filePath, "utf-8")) as RuntimeState;
    expect(content.lastError).toBeDefined();
    expect(content.lastError?.category).toBe("export-circuit-open");
    expect(content.lastError?.exportCircuitCategory).toBe("server_error");
    // FSM coupling: circuit OPEN should put the SDK in ACTIVE_DEGRADED.
    expect(content.core.state).toBe("ACTIVE_DEGRADED");

    // Recover: probe succeeds → close → lastError cleared.
    delegate.setNextResult({ code: 0 });
    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS);
    exporter.export([createMockSpan()], vi.fn());
    expect(closedEvents).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1100);
    const finalContent = JSON.parse(readFileSync(filePath, "utf-8")) as RuntimeState;
    expect(finalContent.lastError).toBeUndefined();
    expect(finalContent.core.state).toBe("ACTIVE");
  });

  it("does not transition out of ACTIVE_DEGRADED on circuit close when OTel coexistence is also failed", async () => {
    // Drive the SDK to ACTIVE first, then fail OTel coexistence, then trip the circuit.
    lifecycle.setCoreState(lifecycle.CoreState.REGISTERING);
    lifecycle.setCoreState(lifecycle.CoreState.KEY_PENDING);
    lifecycle.setCoreState(lifecycle.CoreState.KEY_RESOLVED);
    lifecycle.setCoreState(lifecycle.CoreState.ACTIVE);
    // Push an unrelated degradation source (simulating OTel COEXISTENCE_FAILED's
    // user-visible surface). This is the same path the production code uses.
    lifecycle.pushDegradationSource("otel-coexistence");
    expect(lifecycle.getCoreState()).toBe("ACTIVE_DEGRADED");

    delegate.setNextResult({ code: 1, error: Object.assign(new Error("auth"), { status: 401 }) });
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      exporter.export([createMockSpan()], vi.fn());
    }
    expect(openedEvents).toHaveLength(1);
    expect(lifecycle.getCoreState()).toBe("ACTIVE_DEGRADED");

    // Recover the circuit; SDK must STAY in ACTIVE_DEGRADED because the
    // unrelated degradation source is still active.
    delegate.setNextResult({ code: 0 });
    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS);
    exporter.export([createMockSpan()], vi.fn());
    expect(closedEvents).toHaveLength(1);
    expect(lifecycle.getCoreState()).toBe("ACTIVE_DEGRADED");

    // Clearing the unrelated source returns SDK to ACTIVE.
    lifecycle.clearDegradationSource("otel-coexistence");
    expect(lifecycle.getCoreState()).toBe("ACTIVE");
  });
});
