/**
 * Public side-effect evidence emission API.
 *
 * Exposes {@link recordSideEffect} as a single user-callable function
 * that attaches allowlisted, non-sensitive semantic metadata about a
 * side-effect operation (email, calendar_link, webhook, external_api,
 * queue, after_callback) to the current active OTel span.
 *
 * The behavior contract is observational only: this function never
 * executes a side effect, never retries, never delays, never throws.
 * All failure modes (no active span, ended span, NonRecordingSpan,
 * capture-config disabled, allowlist rejection, per-span budget
 * exhausted, OTel attribute slot exhaustion) silently route to a
 * no-op or to an omission-counter increment that carries no rejected
 * input.
 */

import {
  MAX_SIDE_EFFECT_SCALARS_PER_OPERATION,
  type SideEffectOperationKind,
  type SideEffectOperationPhase,
  type SideEffectOperationStatus,
  type SideEffectSemanticFieldKey,
} from "@glasstrace/protocol";
import {
  checkOperationKind,
  checkOperationLabel,
  checkOperationPhase,
  checkOperationStatus,
  checkScalarField,
  checkSemanticFieldKey,
  checkSemanticFieldValue,
} from "./allowlist.js";
import { type Span } from "@opentelemetry/api";
import {
  attachField,
  attachOperation,
  attachScalar,
  getRecordingActiveSpan,
  hasExplicitFieldAttribute,
  isRecordingSpan,
  recordOmission,
} from "./emit.js";
import type { SideEffectOmissionReason } from "@glasstrace/protocol";
import { getActiveConfig } from "../init-client.js";
import {
  decisionTrace,
  decisionTraceEnabled,
  _resetDecisionTraceForTesting,
} from "../decision-trace.js";

// ---------------------------------------------------------------------------
// Vocabulary-governance signals (DISC-1878 + DISC-1879)
// ---------------------------------------------------------------------------

/**
 * Verbose flag, set by `registerGlasstrace()` from the resolved
 * `GlasstraceOptions.verbose`. Gates the pattern-key proliferation
 * warn so it stays opt-in for operator debugging. Defaults to `false`
 * when `registerGlasstrace()` has not been called (e.g., direct
 * `recordSideEffect` calls in tests).
 */
let _verbose = false;

/**
 * Setter for the verbose flag. Called from `registerGlasstrace()`
 * after `resolveConfig()` runs. Not exposed from the public package
 * barrel — internal coordination only.
 *
 * @internal
 */
export function setSideEffectVerboseFlag(verbose: boolean): void {
  _verbose = verbose;
}

/**
 * One-shot guard for the no-recording-active-span diagnostic. The warn
 * fires at most once per process so a high-frequency call site (a tRPC
 * procedure that drops every request) does not flood the log.
 */
let _noActiveSpanWarned = false;

/**
 * Emit a one-time, verbose-gated diagnostic when `recordSideEffect` is
 * called correctly (valid `kind`) but no recording span is available to
 * attach evidence to — the otherwise-silent drop that makes a lost
 * side effect externally undebuggable. Marked before the `console.warn`
 * (so a throwing host does not cause a retry) and fenced (so a host that
 * replaces `console.warn` cannot disrupt the behavior-neutral path).
 */
function maybeWarnNoActiveSpan(): void {
  if (!_verbose) return;
  if (_noActiveSpanWarned) return;
  _noActiveSpanWarned = true;
  try {
    console.warn(
      `[glasstrace] recordSideEffect: no recording active span at the ` +
        `call site — side-effect evidence was dropped. Wrap tRPC ` +
        `procedures with @glasstrace/sdk/trpc tracedMiddleware, or pass ` +
        `an owned span: recordSideEffect(input, { span }).`,
    );
  } catch {
    // Diagnostic deliverability is best-effort; never propagate.
  }
}

/**
 * Distinct casing-patterns observed per `*Class` / `*Role` key, used
 * to dedup the value-casing warn so a given (key, casing-pattern)
 * pair warns at most once per process lifetime.
 *
 * Bounded by `_CASING_DEDUP_MAX_KEYS` to prevent unbounded memory
 * growth when a producer emits high-cardinality pattern keys (e.g.,
 * per-provider `provider1Class`, `provider2Class`, ...). Once the
 * cap is reached, new keys are silently skipped — no warn, no map
 * growth. Existing keys in the cap continue to dedup correctly.
 * For the high-cardinality-producer scenario the proliferation warn
 * (verbose-gated) is the operator-facing signal; this
 * cap is just a memory bound.
 */
