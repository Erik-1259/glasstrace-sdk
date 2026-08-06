/**
 * Provider-neutral result-evidence protocol, wire version 1.
 *
 * Result evidence widens the side-effect scalar channel with bounded
 * facts about what a database operation *returned* — an aggregate
 * count, an aggregation bucket value, or scalars from a capped sample
 * of returned rows — without ever carrying raw payloads, identifiers,
 * timestamps, or row contents beyond the existing scalar admission
 * rules.
 *
 * The protocol is deliberately provider-neutral: no public symbol
 * names an ORM, a model, a field, or a concrete adapter operation.
 * Producers map their private operation recognition onto one of three
 * closed families:
 *
 *   - family `1` — an aggregate count result
 *   - family `2` — an aggregation bucket result
 *   - family `3` — bounded row evidence
 *
 * A family is a *logical bundle*: the family marker, its metadata, and
 * its scalar values are meaningful only together. Attribute transport
 * is best effort — OpenTelemetry `setAttributes` is not transactional —
 * so a receiver must validate completeness and drop the entire marked
 * family when any part is missing, unknown, cross-family, or invalid.
 * A valid-looking prefix of a family must never be retained.
 * {@link validateResultEvidenceCompleteFamily} implements that closed
 * validation so producers, receivers, and tests share one definition
 * of "complete".
 *
 * A marked span claims its entire side-effect scalar channel: every
 * flat scalar on the span is validated as family-1/2 evidence, and any
 * flat scalar invalidates a family-3 bundle. A producer must therefore
 * never co-locate result evidence with ordinary value-fidelity scalars
 * on one span.
 *
 * Ownership is split between the two ends of the wire:
 *
 *   - producer-owned: the family marker, operation cardinality fields
 *     (`rows_total`, `row_cap`, `rows_selected`, `rows_emitted`),
 *     per-row `candidates` / `emitted` metadata, and scalar values;
 *   - receiver-owned: `rows_captured`, per-row `retained` metadata, and
 *     the receiver scalar manifest. Producer helpers cannot build
 *     receiver-owned keys, and a bundle that carries them is invalid.
 *
 * Receiving a structurally valid configuration envelope or bundle does
 * not authenticate a server or a telemetry producer; it is
 * compatibility configuration and evidence shape only.
 */

import { z } from "zod";
import {
  MAX_SIDE_EFFECT_SCALARS_PER_OPERATION,
  SIDE_EFFECT_HASHED_ID_HEX_LENGTH,
  SIDE_EFFECT_HASHED_ID_PREFIX,
  SIDE_EFFECT_SCALAR_KEY_PATTERN,
  SIDE_EFFECT_SCALAR_PREFIX,
  isSideEffectScalarKey,
} from "./side-effect.js";

// --- Wire version and bounds ---

/**
 * Version of the result-evidence wire grammar defined by this module.
 * Present as the `wireVersion` member of the server-injected capability
 * envelope; a consumer that sees any other version must treat both
 * result-evidence capabilities as unavailable.
 */
export const RESULT_EVIDENCE_WIRE_VERSION = 1;

/**
 * Highest row index representable in the row-scalar and row-metadata
 * key grammars (`r0`..`r255`). This is a grammar bound, not a capture
 * bound — producers select far fewer rows (see
 * {@link MAX_RESULT_EVIDENCE_ROWS_PER_OPERATION}).
 */
export const MAX_RESULT_EVIDENCE_ROW_INDEX = 255;

/**
 * Maximum returned-array positions a producer may select for row
 * evidence in one operation (`N`). `row_cap` on a family-3 bundle is
 * valid only in `1..MAX_RESULT_EVIDENCE_ROWS_PER_OPERATION`.
 */
export const MAX_RESULT_EVIDENCE_ROWS_PER_OPERATION = 8;

/**
 * Maximum value of a per-row metadata count (`row.r<n>.candidates` /
 * `row.r<n>.emitted`). A per-row count above this bound invalidates the
 * family. This is a per-row metadata bound; any producer-internal
 * inspection budget that happens to share the number 256 is a separate,
 * private limit, not this export.
 */
export const MAX_RESULT_EVIDENCE_CANDIDATES_PER_ROW = 256;

/**
 * Absolute-value floor at which a `*Value` scalar is considered
 * timestamp-shaped (a plausible epoch-seconds wall-clock reading) and
 * rejected from result evidence. See
 * {@link isResultEvidenceTimestampShapedNumeric}.
 */
export const RESULT_EVIDENCE_TIMESTAMP_VALUE_ABS_MIN = 1_000_000_000;

/**
 * Absolute-value floor at which a `*Ms` scalar is considered
 * timestamp-shaped (a plausible epoch-milliseconds wall-clock reading)
 * and rejected from result evidence. See
 * {@link isResultEvidenceTimestampShapedNumeric}.
 */
export const RESULT_EVIDENCE_TIMESTAMP_MS_ABS_MIN = 1_000_000_000_000;

