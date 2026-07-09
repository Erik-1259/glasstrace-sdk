/**
 * `@glasstrace/sdk/diagnostics` — Node-only, experimental diagnostic surface.
 *
 * A flag-gated span-lifecycle diagnostic `SpanProcessor` that emits per-run
 * JSONL records (start / end / unended / run-summary) so span loss is
 * observable on a real app. It never mutates, exports, ends, or salvages a
 * span. Off unless `GLASSTRACE_SPAN_DIAGNOSTICS=true`; records go to the file at
 * `GLASSTRACE_SPAN_DIAGNOSTICS_OUT` or to stdout with a `[span-diag]` prefix.
 *
 * Resolves only under the Node condition — it uses `node:fs`. No internal ids in
 * this surface's docs.
 */

import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { SpanDiagnosticsProcessor } from "./span-diagnostics-processor.js";
import { createJsonlSink } from "./jsonl-sink.js";
import { spanDiagnosticsEnabled } from "../span-diagnostics-flag.js";
import type { DiagnosticRecord } from "./records.js";

/** Options for {@link createSpanDiagnostics}. */
export interface SpanDiagnosticsOptions {
  /** Force on/off. Defaults to the resolved `GLASSTRACE_SPAN_DIAGNOSTICS` flag. */
  enabled?: boolean;
  /** Output file path. Defaults to `GLASSTRACE_SPAN_DIAGNOSTICS_OUT`, else stdout. */
  outPath?: string;
  /** Age (ms) after which a still-open span is reported unended. Default 5000. */
  leakTimeoutMs?: number;
  /** Sweep interval (ms). Default = `leakTimeoutMs`. */
  sweepIntervalMs?: number;
  /** Max concurrently-tracked spans. Default 1024. */
  maxTrackedSpans?: number;
  /** Custom record sink; overrides the JSONL file/stdout sink. */
  emit?: (record: DiagnosticRecord) => void;
  /** Injectable clock returning epoch milliseconds. Default `Date.now`. */
  now?: () => number;
}

/**
 * Create the diagnostic `SpanProcessor`. When disabled (the default unless the
 * flag or `enabled` is set) it is a cheap no-op and no sink is opened.
 */
export function createSpanDiagnostics(options: SpanDiagnosticsOptions = {}): SpanProcessor {
  const enabled = options.enabled ?? spanDiagnosticsEnabled();
  const emit = enabled
    ? (options.emit ??
      createJsonlSink(options.outPath ?? process.env.GLASSTRACE_SPAN_DIAGNOSTICS_OUT))
    : undefined;
  return new SpanDiagnosticsProcessor({
    enabled,
    emit,
    leakTimeoutMs: options.leakTimeoutMs,
    sweepIntervalMs: options.sweepIntervalMs,
    maxTrackedSpans: options.maxTrackedSpans,
    now: options.now,
  });
}

// Re-export the bound local (not `export { X } from "./..."`): a pure
// `export ... from` on a fresh tsup entry can leave a dangling sibling
// reference in the ESM bundle, which the edge-bundle guard flags.
export { SpanDiagnosticsProcessor };
export type { SpanDiagnosticsProcessorOptions } from "./span-diagnostics-processor.js";
export type {
  DiagnosticRecord,
  StartRecord,
  EndRecord,
  UnendedRecord,
  UnendedSpanFact,
  RunSummaryRecord,
  SpanKindName,
} from "./records.js";