const _casingWarnSeen = new Map<string, Set<string>>();

/**
 * Cap on the casing-warn dedup map. 100 = bounded memory budget
 * (~10KB worst case: 100 keys × 2 casing patterns × ~50 bytes
 * per entry) while leaving room for legitimate producer vocabularies
 * to warn on real deviations. Producers exceeding this cap are
 * surfaced via the proliferation warn instead.
 */
const _CASING_DEDUP_MAX_KEYS = 100;

/**
 * Distinct pattern-admitted field keys observed this process,
 * excluding explicitly-mapped keys (stable-core or extended evidence).
 * Used as the input to the proliferation warn threshold check.
 */
const _patternKeysSeen = new Set<string>();

/**
 * Bounded queue of the most-recent pattern-admitted keys, used to
 * name a small sample in the proliferation warn message. Capped at
 * `_RECENT_KEYS_IN_WARN` entries.
 */
const _recentPatternKeys: string[] = [];

/**
 * Whether the proliferation warn has already fired this process. The
 * warn is one-shot — once threshold is crossed and the warn fires,
 * no further proliferation warns emit for the remainder of the
 * process lifetime.
 */
let _proliferationWarned = false;

/**
 * Threshold for the proliferation warn: 50 distinct pattern-admitted
 * keys this process. Rationale: 5× the per-operation field cap (10),
 * leaving room for moderate vocabulary expansion across operations
 * before signaling that producer-side vocabulary review is warranted.
 */
const _PROLIFERATION_THRESHOLD = 50;

/** Maximum number of recent keys to name in the proliferation warn. */
const _RECENT_KEYS_IN_WARN = 5;

/**
 * Suffixes whose values follow the lowercase-kebab convention per the
 * v4 vocabulary contract. `*Count` (digit-only) and `*Kind` (no
 * casing convention enforced) are excluded.
 */
function shouldCheckCasingConvention(key: string): boolean {
  return key.endsWith("Class") || key.endsWith("Role");
}

/**
 * Compute a coarse casing-pattern bucket for a value. Used as the
 * dedup key for the casing warn so each distinct deviation from
 * lowercase warns once.
 */
function casingPattern(value: string): "uppercase" | "mixed" {
  return value === value.toUpperCase() ? "uppercase" : "mixed";
}

/**
 * Warn once per (`*Class`/`*Role` key, casing-pattern)
 * pair when a value deviates from the lowercase-kebab convention.
 * Emission still succeeds; the warn surfaces producer-side
 * normalization opportunities. Warn message contains the key name
 * only (no value) for PII safety. The `[glasstrace]` prefix routes
 * past the SDK's own console-capture machinery.
 */
function maybeWarnMixedCasing(key: string, value: string): void {
  if (!shouldCheckCasingConvention(key)) return;
  if (value === value.toLowerCase()) return;
  const pattern = casingPattern(value);
  let seenPatterns = _casingWarnSeen.get(key);
  if (!seenPatterns) {
    // Cap the dedup map to prevent unbounded growth under a
    // high-cardinality producer. Once we hit the cap, new keys are
    // silently skipped — better to lose late-arriving warns than to
    // grow the map without bound. Existing tracked keys continue to
    // dedup correctly.
    if (_casingWarnSeen.size >= _CASING_DEDUP_MAX_KEYS) return;
    seenPatterns = new Set();
    _casingWarnSeen.set(key, seenPatterns);
  }
  if (seenPatterns.has(pattern)) return;
  seenPatterns.add(pattern);
  console.warn(
    `[glasstrace] side-effect field "${key}" value has ${pattern} casing; ` +
      `convention is lowercase-kebab. Producer should normalize.`,
  );
}

/**
 * Proliferation soft-cap. Counts distinct
 * pattern-admitted keys (those without an explicit
 * `FIELD_ATTRIBUTE_BY_KEY` entry) seen this process. When verbose
 * is on and the count crosses `_PROLIFERATION_THRESHOLD`, emits a
 * one-shot warn naming the most-recent `_RECENT_KEYS_IN_WARN` keys.
 * Stable-core and extended evidence keys never count.
 */