/**
 * Maximum value of the `rows_total` operation field (uint32).
 * `rows_total` is the snapshotted returned-array length of the
 * application-executed operation — never an unpaginated database
 * total.
 */
const MAX_RESULT_EVIDENCE_ROWS_TOTAL = 0xffff_ffff;

// --- Families ---

/**
 * Closed result-evidence family codes: `1` = count, `2` = aggregate,
 * `3` = bounded rows. Any other value — including numeric strings and
 * non-integers — is not a family.
 */
export const ResultEvidenceFamilySchema = z.literal([1, 2, 3]);

/**
 * One of the closed result-evidence family codes.
 *
 * @see {@link ResultEvidenceFamilySchema}
 */
export type ResultEvidenceFamily = z.infer<typeof ResultEvidenceFamilySchema>;

// --- Operation-level attribute keys ---

/**
 * Attribute-name prefix for every version-1 result-evidence metadata
 * attribute. Row *scalars* deliberately live on the existing
 * side-effect scalar channel (`glasstrace.side_effect.scalar.r<n>.*`),
 * not under this prefix — the prefix carries the family marker and
 * metadata only.
 */
export const RESULT_EVIDENCE_ATTRIBUTE_PREFIX =
  "glasstrace.side_effect.result.v1.";

/**
 * Producer-owned family marker attribute. Value is one of the closed
 * {@link ResultEvidenceFamily} codes. A bundle without this marker is
 * not result evidence; scalars accompanying a missing or invalid
 * marker must not be retained as result evidence.
 */
export const RESULT_EVIDENCE_FAMILY_ATTRIBUTE_KEY =
  "glasstrace.side_effect.result.v1.family";

/**
 * Producer-owned family-3 operation field: the snapshotted
 * returned-array length (uint32) of the application-executed
 * operation. Never an unpaginated database total — for an operation
 * that returned 20 rows, `rows_total` is 20 regardless of how many
 * rows matched in the database.
 */
export const RESULT_EVIDENCE_ROWS_TOTAL_ATTRIBUTE_KEY =
  "glasstrace.side_effect.result.v1.rows_total";

/**
 * Producer-owned family-3 operation field: the producer's row-selection
 * cap for this operation. Valid only in
 * `1..MAX_RESULT_EVIDENCE_ROWS_PER_OPERATION`.
 */
export const RESULT_EVIDENCE_ROW_CAP_ATTRIBUTE_KEY =
  "glasstrace.side_effect.result.v1.row_cap";

/**
 * Producer-owned family-3 operation field: how many returned-array
 * positions the producer selected for observation. Selected rows are
 * contiguous from position 0, so per-row producer metadata exists for
 * exactly `r0..r(rows_selected - 1)`.
 */
export const RESULT_EVIDENCE_ROWS_SELECTED_ATTRIBUTE_KEY =
  "glasstrace.side_effect.result.v1.rows_selected";

/**
 * Producer-owned family-3 operation field: the number of distinct
 * selected rows that contributed at least one emitted scalar. This
 * counts rows, not scalars.
 */
export const RESULT_EVIDENCE_ROWS_EMITTED_ATTRIBUTE_KEY =
  "glasstrace.side_effect.result.v1.rows_emitted";

/**
 * Receiver-owned family-3 field: the number of rows with at least one
 * retained scalar after receiver-side filtering. Producers must never
 * emit this key; a producer bundle carrying it is invalid.
 */
export const RESULT_EVIDENCE_ROWS_CAPTURED_ATTRIBUTE_KEY =
  "glasstrace.side_effect.result.v1.rows_captured";

/**
 * Receiver-owned manifest of the exact stored scalar keys for an
 * admitted family. Producers must never emit this key; a producer
 * bundle carrying it is invalid.
 */
export const RESULT_EVIDENCE_RECEIVER_SCALAR_MANIFEST_ATTRIBUTE_KEY =
  "glasstrace.side_effect.result.v1.receiver.scalar_manifest";

// --- Row grammar shared internals ---

/**
 * Fixed prefix of every per-row metadata attribute
 * (`glasstrace.side_effect.result.v1.row.r<n>.<kind>`). Internal —
 * consumers build and parse row-metadata keys through the exported
 * helpers, which are the grammar's source of truth.
 */
const RESULT_EVIDENCE_ROW_METADATA_KEY_PREFIX =
  "glasstrace.side_effect.result.v1.row.";

/**
 * Canonical decimal row segment: `r0`, or `r` followed by a non-zero
 * digit and up to two more digits (no leading zeros, no sign, no
 * whitespace). Values above 255 match the shape but overflow the
 * grammar and are rejected separately so parsers can report overflow
 * distinctly from a malformed segment.
 */
const ROW_SEGMENT_PATTERN = /^r(0|[1-9][0-9]{0,2})$/;

/**
 * Parse one `r<n>` segment. Returns the row index, `"overflow"` for a
 * canonical index above {@link MAX_RESULT_EVIDENCE_ROW_INDEX}, or
 * `null` when the segment is not a canonical row segment at all.
 */
