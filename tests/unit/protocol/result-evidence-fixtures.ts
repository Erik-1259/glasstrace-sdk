/**
 * Shared fixtures for the result-evidence protocol tests.
 *
 * Builders produce *valid* version-1 logical bundles; tests derive
 * invalid cases by spreading a valid bundle and overriding, adding, or
 * deleting individual attributes so each test names exactly the defect
 * it exercises.
 */

import {
  RESULT_EVIDENCE_FAMILY_ATTRIBUTE_KEY,
  RESULT_EVIDENCE_ROWS_TOTAL_ATTRIBUTE_KEY,
  RESULT_EVIDENCE_ROW_CAP_ATTRIBUTE_KEY,
  RESULT_EVIDENCE_ROWS_SELECTED_ATTRIBUTE_KEY,
  RESULT_EVIDENCE_ROWS_EMITTED_ATTRIBUTE_KEY,
  buildResultEvidenceProducerRowMetadataKey,
  buildResultEvidenceRowScalarKey,
} from "../../../packages/protocol/src/index.js";

/** A mutable attribute record under construction. */
export type BundleAttributes = Record<string, unknown>;

/**
 * A valid family-1 (count) bundle: the marker plus flat scalars.
 * Callers override `scalars` to control count and values.
 */
export function familyOneBundle(
  scalars: Record<string, unknown> = { matchedValue: 7 },
): BundleAttributes {
  return flatFamilyBundle(1, scalars);
}

/**
 * A valid family-2 (aggregate) bundle: the marker plus flat scalars.
 */
export function familyTwoBundle(
  scalars: Record<string, unknown> = { sumAmount: 1234.5 },
): BundleAttributes {
  return flatFamilyBundle(2, scalars);
}

function flatFamilyBundle(
  family: 1 | 2,
  scalars: Record<string, unknown>,
): BundleAttributes {
  const bundle: BundleAttributes = {
    [RESULT_EVIDENCE_FAMILY_ATTRIBUTE_KEY]: family,
  };
  for (const [baseKey, value] of Object.entries(scalars)) {
    bundle[`glasstrace.side_effect.scalar.${baseKey}`] = value;
  }
  return bundle;
}

/** One selected row of a family-3 bundle under construction. */
export interface FamilyThreeRow {
  /** Base-key → value scalars emitted for this row. */
  readonly scalars: Record<string, unknown>;
  /** Per-row candidates count; defaults to the scalar count. */
  readonly candidates?: number;
  /** Per-row emitted count; defaults to the scalar count. */
  readonly emitted?: number;
}

/**
 * A valid family-3 (bounded rows) bundle. Derives `rows_selected`,
 * `rows_emitted`, and the contiguous per-row metadata from `rows`
 * unless explicitly overridden, so the default output always passes
 * complete-family validation.
 */
export function familyThreeBundle(options: {
  readonly rows: readonly FamilyThreeRow[];
  readonly rowsTotal?: number;
  readonly rowCap?: number;
  readonly rowsSelected?: number;
  readonly rowsEmitted?: number;
}): BundleAttributes {
  const { rows } = options;
  const rowsSelected = options.rowsSelected ?? rows.length;
  const rowsTotal = options.rowsTotal ?? rows.length;
  const rowCap = options.rowCap ?? 8;
  const rowsEmitted =
    options.rowsEmitted ??
    rows.filter((row) => Object.keys(row.scalars).length > 0).length;

  const bundle: BundleAttributes = {
    [RESULT_EVIDENCE_FAMILY_ATTRIBUTE_KEY]: 3,
    [RESULT_EVIDENCE_ROWS_TOTAL_ATTRIBUTE_KEY]: rowsTotal,
    [RESULT_EVIDENCE_ROW_CAP_ATTRIBUTE_KEY]: rowCap,
    [RESULT_EVIDENCE_ROWS_SELECTED_ATTRIBUTE_KEY]: rowsSelected,
    [RESULT_EVIDENCE_ROWS_EMITTED_ATTRIBUTE_KEY]: rowsEmitted,
  };

  rows.forEach((row, rowIndex) => {
    const scalarEntries = Object.entries(row.scalars);
    const candidatesKey = buildResultEvidenceProducerRowMetadataKey(
      rowIndex,
      "candidates",
    );
    const emittedKey = buildResultEvidenceProducerRowMetadataKey(
      rowIndex,
      "emitted",
    );
    if (candidatesKey === null || emittedKey === null) {
      throw new Error(`fixture row index out of grammar: ${rowIndex}`);
    }
    bundle[candidatesKey] = row.candidates ?? scalarEntries.length;
    bundle[emittedKey] = row.emitted ?? scalarEntries.length;
    for (const [baseKey, value] of scalarEntries) {
      const scalarKey = buildResultEvidenceRowScalarKey(rowIndex, baseKey);
      if (scalarKey === null) {
        throw new Error(`fixture scalar key out of grammar: ${baseKey}`);
      }
      bundle[scalarKey] = value;
    }
  });

  return bundle;
}

/** A shallow copy of `bundle` without `key`. */
export function withoutKey(
  bundle: BundleAttributes,
  key: string,
): BundleAttributes {
  const copy = { ...bundle };
  delete copy[key];
  return copy;
}
