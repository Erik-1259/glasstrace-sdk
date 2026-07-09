/**
 * A span-lifecycle diagnostic `SpanProcessor`. Observe-only: it records when
 * spans start and end (and which never end) but never mutates, exports, ends,
 * or salvages a span. It exists to make span loss observable on a real app —
 * the route span that goes missing from export under fast Server-Action
 * follow-up — by emitting per-run lifecycle records the sweep harness collects.
 *
 * It tracks SERVER **and** INTERNAL spans deliberately: the side-effect child
 * a Server Action spawns is INTERNAL, and its create/end fate is a required
 * output, so SERVER-only would miss it.
 *
 * Hard invariants:
 *   - never throws into the host request (OTel's `MultiSpanProcessor` iterates
 *     processors with no `try/catch`, so an unguarded throw would reach
 *     `tracer.startSpan()` / `span.end()`);
 *   - reads only structural, low-cardinality facts (name, route template, HTTP
 *     method, kind, ids, age) — never raw attribute values, URLs, headers, or
 *     bodies;
 *   - `shutdown()` is idempotent (one `run-summary`).
 *
 * Node-only: constructed behind the `@glasstrace/sdk/diagnostics` subpath and
 * the bare-path auto-attach; the JSONL sink it is paired with uses `node:fs`.
 */

import { SpanKind } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type {
  DiagnosticRecord,
  EndRecord,
  StartRecord,
  UnendedSpanFact,
} from "./records.js";
import { spanKindToString } from "./records.js";

/** Options for {@link SpanDiagnosticsProcessor}. */
export interface SpanDiagnosticsProcessorOptions {
  /** When false every hook is a no-op and no sweep timer is installed. */
  enabled: boolean;
  /**
   * Sink for each diagnostic record. Optional: when absent the processor still
   * tracks lifecycle but emits nothing. Always invoked through an internal
   * guard, so a throwing sink can never propagate into the host request.
   */
  emit?: (record: DiagnosticRecord) => void;
  /** Age (ms) after which a still-open tracked span is reported as unended. Default 5000. */
  leakTimeoutMs?: number;
  /** Sweep interval (ms). Default = `leakTimeoutMs`. */
  sweepIntervalMs?: number;
  /** Max concurrently-tracked spans; overflow increments `droppedFromCap`. Default 1024. */
  maxTrackedSpans?: number;
  /** Injectable clock returning epoch milliseconds. Default `Date.now`. */
  now?: () => number;
}

interface TrackedSpan {
  span: Span | ReadableSpan;
  startedAtMs: number;
  reported: boolean;
}

const DEFAULT_LEAK_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_TRACKED_SPANS = 1_024;
const ROOT_PARENT_SPAN_ID = "0000000000000000";

/**
 * Tracking-map key. Keyed by `traceId:spanId`, not `spanId` alone: a span id is
 * only guaranteed unique within a trace, so two concurrent traces could reuse
 * one and mispair start/end or evict prematurely.
 */
function trackingKey(span: Span | ReadableSpan): string {
  const ctx = span.spanContext();
  return `${ctx.traceId}:${ctx.spanId}`;
}

export class SpanDiagnosticsProcessor implements SpanProcessor {
  private readonly enabled: boolean;
  private readonly emitRecord?: (record: DiagnosticRecord) => void;
  private readonly leakTimeoutMs: number;
  private readonly sweepIntervalMs: number;
  private readonly maxTrackedSpans: number;
  private readonly now: () => number;