function parseRowSegment(segment: string): number | "overflow" | null {
  const match = ROW_SEGMENT_PATTERN.exec(segment);
  if (match === null) return null;
  const rowIndex = Number(match[1]);
  if (rowIndex > MAX_RESULT_EVIDENCE_ROW_INDEX) return "overflow";
  return rowIndex;
}

/** True when `rowIndex` is an integer within the row grammar. */
function isValidRowIndex(rowIndex: number): boolean {
  return (
    typeof rowIndex === "number" &&
    Number.isInteger(rowIndex) &&
    rowIndex >= 0 &&
    rowIndex <= MAX_RESULT_EVIDENCE_ROW_INDEX
  );
}

/**
 * Shared split of a row-qualified key remainder into its `r<n>` segment
 * and trailing suffix segment. Both parsers reject the same four
 * remainder-level defects; suffix-specific validation stays with each
 * parser.
 */
type RowSegmentedRemainder =
  | { readonly ok: true; readonly rowIndex: number; readonly suffix: string }
  | {
      readonly ok: false;
      readonly reason:
        | "missing_row_segment"
        | "noncanonical_row_index"
        | "row_index_overflow"
        | "extra_segment";
    };

function splitRowSegmentedRemainder(remainder: string): RowSegmentedRemainder {
  const segments = remainder.split(".");
  if (segments.length === 1) {
    // No dot — the remainder cannot carry both a row segment and a
    // suffix segment.
    return { ok: false, reason: "missing_row_segment" };
  }
  const [rowSegment, ...rest] = segments;
  const parsedIndex = parseRowSegment(rowSegment);
  if (parsedIndex === null) {
    // A row-like shape with non-canonical digits is reported as
    // noncanonical; anything else is simply not a row segment.
    const reason = /^r[0-9]+$/.test(rowSegment)
      ? "noncanonical_row_index"
      : "missing_row_segment";
    return { ok: false, reason };
  }
  if (parsedIndex === "overflow") {
    return { ok: false, reason: "row_index_overflow" };
  }
  if (rest.length > 1) {
    return { ok: false, reason: "extra_segment" };
  }
  return { ok: true, rowIndex: parsedIndex, suffix: rest[0] };
}

// --- Row scalar keys ---

/**
 * Closed failure reasons for {@link parseResultEvidenceRowScalarKey}:
 *
 *   - `wrong_prefix` — the key is not on the side-effect scalar channel
 *   - `missing_row_segment` — the remainder is not of the two-segment
 *     `r<n>.<baseKey>` form (flat scalar keys and keys whose leading
 *     segment is not a row segment parse to this reason)
 *   - `noncanonical_row_index` — a row-like segment with leading zeros
 *     or more than three digits (`r01`, `r0005`, `r1000`)
 *   - `row_index_overflow` — a canonical index above `r255`
 *     (`r256`..`r999`)
 *   - `extra_segment` — more than one `.` after the row segment
 *   - `invalid_base_key` — the base key fails the unchanged scalar-key
 *     grammar or its 80-character cap
 */
export type ResultEvidenceRowScalarKeyParseFailureReason =
  | "wrong_prefix"
  | "missing_row_segment"
  | "noncanonical_row_index"
  | "row_index_overflow"
  | "extra_segment"
  | "invalid_base_key";

/**
 * Closed parse result for {@link parseResultEvidenceRowScalarKey}.
 * Success carries the parsed row index and base key; failure carries
 * one {@link ResultEvidenceRowScalarKeyParseFailureReason}. The parser
 * never throws.
 */
export type ResultEvidenceRowScalarKeyParseResult =
  | { readonly ok: true; readonly rowIndex: number; readonly baseKey: string }
  | {
      readonly ok: false;
      readonly reason: ResultEvidenceRowScalarKeyParseFailureReason;
    };

/**
 * Build a row-scalar attribute key
 * `glasstrace.side_effect.scalar.r<n>.<baseKey>`.
 *
 * Returns `null` — never coercing — when `rowIndex` is not an integer
 * in `0..255` or `baseKey` fails the unchanged scalar-key grammar
 * (camelCase with a magnitude/identity suffix, at most 80 characters).
 * A built key is therefore at most 115 code units: the 30-character
 * channel prefix, at most 5 characters of row segment, and at most 80
 * characters of base key.
 */
export function buildResultEvidenceRowScalarKey(
  rowIndex: number,
  baseKey: string,
): string | null {
  if (!isValidRowIndex(rowIndex)) return null;
  if (typeof baseKey !== "string" || !isSideEffectScalarKey(baseKey)) {
    return null;
  }
  return `${SIDE_EFFECT_SCALAR_PREFIX}r${rowIndex}.${baseKey}`;
}

/**
 * Parse a row-scalar attribute key. The inverse of
 * {@link buildResultEvidenceRowScalarKey}: every built key parses back
 * to its inputs, and every non-conforming key fails closed with a
 * {@link ResultEvidenceRowScalarKeyParseFailureReason}. Never throws,
 * including on non-string input.
 */
