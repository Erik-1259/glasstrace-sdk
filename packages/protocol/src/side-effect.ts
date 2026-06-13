/**
 * Side-effect evidence value-enum constants.
 *
 * The runtime `as const` tuples are the source of truth for the
 * allowlisted value sets. TypeScript types are derived via
 * `typeof T[number]` so consumers get a literal-type union without a
 * separate string-literal-union declaration that could silently drift
 * from the runtime allowlist.
 *
 * These tuples align verbatim with the product-side wire schema in
 * `glasstrace-product/shared/types/agent-evidence.ts`. Members must
 * remain in sync across both repos; the SDK enforces these allowlists
 * client-side as defense-in-depth before any attribute reaches the
 * wire (the product's storage filter is a second defense, not the
 * primary boundary).
 *
 * @drift-check ../../glasstrace-product/docs/component-designs/side-effect-evidence-summaries.md
 */

/**
 * Allowlisted side-effect operation kinds (v1).
 *
 * Each kind names a category of side effect the receiver projects in
 * MCP tool responses. New kinds require a coordinated bump across the
 * wire-schema definition, this tuple, and any downstream consumer that
 * switches on the kind.
 */
export const SIDE_EFFECT_OPERATION_KINDS = [
  "email",
  "calendar_link",
  "webhook",
  "external_api",
  "queue",
  "after_callback",
] as const;

/**
 * One of the allowlisted side-effect operation kinds.
 *
 * @see {@link SIDE_EFFECT_OPERATION_KINDS}
 */
export type SideEffectOperationKind =
  (typeof SIDE_EFFECT_OPERATION_KINDS)[number];

/**
 * Stable-core semantic field keys for `recordSideEffect()` evidence.
 *
 * These seven keys have specialized value validators (BCP-47 for
 * `locale`, IANA for `timezone`, compact token for the rest) and are
 * the closed set of names that can never be removed without a
 * coordinated wire-breaking change. Pattern-admitted keys (see
 * {@link SIDE_EFFECT_SEMANTIC_FIELD_OPEN_PATTERN}) live alongside
 * these and are validated by suffix routing.
 */
export const SIDE_EFFECT_SEMANTIC_FIELD_STABLE_CORE_KEYS = [
  "templateKey",
  "providerOperation",
  "role",
  "locale",
  "timezone",
  "status",
  "phase",
] as const;

/**
 * One of the stable-core semantic field keys (compile-time literal
 * union). Consumers who want autocomplete for the closed stable-core
 * set import this narrower type; consumers who accept the wider
 * named-pattern admission shape use {@link SideEffectSemanticFieldKey}.
 *
 * @see {@link SIDE_EFFECT_SEMANTIC_FIELD_STABLE_CORE_KEYS}
 */
export type SideEffectSemanticFieldStableCoreKey =
  (typeof SIDE_EFFECT_SEMANTIC_FIELD_STABLE_CORE_KEYS)[number];

/**
 * Open-pattern semantic field key regex.
 *
 * Keys that match this regex are admitted alongside the stable-core
 * literal set. The suffix family is `*Class` / `*Count` / `*Kind` /
 * `*Role` / `*Holds`; producers normalize key names to lowerCamelCase
 * with one of the canonical suffixes. Value-shape validators route on
 * the suffix:
 *
 *   - `*Count` → digit-only string (max 16 chars)
 *   - `*Holds` → boolean string (`"true"` / `"false"`)
 *   - `*Class` / `*Kind` / `*Role` → compact-token string (max 80)
 *
 * `*Holds` carries a producer-supplied boolean relation (an asserted
 * invariant such as `timezonePreservedHolds`) inline on the categorical
 * field channel — not the scalar channel. Stable-core keys with
 * specialized validators take precedence over the default suffix
 * routing.
 */
export const SIDE_EFFECT_SEMANTIC_FIELD_OPEN_PATTERN =
  /^[a-z][A-Za-z0-9]*(Class|Count|Kind|Role|Holds)$/;

/**
 * Maximum length, in characters, of a semantic field KEY name.
 *
 * The pattern regex {@link SIDE_EFFECT_SEMANTIC_FIELD_OPEN_PATTERN}
 * has no length bound on its own. A producer that derived a key
 * from request/provider metadata could pass a giant string ending in
 * `Class`/`Count`/`Kind`/`Role` and inflate the emitted
 * `glasstrace.side_effect.field.<key>` OTel attribute. The closed
 * enum era bounded key-name size implicitly; pattern admission
 * needs an explicit cap. 80 mirrors the SDK's value-length cap for
 * symmetry; stable-core keys are all ≤22 chars and pattern keys
 * following the lowerCamelCase + canonical-suffix convention rarely
 * exceed ~30 chars, so 80 gives generous headroom while keeping
 * telemetry payloads bounded.
 *
 * The cap lives at the protocol layer (not just the SDK runtime)
 * because {@link isSideEffectSemanticFieldKey} is exported as the
 * public runtime guard for producer-supplied keys; consumers calling
 * the guard must see the same admission decision the SDK uses at
 * emission.
 */
