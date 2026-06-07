/**
 * Phase-1 protocol-level tests for the side-effect evidence
 * constants and value-enum tuples (SDK-049).
 *
 * Pins the wire-string namespace, asserts the runtime tuples match
 * the SCHEMA-036 allowlists verbatim, and verifies the derived type
 * unions are usable as compile-time literal types. The wire-string
 * set must remain in lockstep with
 * `glasstrace-product/shared/types/agent-evidence.ts`; this file is
 * the SDK-side contract test.
 */

import { describe, it, expect } from "vitest";
import {
  GLASSTRACE_ATTRIBUTE_NAMES,
  DEFAULT_CAPTURE_CONFIG,
  SIDE_EFFECT_OPERATION_KINDS,
  SIDE_EFFECT_SEMANTIC_FIELD_STABLE_CORE_KEYS,
  SIDE_EFFECT_SEMANTIC_FIELD_OPEN_PATTERN,
  MAX_SIDE_EFFECT_SEMANTIC_FIELD_KEY_LENGTH,
  isSideEffectSemanticFieldKey,
  SIDE_EFFECT_OMISSION_REASONS,
  SIDE_EFFECT_SCALAR_KEY_PATTERN,
  SIDE_EFFECT_SCALAR_PREFIX,
  MAX_SIDE_EFFECT_SCALARS_PER_OPERATION,
  isSideEffectScalarKey,
  SIDE_EFFECT_HASHED_ID_PREFIX,
  SIDE_EFFECT_OPERATION_STATUSES,
  SIDE_EFFECT_OPERATION_PHASES,
  type SideEffectOperationKind,
  type SideEffectSemanticFieldKey,
  type SideEffectSemanticFieldStableCoreKey,
  type SideEffectOmissionReason,
  type SideEffectOperationStatus,
  type SideEffectOperationPhase,
} from "../../../packages/protocol/src/index.js";

describe("GLASSTRACE_ATTRIBUTE_NAMES — side-effect entries", () => {
  const sideEffectKeys = [
    "SIDE_EFFECT_KIND",
    "SIDE_EFFECT_OPERATION",
    "SIDE_EFFECT_STATUS",
    "SIDE_EFFECT_PHASE",
    "SIDE_EFFECT_FIELD_TEMPLATE_KEY",
    "SIDE_EFFECT_FIELD_PROVIDER_OPERATION",
    "SIDE_EFFECT_FIELD_ROLE",
    "SIDE_EFFECT_FIELD_LOCALE",
    "SIDE_EFFECT_FIELD_TIMEZONE",
    "SIDE_EFFECT_FIELD_STATUS",
    "SIDE_EFFECT_FIELD_PHASE",
    "SIDE_EFFECT_FIELD_RECIPIENT_CLASS",
    "SIDE_EFFECT_FIELD_PARTICIPANT_COUNT",
    "SIDE_EFFECT_FIELD_ACTIVE_PARTICIPANT_COUNT",
    "SIDE_EFFECT_OMITTED_PII",
    "SIDE_EFFECT_OMITTED_SECRET",
    "SIDE_EFFECT_OMITTED_RAW_PAYLOAD",
    "SIDE_EFFECT_OMITTED_UNSUPPORTED_KEY",
    "SIDE_EFFECT_OMITTED_VALUE_TOO_LONG",
    "SIDE_EFFECT_OMITTED_NOT_EMITTED",
    "SIDE_EFFECT_OMITTED_CAPTURE_DISABLED",
    "SIDE_EFFECT_OMITTED_RAW_TIMESTAMP",
    "SIDE_EFFECT_OMITTED_UNHASHED_ID",
    "SIDE_EFFECT_OMITTED_NON_FINITE",
  ] as const;

  it("exports exactly the 24 expected side-effect attribute keys", () => {
    const actual = Object.keys(GLASSTRACE_ATTRIBUTE_NAMES).filter((k) =>
      k.startsWith("SIDE_EFFECT_"),
    );
    expect(actual.sort()).toEqual([...sideEffectKeys].sort());
  });

  it("each side-effect attribute name uses the glasstrace.side_effect.* prefix", () => {
    for (const key of sideEffectKeys) {
      const value = GLASSTRACE_ATTRIBUTE_NAMES[key];
      expect(value).toMatch(/^glasstrace\.side_effect\./);
    }
  });

  it("top-level operation attributes use the four canonical wire strings", () => {
    expect(GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_KIND).toBe(
      "glasstrace.side_effect.kind",
    );
    expect(GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OPERATION).toBe(
      "glasstrace.side_effect.operation",
    );
    expect(GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_STATUS).toBe(
      "glasstrace.side_effect.status",
    );
    expect(GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_PHASE).toBe(
      "glasstrace.side_effect.phase",
    );
  });

  it("field attributes use the camelCase semantic-field-key suffix", () => {
    expect(GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_TEMPLATE_KEY).toBe(
      "glasstrace.side_effect.field.templateKey",
    );
    expect(
      GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_PROVIDER_OPERATION,
    ).toBe("glasstrace.side_effect.field.providerOperation");
    expect(GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_ROLE).toBe(
      "glasstrace.side_effect.field.role",
    );
    expect(GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_LOCALE).toBe(
      "glasstrace.side_effect.field.locale",
    );
    expect(GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_TIMEZONE).toBe(
      "glasstrace.side_effect.field.timezone",
    );
    expect(GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_STATUS).toBe(
      "glasstrace.side_effect.field.status",
    );
    expect(GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_PHASE).toBe(
      "glasstrace.side_effect.field.phase",
    );
    expect(GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_RECIPIENT_CLASS).toBe(
      "glasstrace.side_effect.field.recipientClass",
    );
    expect(GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_PARTICIPANT_COUNT).toBe(
      "glasstrace.side_effect.field.participantCount",
    );
    expect(
      GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_ACTIVE_PARTICIPANT_COUNT,
    ).toBe("glasstrace.side_effect.field.activeParticipantCount");
  });

  it("omission attributes use the snake_case omission-reason suffix", () => {
    expect(GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_PII).toBe(
      "glasstrace.side_effect.omitted.pii",
    );
    expect(GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_SECRET).toBe(
      "glasstrace.side_effect.omitted.secret",
    );
    expect(GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_RAW_PAYLOAD).toBe(
      "glasstrace.side_effect.omitted.raw_payload",
    );
    expect(
      GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_UNSUPPORTED_KEY,
    ).toBe("glasstrace.side_effect.omitted.unsupported_key");
    expect(
      GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_VALUE_TOO_LONG,
    ).toBe("glasstrace.side_effect.omitted.value_too_long");
    expect(GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_NOT_EMITTED).toBe(
      "glasstrace.side_effect.omitted.not_emitted",
    );
    expect(
      GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_CAPTURE_DISABLED,
    ).toBe("glasstrace.side_effect.omitted.capture_disabled");
    expect(
      GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_RAW_TIMESTAMP,
    ).toBe("glasstrace.side_effect.omitted.raw_timestamp");
    expect(
      GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_UNHASHED_ID,
    ).toBe("glasstrace.side_effect.omitted.unhashed_id");
    expect(
      GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_NON_FINITE,
    ).toBe("glasstrace.side_effect.omitted.non_finite");
  });
});