export function parseResultEvidenceRowScalarKey(
  attributeKey: string,
): ResultEvidenceRowScalarKeyParseResult {
  if (
    typeof attributeKey !== "string" ||
    !attributeKey.startsWith(SIDE_EFFECT_SCALAR_PREFIX)
  ) {
    return { ok: false, reason: "wrong_prefix" };
  }
  const split = splitRowSegmentedRemainder(
    attributeKey.slice(SIDE_EFFECT_SCALAR_PREFIX.length),
  );
  if (!split.ok) {
    return { ok: false, reason: split.reason };
  }
  if (!isSideEffectScalarKey(split.suffix)) {
    return { ok: false, reason: "invalid_base_key" };
  }
  return { ok: true, rowIndex: split.rowIndex, baseKey: split.suffix };
}

// --- Row metadata keys ---

/**
 * Closed per-row metadata kinds. `candidates` and `emitted` are
 * producer-owned; `retained` is receiver-owned. Builders enforce that
 * split: the producer builder cannot build `retained`, and the
 * receiver builder builds only `retained`.
 */
export const ResultEvidenceRowMetadataKindSchema = z.literal([
  "candidates",
  "emitted",
  "retained",
]);

/**
 * One of the closed per-row metadata kinds.
 *
 * @see {@link ResultEvidenceRowMetadataKindSchema}
 */
export type ResultEvidenceRowMetadataKind = z.infer<
  typeof ResultEvidenceRowMetadataKindSchema
>;

/**
 * Closed failure reasons for {@link parseResultEvidenceRowMetadataKey}:
 *
 *   - `wrong_prefix` — not under the row-metadata prefix
 *   - `missing_row_segment` — the remainder is not of the two-segment
 *     `r<n>.<kind>` form (a bare trailing segment or a non-row leading
 *     segment parses to this reason)
 *   - `noncanonical_row_index` — a row-like segment with leading zeros
 *     or more than three digits (`r01`, `r1000`)
 *   - `row_index_overflow` — a canonical index above `r255`
 *     (`r256`..`r999`)
 *   - `extra_segment` — more than one `.` after the row segment
 *   - `invalid_kind` — the trailing segment is not one of the closed
 *     kinds
 */
export type ResultEvidenceRowMetadataKeyParseFailureReason =
  | "wrong_prefix"
  | "missing_row_segment"
  | "noncanonical_row_index"
  | "row_index_overflow"
  | "extra_segment"
  | "invalid_kind";

/**
 * Closed parse result for {@link parseResultEvidenceRowMetadataKey}.
 * Success carries the row index and metadata kind; failure carries one
 * {@link ResultEvidenceRowMetadataKeyParseFailureReason}. The parser
 * never throws.
 */
export type ResultEvidenceRowMetadataKeyParseResult =
  | {
      readonly ok: true;
      readonly rowIndex: number;
      readonly kind: ResultEvidenceRowMetadataKind;
    }
  | {
      readonly ok: false;
      readonly reason: ResultEvidenceRowMetadataKeyParseFailureReason;
    };

/**
 * Build a producer-owned per-row metadata key
 * `glasstrace.side_effect.result.v1.row.r<n>.<kind>` for the
 * producer-buildable kinds `candidates` and `emitted` only.
 *
 * Returns `null` — never coercing — for an out-of-grammar row index or
 * any other kind, including the receiver-owned `retained` (enforced at
 * runtime, not just in the type signature). A built key is at most 52
 * code units.
 */
export function buildResultEvidenceProducerRowMetadataKey(
  rowIndex: number,
  kind: "candidates" | "emitted",
): string | null {
  if (!isValidRowIndex(rowIndex)) return null;
  if (kind !== "candidates" && kind !== "emitted") return null;
  return `${RESULT_EVIDENCE_ROW_METADATA_KEY_PREFIX}r${rowIndex}.${kind}`;
}

/**
 * Build the receiver-owned per-row metadata key
 * `glasstrace.side_effect.result.v1.row.r<n>.retained`. The receiver
 * builder takes no kind parameter — `retained` is the only
 * receiver-buildable kind. Returns `null` for an out-of-grammar row
 * index.
 */
export function buildResultEvidenceReceiverRowMetadataKey(
  rowIndex: number,
): string | null {
  if (!isValidRowIndex(rowIndex)) return null;
  return `${RESULT_EVIDENCE_ROW_METADATA_KEY_PREFIX}r${rowIndex}.retained`;
}

/**
 * Parse a per-row metadata attribute key. The inverse of the two
 * metadata builders: every built key parses back to its inputs, and
 * every non-conforming key fails closed with a
 * {@link ResultEvidenceRowMetadataKeyParseFailureReason}. Never
 * throws, including on non-string input.
 */