export const MAX_SIDE_EFFECT_SEMANTIC_FIELD_KEY_LENGTH = 80;

/**
 * Runtime guard for the semantic field key admission contract.
 *
 * Returns `true` when `key` is non-empty, no longer than
 * {@link MAX_SIDE_EFFECT_SEMANTIC_FIELD_KEY_LENGTH}, and either one
 * of the seven stable-core keys or matches the open-pattern regex.
 * Use this guard at any runtime call-site that needs to validate a
 * producer-supplied key before emission; for compile-time
 * autocomplete on the stable-core subset, import
 * {@link SideEffectSemanticFieldStableCoreKey}.
 *
 * Note: the length cap is part of the admission contract, not a
 * separate SDK runtime concern. Consumers using this guard see the
 * same decision the SDK uses at `recordSideEffect()` emission.
 */
export function isSideEffectSemanticFieldKey(key: string): boolean {
  if (key.length > MAX_SIDE_EFFECT_SEMANTIC_FIELD_KEY_LENGTH) return false;
  return (
    (SIDE_EFFECT_SEMANTIC_FIELD_STABLE_CORE_KEYS as readonly string[]).includes(
      key,
    ) || SIDE_EFFECT_SEMANTIC_FIELD_OPEN_PATTERN.test(key)
  );
}

/**
 * Any admissible semantic field key — the stable-core literal union
 * plus any string matching the open-pattern regex.
 *
 * Note: TypeScript collapses `<literal-union> | string` to `string`
 * at the type level (the `string` member subsumes the literal arm),
 * so compile-time narrowing is intentionally relaxed at this
 * surface. Runtime admission is enforced by
 * {@link isSideEffectSemanticFieldKey}. Consumers who want
 * compile-time stable-core autocomplete should import
 * {@link SideEffectSemanticFieldStableCoreKey} instead.
 */
export type SideEffectSemanticFieldKey =
  | SideEffectSemanticFieldStableCoreKey
  | string;

/**
 * Allowlisted reasons a side-effect value may be omitted from the
 * emitted summary.
 *
 * The SDK records counts under these reasons rather than the rejected
 * values themselves so unsafe input never appears anywhere on the
 * wire. The set is fixed by the wire schema; new reasons require a
 * coordinated cross-repo bump.
 */
export const SIDE_EFFECT_OMISSION_REASONS = [
  "pii",
  "secret",
  "raw_payload",
  "unsupported_key",
  "value_too_long",
  "not_emitted",
  "capture_disabled",
  // Value-fidelity scalar channel reasons. A scalar is dropped under
  // `raw_timestamp` when a wall-clock value (a `Date` instance, or a
  // numeric epoch on a `*Ms` key) is rejected in favor of a bounded
  // delta; `unhashed_id` when an `*Id` scalar is not the `gthid_<hex>`
  // output of `hashId`; `non_finite` when a number is NaN/±Infinity.
  // (A type-mismatched value — e.g. a date *string* on a numeric key —
  // is dropped under `raw_payload`, not `raw_timestamp`, since the
  // scalar channel only carries native numbers/booleans plus `gthid_`
  // ids.) These mirror the product `SideEffectOmissionReasonSchema`
  // tuple verbatim (hand-maintained on both sides; see @drift-check
  // above). `non_finite` is SDK-emit-time only — JSON cannot carry
  // NaN/Infinity to the wire.
  "raw_timestamp",
  "unhashed_id",
  "non_finite",
] as const;

/**
 * One of the allowlisted side-effect omission reasons.
 *
 * @see {@link SIDE_EFFECT_OMISSION_REASONS}
 */
export type SideEffectOmissionReason =
  (typeof SIDE_EFFECT_OMISSION_REASONS)[number];

