/**
 * Public side-effect evidence emission API (SDK-049).
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

import type {
  SideEffectOperationKind,
  SideEffectOperationPhase,
  SideEffectOperationStatus,
  SideEffectSemanticFieldKey,
} from "@glasstrace/protocol";
import {
  checkOperationKind,
  checkOperationLabel,
  checkOperationPhase,
  checkOperationStatus,
  checkSemanticFieldKey,
  checkSemanticFieldValue,
} from "./allowlist.js";
import {
  attachField,
  attachOperation,
  recordOmission,
  recordOmissionOnActiveSpan,
} from "./emit.js";
import { getActiveConfig } from "../init-client.js";

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
}

/**
 * Record allowlisted side-effect evidence on the current active OTel
 * span (SDK-049).
 *
 * Behavior is observational only: this function never executes,
 * retries, or duplicates a side effect. The default capture-config
 * flag `sideEffectEvidence` is `false`; callers must opt in via
 * account configuration before any attribute reaches the wire.
 *
 * Edge cases (all silent no-ops):
 *  - capture-config flag is `false` ⇒ no-op (no allowlist evaluation)
 *  - input is not a plain object ⇒ no-op
 *  - `kind` is not in the v1 allowlist ⇒ no-op
 *  - no active span ⇒ no-op
 *  - active span has already ended or is `NonRecordingSpan` ⇒ no-op
 *  - per-span operation budget exhausted (5 ops max) ⇒ records a
 *    `value_too_long` omission count, no operation attributes
 *  - OTel attribute slot exhaustion ⇒ silently drops the attribute
 *    write
 *
 * The SDK guards only callers of this function. Direct
 * `span.setAttribute("glasstrace.side_effect.<...>", ...)` writes
 * bypass the SDK and rely on the product's storage filter (ING-023)
 * as the second defense layer; this is intentional defense-in-depth,
 * not a gap.
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
 * });
 * ```
 */
export function recordSideEffect(input: RecordSideEffectInput): void {
  try {
    runRecordSideEffect(input);
  } catch {
    // Defense-in-depth: any unexpected throw inside the function
    // (e.g., a host shim mis-implementing OTel API) must not
    // propagate to the user's code path. Behavior-neutrality requires
    // recordSideEffect to be observationally invisible.
  }
}

function runRecordSideEffect(input: unknown): void {
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

  const labelOutcome = checkOperationLabel(candidate.operation);
  if (!labelOutcome.accepted) {
    recordOmissionOnActiveSpan(labelOutcome.reason);
    return;
  }

  let acceptedStatus: SideEffectOperationStatus | undefined;
  if (candidate.status !== undefined) {
    if (checkOperationStatus(candidate.status)) {
      acceptedStatus = candidate.status;
    } else {
      recordOmissionOnActiveSpan("unsupported_key");
    }
  }

  let acceptedPhase: SideEffectOperationPhase | undefined;
  if (candidate.phase !== undefined) {
    if (checkOperationPhase(candidate.phase)) {
      acceptedPhase = candidate.phase;
    } else {
      recordOmissionOnActiveSpan("unsupported_key");
    }
  }

  const outcome = attachOperation({
    kind: candidate.kind,
    operation: labelOutcome.value,
    status: acceptedStatus,
    phase: acceptedPhase,
  });

  if (outcome.kind === "no_active_span") {
    // No span to record an omission against either — silent drop.
    return;
  }
  if (outcome.kind === "over_budget") {
    recordOmission(outcome.span, "value_too_long");
    return;
  }

  // Process semantic fields. Each rejection routes to an omission
  // count on the same span; accepted values become field attributes.
  const fields = candidate.fields;
  if (fields && typeof fields === "object") {
    for (const [rawKey, rawValue] of Object.entries(fields)) {
      if (!checkSemanticFieldKey(rawKey)) {
        recordOmission(outcome.span, "unsupported_key");
        continue;
      }
      const valueOutcome = checkSemanticFieldValue(rawKey, rawValue);
      if (!valueOutcome.accepted) {
        recordOmission(outcome.span, valueOutcome.reason);
        continue;
      }
      attachField(outcome.span, rawKey, valueOutcome.value);
    }
  }
}