export function parseResultEvidenceRowMetadataKey(
  attributeKey: string,
): ResultEvidenceRowMetadataKeyParseResult {
  if (
    typeof attributeKey !== "string" ||
    !attributeKey.startsWith(RESULT_EVIDENCE_ROW_METADATA_KEY_PREFIX)
  ) {
    return { ok: false, reason: "wrong_prefix" };
  }
  const split = splitRowSegmentedRemainder(
    attributeKey.slice(RESULT_EVIDENCE_ROW_METADATA_KEY_PREFIX.length),
  );
  if (!split.ok) {
    return { ok: false, reason: split.reason };
  }
  const kindResult = ResultEvidenceRowMetadataKindSchema.safeParse(
    split.suffix,
  );
  if (!kindResult.success) {
    return { ok: false, reason: "invalid_kind" };
  }
  return { ok: true, rowIndex: split.rowIndex, kind: kindResult.data };
}

// --- Timestamp-shaped numeric screening ---

/**
 * True when a numeric scalar candidate is timestamp-shaped: a finite
 * value whose absolute magnitude is at or above
 * {@link RESULT_EVIDENCE_TIMESTAMP_MS_ABS_MIN} on a `*Ms` key, or at
 * or above {@link RESULT_EVIDENCE_TIMESTAMP_VALUE_ABS_MIN} on a
 * `*Value` key. Timestamp-shaped values are rejected from result
 * evidence — a wall-clock reading is re-identification risk, not a
 * magnitude.
 *
 * The screen is magnitude-only: fractional values at or above a
 * threshold are timestamp-shaped too, because high-resolution clocks
 * legitimately produce fractional epoch readings and an
 * integer-shape requirement would let them bypass the screen. This
 * matches the SDK's emit-time fidelity screen, which also rejects
 * fractional epoch-scale `*Ms` values.
 *
 * Only `*Ms` and `*Value` keys are screened; other suffixes return
 * `false` regardless of magnitude. Non-numbers and non-finite
 * numbers also return `false` — they are not timestamp-*shaped*,
 * though other admission rules reject them. Never throws.
 */
export function isResultEvidenceTimestampShapedNumeric(
  key: string,
  value: number,
): boolean {
  if (typeof key !== "string") return false;
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  const magnitude = Math.abs(value);
  if (key.endsWith("Ms")) {
    return magnitude >= RESULT_EVIDENCE_TIMESTAMP_MS_ABS_MIN;
  }
  if (key.endsWith("Value")) {
    return magnitude >= RESULT_EVIDENCE_TIMESTAMP_VALUE_ABS_MIN;
  }
  return false;
}

// --- Complete-family validation ---

/**
 * Closed failure reasons for
 * {@link validateResultEvidenceCompleteFamily}. Exactly one reason is
 * reported per invalid bundle, and the choice is deterministic — it
 * never depends on attribute enumeration order. Validation runs in
 * fixed phases: record readability, family marker, key grammar and
 * ownership (`receiver_owned_key`, then `unknown_result_key`, then
 * `invalid_scalar_key`, each judged across every key), family shape,
 * scalar values, then cross-field consistency. The first phase with a
 * defect reports its highest-priority reason.
 */
export type ResultEvidenceCompleteFamilyValidationFailureReason =
  | "unreadable_attributes"
  | "missing_family_marker"
  | "invalid_family_marker"
  | "receiver_owned_key"
  | "unknown_result_key"
  | "cross_family_key"
  | "missing_operation_field"
  | "invalid_operation_field"
  | "noncontiguous_row_metadata"
  | "invalid_row_metadata_value"
  | "row_scalar_out_of_range"
  | "inconsistent_cardinality"
  | "no_eligible_scalar"
  | "scalar_count_exceeded"
  | "invalid_scalar_key"
  | "invalid_scalar_value"
  | "family_forbidden_suffix";

/**
 * Closed result of {@link validateResultEvidenceCompleteFamily}.
 * Success reports the family and its scalar count, plus the four
 * operation cardinality fields for family 3. Failure carries one
 * {@link ResultEvidenceCompleteFamilyValidationFailureReason}.
 */
export type ResultEvidenceCompleteFamilyValidationResult =
  | {
      readonly ok: true;
      readonly family: 1 | 2;
      readonly scalarCount: number;
    }
  | {
      readonly ok: true;
      readonly family: 3;
      readonly scalarCount: number;
      readonly rowsTotal: number;
      readonly rowCap: number;
      readonly rowsSelected: number;
      readonly rowsEmitted: number;
    }
  | {
      readonly ok: false;
      readonly reason: ResultEvidenceCompleteFamilyValidationFailureReason;
    };

/** True for a nonnegative integer no larger than `max`. */
function isBoundedCount(value: unknown, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= max
  );
}

/**
 * The numeric admission shared by every numeric scalar suffix: a
 * finite native number that is not an unsafe integer and not
 * timestamp-shaped for its key. Non-integers are admitted when finite
 * (a ratio is legitimately fractional) unless the magnitude-only
 * timestamp screen rejects them on a `*Ms` / `*Value` key;
 * integer-shaped values beyond `Number.MAX_SAFE_INTEGER` are rejected
 * because their exact magnitude is no longer representable.
 */
function isAdmissibleNumericScalar(baseKey: string, value: unknown): boolean {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) return false;
  if (isResultEvidenceTimestampShapedNumeric(baseKey, value)) return false;
  return true;
}