  private readonly tracked = new Map<string, TrackedSpan>();
  private droppedFromCap = 0;
  private startedCount = 0;
  private endedCount = 0;
  private unendedCount = 0;
  private sweepRan = false;
  private hasShutDown = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: SpanDiagnosticsProcessorOptions) {
    this.enabled = options.enabled;
    this.emitRecord = options.emit;
    this.leakTimeoutMs = Math.max(1, options.leakTimeoutMs ?? DEFAULT_LEAK_TIMEOUT_MS);
    this.sweepIntervalMs = Math.max(1, options.sweepIntervalMs ?? this.leakTimeoutMs);
    this.maxTrackedSpans = Math.max(1, options.maxTrackedSpans ?? DEFAULT_MAX_TRACKED_SPANS);
    this.now = options.now ?? Date.now;

    if (this.enabled) {
      const timer = setInterval(() => this.sweep(), this.sweepIntervalMs);
      // Never let a diagnostic timer keep the process alive.
      timer.unref();
      this.timer = timer;
    }
  }

  onStart(span: Span): void {
    if (!this.enabled) return;
    try {
      const kind = span.kind;
      if (kind !== SpanKind.SERVER && kind !== SpanKind.INTERNAL) return;
      if (this.tracked.size >= this.maxTrackedSpans) {
        this.droppedFromCap++;
        return;
      }
      const startedAtMs = this.now();
      this.tracked.set(trackingKey(span), { span, startedAtMs, reported: false });
      this.startedCount++;
      this.safeEmit(this.buildStart(span, startedAtMs));
    } catch {
      // Diagnostic-only; never disrupt span start.
    }
  }

  onEnd(span: ReadableSpan): void {
    if (!this.enabled) return;
    try {
      const key = trackingKey(span);
      const tracked = this.tracked.get(key);
      if (tracked === undefined) return;
      this.tracked.delete(key);
      const endedAtMs = this.now();
      this.endedCount++;
      this.safeEmit(this.buildEnd(span, tracked.startedAtMs, endedAtMs));
    } catch {
      // Diagnostic-only; never disrupt span end.
    }
  }

  async forceFlush(): Promise<void> {
    // Observe-only: nothing is buffered downstream to flush.
  }

  async shutdown(): Promise<void> {
    if (this.hasShutDown) return;
    this.hasShutDown = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!this.enabled) {
      this.tracked.clear();
      return;
    }
    try {
      const nowMs = this.now();
      const facts: UnendedSpanFact[] = [];
      for (const tracked of this.tracked.values()) {
        if (tracked.reported) continue;
        facts.push(this.buildUnendedFact(tracked.span, nowMs - tracked.startedAtMs));
      }
      this.tracked.clear();
      // Emit an `unended` record when there is anything to report — still-open
      // spans OR cap drops — so `droppedFromCap` surfaces even when the table
      // drained empty.
      if (facts.length > 0 || this.droppedFromCap > 0) {
        this.unendedCount += facts.length;
        this.safeEmit({
          ev: "unended",
          reason: "shutdown",
          t: nowMs,
          count: facts.length,
          droppedFromCap: this.droppedFromCap,
          spans: facts,
        });
      }
      // Second clock read so the run-summary timestamp is distinct from the
      // unended one under a monotonically increasing injected clock.
      const summaryT = this.now();
      this.safeEmit({
        ev: "run-summary",
        t: summaryT,
        started: this.startedCount,
        ended: this.endedCount,
        unended: this.unendedCount,
        droppedFromCap: this.droppedFromCap,
        sweptAtTimeout: this.sweepRan,
        ranShutdown: true,
      });
    } catch {
      // A shutdown-diagnostic failure must not fail provider shutdown.
    }
  }

  private sweep(): void {
    if (this.hasShutDown) return;
    try {
      this.sweepRan = true;
      const nowMs = this.now();
      const facts: UnendedSpanFact[] = [];
      for (const tracked of this.tracked.values()) {
        if (tracked.reported) continue;
        if (nowMs - tracked.startedAtMs < this.leakTimeoutMs) continue;
        tracked.reported = true;
        facts.push(this.buildUnendedFact(tracked.span, nowMs - tracked.startedAtMs));
      }
      if (facts.length > 0) {
        this.unendedCount += facts.length;
        this.safeEmit({
          ev: "unended",
          reason: "timeout",
          t: nowMs,
          count: facts.length,
          droppedFromCap: this.droppedFromCap,
          spans: facts,
        });
      }
    } catch {
      // Diagnostic-only; a sweep failure must not disrupt the host.
    }
  }

  private safeEmit(record: DiagnosticRecord): void {
    try {
      this.emitRecord?.(record);
    } catch {
      // A throwing sink must never escape a hook.
    }
  }

  private buildStart(span: Span | ReadableSpan, startedAtMs: number): StartRecord {
    const ctx = span.spanContext();
    const facts = this.structuralFacts(span);
    return {
      ev: "start",
      t: startedAtMs,
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      parentSpanId: span.parentSpanContext?.spanId ?? ROOT_PARENT_SPAN_ID,
      name: span.name,
      kind: spanKindToString(span.kind),
      ...(facts.route !== undefined ? { route: facts.route } : {}),
      ...(facts.method !== undefined ? { method: facts.method } : {}),
    };
  }

  private buildEnd(
    span: ReadableSpan,
    startedAtMs: number,
    endedAtMs: number,
  ): EndRecord {
    const ctx = span.spanContext();
    const facts = this.structuralFacts(span);
    return {
      ev: "end",
      t: endedAtMs,
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      name: span.name,
      kind: spanKindToString(span.kind),
      // Clamp at 0: a backward wall-clock step (NTP correction, VM
      // pause/resume) between start and end must not emit a negative duration.
      durationMs: Math.max(0, endedAtMs - startedAtMs),
      ...(facts.route !== undefined ? { route: facts.route } : {}),
      ...(facts.method !== undefined ? { method: facts.method } : {}),
    };
  }

  private buildUnendedFact(span: Span | ReadableSpan, ageMs: number): UnendedSpanFact {
    const ctx = span.spanContext();
    const facts = this.structuralFacts(span);
    return {
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      name: span.name,
      kind: spanKindToString(span.kind),
      ...(facts.route !== undefined ? { route: facts.route } : {}),
      ...(facts.method !== undefined ? { method: facts.method } : {}),
      // Clamp at 0 for the same backward-clock reason as durationMs.
      ageMs: Math.max(0, ageMs),
    };
  }

  /**
   * The single span → record redaction boundary. Reads ONLY `http.route` and
   * the HTTP method (strings only) from attributes; never spreads or copies the
   * raw attribute bag, so raw values, URLs, headers, and bodies cannot leak.
   */
  private structuralFacts(span: Span | ReadableSpan): { route?: string; method?: string } {
    const attrs = span.attributes;
    const route = attrs["http.route"];
    const method = attrs["http.method"] ?? attrs["http.request.method"];
    return {
      ...(typeof route === "string" ? { route } : {}),
      ...(typeof method === "string" ? { method } : {}),
    };
  }
}
