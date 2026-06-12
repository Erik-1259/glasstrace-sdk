/**
 * Side-effect evidence attribute emission and per-span counter state
 * (SDK-049).
 *
 * Pure observer: this module never executes a side effect, never
 * creates a span, never throws to the caller. All failure modes route
 * to silent no-ops or omission counters. Per-span state is held in a
 * `WeakMap` keyed by the OTel `Span` object so counters auto-clean
 * when the span is garbage-collected after export.
 */

import * as otelApi from "@opentelemetry/api";
import {
  GLASSTRACE_ATTRIBUTE_NAMES,
  MAX_SIDE_EFFECT_SCALARS_PER_OPERATION,
  SIDE_EFFECT_SCALAR_PREFIX,
  type SideEffectOmissionReason,
  type SideEffectOperationKind,
  type SideEffectOperationPhase,
  type SideEffectOperationStatus,
  type SideEffectSemanticFieldKey,
} from "@glasstrace/protocol";
import { MAX_SIDE_EFFECT_OPERATIONS_PER_SPAN } from "./allowlist.js";

/**
 * Per-span side-effect bookkeeping. `operationsRecorded` enforces the
 * SCHEMA-036 budget of 5 operations per span; `omissions` carries one
 * counter per omission reason so final `glasstrace.side_effect.omitted.*`
 * attributes can be flushed on the span as integer counts.
 */
interface SpanSideEffectState {
  operationsRecorded: number;
  omissions: Map<SideEffectOmissionReason, number>;
  /**
   * Cumulative count of value-fidelity scalars attached to this span via the
   * owned-span `capture()` path, enforcing the per-operation scalar budget
   * across many `capture()` calls (e.g. a Prisma adapter projecting several
   * allowlisted columns onto one span).
   */
  scalarsRecorded: number;
}

const spanState: WeakMap<otelApi.Span, SpanSideEffectState> = new WeakMap();

function getOrCreateState(span: otelApi.Span): SpanSideEffectState {
  let state = spanState.get(span);
  if (!state) {
    state = { operationsRecorded: 0, omissions: new Map(), scalarsRecorded: 0 };
    spanState.set(span, state);
  }
  return state;
}

/**
 * Whether `span` is a usable recording span: `false` for a
 * `NonRecordingSpan` or an already-ended span (both report
 * `isRecording() === false`), and `false` if `isRecording` throws. A
 * span whose `isRecording` is absent is treated as usable — the same
 * convention as `capture()` and the Prisma adapter — since the only
 * standard spans that report not-recording implement the method. Used
 * to validate both the ambient active span and a caller-supplied owned
 * span.
 */
