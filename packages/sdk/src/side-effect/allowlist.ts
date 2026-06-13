/**
 * Side-effect evidence allowlist enforcement.
 *
 * Two enforcement layers, both pure functions with no I/O. The SDK
 * runs these before any `glasstrace.side_effect.*` attribute is
 * attached to a span; the receiver's storage filter is a second
 * defense, not the primary boundary. A value rejected here
 * never reaches the OTel exporter, so it cannot leak through any
 * downstream telemetry path.
 *
 * Layer 1 (input shape):
 *  - Reject non-string scalars where strings are required.
 *  - Reject lengths exceeding the wire-schema budgets
 *    (operation label > 96 chars, field value > 80 chars) ⇒
 *    `value_too_long`.
 *  - Reject unsafe-pattern matches (URL, email, headers, tokens,
 *    UUIDs, prose-shaped whitespace) ⇒ category-mapped reason.
 *
 * Layer 2 (per-field validators):
 *  - `templateKey | providerOperation | role | status | phase` and
 *    the operation label require a compact token regex.
 *  - `locale` requires a BCP-47-shaped token.
 *  - `timezone` requires an IANA-shaped token.
 *
 * The regexes mirror the product-side schema in
 * `glasstrace-product/shared/types/agent-evidence.ts:585-619`
 * verbatim so any value the SDK admits is guaranteed to pass the
 * product's storage-time filter.
 *
 * @drift-check ../../glasstrace-product/shared/types/agent-evidence.ts
 */

import type {
  CaptureFidelity,
  SideEffectOmissionReason,
  SideEffectOperationKind,
  SideEffectOperationPhase,
  SideEffectOperationStatus,
  SideEffectSemanticFieldKey,
} from "@glasstrace/protocol";
import {
  isSideEffectScalarKey,
  isSideEffectSemanticFieldKey,
  SIDE_EFFECT_HASHED_ID_HEX_LENGTH,
  SIDE_EFFECT_HASHED_ID_PREFIX,
  SIDE_EFFECT_OMISSION_REASONS,
  SIDE_EFFECT_OPERATION_KINDS,
  SIDE_EFFECT_OPERATION_PHASES,
  SIDE_EFFECT_OPERATION_STATUSES,
} from "@glasstrace/protocol";

/**
 * Maximum length, in characters, of a side-effect operation label.
 * Mirrors `AGENT_EVIDENCE_MAX_SIDE_EFFECT_OPERATION_LABEL_LENGTH`
 * in the product-side schema.
 */
export const MAX_SIDE_EFFECT_OPERATION_LABEL_LENGTH = 96;

/**
 * Maximum length, in characters, of a side-effect semantic field
 * value for stable-core keys (other than `locale` / `timezone`,
 * which use specialized validators) and for pattern-admitted
 * `*Class` / `*Kind` / `*Role` keys. Mirrors
 * `AGENT_EVIDENCE_MAX_SIDE_EFFECT_FIELD_VALUE_LENGTH`.
 */
export const MAX_SIDE_EFFECT_FIELD_VALUE_LENGTH = 80;

/**
 * Maximum length, in characters, of a pattern-admitted `*Count`
 * value. Tighter than the default field-value length because count
 * values are non-negative integer strings, not free-form tokens.
 * Mirrors `AGENT_EVIDENCE_MAX_SIDE_EFFECT_FIELD_COUNT_VALUE_LENGTH`.
 */
export const MAX_SIDE_EFFECT_FIELD_COUNT_VALUE_LENGTH = 16;


/**
 * Maximum number of side-effect operations recorded on a single span
 * before further calls are dropped under the `value_too_long`
 * omission reason. Mirrors
 * `AGENT_EVIDENCE_MAX_SIDE_EFFECT_OPERATIONS`.
 */
export const MAX_SIDE_EFFECT_OPERATIONS_PER_SPAN = 5;

const OPERATION_KIND_SET: ReadonlySet<string> = new Set(
  SIDE_EFFECT_OPERATION_KINDS,
);
const OPERATION_STATUS_SET: ReadonlySet<string> = new Set(
  SIDE_EFFECT_OPERATION_STATUSES,
);
const OPERATION_PHASE_SET: ReadonlySet<string> = new Set(
  SIDE_EFFECT_OPERATION_PHASES,
);
const OMISSION_REASON_SET: ReadonlySet<string> = new Set(
  SIDE_EFFECT_OMISSION_REASONS,
);