/**
 * True for the exact hashed-identifier token shape `gthid_<hex32>`,
 * derived from the exported prefix and digest-length constants so the
 * wire shape has one source of truth in this package.
 */
function isHashedIdToken(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (!value.startsWith(SIDE_EFFECT_HASHED_ID_PREFIX)) return false;
  const digest = value.slice(SIDE_EFFECT_HASHED_ID_PREFIX.length);
  return (
    digest.length === SIDE_EFFECT_HASHED_ID_HEX_LENGTH &&
    /^[0-9a-f]+$/.test(digest)
  );
}

/**
 * Suffix family of a base key, read from the scalar-key pattern's
 * suffix capture group. Callers pass only keys that already satisfy
 * {@link SIDE_EFFECT_SCALAR_KEY_PATTERN}; a non-matching key maps to
 * the empty suffix, which both value loops reject explicitly so the
 * backstop fails closed.
 */
function scalarSuffix(baseKey: string): string {
  const match = SIDE_EFFECT_SCALAR_KEY_PATTERN.exec(baseKey);
  return match === null ? "" : match[1];
}

/**
 * A per-row metadata accumulator with no prototype, so a polluted
 * `Object.prototype` cannot make an absent `candidates` / `emitted`
 * entry appear present. This validator is a fail-closed boundary and
 * must keep failing closed even in a compromised process.
 */
function emptyRowMetadataEntry(): { candidates?: unknown; emitted?: unknown } {
  return Object.create(null) as { candidates?: unknown; emitted?: unknown };
}

/**
 * Validate one candidate result-evidence logical bundle against the
 * closed version-1 family shapes.
 *
 * `attributes` is the operation's side-effect scalar channel
 * (`glasstrace.side_effect.scalar.*`) and result-evidence metadata
 * (`glasstrace.side_effect.result.v1.*`) attributes. Keys outside
 * those two namespaces are ignored, so a caller may pass a span's full
 * attribute record; keys *inside* them are validated against the
 * closed grammar with no exceptions. A marked span therefore claims
 * its entire scalar channel: every flat scalar is family-1/2 evidence,
 * and any flat scalar invalidates family 3 — producers must not
 * co-locate result evidence with ordinary value-fidelity scalars on
 * one span.
 *
 * The closed shapes:
 *
 *   - families `1` and `2` carry the matching marker and 1..16 flat
 *     scalar attributes with numeric suffixes (`*Ms`, `*Amount`,
 *     `*Bytes`, `*Ratio`, `*Value`); `*Flag` and `*Id` are
 *     family-3-only, and no operation-row or per-row key may appear;
 *   - family `3` carries the marker, all four operation fields
 *     (`rows_total` uint32, `row_cap` in 1..8, `rows_selected`,
 *     `rows_emitted`), contiguous `candidates`/`emitted` metadata for
 *     exactly rows `r0..r(rows_selected-1)`, and 1..16 row scalars on
 *     selected rows only — never a flat scalar.
 *
 * Cross-field consistency is part of completeness: `rows_selected`
 * must fit `1..row_cap` and not exceed `rows_total`; each row's
 * `emitted` must not exceed its `candidates`; the number of scalars
 * present for a row must equal that row's `emitted`; and
 * `rows_emitted` must equal the number of selected rows with at least
 * one scalar. Cardinality metadata never stands alone: with no
 * surviving row scalar the whole family is invalid rather than
 * reporting counts without evidence.
 *
 * Every defect — a receiver-owned key in a producer bundle, an unknown
 * or cross-family key, a 17th scalar, a missing marker, a
 * family/shape mismatch, or an incomplete family — invalidates the
 * entire marked family. Completeness here is attribute-shape
 * completeness only: a receiver additionally verifies span-operation /
 * family agreement and its current capability and kill state, which
 * are outside this validator's input.
 *
 * Never throws: a record whose values cannot be read (a throwing
 * getter, a revoked proxy) fails closed as `unreadable_attributes`.
 */
export function validateResultEvidenceCompleteFamily(
  attributes: Readonly<Record<string, unknown>>,
): ResultEvidenceCompleteFamilyValidationResult {
  try {
    return validateBundle(attributes);
  } catch {
    return { ok: false, reason: "unreadable_attributes" };
  }
}