describe("DEFAULT_CAPTURE_CONFIG — conservative defaults", () => {
  it("defaults sideEffectEvidence to false", () => {
    expect(DEFAULT_CAPTURE_CONFIG.sideEffectEvidence).toBe(false);
  });

  it("defaults captureFidelity to strict (fail-closed)", () => {
    expect(DEFAULT_CAPTURE_CONFIG.captureFidelity).toBe("strict");
  });
});

describe("SIDE_EFFECT_OPERATION_KINDS", () => {
  it("matches the SCHEMA-036 allowlist verbatim", () => {
    expect([...SIDE_EFFECT_OPERATION_KINDS]).toEqual([
      "email",
      "calendar_link",
      "webhook",
      "external_api",
      "queue",
      "after_callback",
    ]);
  });

  it("is iterable and produces a literal-type union", () => {
    // Compile-time exhaustiveness: the union must include every
    // tuple member. If a new kind is added but the type derivation
    // is broken, the assertion below will fail at type-check.
    const sample: SideEffectOperationKind = "email";
    expect(SIDE_EFFECT_OPERATION_KINDS).toContain(sample);
  });
});

describe("SIDE_EFFECT_SEMANTIC_FIELD_STABLE_CORE_KEYS", () => {
  it("contains exactly the 7 stable-core keys in canonical order", () => {
    expect([...SIDE_EFFECT_SEMANTIC_FIELD_STABLE_CORE_KEYS]).toEqual([
      "templateKey",
      "providerOperation",
      "role",
      "locale",
      "timezone",
      "status",
      "phase",
    ]);
  });

  it("derives a narrower literal-type union for stable-core autocomplete", () => {
    const sample: SideEffectSemanticFieldStableCoreKey = "templateKey";
    expect(SIDE_EFFECT_SEMANTIC_FIELD_STABLE_CORE_KEYS).toContain(sample);
  });
});