function maybeWarnPatternKeyProliferation(key: string): void {
  if (!_verbose) return;
  if (_proliferationWarned) return;
  if (hasExplicitFieldAttribute(key)) return;
  if (_patternKeysSeen.has(key)) return;
  _patternKeysSeen.add(key);
  _recentPatternKeys.push(key);
  if (_recentPatternKeys.length > _RECENT_KEYS_IN_WARN) {
    _recentPatternKeys.shift();
  }
  if (_patternKeysSeen.size >= _PROLIFERATION_THRESHOLD) {
    _proliferationWarned = true;
    console.warn(
      `[glasstrace] side-effect emission has used ${_patternKeysSeen.size} ` +
        `distinct pattern-admitted field keys this process; recent: ` +
        `${_recentPatternKeys.join(", ")}. ` +
        `Consider producer-side vocabulary review (lowercase-kebab convention; ` +
        `Class/Count/Kind/Role suffixes).`,
    );
  }
}

/**
 * Test-only state reset for the vocabulary-governance counters. Not
 * exposed from the public package barrel. Tests for the warn paths
 * must call this in `beforeEach` to ensure dedup state does not leak
 * across describe blocks.
 *
 * @internal
 */
export function _resetSideEffectVocabState(): void {
  _verbose = false;
  _casingWarnSeen.clear();
  _patternKeysSeen.clear();
  _recentPatternKeys.length = 0;
  _proliferationWarned = false;
  _noActiveSpanWarned = false;
  // Clear decision-trace toggle + dedup state so the capture-gate
  // decision lines do not leak across describe blocks.
  _resetDecisionTraceForTesting();
}

/**
 * Input shape for {@link recordSideEffect}.
 *
 * All fields except `kind` and `operation` are optional. The SDK
 * silently drops unknown fields and unsafe values, surfacing only an
 * integer omission count under the matching
 * `glasstrace.side_effect.omitted.*` attribute on the active span.
 */
export interface RecordSideEffectInput {
  /**
   * One of the allowlisted v1 operation kinds. Calls with any other
   * value (typo, unsupported kind, non-string) silently drop without
   * recording an omission, because there is no kind to attach the
   * counter to.
   */
  kind: SideEffectOperationKind;

  /**
   * Compact, normalized operation label (max 96 chars). Must match
   * `^[A-Za-z0-9][A-Za-z0-9_.:-]*$`. Free-form prose, URLs, query
   * strings, and email-shaped values are silently dropped and routed
   * to the matching omission counter.
   */
  operation: string;

  /**
   * Optional operation lifecycle status. Defaults to omitted. Values
   * outside the v1 allowlist are silently dropped.
   */
  status?: SideEffectOperationStatus;

  /**
   * Optional operation execution phase (request / post_response /
   * background / unknown). Defaults to omitted.
   */
  phase?: SideEffectOperationPhase;

  /**
   * Optional allowlisted semantic fields. Keys outside the v1
   * allowlist (`templateKey`, `providerOperation`, `role`, `locale`,
   * `timezone`, `status`, `phase`) and values matching unsafe
   * patterns (URLs, emails, tokens, headers, prose-shaped
   * whitespace) are silently dropped and routed to the matching
   * omission counter.
   */
  fields?: Partial<Record<SideEffectSemanticFieldKey, string>>;

  /**
   * Optional value-fidelity scalars emitted on the off-summary
   * `glasstrace.side_effect.scalar.*` channel. Keys must be camelCase
   * ending in `Ms` / `Amount` / `Bytes` / `Ratio` / `Id` / `Value` /
   * `Flag` (`Count` routes to the categorical `fields` channel instead).
   * Values are native `number` / `boolean` / `string`.
   *
   * Under the default `strict` capture posture the SDK rejects raw
   * wall-clock timestamps (a `Date`, or a raw epoch on a `*Ms` key) and
   * unhashed `*Id` values at emit time — send bounded deltas as numbers,
   * and pre-hash identifiers with `hashId` (`@glasstrace/sdk/node`). At
   * most
   * {@link MAX_SIDE_EFFECT_SCALARS_PER_OPERATION} scalars are recorded
   * per call; rejected values route to the matching omission counter and
   * the raw value never reaches the wire. The same key may also appear
   * in `fields` — the two channels are distinct (selected by attribute
   * prefix), so a categorical and a scalar facet can share a name.
   */
  scalars?: Record<string, unknown>;

