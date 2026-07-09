/**
 * The span-lifecycle diagnostic record types — one JSON object per JSONL line.
 *
 * These shapes are a stable cross-workstream contract: the diagnostic sweep
 * harness parses them. Fields marked optional are **omitted entirely** (never
 * `null`) when absent. Key order in the emitted objects is fixed to match the
 * documented examples, so downstream golden-line comparisons are stable.
 */

import { SpanKind } from "@opentelemetry/api";

/** The OpenTelemetry span kinds rendered as strings in diagnostic records. */
export type SpanKindName = "SERVER" | "INTERNAL" | "CLIENT" | "PRODUCER" | "CONSUMER";

/** A span entering its lifecycle (`onStart`). */
export interface StartRecord {
  ev: "start";
  /** Epoch milliseconds at which the processor observed the start. */
  t: number;
  traceId: string;
  spanId: string;
  /** Parent span id; an all-zero value marks a root span. */
  parentSpanId: string;
  /**
   * The span name at start. Instrumentation-controlled: it may embed a raw path
   * or a dynamic segment when no route template resolved. Prefer `route` (the
   * `http.route` template) as the trustworthy structural key; classification
   * should key on route/method/ids, not on `name`.
   */
  name: string;
  kind: SpanKindName;
  /** The `http.route` template, when one resolved. */
  route?: string;
  /** The HTTP method, when present. */
  method?: string;
}

/** A tracked span ending (`onEnd`). */
export interface EndRecord {
  ev: "end";
  /** Epoch milliseconds at which the processor observed the end. */
  t: number;
  traceId: string;
  spanId: string;
  /**
   * The span name at end. Instrumentation-controlled and may differ from the
   * start name under Next's name-after-start lifecycle; see {@link StartRecord}.
   */
  name: string;
  kind: SpanKindName;
  /** Processor-clock duration (end − start), in milliseconds. */
  durationMs: number;
  /** The `http.route` template, when one resolved. */
  route?: string;
  /** The HTTP method, when present. */
  method?: string;
}

/** A single still-open span reported in an {@link UnendedRecord}. */
export interface UnendedSpanFact {
  traceId: string;
  spanId: string;
  /** See the redaction note on {@link StartRecord.name}. */
  name: string;
  kind: SpanKindName;
  /** The `http.route` template, when one resolved. */
  route?: string;
  /** The HTTP method, when present. */
  method?: string;
  /** Age (ms) at the moment the span was reported still-open. */
  ageMs: number;
}

/** Spans still open at a timeout sweep or at shutdown. */
export interface UnendedRecord {
  ev: "unended";
  reason: "timeout" | "shutdown";
  t: number;
  /** Number of spans in `spans`. */
  count: number;
  /** Spans dropped without tracking because the tracking cap was reached. */
  droppedFromCap: number;
  spans: UnendedSpanFact[];
}

/** The single terminal record emitted at shutdown — the liveness signal. */
export interface RunSummaryRecord {
  ev: "run-summary";
  t: number;
  started: number;
  ended: number;
  unended: number;
  droppedFromCap: number;
  /** Whether a timeout sweep ran at least once. */
  sweptAtTimeout: boolean;
  /** Whether shutdown ran (always true in this record). */
  ranShutdown: boolean;
}

/** Any diagnostic record written to the JSONL sink. */
export type DiagnosticRecord =
  | StartRecord
  | EndRecord
  | UnendedRecord
  | RunSummaryRecord;

// Single lookup table (not a switch) so partial exercise still hits the one
// return line, and the SpanKindName contract values are pinned to the enum.
const SPAN_KIND_NAMES: Record<number, SpanKindName> = {
  [SpanKind.INTERNAL]: "INTERNAL",
  [SpanKind.SERVER]: "SERVER",
  [SpanKind.CLIENT]: "CLIENT",
  [SpanKind.PRODUCER]: "PRODUCER",
  [SpanKind.CONSUMER]: "CONSUMER",
};

/** Map an OpenTelemetry {@link SpanKind} to its record string; defaults to `INTERNAL`. */
export function spanKindToString(kind: SpanKind): SpanKindName {
  return SPAN_KIND_NAMES[kind] ?? "INTERNAL";
}
