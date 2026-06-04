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
 * MCP tool responses. New kinds require a coordinated bump across
 * SCHEMA-036 (product), this tuple (SDK), and any downstream consumer
 * that switches on the kind.
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
 * `*Role`; producers normalize key names to lowerCamelCase with one
 * of the four canonical suffixes. Value-shape validators route on
 * the suffix:
 *
 *   - `*Count` → digit-only string (max 16 chars)
 *   - `*Class` / `*Kind` / `*Role` → compact-token string (max 80)
 *
 * Stable-core keys with specialized validators take precedence over
 * the default suffix routing.
 */
export const SIDE_EFFECT_SEMANTIC_FIELD_OPEN_PATTERN =
  /^[a-z][A-Za-z0-9]*(Class|Count|Kind|Role)$/;

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
 * wire. The set is fixed by SCHEMA-036; new reasons require a
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
] as const;

/**
 * One of the allowlisted side-effect omission reasons.
 *
 * @see {@link SIDE_EFFECT_OMISSION_REASONS}
 */
export type SideEffectOmissionReason =
  (typeof SIDE_EFFECT_OMISSION_REASONS)[number];

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