/**
 * Returns `true` when `reason` is one of the wire-schema omission
 * reasons. Exposed for tests and any future caller that needs to
 * narrow an arbitrary string to a `SideEffectOmissionReason` before
 * passing it to the emission helpers; the SDK's own emission path
 * always works with statically known literals.
 */
export function isKnownOmissionReason(
  reason: string,
): reason is SideEffectOmissionReason {
  return OMISSION_REASON_SET.has(reason);
}

// Compact-token regex shared by templateKey/providerOperation/role/status/phase
// and the operation label. The trailing length guard is enforced
// separately so the budget rejection produces `value_too_long`
// (rather than this regex's anchor failure being mis-categorized).
const TOKEN_REGEX = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

// BCP-47-shaped locale, mirroring the wire schema's
// SideEffectLocaleValueSchema regex.
const LOCALE_REGEX = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

// IANA-shaped timezone, mirroring the wire schema's
// SideEffectTimezoneValueSchema regex.
const TIMEZONE_REGEX =
  /^(?:UTC|GMT|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){1,3})$/;

// Non-negative integer string for participant-count fields. Tighter
// than TOKEN_REGEX so misleading non-digit values (`"many"`, `"a few"`,
// `"1:2"`) are rejected as `raw_payload` rather than recorded as
// causal evidence. The leading anchor reproduces the TOKEN_REGEX
// rejection of signed counts (`"-1"`) and rejects empty strings.
const DIGIT_REGEX = /^[0-9]+$/;

// Boolean-literal string for `*Holds` relation fields. The value is the
// stringified producer boolean (`"true"`/`"false"`); coercion to a real
// boolean happens at projection/read time, not on the wire. The product
// admits `*Holds` and a matching boolean value-schema in a coordinated
// co-merge (not yet shipped); this regex is the SDK-side enforcement
// that pairs with it.
const BOOL_REGEX = /^(?:true|false)$/;

// Unsafe-pattern detectors. Each rejects independently; the first
// match determines the omission reason. The patterns and the reason
// mapping are calibrated against the product's
// SideEffectUnsafeTextSchema (agent-evidence.ts:563-583) and the
// SDK-049 §Safety Requirements list.

const URL_SCHEME = /:\/\//;
const URL_SCHEME_RELATIVE = /^\/\//;
const EMAIL_LIKE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const QUERY_LIKE = /\?/;
const FRAGMENT_LIKE = /#/;
const HEADER_LIKE = /\b(authorization|set-cookie|cookie)\b\s*[:=]/i;
const HEADER_TOKEN_LIKE =
  /\b(authorization|set-cookie|cookie)\b\s+\S+=/i;
