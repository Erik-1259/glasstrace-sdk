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
 * Allowlisted semantic field keys for `recordSideEffect()` evidence.
 *
 * Only fields named here may be attached to a side-effect operation
 * summary. Any other key is silently dropped at the SDK boundary and
 * counted under the `unsupported_key` omission reason.
 */
export const SIDE_EFFECT_SEMANTIC_FIELD_KEYS = [
  "templateKey",
  "providerOperation",
  "role",
  "locale",
  "timezone",
  "status",
  "phase",
  "recipientClass",
  "participantCount",
  "activeParticipantCount",
] as const;

/**
 * One of the allowlisted side-effect semantic field keys.
 *
 * @see {@link SIDE_EFFECT_SEMANTIC_FIELD_KEYS}
 */
export type SideEffectSemanticFieldKey =
  (typeof SIDE_EFFECT_SEMANTIC_FIELD_KEYS)[number];

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