function validateBundle(
  attributes: Readonly<Record<string, unknown>>,
): ResultEvidenceCompleteFamilyValidationResult {
  const fail = (
    reason: ResultEvidenceCompleteFamilyValidationFailureReason,
  ): ResultEvidenceCompleteFamilyValidationResult => ({ ok: false, reason });

  if (attributes === null || typeof attributes !== "object") {
    return fail("missing_family_marker");
  }

  const keys = Object.keys(attributes);

  if (!keys.includes(RESULT_EVIDENCE_FAMILY_ATTRIBUTE_KEY)) {
    return fail("missing_family_marker");
  }
  const markerResult = ResultEvidenceFamilySchema.safeParse(
    attributes[RESULT_EVIDENCE_FAMILY_ATTRIBUTE_KEY],
  );
  if (!markerResult.success) {
    return fail("invalid_family_marker");
  }
  const family = markerResult.data;

  // Key grammar and ownership. Every key is classified before any
  // defect is reported, then defect classes are reported in fixed
  // priority order, so the reported reason never depends on attribute
  // enumeration order.
  let sawReceiverOwnedKey = false;
  let sawUnknownResultKey = false;
  let sawInvalidScalarKey = false;
  const operationFields = new Map<string, unknown>();
  const rowMetadata = new Map<
    number,
    { candidates?: unknown; emitted?: unknown }
  >();
  const flatScalars = new Map<string, unknown>();
  const rowScalars = new Map<number, Map<string, unknown>>();

  for (const key of keys) {
    if (key === RESULT_EVIDENCE_FAMILY_ATTRIBUTE_KEY) continue;
    if (
      key === RESULT_EVIDENCE_ROWS_CAPTURED_ATTRIBUTE_KEY ||
      key === RESULT_EVIDENCE_RECEIVER_SCALAR_MANIFEST_ATTRIBUTE_KEY
    ) {
      sawReceiverOwnedKey = true;
      continue;
    }
    if (key.startsWith(RESULT_EVIDENCE_ROW_METADATA_KEY_PREFIX)) {
      const parsed = parseResultEvidenceRowMetadataKey(key);
      if (!parsed.ok) {
        sawUnknownResultKey = true;
        continue;
      }
      if (parsed.kind === "retained") {
        sawReceiverOwnedKey = true;
        continue;
      }
      const entry = rowMetadata.get(parsed.rowIndex) ?? emptyRowMetadataEntry();
      entry[parsed.kind] = attributes[key];
      rowMetadata.set(parsed.rowIndex, entry);
      continue;
    }
    if (key.startsWith(RESULT_EVIDENCE_ATTRIBUTE_PREFIX)) {
      if (
        key === RESULT_EVIDENCE_ROWS_TOTAL_ATTRIBUTE_KEY ||
        key === RESULT_EVIDENCE_ROW_CAP_ATTRIBUTE_KEY ||
        key === RESULT_EVIDENCE_ROWS_SELECTED_ATTRIBUTE_KEY ||
        key === RESULT_EVIDENCE_ROWS_EMITTED_ATTRIBUTE_KEY
      ) {
        operationFields.set(key, attributes[key]);
        continue;
      }
      sawUnknownResultKey = true;
      continue;
    }
    if (key.startsWith(SIDE_EFFECT_SCALAR_PREFIX)) {
      const parsed = parseResultEvidenceRowScalarKey(key);
      if (parsed.ok) {
        const rowMap = rowScalars.get(parsed.rowIndex) ?? new Map();
        rowMap.set(parsed.baseKey, attributes[key]);
        rowScalars.set(parsed.rowIndex, rowMap);
        continue;
      }
      if (parsed.reason === "missing_row_segment") {
        const baseKey = key.slice(SIDE_EFFECT_SCALAR_PREFIX.length);
        if (!isSideEffectScalarKey(baseKey)) {
          sawInvalidScalarKey = true;
          continue;
        }
        flatScalars.set(baseKey, attributes[key]);
        continue;
      }
      sawInvalidScalarKey = true;
      continue;
    }
    // Keys outside the scalar and result-evidence namespaces are not
    // part of the bundle.
  }

  if (sawReceiverOwnedKey) return fail("receiver_owned_key");
  if (sawUnknownResultKey) return fail("unknown_result_key");
  if (sawInvalidScalarKey) return fail("invalid_scalar_key");

  if (family === 1 || family === 2) {
    if (
      operationFields.size > 0 ||
      rowMetadata.size > 0 ||
      rowScalars.size > 0
    ) {
      return fail("cross_family_key");
    }
    if (flatScalars.size === 0) return fail("no_eligible_scalar");
    if (flatScalars.size > MAX_SIDE_EFFECT_SCALARS_PER_OPERATION) {
      return fail("scalar_count_exceeded");
    }
    // Value defects are judged across every scalar and reported by
    // fixed class priority: forbidden suffix before invalid value.
    let sawForbiddenSuffix = false;
    let sawInvalidValue = false;
    for (const [baseKey, value] of flatScalars) {
      const suffix = scalarSuffix(baseKey);
      if (suffix === "Flag" || suffix === "Id") {
        sawForbiddenSuffix = true;
        continue;
      }
      if (suffix === "" || !isAdmissibleNumericScalar(baseKey, value)) {
        sawInvalidValue = true;
      }
    }
    if (sawForbiddenSuffix) return fail("family_forbidden_suffix");
    if (sawInvalidValue) return fail("invalid_scalar_value");
    return { ok: true, family, scalarCount: flatScalars.size };
  }

  // Family 3.
  if (flatScalars.size > 0) return fail("cross_family_key");
  for (const attributeKey of [
    RESULT_EVIDENCE_ROWS_TOTAL_ATTRIBUTE_KEY,
    RESULT_EVIDENCE_ROW_CAP_ATTRIBUTE_KEY,
    RESULT_EVIDENCE_ROWS_SELECTED_ATTRIBUTE_KEY,
    RESULT_EVIDENCE_ROWS_EMITTED_ATTRIBUTE_KEY,
  ]) {
    if (!operationFields.has(attributeKey)) {
      return fail("missing_operation_field");
    }
  }
  const rowsTotal = operationFields.get(
    RESULT_EVIDENCE_ROWS_TOTAL_ATTRIBUTE_KEY,
  );
  const rowCap = operationFields.get(RESULT_EVIDENCE_ROW_CAP_ATTRIBUTE_KEY);
  const rowsSelected = operationFields.get(
    RESULT_EVIDENCE_ROWS_SELECTED_ATTRIBUTE_KEY,
  );
  const rowsEmitted = operationFields.get(
    RESULT_EVIDENCE_ROWS_EMITTED_ATTRIBUTE_KEY,
  );
  if (!isBoundedCount(rowsTotal, MAX_RESULT_EVIDENCE_ROWS_TOTAL)) {
    return fail("invalid_operation_field");
  }
  if (
    !isBoundedCount(rowCap, MAX_RESULT_EVIDENCE_ROWS_PER_OPERATION) ||
    rowCap < 1
  ) {
    return fail("invalid_operation_field");
  }
  if (
    !isBoundedCount(rowsSelected, MAX_RESULT_EVIDENCE_ROWS_PER_OPERATION) ||
    rowsSelected < 1 ||
    rowsSelected > rowCap ||
    rowsSelected > rowsTotal
  ) {
    return fail("invalid_operation_field");
  }
  if (!isBoundedCount(rowsEmitted, MAX_RESULT_EVIDENCE_ROWS_PER_OPERATION)) {
    return fail("invalid_operation_field");
  }

  // Contiguous producer metadata for exactly the selected rows. The
  // presence checks compare against `undefined` on prototype-free
  // entries, so absence stays absence under a polluted process.
  for (let rowIndex = 0; rowIndex < rowsSelected; rowIndex += 1) {
    const entry = rowMetadata.get(rowIndex);
    if (
      entry === undefined ||
      entry.candidates === undefined ||
      entry.emitted === undefined
    ) {
      return fail("noncontiguous_row_metadata");
    }
  }
  if (rowMetadata.size !== rowsSelected) {
    return fail("noncontiguous_row_metadata");
  }
  for (const [, entry] of rowMetadata) {
    const { candidates, emitted } = entry;
    if (
      !isBoundedCount(candidates, MAX_RESULT_EVIDENCE_CANDIDATES_PER_ROW) ||
      !isBoundedCount(emitted, MAX_RESULT_EVIDENCE_CANDIDATES_PER_ROW)
    ) {
      return fail("invalid_row_metadata_value");
    }
    if (emitted > candidates) {
      return fail("invalid_row_metadata_value");
    }
  }

  // Row scalars: on selected rows only, bounded by the shared
  // operation ceiling, with per-suffix value admission.
  let scalarCount = 0;
  for (const [rowIndex, rowMap] of rowScalars) {
    if (rowIndex >= rowsSelected) return fail("row_scalar_out_of_range");
    scalarCount += rowMap.size;
  }
  if (scalarCount === 0) return fail("no_eligible_scalar");
  if (scalarCount > MAX_SIDE_EFFECT_SCALARS_PER_OPERATION) {
    return fail("scalar_count_exceeded");
  }
  let sawInvalidRowValue = false;
  for (const [, rowMap] of rowScalars) {
    for (const [baseKey, value] of rowMap) {
      const suffix = scalarSuffix(baseKey);
      if (suffix === "Flag") {
        if (typeof value !== "boolean") sawInvalidRowValue = true;
        continue;
      }
      if (suffix === "Id") {
        if (!isHashedIdToken(value)) sawInvalidRowValue = true;
        continue;
      }
      if (suffix === "" || !isAdmissibleNumericScalar(baseKey, value)) {
        sawInvalidRowValue = true;
      }
    }
  }
  if (sawInvalidRowValue) return fail("invalid_scalar_value");

  // Cardinality metadata must agree with the scalars actually present:
  // per-row emitted equals that row's scalar count, and rows_emitted
  // equals the number of selected rows with at least one scalar.
  let rowsWithScalars = 0;
  for (let rowIndex = 0; rowIndex < rowsSelected; rowIndex += 1) {
    const entry = rowMetadata.get(rowIndex);
    const presentScalars = rowScalars.get(rowIndex)?.size ?? 0;
    if (entry === undefined || entry.emitted !== presentScalars) {
      return fail("inconsistent_cardinality");
    }
    if (presentScalars > 0) rowsWithScalars += 1;
  }
  if (rowsEmitted !== rowsWithScalars) {
    return fail("inconsistent_cardinality");
  }

  return {
    ok: true,
    family,
    scalarCount,
    rowsTotal,
    rowCap,
    rowsSelected,
    rowsEmitted,
  };
}