const BEARER_LIKE = /bearer\s+\S+/i;
const TOKEN_KV_LIKE =
  /["']?(password|passwd|token|api[_-]?key|secret|client_secret)["']?\s*[:=]/i;
const PROSE_LIKE = /[\r\n\t]|\s{2,}/;
const UUID_LIKE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const GT_KEY_LIKE = /gt_(dev|anon|live)_[A-Za-z0-9_-]+/;

/**
 * Inspect a value for unsafe patterns. Returns the matched omission
 * reason or `null` if the value is shape-clean. The function does NOT
 * apply the per-field token regex; that is Layer 2 below.
 *
 * Detector order matters: URL-shape detectors run before token-shape
 * detectors so a URL with an embedded `token=` query parameter is
 * categorized as `raw_payload` (the structural shape that brought it
 * here was the URL, not the token). Header and bearer-shaped values
 * are categorized as `secret` because they always carry credential
 * material. Email is `pii`. Whitespace anomalies are `raw_payload`.
 */
function detectUnsafePattern(value: string): SideEffectOmissionReason | null {
  // Whitespace anomalies fall into raw_payload because they indicate
  // prose or copy-pasted user content rather than a compact label.
  if (value.trim() !== value) return "raw_payload";
  if (PROSE_LIKE.test(value)) return "raw_payload";

  // URL-shape detectors run first so a credential-bearing query
  // string is categorized by its structural shape (raw_payload)
  // rather than the credential token inside it. The product's
  // The wire-schema filter rejects URL shapes regardless of category, so
  // either choice is safe; the test fixture documents that URL-shape
  // wins.
  if (URL_SCHEME.test(value)) return "raw_payload";
  if (URL_SCHEME_RELATIVE.test(value)) return "raw_payload";
  if (QUERY_LIKE.test(value)) return "raw_payload";
  if (FRAGMENT_LIKE.test(value)) return "raw_payload";

  // Header-shaped and credential-shaped values route to `secret`
  // because they always carry authentication material. Bearer- and
  // token-key-value-like values are detected even when no header
  // prefix is present.
  if (BEARER_LIKE.test(value)) return "secret";
  if (HEADER_TOKEN_LIKE.test(value)) return "secret";
  if (TOKEN_KV_LIKE.test(value)) return "secret";
  if (HEADER_LIKE.test(value)) return "secret";
  if (UUID_LIKE.test(value)) return "secret";
  if (GT_KEY_LIKE.test(value)) return "secret";

  // PII detector.
  if (EMAIL_LIKE.test(value)) return "pii";

  return null;
}

/**
 * Run Layer 2 per-field validation. Returns `true` when the value
 * matches the field's regex. Length and shape rejection from Layer 1
 * is the caller's responsibility — by the time this runs the value
 * is known to be a non-empty string within the per-field length
 * budget and free of unsafe patterns.
 *
 * Routing order matters: stable-core specialized validators
 * (`locale`, `timezone`) win over the default suffix routing, so
 * stable-core admission is checked first. Pattern-admitted keys
 * route by suffix: `*Count` → digit-only; `*Class` / `*Kind` /
 * `*Role` → compact token. Non-stable-core, non-pattern-matching
 * keys never reach this function (Layer-1 admission via
 * {@link isSideEffectSemanticFieldKey} rejects them and routes to
 * the `unsupported_key` omission counter).
 */
function passesFieldValidator(
  key: SideEffectSemanticFieldKey,
  value: string,
): boolean {
  if (key === "locale") return LOCALE_REGEX.test(value);
  if (key === "timezone") return TIMEZONE_REGEX.test(value);
  if (typeof key === "string" && key.endsWith("Count")) {
    return DIGIT_REGEX.test(value);
  }
  if (typeof key === "string" && key.endsWith("Holds")) {
    return BOOL_REGEX.test(value);
  }
  return TOKEN_REGEX.test(value);
}

/**
 * Outcome of allowlist enforcement on a single value.
 */
export type ValueOutcome =
  | { accepted: true; value: string }
  | { accepted: false; reason: SideEffectOmissionReason };

/**
 * Check the operation label (`recordSideEffect({ operation })`).
 *
 * Order matters: type rejection ⇒ length budget ⇒ unsafe pattern ⇒
 * field validator. This ordering lets each rejection class produce a
 * meaningful omission reason without the regex anchor failure
 * masking an upstream length or shape problem.
 */
export function checkOperationLabel(value: unknown): ValueOutcome {
  if (typeof value !== "string" || value.length === 0) {
    return { accepted: false, reason: "raw_payload" };
  }
  if (value.length > MAX_SIDE_EFFECT_OPERATION_LABEL_LENGTH) {
    return { accepted: false, reason: "value_too_long" };
  }
  const unsafe = detectUnsafePattern(value);
  if (unsafe) {
    return { accepted: false, reason: unsafe };
  }
  if (!TOKEN_REGEX.test(value)) {
    // A value that survives unsafe-pattern detection but still fails
    // the compact-token regex is malformed (e.g., starts with a hyphen
    // or contains a slash). Categorize as `raw_payload` because the
    // value carries shape inconsistent with a normalized label.
    return { accepted: false, reason: "raw_payload" };
  }
  return { accepted: true, value };
}

/**
 * Check a semantic field value for one of the allowlisted keys. The
 * key must already be known to be allowlisted (Layer 1 filters
 * unsupported keys via {@link checkSemanticFieldKey}).
 */
export function checkSemanticFieldValue(
  key: SideEffectSemanticFieldKey,
  value: unknown,
): ValueOutcome {
  if (typeof value !== "string" || value.length === 0) {
    return { accepted: false, reason: "raw_payload" };
  }
  // *Count keys use a tighter length budget than the default
  // field-value cap (integer strings are not free-form tokens).
  // Routing here mirrors the suffix routing in passesFieldValidator.
  const maxLength =
    typeof key === "string" && key.endsWith("Count")
      ? MAX_SIDE_EFFECT_FIELD_COUNT_VALUE_LENGTH
      : MAX_SIDE_EFFECT_FIELD_VALUE_LENGTH;
  if (value.length > maxLength) {
    return { accepted: false, reason: "value_too_long" };
  }
  const unsafe = detectUnsafePattern(value);
  if (unsafe) {
    return { accepted: false, reason: unsafe };
  }
  if (!passesFieldValidator(key, value)) {
    return { accepted: false, reason: "raw_payload" };
  }
  return { accepted: true, value };
}

// ---------------------------------------------------------------------------
// Value-fidelity scalar channel
// ---------------------------------------------------------------------------

// Fixed-shape hashed-identifier regex the SDK admits under `strict` —
// exactly the shape `hashId` emits (`gthid_` + N lowercase-hex). This is
// stronger than the product validator's length-agnostic
// `^gthid_[0-9a-f]+$`: pinning the length closes a smuggling vector
// (arbitrary hex-encoded data behind `gthid_`) and bounds attribute
// size. The length comes from the shared protocol constant so the
// validator and `hashId` cannot drift.
const GTHID_STRICT_REGEX = new RegExp(
  `^${SIDE_EFFECT_HASHED_ID_PREFIX}[0-9a-f]{${SIDE_EFFECT_HASHED_ID_HEX_LENGTH}}$`,
);

// Minimum value (milliseconds) treated as a wall-clock epoch on a
// timestamp-shaped (`*Ms`) key. 1e12 ms ≈ year 2001; a duration in ms
// below ~31.7 years stays under this bound, so a raw `Date.now()`
// (~1.7e12 today) is caught while realistic durations are not. The
// heuristic cannot distinguish a >31-year duration from an epoch — such
// a producer should use `captureFidelity: "full"` or a coarser unit.
const SCALAR_EPOCH_MS_MIN = 1e12;

/** A `*Ms` scalar carries milliseconds, where a raw epoch can leak. */
function isTimestampShapedScalarKey(key: string): boolean {
  return key.endsWith("Ms");
}

/**
 * Outcome of scalar-channel enforcement on a single value. The accepted
 * value is the native `number` / `boolean` / `string` (no stringify) —
 * the product validator rejects numeric- and boolean-shaped strings, so
 * the emitter must attach the native type.
 */
export type ScalarOutcome =
  | { accepted: true; value: number | boolean | string }
  | { accepted: false; reason: SideEffectOmissionReason };

/**
 * Check a value for the `glasstrace.side_effect.scalar.*` channel.
 *
 * The key suffix declares the value type, and this validator enforces it:
 *
 *  - `*Ms` / `*Amount` / `*Bytes` / `*Ratio` / `*Value` → finite `number`
 *  - `*Flag` → `boolean`
 *  - `*Id` → a pseudonymized `gthid_` string (categorical string enums
 *    belong on the `fields` channel, not here)
 *
 * A value whose type does not match its suffix is dropped rather than
 * emitted, so downstream consumers never see a `*Ms` boolean or a
 * `*Flag` number. The omission reason is `raw_payload` for the numeric
 * and `*Flag` suffixes, and `unhashed_id` for a non-string (or, under
 * `strict`, non-`gthid_`) `*Id`.
 *
 * `mode` is the **effective** fidelity (the conjunction of the
 * server-pushed `CaptureConfig.captureFidelity` and the producer opt-in,
 * resolved by the caller). Under `strict` (the default and — until the
 * ingestion sanitizer ships — the only mode the emitter passes) raw
 * wall-clock timestamps (a `Date`, or a raw epoch on a `*Ms` key) and
 * unhashed identifiers are rejected at emit so they never reach the wire.
 * `full` relaxes only those timestamp/id privacy rejections; the
 * suffix-type, length, PII, and non-finite checks apply in both modes.
 *
 * Note: epoch screening covers only `*Ms` keys (the sole time-typed
 * suffix). A wall-clock value placed on another numeric suffix is not
 * detected here and relies on the server-side sanitizer as the backstop;
 * producers should keep wall-clock magnitudes off non-`*Ms` keys.
 *
 * Channel selection is by attribute prefix, never key suffix; this
 * function presumes the caller routed the value to the scalar channel.
 */
export function checkScalarField(
  key: string,
  value: unknown,
  mode: CaptureFidelity = "strict",
): ScalarOutcome {
  if (typeof key !== "string" || !isSideEffectScalarKey(key)) {
    return { accepted: false, reason: "unsupported_key" };
  }

  // A `Date` is unambiguously a wall-clock value and is never an emittable
  // scalar (OTel cannot carry a `Date`); classify it by intent in both
  // modes — the producer should send a bounded delta number instead.
  if (value instanceof Date) {
    return { accepted: false, reason: "raw_timestamp" };
  }

  // `*Id`: a pseudonymized identifier string. Under `strict` it must be
  // the fixed-shape `gthid_<hex>` output of `hashId`; under `full` a raw
  // id string is allowed, still guarded for PII and length.
  if (key.endsWith("Id")) {
    if (typeof value !== "string") {
      return { accepted: false, reason: "unhashed_id" };
    }
    if (mode === "strict") {
      if (!GTHID_STRICT_REGEX.test(value)) {
        return { accepted: false, reason: "unhashed_id" };
      }
      return { accepted: true, value };
    }
    // `full`: a raw (non-`gthid_`) id is allowed here, but note the
    // product `SideEffectScalarSchema` requires `gthid_` for `*Id`
    // unconditionally — so this shape is NOT yet product-valid. The
    // emitter never passes `full` today (it is hard-wired `strict`); when
    // the `full` path is wired, the product schema must gain matching
    // fidelity-awareness first. (Guarded by the strict-only emit call.)
    if (value.length === 0) {
      return { accepted: false, reason: "raw_payload" };
    }
    const unsafe = detectUnsafePattern(value);
    if (unsafe) {
      return { accepted: false, reason: unsafe };
    }
    if (value.length > MAX_SIDE_EFFECT_FIELD_VALUE_LENGTH) {
      return { accepted: false, reason: "value_too_long" };
    }
    return { accepted: true, value };
  }

  // `*Flag`: boolean only.
  if (key.endsWith("Flag")) {
    if (typeof value !== "boolean") {
      return { accepted: false, reason: "raw_payload" };
    }
    return { accepted: true, value };
  }

  // All remaining valid suffixes (`Ms` / `Amount` / `Bytes` / `Ratio` /
  // `Value`) are numeric magnitudes.
  if (typeof value !== "number") {
    return { accepted: false, reason: "raw_payload" };
  }
  if (!Number.isFinite(value)) {
    return { accepted: false, reason: "non_finite" };
  }
  if (
    mode === "strict" &&
    isTimestampShapedScalarKey(key) &&
    value >= SCALAR_EPOCH_MS_MIN
  ) {
    return { accepted: false, reason: "raw_timestamp" };
  }
  return { accepted: true, value };
}

/**
 * Returns `true` when `key` is allowlisted as a semantic field key.
 * The narrowing predicate lets callers safely route the value to
 * {@link checkSemanticFieldValue}.
 */
export function checkSemanticFieldKey(
  key: unknown,
): key is SideEffectSemanticFieldKey {
  return typeof key === "string" && isSideEffectSemanticFieldKey(key);
}

/**
 * Returns `true` when `kind` is one of the v1 allowlisted operation
 * kinds.
 */
export function checkOperationKind(
  kind: unknown,
): kind is SideEffectOperationKind {
  return typeof kind === "string" && OPERATION_KIND_SET.has(kind);
}

/**
 * Returns `true` when `status` is one of the v1 allowlisted operation
 * statuses. Distinct from the per-field `status` check because the
 * top-level operation status is enforced as an enum membership only —
 * no compact-token regex applies (the wire-schema enum is the
 * exhaustive accepted set).
 */
export function checkOperationStatus(
  status: unknown,
): status is SideEffectOperationStatus {
  return typeof status === "string" && OPERATION_STATUS_SET.has(status);
}

/**
 * Returns `true` when `phase` is one of the v1 allowlisted operation
 * phases.
 */
export function checkOperationPhase(
  phase: unknown,
): phase is SideEffectOperationPhase {
  return typeof phase === "string" && OPERATION_PHASE_SET.has(phase);
}
