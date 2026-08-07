/**
 * Protocol-level tests for the provider-neutral result-evidence wire
 * grammar (version 1): family codes, bounds, attribute-key constants,
 * row-scalar and row-metadata key builders/parsers, the
 * timestamp-shaped numeric screen, and complete-family validation.
 *
 * The grammar strings and bounds pinned here are a wire contract
 * shared with the receiving backend; a change that fails one of these
 * pins is a cross-repo wire change, not a refactor.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  RESULT_EVIDENCE_WIRE_VERSION,
  MAX_RESULT_EVIDENCE_ROW_INDEX,
  MAX_RESULT_EVIDENCE_ROWS_PER_OPERATION,
  MAX_RESULT_EVIDENCE_CANDIDATES_PER_ROW,
  RESULT_EVIDENCE_TIMESTAMP_VALUE_ABS_MIN,
  RESULT_EVIDENCE_TIMESTAMP_MS_ABS_MIN,
  ResultEvidenceFamilySchema,
  type ResultEvidenceFamily,
  RESULT_EVIDENCE_ATTRIBUTE_PREFIX,
  RESULT_EVIDENCE_FAMILY_ATTRIBUTE_KEY,
  RESULT_EVIDENCE_ROWS_TOTAL_ATTRIBUTE_KEY,
  RESULT_EVIDENCE_ROW_CAP_ATTRIBUTE_KEY,
  RESULT_EVIDENCE_ROWS_SELECTED_ATTRIBUTE_KEY,
  RESULT_EVIDENCE_ROWS_EMITTED_ATTRIBUTE_KEY,
  RESULT_EVIDENCE_ROWS_CAPTURED_ATTRIBUTE_KEY,
  RESULT_EVIDENCE_RECEIVER_SCALAR_MANIFEST_ATTRIBUTE_KEY,
  buildResultEvidenceRowScalarKey,
  parseResultEvidenceRowScalarKey,
  ResultEvidenceRowMetadataKindSchema,
  type ResultEvidenceRowMetadataKind,
  buildResultEvidenceProducerRowMetadataKey,
  buildResultEvidenceReceiverRowMetadataKey,
  parseResultEvidenceRowMetadataKey,
  isResultEvidenceTimestampShapedNumeric,
  validateResultEvidenceCompleteFamily,
  SIDE_EFFECT_SCALAR_PREFIX,
  MAX_SIDE_EFFECT_SCALARS_PER_OPERATION,
} from "../../../packages/protocol/src/index.js";
import {
  familyOneBundle,
  familyTwoBundle,
  familyThreeBundle,
  withoutKey,
} from "./result-evidence-fixtures.js";

const HEX32 = "0123456789abcdef0123456789abcdef";

describe("result-evidence bounds and wire version", () => {
  it("pins the wire version and program bounds", () => {
    expect(RESULT_EVIDENCE_WIRE_VERSION).toBe(1);
    expect(MAX_RESULT_EVIDENCE_ROW_INDEX).toBe(255);
    expect(MAX_RESULT_EVIDENCE_ROWS_PER_OPERATION).toBe(8);
    expect(MAX_RESULT_EVIDENCE_CANDIDATES_PER_ROW).toBe(256);
    expect(RESULT_EVIDENCE_TIMESTAMP_VALUE_ABS_MIN).toBe(1_000_000_000);
    expect(RESULT_EVIDENCE_TIMESTAMP_MS_ABS_MIN).toBe(1_000_000_000_000);
  });
});

describe("result-evidence attribute-key constants", () => {
  it("pins each operation-level wire string with its complete prefix", () => {
    expect(RESULT_EVIDENCE_ATTRIBUTE_PREFIX).toBe(
      "glasstrace.side_effect.result.v1.",
    );
    expect(RESULT_EVIDENCE_FAMILY_ATTRIBUTE_KEY).toBe(
      "glasstrace.side_effect.result.v1.family",
    );
    expect(RESULT_EVIDENCE_ROWS_TOTAL_ATTRIBUTE_KEY).toBe(
      "glasstrace.side_effect.result.v1.rows_total",
    );
    expect(RESULT_EVIDENCE_ROW_CAP_ATTRIBUTE_KEY).toBe(
      "glasstrace.side_effect.result.v1.row_cap",
    );
    expect(RESULT_EVIDENCE_ROWS_SELECTED_ATTRIBUTE_KEY).toBe(
      "glasstrace.side_effect.result.v1.rows_selected",
    );
    expect(RESULT_EVIDENCE_ROWS_EMITTED_ATTRIBUTE_KEY).toBe(
      "glasstrace.side_effect.result.v1.rows_emitted",
    );
    expect(RESULT_EVIDENCE_ROWS_CAPTURED_ATTRIBUTE_KEY).toBe(
      "glasstrace.side_effect.result.v1.rows_captured",
    );
    expect(RESULT_EVIDENCE_RECEIVER_SCALAR_MANIFEST_ATTRIBUTE_KEY).toBe(
      "glasstrace.side_effect.result.v1.receiver.scalar_manifest",
    );
  });

  it("every operation-level key starts with the exported prefix", () => {
    for (const key of [
      RESULT_EVIDENCE_FAMILY_ATTRIBUTE_KEY,
      RESULT_EVIDENCE_ROWS_TOTAL_ATTRIBUTE_KEY,
      RESULT_EVIDENCE_ROW_CAP_ATTRIBUTE_KEY,
      RESULT_EVIDENCE_ROWS_SELECTED_ATTRIBUTE_KEY,
      RESULT_EVIDENCE_ROWS_EMITTED_ATTRIBUTE_KEY,
      RESULT_EVIDENCE_ROWS_CAPTURED_ATTRIBUTE_KEY,
      RESULT_EVIDENCE_RECEIVER_SCALAR_MANIFEST_ATTRIBUTE_KEY,
    ]) {
      expect(key.startsWith(RESULT_EVIDENCE_ATTRIBUTE_PREFIX)).toBe(true);
    }
  });
});

describe("ResultEvidenceFamilySchema", () => {
  it("accepts exactly the closed family codes 1, 2, 3", () => {
    for (const family of [1, 2, 3]) {
      expect(ResultEvidenceFamilySchema.safeParse(family).success).toBe(true);
    }
  });

  it("rejects non-family values including numeric strings and non-integers", () => {
    for (const value of [0, 4, -1, 1.5, "1", "3", true, null, undefined, [1]]) {
      expect(ResultEvidenceFamilySchema.safeParse(value).success).toBe(false);
    }
  });

  it("derives a literal-type union", () => {
    const count: ResultEvidenceFamily = 1;
    const aggregate: ResultEvidenceFamily = 2;
    const boundedRows: ResultEvidenceFamily = 3;
    expect([count, aggregate, boundedRows]).toEqual([1, 2, 3]);
  });
});

describe("buildResultEvidenceRowScalarKey", () => {
  it("builds canonical keys at both row-index boundaries", () => {
    expect(buildResultEvidenceRowScalarKey(0, "elapsedMs")).toBe(
      "glasstrace.side_effect.scalar.r0.elapsedMs",
    );
    expect(buildResultEvidenceRowScalarKey(255, "totalAmount")).toBe(
      "glasstrace.side_effect.scalar.r255.totalAmount",
    );
  });

  it("caps the built key at 115 code units with an 80-character base key", () => {
    const baseKey = `${"a".repeat(78)}Ms`;
    expect(baseKey.length).toBe(80);
    const built = buildResultEvidenceRowScalarKey(255, baseKey);
    expect(built).not.toBeNull();
    expect((built as string).length).toBe(115);
  });

  it("returns null for out-of-grammar row indices without coercing", () => {
    for (const rowIndex of [-1, 256, 0.5, 1.0000001, NaN, Infinity]) {
      expect(buildResultEvidenceRowScalarKey(rowIndex, "elapsedMs")).toBeNull();
    }
  });

  it("returns null for invalid base keys", () => {
    for (const baseKey of [
      "",
      "Capitalized",
      "noSuffix",
      "participantCount", // Count is not a scalar suffix
      "snake_caseMs", // underscore fails the scalar pattern
      "withDotMs.x",
      `${"a".repeat(79)}Ms`, // 81 chars — over the shared cap
    ]) {
      expect(buildResultEvidenceRowScalarKey(0, baseKey)).toBeNull();
    }
  });
});

describe("parseResultEvidenceRowScalarKey", () => {
  it("round-trips every built key", () => {
    for (const [rowIndex, baseKey] of [
      [0, "elapsedMs"],
      [9, "hitRatio"],
      [10, "payloadBytes"],
      [99, "scoreValue"],
      [100, "sumAmount"],
      [255, "activeFlag"],
    ] as const) {
      const built = buildResultEvidenceRowScalarKey(rowIndex, baseKey);
      expect(built).not.toBeNull();
      expect(parseResultEvidenceRowScalarKey(built as string)).toEqual({
        ok: true,
        rowIndex,
        baseKey,
      });
    }
  });

  it("fails closed with wrong_prefix off the scalar channel", () => {
    for (const key of [
      "glasstrace.side_effect.field.templateKey",
      "glasstrace.side_effect.result.v1.family",
      "elapsedMs",
      "",
    ]) {
      expect(parseResultEvidenceRowScalarKey(key)).toEqual({
        ok: false,
        reason: "wrong_prefix",
      });
    }
  });

  it("reports flat scalar keys as missing_row_segment", () => {
    expect(
      parseResultEvidenceRowScalarKey(`${SIDE_EFFECT_SCALAR_PREFIX}elapsedMs`),
    ).toEqual({ ok: false, reason: "missing_row_segment" });
    // A non-row leading segment is also not a row key.
    expect(
      parseResultEvidenceRowScalarKey(`${SIDE_EFFECT_SCALAR_PREFIX}x5.elapsedMs`),
    ).toEqual({ ok: false, reason: "missing_row_segment" });
  });

  it("rejects noncanonical row indices", () => {
    for (const segment of ["r01", "r00", "r007", "r0123"]) {
      expect(
        parseResultEvidenceRowScalarKey(
          `${SIDE_EFFECT_SCALAR_PREFIX}${segment}.elapsedMs`,
        ),
      ).toEqual({ ok: false, reason: "noncanonical_row_index" });
    }
  });

  it("rejects canonical indices above r255 as overflow", () => {
    for (const segment of ["r256", "r300", "r999"]) {
      expect(
        parseResultEvidenceRowScalarKey(
          `${SIDE_EFFECT_SCALAR_PREFIX}${segment}.elapsedMs`,
        ),
      ).toEqual({ ok: false, reason: "row_index_overflow" });
    }
    // Four digits no longer match the canonical shape at all.
    expect(
      parseResultEvidenceRowScalarKey(
        `${SIDE_EFFECT_SCALAR_PREFIX}r1000.elapsedMs`,
      ),
    ).toEqual({ ok: false, reason: "noncanonical_row_index" });
  });

  it("rejects extra segments, including empty middle segments", () => {
    for (const remainder of ["r1.elapsed.Ms", "r1..elapsedMs"]) {
      expect(
        parseResultEvidenceRowScalarKey(
          `${SIDE_EFFECT_SCALAR_PREFIX}${remainder}`,
        ),
      ).toEqual({ ok: false, reason: "extra_segment" });
    }
  });

  it("rejects invalid base keys", () => {
    for (const baseKey of ["", "Capitalized", "participantCount", `${"a".repeat(79)}Ms`]) {
      expect(
        parseResultEvidenceRowScalarKey(
          `${SIDE_EFFECT_SCALAR_PREFIX}r1.${baseKey}`,
        ),
      ).toEqual({ ok: false, reason: "invalid_base_key" });
    }
  });
});

describe("row metadata kinds and builders", () => {
  it("pins the closed kind set", () => {
    for (const kind of ["candidates", "emitted", "retained"]) {
      expect(ResultEvidenceRowMetadataKindSchema.safeParse(kind).success).toBe(
        true,
      );
    }
    for (const value of ["captured", "Candidates", "", 1, null]) {
      expect(ResultEvidenceRowMetadataKindSchema.safeParse(value).success).toBe(
        false,
      );
    }
    const sample: ResultEvidenceRowMetadataKind = "candidates";
    expect(sample).toBe("candidates");
  });

  it("builds producer keys for candidates and emitted only", () => {
    expect(buildResultEvidenceProducerRowMetadataKey(0, "candidates")).toBe(
      "glasstrace.side_effect.result.v1.row.r0.candidates",
    );
    expect(buildResultEvidenceProducerRowMetadataKey(255, "emitted")).toBe(
      "glasstrace.side_effect.result.v1.row.r255.emitted",
    );
    // The receiver-owned kind is rejected at runtime even when the
    // compile-time signature is bypassed.
    expect(
      buildResultEvidenceProducerRowMetadataKey(
        0,
        "retained" as unknown as "candidates",
      ),
    ).toBeNull();
  });

  it("builds the receiver retained key only", () => {
    expect(buildResultEvidenceReceiverRowMetadataKey(0)).toBe(
      "glasstrace.side_effect.result.v1.row.r0.retained",
    );
    expect(buildResultEvidenceReceiverRowMetadataKey(255)).toBe(
      "glasstrace.side_effect.result.v1.row.r255.retained",
    );
  });

  it("returns null for out-of-grammar row indices", () => {
    for (const rowIndex of [-1, 256, 0.5, NaN, Infinity]) {
      expect(
        buildResultEvidenceProducerRowMetadataKey(rowIndex, "candidates"),
      ).toBeNull();
      expect(buildResultEvidenceReceiverRowMetadataKey(rowIndex)).toBeNull();
    }
  });

  it("caps every metadata key at 52 code units", () => {
    const longest = buildResultEvidenceProducerRowMetadataKey(
      255,
      "candidates",
    );
    expect(longest).not.toBeNull();
    expect((longest as string).length).toBe(52);
    const retained = buildResultEvidenceReceiverRowMetadataKey(255);
    expect((retained as string).length).toBeLessThanOrEqual(52);
  });
});

describe("parseResultEvidenceRowMetadataKey", () => {
  it("round-trips built producer and receiver keys", () => {
    const producerKey = buildResultEvidenceProducerRowMetadataKey(
      42,
      "emitted",
    );
    expect(parseResultEvidenceRowMetadataKey(producerKey as string)).toEqual({
      ok: true,
      rowIndex: 42,
      kind: "emitted",
    });
    const receiverKey = buildResultEvidenceReceiverRowMetadataKey(7);
    expect(parseResultEvidenceRowMetadataKey(receiverKey as string)).toEqual({
      ok: true,
      rowIndex: 7,
      kind: "retained",
    });
  });

  it("fails closed on each grammar violation", () => {
    const prefix = "glasstrace.side_effect.result.v1.row.";
    expect(
      parseResultEvidenceRowMetadataKey(
        "glasstrace.side_effect.scalar.r1.candidates",
      ),
    ).toEqual({ ok: false, reason: "wrong_prefix" });
    expect(parseResultEvidenceRowMetadataKey(`${prefix}candidates`)).toEqual({
      ok: false,
      reason: "missing_row_segment",
    });
    expect(parseResultEvidenceRowMetadataKey(`${prefix}r01.candidates`)).toEqual(
      { ok: false, reason: "noncanonical_row_index" },
    );
    expect(
      parseResultEvidenceRowMetadataKey(`${prefix}r256.candidates`),
    ).toEqual({ ok: false, reason: "row_index_overflow" });
    expect(
      parseResultEvidenceRowMetadataKey(`${prefix}r1.candidates.extra`),
    ).toEqual({ ok: false, reason: "extra_segment" });
    expect(
      parseResultEvidenceRowMetadataKey(`${prefix}r1..candidates`),
    ).toEqual({ ok: false, reason: "extra_segment" });
    expect(parseResultEvidenceRowMetadataKey(`${prefix}r1.captured`)).toEqual({
      ok: false,
      reason: "invalid_kind",
    });
  });
});

describe("isResultEvidenceTimestampShapedNumeric", () => {
  it("screens *Ms values at the millisecond threshold", () => {
    expect(
      isResultEvidenceTimestampShapedNumeric("elapsedMs", 1_000_000_000_000),
    ).toBe(true);
    expect(
      isResultEvidenceTimestampShapedNumeric("elapsedMs", 999_999_999_999),
    ).toBe(false);
    // Absolute value: a negated epoch is still timestamp-shaped.
    expect(
      isResultEvidenceTimestampShapedNumeric("elapsedMs", -1_000_000_000_000),
    ).toBe(true);
  });

  it("screens *Value values at the seconds threshold", () => {
    expect(
      isResultEvidenceTimestampShapedNumeric("scoreValue", 1_000_000_000),
    ).toBe(true);
    expect(
      isResultEvidenceTimestampShapedNumeric("scoreValue", 999_999_999),
    ).toBe(false);
    expect(
      isResultEvidenceTimestampShapedNumeric("scoreValue", -1_000_000_000),
    ).toBe(true);
  });

  it("only *Ms and *Value keys are screened", () => {
    for (const key of ["payloadBytes", "totalAmount", "hitRatio", "ownerId"]) {
      expect(
        isResultEvidenceTimestampShapedNumeric(key, 9_000_000_000_000_000),
      ).toBe(false);
    }
  });

  it("screens fractional epoch-scale values — the threshold is magnitude-only", () => {
    // High-resolution clocks produce fractional epoch readings; an
    // integer-shape requirement would let a hostile or nonconforming
    // producer smuggle a wall-clock value past the screen.
    expect(
      isResultEvidenceTimestampShapedNumeric("elapsedMs", 1_500_000_000_000.5),
    ).toBe(true);
    expect(
      isResultEvidenceTimestampShapedNumeric("startValue", 1_700_000_000.25),
    ).toBe(true);
    expect(
      isResultEvidenceTimestampShapedNumeric("elapsedMs", -1_500_000_000_000.5),
    ).toBe(true);
    // Fractional values below the threshold stay admissible.
    expect(
      isResultEvidenceTimestampShapedNumeric("elapsedMs", 999_999_999_999.5),
    ).toBe(false);
    expect(
      isResultEvidenceTimestampShapedNumeric("startValue", 999_999_999.75),
    ).toBe(false);
  });

  it("non-finite values are not timestamp-shaped", () => {
    expect(isResultEvidenceTimestampShapedNumeric("elapsedMs", NaN)).toBe(
      false,
    );
    expect(isResultEvidenceTimestampShapedNumeric("elapsedMs", Infinity)).toBe(
      false,
    );
  });

  it("never throws on non-string keys or non-number values", () => {
    expect(
      isResultEvidenceTimestampShapedNumeric(
        undefined as unknown as string,
        1_000_000_000_000,
      ),
    ).toBe(false);
    expect(
      isResultEvidenceTimestampShapedNumeric(
        "elapsedMs",
        "1000000000000" as unknown as number,
      ),
    ).toBe(false);
  });
});

describe("validateResultEvidenceCompleteFamily — families 1 and 2", () => {
  it("accepts a family-1 bundle with one flat scalar", () => {
    expect(validateResultEvidenceCompleteFamily(familyOneBundle())).toEqual({
      ok: true,
      family: 1,
      scalarCount: 1,
    });
  });

  it("accepts a family-2 bundle at the 16-scalar ceiling", () => {
    const scalars: Record<string, unknown> = {};
    for (let i = 0; i < MAX_SIDE_EFFECT_SCALARS_PER_OPERATION; i += 1) {
      scalars[`bucket${i}Value`] = i;
    }
    expect(
      validateResultEvidenceCompleteFamily(familyTwoBundle(scalars)),
    ).toEqual({ ok: true, family: 2, scalarCount: 16 });
  });

  it("rejects a 17th scalar", () => {
    const scalars: Record<string, unknown> = {};
    for (let i = 0; i < 17; i += 1) {
      scalars[`bucket${i}Value`] = i;
    }
    expect(
      validateResultEvidenceCompleteFamily(familyTwoBundle(scalars)),
    ).toEqual({ ok: false, reason: "scalar_count_exceeded" });
  });

  it("rejects a marker-only bundle", () => {
    expect(validateResultEvidenceCompleteFamily(familyOneBundle({}))).toEqual({
      ok: false,
      reason: "no_eligible_scalar",
    });
  });

  it("rejects scalars with a missing marker", () => {
    const bundle = withoutKey(
      familyOneBundle(),
      RESULT_EVIDENCE_FAMILY_ATTRIBUTE_KEY,
    );
    expect(validateResultEvidenceCompleteFamily(bundle)).toEqual({
      ok: false,
      reason: "missing_family_marker",
    });
  });

  it("rejects invalid markers including numeric strings", () => {
    for (const marker of ["1", 1.5, 4, 0, true, null]) {
      const bundle = {
        ...familyOneBundle(),
        [RESULT_EVIDENCE_FAMILY_ATTRIBUTE_KEY]: marker,
      };
      expect(validateResultEvidenceCompleteFamily(bundle)).toEqual({
        ok: false,
        reason: "invalid_family_marker",
      });
    }
  });

  it("rejects family-3-only suffixes in flat families", () => {
    expect(
      validateResultEvidenceCompleteFamily(familyOneBundle({ activeFlag: true })),
    ).toEqual({ ok: false, reason: "family_forbidden_suffix" });
    expect(
      validateResultEvidenceCompleteFamily(
        familyTwoBundle({ ownerId: `gthid_${HEX32}` }),
      ),
    ).toEqual({ ok: false, reason: "family_forbidden_suffix" });
  });

  it("rejects inadmissible numeric values", () => {
    for (const value of [
      "7", // numeric string
      true, // boolean on a numeric key
      NaN,
      Infinity,
      -Infinity,
      2 ** 53, // unsafe integer
      1_000_000_000_000, // timestamp-shaped on *Ms
      1_700_000_000_000.5, // fractional epoch is still timestamp-shaped
    ]) {
      expect(
        validateResultEvidenceCompleteFamily(
          familyOneBundle({ elapsedMs: value }),
        ),
      ).toEqual({ ok: false, reason: "invalid_scalar_value" });
    }
  });

  it("accepts finite non-integers and safe integers", () => {
    expect(
      validateResultEvidenceCompleteFamily(
        familyTwoBundle({ hitRatio: 0.375, sumAmount: 2 ** 53 - 1 }),
      ),
    ).toEqual({ ok: true, family: 2, scalarCount: 2 });
  });

  it("rejects any operation-row or per-row key in a flat family", () => {
    expect(
      validateResultEvidenceCompleteFamily({
        ...familyOneBundle(),
        [RESULT_EVIDENCE_ROWS_TOTAL_ATTRIBUTE_KEY]: 4,
      }),
    ).toEqual({ ok: false, reason: "cross_family_key" });
    expect(
      validateResultEvidenceCompleteFamily({
        ...familyOneBundle(),
        [buildResultEvidenceProducerRowMetadataKey(0, "candidates") as string]: 1,
      }),
    ).toEqual({ ok: false, reason: "cross_family_key" });
    expect(
      validateResultEvidenceCompleteFamily({
        ...familyOneBundle(),
        [buildResultEvidenceRowScalarKey(0, "elapsedMs") as string]: 5,
      }),
    ).toEqual({ ok: false, reason: "cross_family_key" });
  });

  it("rejects receiver-owned keys in a producer bundle", () => {
    expect(
      validateResultEvidenceCompleteFamily({
        ...familyOneBundle(),
        [RESULT_EVIDENCE_ROWS_CAPTURED_ATTRIBUTE_KEY]: 1,
      }),
    ).toEqual({ ok: false, reason: "receiver_owned_key" });
    expect(
      validateResultEvidenceCompleteFamily({
        ...familyOneBundle(),
        [RESULT_EVIDENCE_RECEIVER_SCALAR_MANIFEST_ATTRIBUTE_KEY]: "{}",
      }),
    ).toEqual({ ok: false, reason: "receiver_owned_key" });
  });

  it("rejects unknown result-namespace keys", () => {
    expect(
      validateResultEvidenceCompleteFamily({
        ...familyOneBundle(),
        "glasstrace.side_effect.result.v1.bogus": 1,
      }),
    ).toEqual({ ok: false, reason: "unknown_result_key" });
  });

  it("rejects malformed keys on the scalar channel", () => {
    for (const key of [
      `${SIDE_EFFECT_SCALAR_PREFIX}BadKey`,
      `${SIDE_EFFECT_SCALAR_PREFIX}r01.elapsedMs`,
      `${SIDE_EFFECT_SCALAR_PREFIX}r256.elapsedMs`,
      `${SIDE_EFFECT_SCALAR_PREFIX}r1.elapsed.Ms`,
    ]) {
      expect(
        validateResultEvidenceCompleteFamily({
          ...familyOneBundle(),
          [key]: 5,
        }),
      ).toEqual({ ok: false, reason: "invalid_scalar_key" });
    }
  });

  it("ignores attributes outside the scalar and result namespaces", () => {
    expect(
      validateResultEvidenceCompleteFamily({
        ...familyOneBundle(),
        "glasstrace.http.method": "GET",
        "glasstrace.side_effect.field.templateKey": "welcome",
        "glasstrace.side_effect.kind": "external_api",
      }),
    ).toEqual({ ok: true, family: 1, scalarCount: 1 });
  });
});

describe("validateResultEvidenceCompleteFamily — family 3", () => {
  it("accepts a minimal one-row bundle", () => {
    const bundle = familyThreeBundle({
      rows: [{ scalars: { elapsedMs: 12 } }],
    });
    expect(validateResultEvidenceCompleteFamily(bundle)).toEqual({
      ok: true,
      family: 3,
      scalarCount: 1,
      rowsTotal: 1,
      rowCap: 8,
      rowsSelected: 1,
      rowsEmitted: 1,
    });
  });

  it("accepts eight selected rows with sixteen scalars", () => {
    const rows = Array.from({ length: 8 }, () => ({
      scalars: { elapsedMs: 5, payloadBytes: 100 },
    }));
    const bundle = familyThreeBundle({ rows, rowsTotal: 20 });
    expect(validateResultEvidenceCompleteFamily(bundle)).toEqual({
      ok: true,
      family: 3,
      scalarCount: 16,
      rowsTotal: 20,
      rowCap: 8,
      rowsSelected: 8,
      rowsEmitted: 8,
    });
  });

  it("accepts boolean flags and hashed identifiers on rows", () => {
    const bundle = familyThreeBundle({
      rows: [{ scalars: { activeFlag: true, ownerId: `gthid_${HEX32}` } }],
    });
    expect(validateResultEvidenceCompleteFamily(bundle)).toEqual({
      ok: true,
      family: 3,
      scalarCount: 2,
      rowsTotal: 1,
      rowCap: 8,
      rowsSelected: 1,
      rowsEmitted: 1,
    });
  });

  it("accepts the extreme valid operation-field boundaries", () => {
    const bundle = familyThreeBundle({
      rows: [{ scalars: { elapsedMs: 3 }, candidates: 256 }],
      rowsTotal: 0xffff_ffff,
      rowCap: 1,
    });
    expect(validateResultEvidenceCompleteFamily(bundle)).toEqual({
      ok: true,
      family: 3,
      scalarCount: 1,
      rowsTotal: 0xffff_ffff,
      rowCap: 1,
      rowsSelected: 1,
      rowsEmitted: 1,
    });
  });

  it("accepts a selected row that emitted nothing when metadata says so", () => {
    const bundle = familyThreeBundle({
      rows: [
        { scalars: { elapsedMs: 3 }, candidates: 2 },
        { scalars: {}, candidates: 2 },
      ],
    });
    expect(validateResultEvidenceCompleteFamily(bundle)).toEqual({
      ok: true,
      family: 3,
      scalarCount: 1,
      rowsTotal: 2,
      rowCap: 8,
      rowsSelected: 2,
      rowsEmitted: 1,
    });
  });

  it("rejects a 17th row scalar across the operation", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      scalars:
        i === 0
          ? { elapsedMs: 5, payloadBytes: 1, hitRatio: 0.5 }
          : { elapsedMs: 5, payloadBytes: 1 },
    }));
    const bundle = familyThreeBundle({ rows });
    expect(validateResultEvidenceCompleteFamily(bundle)).toEqual({
      ok: false,
      reason: "scalar_count_exceeded",
    });
  });

  it("rejects a flat scalar in family 3", () => {
    const bundle = {
      ...familyThreeBundle({ rows: [{ scalars: { elapsedMs: 12 } }] }),
      [`${SIDE_EFFECT_SCALAR_PREFIX}elapsedMs`]: 12,
    };
    expect(validateResultEvidenceCompleteFamily(bundle)).toEqual({
      ok: false,
      reason: "cross_family_key",
    });
  });

  it("rejects a bundle missing any operation field", () => {
    for (const key of [
      RESULT_EVIDENCE_ROWS_TOTAL_ATTRIBUTE_KEY,
      RESULT_EVIDENCE_ROW_CAP_ATTRIBUTE_KEY,
      RESULT_EVIDENCE_ROWS_SELECTED_ATTRIBUTE_KEY,
      RESULT_EVIDENCE_ROWS_EMITTED_ATTRIBUTE_KEY,
    ]) {
      const bundle = withoutKey(
        familyThreeBundle({ rows: [{ scalars: { elapsedMs: 12 } }] }),
        key,
      );
      expect(validateResultEvidenceCompleteFamily(bundle)).toEqual({
        ok: false,
        reason: "missing_operation_field",
      });
    }
  });

  it("rejects out-of-range operation fields", () => {
    const valid = () =>
      familyThreeBundle({ rows: [{ scalars: { elapsedMs: 12 } }] });
    for (const [key, value] of [
      [RESULT_EVIDENCE_ROWS_TOTAL_ATTRIBUTE_KEY, -1],
      [RESULT_EVIDENCE_ROWS_TOTAL_ATTRIBUTE_KEY, 2 ** 32],
      [RESULT_EVIDENCE_ROWS_TOTAL_ATTRIBUTE_KEY, 1.5],
      [RESULT_EVIDENCE_ROWS_TOTAL_ATTRIBUTE_KEY, "1"],
      [RESULT_EVIDENCE_ROW_CAP_ATTRIBUTE_KEY, 0],
      [RESULT_EVIDENCE_ROW_CAP_ATTRIBUTE_KEY, 9],
      [RESULT_EVIDENCE_ROWS_SELECTED_ATTRIBUTE_KEY, 0],
      [RESULT_EVIDENCE_ROWS_SELECTED_ATTRIBUTE_KEY, 9],
      [RESULT_EVIDENCE_ROWS_EMITTED_ATTRIBUTE_KEY, -1],
      [RESULT_EVIDENCE_ROWS_EMITTED_ATTRIBUTE_KEY, 9],
    ] as const) {
      const bundle = { ...valid(), [key]: value };
      expect(validateResultEvidenceCompleteFamily(bundle)).toEqual({
        ok: false,
        reason: "invalid_operation_field",
      });
    }
  });

  it("rejects rows_selected above row_cap or rows_total", () => {
    const overCap = familyThreeBundle({
      rows: [{ scalars: { elapsedMs: 1 } }, { scalars: { elapsedMs: 2 } }],
      rowCap: 1,
    });
    expect(validateResultEvidenceCompleteFamily(overCap)).toEqual({
      ok: false,
      reason: "invalid_operation_field",
    });
    const overTotal = familyThreeBundle({
      rows: [{ scalars: { elapsedMs: 1 } }, { scalars: { elapsedMs: 2 } }],
      rowsTotal: 1,
    });
    expect(validateResultEvidenceCompleteFamily(overTotal)).toEqual({
      ok: false,
      reason: "invalid_operation_field",
    });
  });

  it("rejects noncontiguous or surplus row metadata", () => {
    const missingEmitted = withoutKey(
      familyThreeBundle({
        rows: [{ scalars: { elapsedMs: 1 } }, { scalars: { elapsedMs: 2 } }],
      }),
      buildResultEvidenceProducerRowMetadataKey(1, "emitted") as string,
    );
    expect(validateResultEvidenceCompleteFamily(missingEmitted)).toEqual({
      ok: false,
      reason: "noncontiguous_row_metadata",
    });

    const surplus = {
      ...familyThreeBundle({ rows: [{ scalars: { elapsedMs: 1 } }] }),
      [buildResultEvidenceProducerRowMetadataKey(5, "candidates") as string]: 1,
      [buildResultEvidenceProducerRowMetadataKey(5, "emitted") as string]: 0,
    };
    expect(validateResultEvidenceCompleteFamily(surplus)).toEqual({
      ok: false,
      reason: "noncontiguous_row_metadata",
    });
  });

  it("rejects out-of-range or dishonest per-row metadata values", () => {
    const overCap = familyThreeBundle({
      rows: [{ scalars: { elapsedMs: 1 }, candidates: 257 }],
    });
    expect(validateResultEvidenceCompleteFamily(overCap)).toEqual({
      ok: false,
      reason: "invalid_row_metadata_value",
    });
    const emittedAboveCandidates = familyThreeBundle({
      rows: [{ scalars: { elapsedMs: 1 }, candidates: 0 }],
    });
    expect(validateResultEvidenceCompleteFamily(emittedAboveCandidates)).toEqual(
      { ok: false, reason: "invalid_row_metadata_value" },
    );
    const nonInteger = familyThreeBundle({
      rows: [{ scalars: { elapsedMs: 1 }, candidates: 1.5 }],
    });
    expect(validateResultEvidenceCompleteFamily(nonInteger)).toEqual({
      ok: false,
      reason: "invalid_row_metadata_value",
    });
  });

  it("rejects a row scalar on an unselected row", () => {
    const bundle = {
      ...familyThreeBundle({ rows: [{ scalars: { elapsedMs: 1 } }] }),
      [buildResultEvidenceRowScalarKey(3, "payloadBytes") as string]: 9,
    };
    expect(validateResultEvidenceCompleteFamily(bundle)).toEqual({
      ok: false,
      reason: "row_scalar_out_of_range",
    });
  });

  it("enforces the selected-row boundary exactly at r(rows_selected)", () => {
    // r(rows_selected - 1) is the last selected row; r(rows_selected)
    // is the first unselected one. Pinning both sides kills an
    // off-by-one (`>` vs `>=`) in the range check.
    const twoRows = familyThreeBundle({
      rows: [{ scalars: { elapsedMs: 1 } }, { scalars: { payloadBytes: 2 } }],
    });
    expect(validateResultEvidenceCompleteFamily(twoRows).ok).toBe(true);

    const boundaryViolation = {
      ...familyThreeBundle({
        rows: [{ scalars: { elapsedMs: 1 } }, { scalars: { payloadBytes: 2 } }],
      }),
      [buildResultEvidenceRowScalarKey(2, "hitRatio") as string]: 0.5,
    };
    expect(validateResultEvidenceCompleteFamily(boundaryViolation)).toEqual({
      ok: false,
      reason: "row_scalar_out_of_range",
    });
  });

  it("rejects a malformed row-metadata key as unknown_result_key", () => {
    for (const key of [
      "glasstrace.side_effect.result.v1.row.r01.candidates",
      "glasstrace.side_effect.result.v1.row.r256.emitted",
      "glasstrace.side_effect.result.v1.row.r1.captured",
      "glasstrace.side_effect.result.v1.row.candidates",
    ]) {
      const bundle = {
        ...familyThreeBundle({ rows: [{ scalars: { elapsedMs: 1 } }] }),
        [key]: 1,
      };
      expect(validateResultEvidenceCompleteFamily(bundle)).toEqual({
        ok: false,
        reason: "unknown_result_key",
      });
    }
  });

  it("rejects cardinality that disagrees with the scalars present", () => {
    const wrongRowsEmitted = familyThreeBundle({
      rows: [{ scalars: { elapsedMs: 1 } }],
      rowsEmitted: 0,
    });
    expect(validateResultEvidenceCompleteFamily(wrongRowsEmitted)).toEqual({
      ok: false,
      reason: "inconsistent_cardinality",
    });
    const wrongPerRowEmitted = familyThreeBundle({
      rows: [{ scalars: { elapsedMs: 1 }, candidates: 3, emitted: 2 }],
    });
    expect(validateResultEvidenceCompleteFamily(wrongPerRowEmitted)).toEqual({
      ok: false,
      reason: "inconsistent_cardinality",
    });
  });

  it("rejects metadata with no surviving row scalar — cardinality never stands alone", () => {
    const bundle = familyThreeBundle({
      rows: [{ scalars: {}, candidates: 4 }],
    });
    expect(validateResultEvidenceCompleteFamily(bundle)).toEqual({
      ok: false,
      reason: "no_eligible_scalar",
    });
  });

  it("rejects invalid row scalar values per suffix", () => {
    for (const scalars of [
      { activeFlag: 1 }, // Flag must be a native boolean
      { activeFlag: "true" },
      { ownerId: "user_123" }, // raw identifier
      { ownerId: `gthid_${HEX32}0` }, // 33 hex chars
      { ownerId: `gthid_${HEX32.slice(1)}` }, // 31 hex chars
      { ownerId: `gthid_${HEX32.toUpperCase()}` }, // uppercase hex
      { elapsedMs: 1_000_000_000_000 }, // timestamp-shaped
      { scoreValue: 1_000_000_000 }, // timestamp-shaped
      { elapsedMs: 1_700_000_000_000.5 }, // fractional epoch, still screened
      { scoreValue: 1_700_000_000.25 }, // fractional epoch, still screened
      { payloadBytes: Infinity },
      { totalAmount: "12" },
    ]) {
      const bundle = familyThreeBundle({ rows: [{ scalars }] });
      expect(validateResultEvidenceCompleteFamily(bundle)).toEqual({
        ok: false,
        reason: "invalid_scalar_value",
      });
    }
  });

  it("rejects receiver-owned per-row retained metadata", () => {
    const bundle = {
      ...familyThreeBundle({ rows: [{ scalars: { elapsedMs: 1 } }] }),
      [buildResultEvidenceReceiverRowMetadataKey(0) as string]: 1,
    };
    expect(validateResultEvidenceCompleteFamily(bundle)).toEqual({
      ok: false,
      reason: "receiver_owned_key",
    });
  });

  it("never throws on hostile top-level input", () => {
    for (const input of [null, undefined, 42, "bundle"]) {
      expect(
        validateResultEvidenceCompleteFamily(
          input as unknown as Record<string, unknown>,
        ),
      ).toEqual({ ok: false, reason: "missing_family_marker" });
    }
  });

  it("fails closed as unreadable_attributes when a value read throws", () => {
    const throwingGetter = { ...familyOneBundle() };
    Object.defineProperty(throwingGetter, "glasstrace.side_effect.scalar.trapValue", {
      enumerable: true,
      get() {
        throw new Error("hostile getter");
      },
    });
    expect(validateResultEvidenceCompleteFamily(throwingGetter)).toEqual({
      ok: false,
      reason: "unreadable_attributes",
    });

    const { proxy, revoke } = Proxy.revocable(familyOneBundle(), {});
    revoke();
    expect(
      validateResultEvidenceCompleteFamily(
        proxy as Record<string, unknown>,
      ),
    ).toEqual({ ok: false, reason: "unreadable_attributes" });
  });

  it("keeps failing closed under Object.prototype pollution", () => {
    // The validator is a fail-closed boundary: a polluted prototype
    // must not make absent per-row metadata appear present.
    const bundle = withoutKey(
      familyThreeBundle({
        rows: [{ scalars: { elapsedMs: 1 } }, { scalars: { elapsedMs: 2 } }],
      }),
      buildResultEvidenceProducerRowMetadataKey(1, "emitted") as string,
    );
    const pollutedPrototype = Object.prototype as Record<string, unknown>;
    try {
      pollutedPrototype.emitted = 1;
      expect(validateResultEvidenceCompleteFamily(bundle)).toEqual({
        ok: false,
        reason: "noncontiguous_row_metadata",
      });
    } finally {
      delete pollutedPrototype.emitted;
    }
  });

  it("reports defect classes in fixed priority order regardless of key order", () => {
    // Every adjacent pair of the documented key-grammar class priority
    // (receiver_owned_key > unknown_result_key > invalid_scalar_key) is
    // pinned in both enumeration orders, so a revert to
    // first-encountered reporting cannot pass silently.
    const base = familyThreeBundle({ rows: [{ scalars: { elapsedMs: 1 } }] });
    const unknownKey = "glasstrace.side_effect.result.v1.bogus";
    const invalidScalarKey = "glasstrace.side_effect.scalar.BadKey";

    for (const bundle of [
      { [unknownKey]: 1, ...base, [RESULT_EVIDENCE_ROWS_CAPTURED_ATTRIBUTE_KEY]: 1 },
      { [RESULT_EVIDENCE_ROWS_CAPTURED_ATTRIBUTE_KEY]: 1, ...base, [unknownKey]: 1 },
      { [invalidScalarKey]: 1, ...base, [RESULT_EVIDENCE_ROWS_CAPTURED_ATTRIBUTE_KEY]: 1 },
      { [RESULT_EVIDENCE_ROWS_CAPTURED_ATTRIBUTE_KEY]: 1, ...base, [invalidScalarKey]: 1 },
    ] as Record<string, unknown>[]) {
      expect(validateResultEvidenceCompleteFamily(bundle)).toEqual({
        ok: false,
        reason: "receiver_owned_key",
      });
    }
    for (const bundle of [
      { [invalidScalarKey]: 1, ...base, [unknownKey]: 1 },
      { [unknownKey]: 1, ...base, [invalidScalarKey]: 1 },
    ] as Record<string, unknown>[]) {
      expect(validateResultEvidenceCompleteFamily(bundle)).toEqual({
        ok: false,
        reason: "unknown_result_key",
      });
    }
  });

  it("reports family_forbidden_suffix over invalid_scalar_value in both key orders", () => {
    for (const scalars of [
      { activeFlag: true, elapsedMs: "bad" },
      { elapsedMs: "bad", activeFlag: true },
    ]) {
      expect(
        validateResultEvidenceCompleteFamily(familyOneBundle(scalars)),
      ).toEqual({ ok: false, reason: "family_forbidden_suffix" });
    }
  });
});

describe("compile-time exactness of literal unions", () => {
  it("ResultEvidenceFamily is exactly 1 | 2 | 3", () => {
    // If inference ever widened to `number`, `number extends 1|2|3`
    // is false, `Exact` collapses to `never`, and this assignment
    // fails typecheck.
    type Exact = ResultEvidenceFamily extends 1 | 2 | 3
      ? 1 | 2 | 3 extends ResultEvidenceFamily
        ? true
        : never
      : never;
    const exact: Exact = true;
    expect(exact).toBe(true);
  });

  it("ResultEvidenceRowMetadataKind is exactly the three closed kinds", () => {
    type Kind = "candidates" | "emitted" | "retained";
    type Exact = ResultEvidenceRowMetadataKind extends Kind
      ? Kind extends ResultEvidenceRowMetadataKind
        ? true
        : never
      : never;
    const exact: Exact = true;
    expect(exact).toBe(true);
  });
});

describe("parser hostility", () => {
  it("parsers never throw on non-string input", () => {
    for (const input of [null, undefined, 42, Symbol("k"), {}]) {
      expect(
        parseResultEvidenceRowScalarKey(input as unknown as string),
      ).toEqual({ ok: false, reason: "wrong_prefix" });
      expect(
        parseResultEvidenceRowMetadataKey(input as unknown as string),
      ).toEqual({ ok: false, reason: "wrong_prefix" });
    }
  });
});

describe("built package exposes the result-evidence surface", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const distDir = path.resolve(here, "../../../packages/protocol/dist");
  const cjsPath = path.join(distDir, "index.cjs");
  const esmPath = path.join(distDir, "index.js");
  const dtsPath = path.join(distDir, "index.d.ts");
  const distPresent =
    existsSync(cjsPath) && existsSync(esmPath) && existsSync(dtsPath);

  const runtimeExports = [
    "RESULT_EVIDENCE_WIRE_VERSION",
    "MAX_RESULT_EVIDENCE_ROW_INDEX",
    "MAX_RESULT_EVIDENCE_ROWS_PER_OPERATION",
    "MAX_RESULT_EVIDENCE_CANDIDATES_PER_ROW",
    "RESULT_EVIDENCE_TIMESTAMP_VALUE_ABS_MIN",
    "RESULT_EVIDENCE_TIMESTAMP_MS_ABS_MIN",
    "ResultEvidenceFamilySchema",
    "RESULT_EVIDENCE_ATTRIBUTE_PREFIX",
    "RESULT_EVIDENCE_FAMILY_ATTRIBUTE_KEY",
    "RESULT_EVIDENCE_ROWS_TOTAL_ATTRIBUTE_KEY",
    "RESULT_EVIDENCE_ROW_CAP_ATTRIBUTE_KEY",
    "RESULT_EVIDENCE_ROWS_SELECTED_ATTRIBUTE_KEY",
    "RESULT_EVIDENCE_ROWS_EMITTED_ATTRIBUTE_KEY",
    "RESULT_EVIDENCE_ROWS_CAPTURED_ATTRIBUTE_KEY",
    "RESULT_EVIDENCE_RECEIVER_SCALAR_MANIFEST_ATTRIBUTE_KEY",
    "buildResultEvidenceRowScalarKey",
    "parseResultEvidenceRowScalarKey",
    "ResultEvidenceRowMetadataKindSchema",
    "buildResultEvidenceProducerRowMetadataKey",
    "buildResultEvidenceReceiverRowMetadataKey",
    "parseResultEvidenceRowMetadataKey",
    "isResultEvidenceTimestampShapedNumeric",
    "validateResultEvidenceCompleteFamily",
    "ResultEvidenceCapabilitiesSchema",
  ] as const;

  const typeOnlyExports = [
    "ResultEvidenceFamily",
    "ResultEvidenceRowScalarKeyParseFailureReason",
    "ResultEvidenceRowScalarKeyParseResult",
    "ResultEvidenceRowMetadataKind",
    "ResultEvidenceRowMetadataKeyParseFailureReason",
    "ResultEvidenceRowMetadataKeyParseResult",
    "ResultEvidenceCompleteFamilyValidationFailureReason",
    "ResultEvidenceCompleteFamilyValidationResult",
    "ResultEvidenceCapabilities",
  ] as const;

  // CI runs Build before Test, so these assertions are active there;
  // locally without a prior build they skip rather than fail, matching
  // the published-surface guard's convention.
  it.runIf(distPresent)("CJS entry exposes every runtime export", () => {
    const require = createRequire(import.meta.url);
    const cjs = require(cjsPath) as Record<string, unknown>;
    for (const name of runtimeExports) {
      expect(cjs[name], name).toBeDefined();
    }
  });

  it.runIf(distPresent)("ESM entry exposes every runtime export", async () => {
    const esm = (await import(pathToFileURL(esmPath).href)) as Record<
      string,
      unknown
    >;
    for (const name of runtimeExports) {
      expect(esm[name], name).toBeDefined();
    }
  });

  it.runIf(distPresent)(
    "declaration file export list names every runtime and type export exactly",
    () => {
      // Membership is asserted against the parsed final `export { ... }`
      // statement, not substring presence — a type name that is a
      // substring of its Schema constant would otherwise pass vacuously.
      const dts = readFileSync(dtsPath, "utf8");
      const exportBlocks = dts.match(/export \{[^}]*\}/g);
      expect(exportBlocks).not.toBeNull();
      const entries = new Set(
        (exportBlocks as string[])
          .flatMap((block) =>
            block.replace(/^export \{/, "").replace(/\}$/, "").split(","),
          )
          .map((entry) => entry.trim()),
      );
      for (const name of runtimeExports) {
        expect(entries.has(name), name).toBe(true);
      }
      for (const name of typeOnlyExports) {
        expect(entries.has(`type ${name}`), name).toBe(true);
      }
    },
  );
});