  /**
   * Optional producer-asserted boolean relations (invariants) emitted on
   * the categorical field channel. Keys must be camelCase ending in
   * `Holds` (e.g. `timezonePreservedHolds`); values are real `boolean`s,
   * coerced to `"true"`/`"false"` on the wire. A non-`Holds` key, a
   * non-boolean value, or a key already attached by `fields` (a
   * same-channel collision — `fields` wins) is dropped with the matching
   * omission counter. Relations count against the same product-side
   * per-operation field budget as `fields` (enforced at projection).
   *
   * Use {@link invariant} / {@link isNullInvariant} to compute the
   * boolean from a comparison.
   */
  relations?: Record<string, boolean>;
}

/**
 * Options for {@link recordSideEffect}.
 */
export interface RecordSideEffectOptions {
  /**
   * A caller-**owned**, recording OTel span to attach the operation to,
   * instead of the ambient active span. Use this from a passive adapter
   * that opens its own span, or whenever the host app's OTel context may
   * not reliably survive to the call site (so the ambient active span is
   * unreliable). When omitted, the ambient active span is used.
   *
   * A supplied span that has ended or is a `NonRecordingSpan` is a silent
   * no-op — the call does NOT fall back to the ambient span. This is the
   * owned-span counterpart, for the categorical channel, to the `span`
   * option on the value-fidelity `capture()` primitive.
   */
  span?: Span;
}

/**
 * Record allowlisted side-effect evidence on the current active OTel
 * span.
 *
 * Behavior is observational only: this function never executes,
 * retries, or duplicates a side effect. The default capture-config
 * flag `sideEffectEvidence` is `false`; callers must opt in via
 * account configuration before any attribute reaches the wire.
 *
 * Pass an owned span via `recordSideEffect(input, { span })` (see
 * {@link RecordSideEffectOptions}) to attach the operation to a span you
 * control instead of the ambient active span — use this when the host
 * app's OTel context may not reliably survive to the call site.
 *
 * Edge cases (all silent no-ops unless noted):
 *  - capture-config flag is `false` ⇒ no-op (no allowlist evaluation)
 *  - input is not a plain object ⇒ no-op
 *  - `kind` is not in the v1 allowlist ⇒ no-op
 *  - no recording span (no `{ span }` supplied and no recording active
 *    span — including an active span that has ended or is a
 *    `NonRecordingSpan`) ⇒ no-op, plus a one-time `console.warn`
 *    diagnostic when `verbose` is enabled
 *  - a supplied `{ span }` that has ended or is a `NonRecordingSpan` ⇒
 *    no-op (does NOT fall back to the ambient span)
 *  - per-span operation budget exhausted (5 ops max) ⇒ records a
 *    `value_too_long` omission count, no operation attributes
 *  - OTel attribute slot exhaustion ⇒ silently drops the attribute
 *    write
 *
 * The SDK guards only callers of this function. Direct
 * `span.setAttribute("glasstrace.side_effect.<...>", ...)` writes
 * bypass the SDK and rely on the receiver's storage filter as the
 * second defense layer; this is intentional defense-in-depth, not a
 * gap.
 *
 * @example Recording a successful cancellation email
 * ```ts
 * import { recordSideEffect } from "@glasstrace/sdk";
 *
 * await mailer.send({ to: recipient, template: "EventCanceledEmail" });
 * recordSideEffect({
 *   kind: "email",
 *   operation: "email.send",
 *   status: "succeeded",
 *   phase: "request",
 *   fields: {
 *     templateKey: "EventCanceledEmail",
 *     role: "invitee",
 *     locale: "en-US",
 *     timezone: "Europe/Paris",
 *   },
 *   scalars: {
 *     // Bounded delta (not a wall-clock epoch) and a boolean flag.
 *     renderMs: 42,
 *     hadAttachmentFlag: false,
 *   },
 * });
 * ```
 */
export function recordSideEffect(
  input: RecordSideEffectInput,
  options?: RecordSideEffectOptions,
): void {
  try {
    runRecordSideEffect(input, options);
  } catch {
    // Defense-in-depth: any unexpected throw inside the function
    // (e.g., a host shim mis-implementing OTel API) must not
    // propagate to the user's code path. Behavior-neutrality requires
    // recordSideEffect to be observationally invisible.
  }
}

/**
 * Record a field/scalar omission on the target span and, when decision
 * tracing is on, emit a `sideEffect.fieldRejected` decision keyed by the
 * closed omission reason. This is the hot-path rejection site, so the key
 * is the reason ONLY — never the rejected field key or value — which bounds
 * the one-shot cardinality to the fixed omission-reason set and keeps unsafe
 * input off the decision channel. The decision emit is call-site guarded so
 * no detail is built when the toggle is OFF, and it never alters the
 * omission bookkeeping.
 */