export function isRecordingSpan(span: otelApi.Span): boolean {
  // A NonRecordingSpan and an ended span both report
  // `isRecording() === false`; honor that as the no-op signal, and
  // treat a throwing `isRecording` as not-recording too. A missing
  // `isRecording` (a non-standard host shim) is treated as usable,
  // matching `capture()` and the Prisma adapter so the primitives stay
  // consistent.
  try {
    if (typeof span.isRecording === "function" && !span.isRecording()) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

/**
 * Returns the currently-active span when it is recording and not yet
 * ended. Returns `undefined` when there is no active span, when the
 * active span is a `NonRecordingSpan`, or when the active span has
 * already ended. Callers treat all such cases as silent no-op
 * conditions: there is no span on which to attach evidence.
 */
export function getRecordingActiveSpan(): otelApi.Span | undefined {
  let span: otelApi.Span | undefined;
  try {
    span = otelApi.trace.getActiveSpan();
  } catch {
    // Defensive: an OTel API surface error must not propagate to the
    // user's side-effect call site.
    return undefined;
  }
  if (!span) return undefined;
  return isRecordingSpan(span) ? span : undefined;
}

function recordOmissionOnSpan(
  span: otelApi.Span,
  reason: SideEffectOmissionReason,
): void {
  const state = getOrCreateState(span);
  const previous = state.omissions.get(reason) ?? 0;
  const next = previous + 1;
  state.omissions.set(reason, next);

  const attribute = OMISSION_ATTRIBUTE_BY_REASON[reason];
  try {
    span.setAttribute(attribute, next);
  } catch {
    // OTel may reject the attribute write (slot exhaustion, ended
    // span). The counter still advances in-memory; further emission
    // attempts are harmless no-ops.
  }
}

const OMISSION_ATTRIBUTE_BY_REASON: Readonly<
  Record<SideEffectOmissionReason, string>
> = {
  pii: GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_PII,
  secret: GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_SECRET,
  raw_payload: GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_RAW_PAYLOAD,
  unsupported_key:
    GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_UNSUPPORTED_KEY,
  value_too_long:
    GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_VALUE_TOO_LONG,
  not_emitted: GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_NOT_EMITTED,
  capture_disabled:
    GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_CAPTURE_DISABLED,
  raw_timestamp:
    GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_RAW_TIMESTAMP,
  unhashed_id: GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_UNHASHED_ID,
  non_finite: GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_NON_FINITE,
};

// Stable-core + DISC-1853 keys keep explicit attribute-name constants
// for backward compatibility with consumers that imported them. New
// pattern-admitted keys (any `*Class`/`*Count`/`*Kind`/`*Role` matching
// the open-pattern regex) derive their attribute name at emission via
// `glasstrace.side_effect.field.${key}` — see `resolveFieldAttribute`
// below.
const FIELD_ATTRIBUTE_BY_KEY: Readonly<Record<string, string>> = {
  templateKey: GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_TEMPLATE_KEY,
  providerOperation:
    GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_PROVIDER_OPERATION,
  role: GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_ROLE,
  locale: GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_LOCALE,
  timezone: GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_TIMEZONE,
  status: GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_STATUS,
  phase: GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_PHASE,
  recipientClass: GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_RECIPIENT_CLASS,
  participantCount:
    GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_PARTICIPANT_COUNT,
  activeParticipantCount:
    GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_ACTIVE_PARTICIPANT_COUNT,
};

/**
 * Resolve the OTel attribute name for a semantic field key. Keys in
 * the explicit `FIELD_ATTRIBUTE_BY_KEY` map (stable-core + the three
 * DISC-1853 keys) use the existing `GLASSTRACE_ATTRIBUTE_NAMES`
 * constants for backward compatibility. Pattern-admitted keys
 * derive `glasstrace.side_effect.field.${key}` at emission. Callers
 * MUST verify the key is admissible (via `checkSemanticFieldKey` or
 * `isSideEffectSemanticFieldKey`) before calling this function; the
 * regex restricts pattern keys to `[a-zA-Z0-9]` so the derived
 * attribute name is always a safe identifier.
 */
function resolveFieldAttribute(key: string): string {
  const explicit = FIELD_ATTRIBUTE_BY_KEY[key];
  if (explicit !== undefined) return explicit;
  return `glasstrace.side_effect.field.${key}`;
}

/**
 * Returns `true` when the key has an explicit entry in
 * `FIELD_ATTRIBUTE_BY_KEY` (stable-core keys or DISC-1853-era keys).
 * Returns `false` for pattern-admitted keys that derive their
 * attribute name at emission. Used by vocabulary-governance signals
 * to distinguish explicitly-mapped keys from pattern-only ones.
 */
export function hasExplicitFieldAttribute(key: string): boolean {
  return FIELD_ATTRIBUTE_BY_KEY[key] !== undefined;
}

/**
 * Outcome of attempting to attach an operation summary onto a known
 * recording span. The `over_budget` discriminant lets the caller route
 * the call's bookkeeping (a `value_too_long` omission) without
 * re-querying span state. The caller resolves the target span (ambient
 * or owned) and handles the no-span case before calling.
 */
export type AttachOutcome =
  | { kind: "attached" }
  | { kind: "over_budget" };

/**
 * Attach the top-level operation attributes to the given recording span
 * and advance the per-span operation counter. The caller resolves the
 * target span (ambient active span or a caller-owned span) and is
 * responsible for invoking {@link attachField} for each accepted
 * semantic field and {@link recordOmission} for each rejected value.
 *
 * Returns `over_budget` when the per-span operation budget (5) is
 * exhausted — the caller routes that to a `value_too_long` omission via
 * {@link recordOmission} — and `attached` otherwise.
 */
export function attachOperation(
  span: otelApi.Span,
  input: {
    kind: SideEffectOperationKind;
    operation: string;
    status?: SideEffectOperationStatus;
    phase?: SideEffectOperationPhase;
  },
): AttachOutcome {
  const state = getOrCreateState(span);
  if (state.operationsRecorded >= MAX_SIDE_EFFECT_OPERATIONS_PER_SPAN) {
    return { kind: "over_budget" };
  }
  state.operationsRecorded += 1;

  try {
    span.setAttribute(GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_KIND, input.kind);
    span.setAttribute(
      GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OPERATION,
      input.operation,
    );
    if (input.status !== undefined) {
      span.setAttribute(
        GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_STATUS,
        input.status,
      );
    }
    if (input.phase !== undefined) {
      span.setAttribute(
        GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_PHASE,
        input.phase,
      );
    }
  } catch {
    // Slot exhaustion or ended-span write — ignore. The counter has
    // already advanced; subsequent calls within the same span are
    // budget-bounded as expected.
  }
  return { kind: "attached" };
}

/**
 * Attach a single allowlisted semantic field to the span. The caller
 * has already routed the field key and value through the allowlist
 * helpers; this function only writes the attribute.
 */
export function attachField(
  span: otelApi.Span,
  key: SideEffectSemanticFieldKey,
  value: string,
): void {
  const attribute = resolveFieldAttribute(key);
  try {
    span.setAttribute(attribute, value);
  } catch {
    // Slot exhaustion — ignore.
  }
}

/**
 * Attach a single value-fidelity scalar to the span on the
 * `glasstrace.side_effect.scalar.*` channel. The caller has already
 * routed the key and value through {@link checkScalarField}; this
 * function writes the **native** `number` / `boolean` / `string` value
 * (no stringify — the product validator rejects numeric- and
 * boolean-shaped strings). The scalar key matched
 * `SIDE_EFFECT_SCALAR_KEY_PATTERN`, restricting it to `[A-Za-z0-9]`, so
 * the derived attribute name is always a safe identifier.
 */
export function attachScalar(
  span: otelApi.Span,
  key: string,
  value: number | boolean | string,
): void {
  try {
    span.setAttribute(`${SIDE_EFFECT_SCALAR_PREFIX}${key}`, value);
  } catch {
    // Slot exhaustion — ignore.
  }
}

/**
 * Reserve one slot in the span's per-operation scalar budget
 * ({@link MAX_SIDE_EFFECT_SCALARS_PER_OPERATION}). Returns `true` and
 * increments the count when a slot is available, `false` once the span is at
 * budget. Used by the owned-span `capture()` path so that many `capture()`
 * calls on one span (e.g. a Prisma adapter projecting several columns) stay
 * within the protocol budget and deterministically omit the overflow rather
 * than over-emitting for downstream truncation.
 */
export function reserveScalarSlot(span: otelApi.Span): boolean {
  const state = getOrCreateState(span);
  if (state.scalarsRecorded >= MAX_SIDE_EFFECT_SCALARS_PER_OPERATION) {
    return false;
  }
  state.scalarsRecorded += 1;
  return true;
}

/**
 * Record an omission directly on a known span. Used by the public
 * API after {@link attachOperation} returns `over_budget` so the
 * count is registered on the same span that observed the operation.
 */
export function recordOmission(
  span: otelApi.Span,
  reason: SideEffectOmissionReason,
): void {
  recordOmissionOnSpan(span, reason);
}
