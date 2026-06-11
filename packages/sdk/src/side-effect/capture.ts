/**
 * Public value-capture primitive (L1 passive capture).
 *
 * {@link capture} emits a single allowlisted value-fidelity scalar onto a
 * caller-**owned** OTel span. It is the counterpart to {@link
 * recordSideEffect} for the case where the emitter owns the target span
 * itself (e.g. a passive database adapter that opens a `db.<Model>.<op>`
 * span) rather than attaching to the ambient active span.
 *
 * Why this exists: {@link recordSideEffect} is ambient-only — it resolves
 * the active span via `getActiveSpan()`. A passive adapter cannot use it,
 * because at its capture point the ambient span is the database client's
 * own operation span, which has already ended and is non-recording. So the
 * adapter must own a fresh recording span and emit onto it explicitly.
 *
 * The behavior contract mirrors {@link recordSideEffect}: observational
 * only. `capture` never executes a side effect, never reads or mutates the
 * captured value's source, and **never throws**. Every failure mode
 * (capture-config disabled, ended / `NonRecordingSpan` target, allowlist
 * rejection, OTel attribute-slot exhaustion) routes to a silent no-op or to
 * an omission-counter increment that carries no rejected input.
 *
 * Capture is **strict-mode only**: timestamp-shaped and unhashed-identifier
 * values are rejected at emit so they never reach the wire. The `full`
 * fidelity relaxation is not reachable through this primitive.
 */

import { type Span } from "@opentelemetry/api";
import { checkScalarField } from "./allowlist.js";
import { attachScalar, recordOmission, reserveScalarSlot } from "./emit.js";
import { isCaptureEnabled } from "../init-client.js";

/** Options for {@link capture}. */
export interface CaptureOptions {
  /**
   * The caller-owned, recording span to attach the scalar to. `capture`
   * writes only to this span; it never resolves or touches the ambient
   * active span. The caller is responsible for `end()`-ing it.
   */
  span: Span;
}

/**
 * Emit a single allowlisted value-fidelity scalar onto a caller-owned span.
 *
 * The scalar `name` must match the value-fidelity scalar key pattern
 * (`*Ms` / `*Amount` / `*Bytes` / `*Ratio` / `*Id` / `*Value` / `*Flag`)
 * and its value must match the suffix type — e.g. a `*Flag` key requires a
 * `boolean`. Mismatches, timestamp-shaped values, and unhashed `*Id`s are
 * rejected under strict mode and recorded as an omission count on the
 * supplied span (never the active span).
 *
 * Edge cases (all silent no-ops, never throws):
 *  - capture-config flag `sideEffectEvidence` is `false` ⇒ no-op, **no
 *    counter** (mirrors {@link recordSideEffect}: with capture disabled the
 *    SDK does no allowlist evaluation and writes nothing).
 *  - the supplied span has already ended or is a `NonRecordingSpan` ⇒
 *    no-op, **no counter** (its omission counter would itself be a dropped
 *    span write). The owning adapter passes a fresh recording span, so this
 *    is a caller-misuse guard.
 *  - the value fails strict allowlist validation ⇒ an omission count is
 *    recorded on the supplied span; the rejected value is never emitted.
 *  - OTel attribute-slot exhaustion ⇒ the attribute write is silently
 *    dropped.
 *
 * @example Project a boolean result field onto an owned database span
 * ```ts
 * import { capture } from "@glasstrace/sdk";
 *
 * const span = tracer.startSpan("db.Poll.findUnique");
 * try {
 *   const row = await query(args);
 *   if (row) capture("mutedFlag", row.muted, { span });
 *   return row;
 * } finally {
 *   span.end();
 * }
 * ```
 */
export function capture(
  name: string,
  value: unknown,
  options: CaptureOptions,
): void {
  try {
    runCapture(name, value, options);
  } catch {
    // Defense-in-depth: an unexpected throw (e.g. a host shim
    // mis-implementing the OTel API) must never propagate to the
    // caller's request path. Capture is observationally invisible.
  }
}

function runCapture(
  name: string,
  value: unknown,
  options: CaptureOptions,
): void {
  const span = options?.span;
  if (!span) return;

  // Capture-config gate first: read at every call so config rotation
  // takes effect on the next emission. With the flag off the SDK does
  // nothing and records no counter (a counter would itself require a
  // span write); this is the maximally fail-closed default.
  if (!isCaptureEnabled()) return;

  // Caller-misuse guard: an ended / NonRecordingSpan cannot carry the
  // scalar, and its omission counter would itself be a dropped write —
  // no-op entirely (no counter). The owning adapter passes a fresh
  // recording span, so correct use never reaches this branch.
  try {
    if (typeof span.isRecording === "function" && !span.isRecording()) {
      return;
    }
  } catch {
    return;
  }

  // Strict scalar validation — the only mode this primitive supports.
  const outcome = checkScalarField(name, value);
  if (!outcome.accepted) {
    // The omission count lands on the caller-supplied span — never the
    // ambient active span (which `capture` deliberately never resolves).
    recordOmission(span, outcome.reason);
    return;
  }

  // Enforce the per-operation scalar budget across many `capture()` calls on
  // the same owned span (e.g. an adapter projecting several columns). Beyond
  // the budget, deterministically omit rather than over-emit for downstream
  // truncation — mirroring `recordSideEffect`'s budget handling.
  if (!reserveScalarSlot(span)) {
    recordOmission(span, "value_too_long");
    return;
  }

  attachScalar(span, name, outcome.value);
}