function recordRejection(span: Span, reason: SideEffectOmissionReason): void {
  recordOmission(span, reason);
  if (decisionTraceEnabled()) {
    decisionTrace("sideEffect.fieldRejected", reason, {
      oneShotKey: `sideEffect.fieldRejected:${reason}`,
    });
  }
}

function runRecordSideEffect(
  input: unknown,
  options?: RecordSideEffectOptions,
): void {
  if (!input || typeof input !== "object") return;

  // Capture-config gate: read at every call so config rotation takes
  // effect on the next emission without restart. The disk read is
  // cached inside getActiveConfig() so this stays cheap on the hot
  // path.
  let captureEnabled: boolean;
  try {
    captureEnabled = getActiveConfig().sideEffectEvidence === true;
  } catch {
    captureEnabled = false;
  }
  // Decision trace (hot path): record which branch this call-site gate
  // took. Call-site guarded so the detail object is not built when the
  // toggle is OFF. Keyed by surface AND outcome so the `recordSideEffect`
  // surface stays distinct from the `capture()` / `prismaAdapter` value
  // paths, and an enabled→disabled rotation re-emits once.
  if (decisionTraceEnabled()) {
    const outcome = captureEnabled ? "enabled" : "disabled";
    decisionTrace("capture.sideEffectEvidence", outcome, {
      inputs: { surface: "recordSideEffect" },
      oneShotKey: `capture.sideEffectEvidence:recordSideEffect:${outcome}`,
    });
  }
  if (!captureEnabled) {
    // Note: we deliberately do NOT increment a `capture_disabled`
    // omission counter for every call. With the flag off, the SDK's
    // contract is "no allowlist evaluation runs and no allocation
    // happens" — surfacing a per-call counter would require attaching
    // to a span and would defeat that goal. The
    // `capture_disabled` reason exists for the receiver-side path
    // where ingestion drops attributes due to product-side flag
    // changes after the SDK emitted them.
    return;
  }

  const candidate = input as Partial<RecordSideEffectInput>;

  if (!checkOperationKind(candidate.kind)) {
    // No `kind` to attach a counter under — silent drop.
    return;
  }

  // Resolve the target span up front and route everything onto it. A
  // caller-supplied span is used only when it is recording (a dead /
  // NonRecordingSpan supplied span is caller misuse — silent no-op, no
  // ambient fallback, mirroring `capture`). Otherwise the ambient active
  // span is used; when none is recording a valid call would otherwise
  // drop invisibly, so emit the one-time verbose diagnostic.
  let targetSpan: Span | undefined;
  if (options?.span !== undefined) {
    if (!isRecordingSpan(options.span)) return;
    targetSpan = options.span;
  } else {
    targetSpan = getRecordingActiveSpan();
    if (!targetSpan) {
      maybeWarnNoActiveSpan();
      return;
    }
  }

  const labelOutcome = checkOperationLabel(candidate.operation);
  if (!labelOutcome.accepted) {
    recordRejection(targetSpan, labelOutcome.reason);
    return;
  }

  let acceptedStatus: SideEffectOperationStatus | undefined;
  if (candidate.status !== undefined) {
    if (checkOperationStatus(candidate.status)) {
      acceptedStatus = candidate.status;
    } else {
      recordRejection(targetSpan, "unsupported_key");
    }
  }

  let acceptedPhase: SideEffectOperationPhase | undefined;
  if (candidate.phase !== undefined) {
    if (checkOperationPhase(candidate.phase)) {
      acceptedPhase = candidate.phase;
    } else {
      recordRejection(targetSpan, "unsupported_key");
    }
  }

  const outcome = attachOperation(targetSpan, {
    kind: candidate.kind,
    operation: labelOutcome.value,
    status: acceptedStatus,
    phase: acceptedPhase,
  });

  if (outcome.kind === "over_budget") {
    recordRejection(targetSpan, "value_too_long");
    return;
  }

  // Process semantic fields. Each rejection routes to an omission
  // count on the same span; accepted values become field attributes.
  // `attachedFieldKeys` records the keys that actually reached the wire,
  // so the relations loop below can detect a genuine same-channel
  // collision (a rejected field does not suppress a valid relation).
  const attachedFieldKeys = new Set<string>();
  const fields = candidate.fields;
  if (fields && typeof fields === "object") {
    for (const [rawKey, rawValue] of Object.entries(fields)) {
      if (!checkSemanticFieldKey(rawKey)) {
        recordRejection(targetSpan, "unsupported_key");
        continue;
      }
      const valueOutcome = checkSemanticFieldValue(rawKey, rawValue);
      if (!valueOutcome.accepted) {
        recordRejection(targetSpan, valueOutcome.reason);
        continue;
      }
      // Vocabulary-governance signals are diagnostic-only. Wrap in a
      // try/catch so a host that replaces `console.warn` with a
      // throwing implementation cannot disrupt the emission path —
      // the contract is "emission still succeeds even when the
      // governance signal can't be delivered".
      try {
        maybeWarnMixedCasing(rawKey, valueOutcome.value);
        maybeWarnPatternKeyProliferation(rawKey);
      } catch {
        // Intentionally silent — warn deliverability is best-effort.
      }
      attachField(targetSpan, rawKey, valueOutcome.value);
      attachedFieldKeys.add(rawKey);
    }
  }

  // Process boolean `*Holds` relations on the categorical field channel.
  // A real boolean is coerced to `"true"`/`"false"` and routed through
  // the same field validator/emitter as `fields`. A key already attached
  // by `fields` collides on the same channel — `fields` wins and the
  // relation is dropped (a *rejected* field key is not a collision).
  // (`scalars` is a separate attribute channel, so a `*Holds` name there
  // is unrelated — and is independently rejected as a non-scalar key.)
  // Relations count against the same product-side per-operation field
  // budget as `fields`, enforced at projection.
  const relations = candidate.relations;
  if (relations && typeof relations === "object") {
    for (const [rawKey, rawValue] of Object.entries(relations)) {
      if (attachedFieldKeys.has(rawKey)) {
        recordRejection(targetSpan, "unsupported_key");
        continue;
      }
      if (!rawKey.endsWith("Holds") || !checkSemanticFieldKey(rawKey)) {
        recordRejection(targetSpan, "unsupported_key");
        continue;
      }
      if (typeof rawValue !== "boolean") {
        // Relations must be real booleans; a non-boolean is malformed.
        recordRejection(targetSpan, "raw_payload");
        continue;
      }
      const valueOutcome = checkSemanticFieldValue(
        rawKey,
        rawValue ? "true" : "false",
      );
      if (!valueOutcome.accepted) {
        recordRejection(targetSpan, valueOutcome.reason);
        continue;
      }
      // Same diagnostic governance as `fields` (the casing warn no-ops
      // for `*Holds`; the proliferation warn counts the pattern key).
      try {
        maybeWarnMixedCasing(rawKey, valueOutcome.value);
        maybeWarnPatternKeyProliferation(rawKey);
      } catch {
        // Intentionally silent — warn deliverability is best-effort.
      }
      attachField(targetSpan, rawKey, valueOutcome.value);
      attachedFieldKeys.add(rawKey);
    }
  }

  // Process value-fidelity scalars on the off-summary `scalar.*`
  // channel. Enforced in `strict` mode at emit: raw wall-clock
  // timestamps and unhashed `*Id` values never reach the wire. The
  // `full` relaxation (which lets raw values through) requires the
  // server-pushed `captureFidelity` AND a producer opt-in, and the
  // ingestion-side sanitizer that re-enforces it — none of which ship in
  // this slice — so the emitter is unconditionally `strict` here and the
  // raw path stays unreachable until that co-wave lands (fail-closed).
  const scalars = candidate.scalars;
  if (scalars && typeof scalars === "object") {
    let scalarCount = 0;
    for (const [rawKey, rawValue] of Object.entries(scalars)) {
      if (scalarCount >= MAX_SIDE_EFFECT_SCALARS_PER_OPERATION) {
        // Per-operation scalar budget exhausted. Record a single
        // count (mirroring the operation over-budget path) and stop;
        // no rejected value is echoed.
        recordRejection(targetSpan, "value_too_long");
        break;
      }
      scalarCount += 1;
      const scalarOutcome = checkScalarField(rawKey, rawValue);
      if (!scalarOutcome.accepted) {
        recordRejection(targetSpan, scalarOutcome.reason);
        continue;
      }
      attachScalar(targetSpan, rawKey, scalarOutcome.value);
    }
  }
}
