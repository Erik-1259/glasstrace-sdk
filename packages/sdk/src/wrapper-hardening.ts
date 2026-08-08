/**
 * Internal hardening helpers shared by the edge-safe span wrappers
 * (`./middleware/index.ts`, `./async-context/index.ts`): the span-leak
 * watchdog and the control-character attribute strip.
 *
 * This module ships inside the edge bundle closure, so it imports only
 * types from `@opentelemetry/api`, nothing from `node:*`, and uses the
 * global `setTimeout` with feature-detected `unref` (the same pattern as
 * `./https-transport.ts`) — `unref` exists on Node timer handles but not
 * on the number returned by edge/browser runtimes.
 *
 * It is intentionally NOT exported from any package barrel or subpath.
 */

import type { Span } from "@opentelemetry/api";
import type { AttributeValue } from "@opentelemetry/api";

/**
 * Watchdog interval before a still-unsettled wrapped call has its span
 * force-ended: 10 minutes. The value is deliberately far above plausible
 * legitimate middleware/async-task duration in the SDK's supported
 * non-production dev/agent runtimes while still bounding the span leak a
 * never-settling thenable/promise would otherwise cause. Work that
 * legitimately outlasts the interval keeps running untouched — only its
 * TELEMETRY span is ended early, truncating the recorded duration.
 */
export const SPAN_WATCHDOG_INTERVAL_MS = 600_000;

/**
 * A per-call guard that guarantees a wrapped call's span ends exactly
 * once: either through the normal settle path (`settle()`) or, if the
 * wrapped thenable/promise never settles, through the watchdog timer.
 *
 * The guard affects the SPAN only. It never cancels, times out, or
 * otherwise touches the user's work.
 */
export interface SpanLeakGuard {
  /**
   * End the span through the normal settle path. Idempotent: after the
   * watchdog has fired (or a prior `settle()`), this is a safe no-op —
   * the span is never ended twice.
   */
  readonly settle: () => void;
  /**
   * Whether the span has already been ended (by the watchdog or a
   * prior `settle()`). Callers use this to skip span mutations —
   * error recording, status changes — that would otherwise hit an
   * already-ended span.
   */
  readonly ended: () => boolean;
}

/**
 * Start the span-leak watchdog for one wrapped call.
 *
 * `endSpan` is the caller's own safe end routine (each wrapper module
 * keeps a local `endSpanSafely`); the guard routes every end through it
 * at most once. If the runtime has no working timer (`setTimeout`
 * throwing is tolerated), the guard degrades to the pre-hardening
 * behavior: `settle()` still ends the span on the normal path, and a
 * never-settling call leaks its span exactly as before.
 */
export function startSpanLeakGuard(
  span: Span,
  endSpan: (span: Span) => void,
  intervalMs: number = SPAN_WATCHDOG_INTERVAL_MS,
): SpanLeakGuard {
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const endOnce = (): void => {
    if (done) return;
    done = true;
    if (timer !== undefined) {
      try {
        clearTimeout(timer);
      } catch {
        // Advisory — a throwing clearTimeout must not block the end.
      }
      timer = undefined;
    }
    endSpan(span);
  };

  try {
    timer = setTimeout(endOnce, intervalMs);
  } catch {
    // No working timer in this runtime: degrade to pre-hardening
    // behavior (normal settle still ends the span; no watchdog).
    timer = undefined;
  }
  if (timer !== undefined) {
    try {
      const handle = timer as unknown as { unref?: () => void };
      if (typeof handle.unref === "function") handle.unref();
    } catch {
      // unref is advisory. Keep the handle: the timer IS armed, and
      // settle() must still be able to clear it.
    }
  }

  return { settle: endOnce, ended: () => done };
}

/**
 * Strip ASCII control characters — every code unit below 0x20, tab
 * (0x09), newline (0x0A), and carriage return (0x0D) included — from a
 * string attribute value. Space (0x20) and above pass through untouched.
 *
 * This is transport hygiene, not privacy redaction: it keeps attribute
 * values single-line and terminal/log-safe. Code units below 0x20 are
 * never surrogate halves, so per-unit filtering is surrogate-pair-safe.
 * The fast path returns the original string when nothing needs
 * stripping, so clean values (the overwhelmingly common case) allocate
 * nothing.
 */
export function stripControlChars(value: string): string {
  let needsStrip = false;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20) {
      needsStrip = true;
      break;
    }
  }
  if (!needsStrip) return value;
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) >= 0x20) out += value[i];
  }
  return out;
}

/**
 * Apply {@link stripControlChars} to a single OTel attribute value:
 * strings are stripped, string elements of array-valued attributes are
 * stripped (a fresh array is returned only when needed), and every
 * non-string value passes through unchanged.
 */
export function sanitizeAttributeValue(value: AttributeValue): AttributeValue {
  if (typeof value === "string") return stripControlChars(value);
  if (Array.isArray(value)) {
    // Lazy clone: allocate only on the first element that actually
    // changes, so clean arrays (the common case) pass through without
    // allocation.
    let out: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const element: unknown = value[i];
      if (typeof element === "string") {
        const stripped = stripControlChars(element);
        if (stripped !== element) {
          out ??= value.slice();
          out[i] = stripped;
        }
      }
    }
    return (out ?? value) as AttributeValue;
  }
  return value;
}

/**
 * Apply {@link sanitizeAttributeValue} across an attribute record,
 * returning a fresh record. Used at the wrappers' `setAttributes`
 * forwarding boundary so caller-supplied values (including array
 * elements mutated in place after snapshot) are sanitized at write time.
 */
export function sanitizeAttributes(
  attributes: Record<string, AttributeValue>,
): Record<string, AttributeValue> {
  // Null prototype so a caller-supplied own key literally named
  // "__proto__" copies as a plain data property instead of hitting the
  // inherited Object.prototype setter (which would drop the entry and
  // rebind this record's prototype to a caller-controlled value).
  const out: Record<string, AttributeValue> = Object.create(null) as Record<
    string,
    AttributeValue
  >;
  for (const key of Object.keys(attributes)) {
    out[key] = sanitizeAttributeValue(attributes[key]);
  }
  return out;
}