describe("SIDE_EFFECT_SEMANTIC_FIELD_OPEN_PATTERN", () => {
  it("matches lowerCamelCase keys ending in one of the four canonical suffixes", () => {
    for (const key of [
      "recipientClass",
      "attachmentClass",
      "severityClass",
      "participantCount",
      "attemptCount",
      "activeParticipantCount",
      "notificationKind",
      "channelKind",
      "actorRole",
      "recipientRole",
    ]) {
      expect(SIDE_EFFECT_SEMANTIC_FIELD_OPEN_PATTERN.test(key)).toBe(true);
    }
  });

  it("rejects non-matching keys (snake_case, uppercase lead, no canonical suffix)", () => {
    for (const key of [
      "random_field", // snake_case + no canonical suffix
      "recipient_class", // snake_case
      "RecipientClass", // uppercase lead
      "messageId", // no canonical suffix
      "payloadHash", // no canonical suffix
      "bookingPhase", // Phase is NOT a canonical suffix
      "", // empty
      "Count", // no lowerCamel prefix
    ]) {
      expect(SIDE_EFFECT_SEMANTIC_FIELD_OPEN_PATTERN.test(key)).toBe(false);
    }
  });
});

describe("isSideEffectSemanticFieldKey runtime guard", () => {
  it("admits all 7 stable-core keys", () => {
    for (const key of SIDE_EFFECT_SEMANTIC_FIELD_STABLE_CORE_KEYS) {
      expect(isSideEffectSemanticFieldKey(key)).toBe(true);
    }
  });

  it("admits pattern keys via the open-pattern regex", () => {
    for (const key of [
      "recipientClass",
      "attemptCount",
      "notificationKind",
      "actorRole",
    ]) {
      expect(isSideEffectSemanticFieldKey(key)).toBe(true);
    }
  });

  it("rejects non-stable-core, non-pattern-matching keys", () => {
    for (const key of [
      "random_field",
      "RecipientClass",
      "recipient_class",
      "messageId",
      "bookingPhase",
    ]) {
      expect(isSideEffectSemanticFieldKey(key)).toBe(false);
    }
  });

  it("rejects pattern keys longer than MAX_SIDE_EFFECT_SEMANTIC_FIELD_KEY_LENGTH", () => {
    // Length cap is part of the admission contract — the protocol
    // guard must match the SDK's emission decision. A consumer
    // calling the runtime guard sees the same answer as
    // `recordSideEffect()`'s admission check.
    const atCap =
      "a".repeat(MAX_SIDE_EFFECT_SEMANTIC_FIELD_KEY_LENGTH - 5) + "Class";
    expect(atCap.length).toBe(MAX_SIDE_EFFECT_SEMANTIC_FIELD_KEY_LENGTH);
    expect(isSideEffectSemanticFieldKey(atCap)).toBe(true);

    const overCap =
      "a".repeat(MAX_SIDE_EFFECT_SEMANTIC_FIELD_KEY_LENGTH - 4) + "Class";
    expect(overCap.length).toBe(MAX_SIDE_EFFECT_SEMANTIC_FIELD_KEY_LENGTH + 1);
    expect(isSideEffectSemanticFieldKey(overCap)).toBe(false);

    // Pathological 100k-char key — would inflate OTel attribute
    // payloads if the guard let it through.
    const pathological = "a".repeat(100_000) + "Class";
    expect(isSideEffectSemanticFieldKey(pathological)).toBe(false);
  });
});

describe("SideEffectSemanticFieldKey type narrowing posture", () => {
  it("type widens to (stable-core | string) — string subsumes the literal arm", () => {
    // Compile-time assertion: stable-core literal narrows; pattern keys
    // assign as `string`. Runtime admission is enforced by
    // `isSideEffectSemanticFieldKey`. This test exercises both arms.
    const stableCore: SideEffectSemanticFieldKey = "templateKey";
    const patternKey: SideEffectSemanticFieldKey = "attachmentClass";
    expect(isSideEffectSemanticFieldKey(stableCore)).toBe(true);
    expect(isSideEffectSemanticFieldKey(patternKey)).toBe(true);
  });

  it("DISC-1853-era keys continue to admit (regression guard for backward-compat asymmetry)", () => {
    // recipientClass/participantCount/activeParticipantCount keep their
    // GLASSTRACE_ATTRIBUTE_NAMES constants but are now admitted via the
    // pattern regex rather than as closed-literal members.
    expect(isSideEffectSemanticFieldKey("recipientClass")).toBe(true);
    expect(isSideEffectSemanticFieldKey("participantCount")).toBe(true);
    expect(isSideEffectSemanticFieldKey("activeParticipantCount")).toBe(true);
  });
});