/**
 * Value-fidelity scalar key pattern.
 *
 * Scalars carry type-aware raw magnitudes off-summary on the
 * `glasstrace.side_effect.scalar.*` channel, distinct from the
 * categorical `*.field.*` summary channel. A scalar key is camelCase
 * ending in one of the magnitude/identity suffixes:
 *
 *   - `*Ms` / `*Amount` / `*Bytes` / `*Ratio` / `*Value` → finite number
 *   - `*Flag` → boolean
 *   - `*Id` → a `gthid_<hex>` hashed identifier (never a raw id)
 *
 * `Count` is deliberately **excluded**: count facets route to the
 * categorical summary channel via the `*Count` semantic-field validator,
 * not the scalar channel. Channel selection is by attribute **prefix**
 * (`…field.*` vs `…scalar.*`), never by key suffix — the same key may
 * legitimately exist on both channels.
 *
 * Mirrors the product `SideEffectScalarSchema` key regex verbatim
 * (`shared/types/agent-evidence.ts`); see @drift-check above.
 */
export const SIDE_EFFECT_SCALAR_KEY_PATTERN =
  /^[a-z][A-Za-z0-9]*(Ms|Amount|Bytes|Ratio|Id|Value|Flag)$/;

/**
 * OTel attribute-name prefix for the value-fidelity scalar channel.
 * The emitted attribute is `${SIDE_EFFECT_SCALAR_PREFIX}${key}` carrying
 * a native `number` / `boolean` / `string` value (no stringify — the
 * product validator rejects numeric- and boolean-shaped strings).
 */
export const SIDE_EFFECT_SCALAR_PREFIX = "glasstrace.side_effect.scalar.";

/**
 * Maximum number of scalars recorded per side-effect operation. Scalars
 * are off-summary and do not count against the categorical
 * per-operation field budget; this is the separate scalar ceiling,
 * enforced SDK-side at emit and re-enforced product-side at ingestion.
 */
export const MAX_SIDE_EFFECT_SCALARS_PER_OPERATION = 16;

/**
 * Runtime guard for the scalar key admission contract. Returns `true`
 * when `key` is no longer than
 * {@link MAX_SIDE_EFFECT_SEMANTIC_FIELD_KEY_LENGTH} and matches
 * {@link SIDE_EFFECT_SCALAR_KEY_PATTERN}. The length cap is shared with
 * the semantic-field key contract for symmetry with the product schema,
 * which bounds the scalar key by the same constant.
 */
export function isSideEffectScalarKey(key: string): boolean {
  if (key.length > MAX_SIDE_EFFECT_SEMANTIC_FIELD_KEY_LENGTH) return false;
  return SIDE_EFFECT_SCALAR_KEY_PATTERN.test(key);
}

/**
 * Fixed prefix of a hashed side-effect identifier produced by `hashId`.
 * The full shape is `gthid_<lowercase-hex>`; the product validator
 * accepts `/^gthid_[0-9a-f]+$/` (length-agnostic), while the SDK emits a
 * fixed-length digest so a forged `gthid_<non-hex>` fails the shape.
 */
export const SIDE_EFFECT_HASHED_ID_PREFIX = "gthid_";

/**
 * Hex length of the digest in a `hashId` token (`gthid_<hex>`). The SDK
 * both emits and (under `strict`) admits exactly this length — a
 * fixed-shape `gthid_[0-9a-f]{N}` token, which is stronger than the
 * product validator's length-agnostic `^gthid_[0-9a-f]+$`. Pinning the
 * length closes a smuggling vector (arbitrary hex-encoded data behind
 * `gthid_`) and bounds the emitted attribute size. Shared by `hashId`
 * and the SDK scalar validator so the two cannot drift.
 */
export const SIDE_EFFECT_HASHED_ID_HEX_LENGTH = 32;

/**
 * Allowlisted side-effect operation lifecycle statuses.
 */
export const SIDE_EFFECT_OPERATION_STATUSES = [
  "scheduled",
  "started",
  "succeeded",
  "failed",
  "unknown",
] as const;

/**
 * One of the allowlisted side-effect operation statuses.
 *
 * @see {@link SIDE_EFFECT_OPERATION_STATUSES}
 */
export type SideEffectOperationStatus =
  (typeof SIDE_EFFECT_OPERATION_STATUSES)[number];

/**
 * Allowlisted side-effect operation execution phases.
 *
 * Distinguishes side effects that ran inside the request handler from
 * those that ran after the response was sent (e.g., `after()` hook,
 * background job).
 */
export const SIDE_EFFECT_OPERATION_PHASES = [
  "request",
  "post_response",
  "background",
  "unknown",
] as const;

/**
 * One of the allowlisted side-effect operation phases.
 *
 * @see {@link SIDE_EFFECT_OPERATION_PHASES}
 */
export type SideEffectOperationPhase =
  (typeof SIDE_EFFECT_OPERATION_PHASES)[number];