describe("SIDE_EFFECT_OMISSION_REASONS", () => {
  it("matches the SCHEMA-036 allowlist verbatim", () => {
    expect([...SIDE_EFFECT_OMISSION_REASONS]).toEqual([
      "pii",
      "secret",
      "raw_payload",
      "unsupported_key",
      "value_too_long",
      "not_emitted",
      "capture_disabled",
      "raw_timestamp",
      "unhashed_id",
      "non_finite",
    ]);
  });

  it("derives a literal-type union", () => {
    const sample: SideEffectOmissionReason = "pii";
    expect(SIDE_EFFECT_OMISSION_REASONS).toContain(sample);
  });
});

describe("value-fidelity scalar contract", () => {
  it("scalar key pattern mirrors the product regex verbatim", () => {
    // Byte-identical to product SideEffectScalarSchema key regex
    // (shared/types/agent-evidence.ts). Pinned so drift is caught here.
    expect(SIDE_EFFECT_SCALAR_KEY_PATTERN.source).toBe(
      "^[a-z][A-Za-z0-9]*(Ms|Amount|Bytes|Ratio|Id|Value|Flag)$",
    );
  });

  it("admits each magnitude/identity suffix", () => {
    for (const key of [
      "elapsedMs",
      "totalAmount",
      "payloadBytes",
      "hitRatio",
      "scoreValue",
      "enabledFlag",
      "actorId",
    ]) {
      expect(SIDE_EFFECT_SCALAR_KEY_PATTERN.test(key)).toBe(true);
      expect(isSideEffectScalarKey(key)).toBe(true);
    }
  });

  it("excludes *Count (it routes to the categorical channel) and malformed keys", () => {
    for (const key of [
      "participantCount", // Count is deliberately not a scalar suffix
      "Capitalized",
      "noSuffix",
      "trailingMsExtra",
      "",
    ]) {
      expect(SIDE_EFFECT_SCALAR_KEY_PATTERN.test(key)).toBe(false);
      expect(isSideEffectScalarKey(key)).toBe(false);
    }
  });

  it("rejects an over-length scalar key via the shared cap", () => {
    const longKey = `${"a".repeat(MAX_SIDE_EFFECT_SEMANTIC_FIELD_KEY_LENGTH)}Ms`;
    expect(SIDE_EFFECT_SCALAR_KEY_PATTERN.test(longKey)).toBe(true);
    expect(isSideEffectScalarKey(longKey)).toBe(false);
  });

  it("pins the scalar channel prefix and hashed-id prefix", () => {
    expect(SIDE_EFFECT_SCALAR_PREFIX).toBe("glasstrace.side_effect.scalar.");
    expect(SIDE_EFFECT_HASHED_ID_PREFIX).toBe("gthid_");
  });

  it("pins the per-operation scalar ceiling", () => {
    expect(MAX_SIDE_EFFECT_SCALARS_PER_OPERATION).toBe(16);
  });
});

describe("SIDE_EFFECT_OPERATION_STATUSES", () => {
  it("matches the SCHEMA-036 allowlist verbatim", () => {
    expect([...SIDE_EFFECT_OPERATION_STATUSES]).toEqual([
      "scheduled",
      "started",
      "succeeded",
      "failed",
      "unknown",
    ]);
  });

  it("derives a literal-type union", () => {
    const sample: SideEffectOperationStatus = "scheduled";
    expect(SIDE_EFFECT_OPERATION_STATUSES).toContain(sample);
  });
});

describe("SIDE_EFFECT_OPERATION_PHASES", () => {
  it("matches the SCHEMA-036 allowlist verbatim", () => {
    expect([...SIDE_EFFECT_OPERATION_PHASES]).toEqual([
      "request",
      "post_response",
      "background",
      "unknown",
    ]);
  });

  it("derives a literal-type union", () => {
    const sample: SideEffectOperationPhase = "request";
    expect(SIDE_EFFECT_OPERATION_PHASES).toContain(sample);
  });
});

describe("Cross-tuple uniqueness", () => {
  it("each tuple's members are unique", () => {
    const tuples: ReadonlyArray<readonly string[]> = [
      SIDE_EFFECT_OPERATION_KINDS,
      SIDE_EFFECT_SEMANTIC_FIELD_STABLE_CORE_KEYS,
      SIDE_EFFECT_OMISSION_REASONS,
      SIDE_EFFECT_OPERATION_STATUSES,
      SIDE_EFFECT_OPERATION_PHASES,
    ];
    for (const tuple of tuples) {
      expect(new Set(tuple).size).toBe(tuple.length);
    }
  });
});
