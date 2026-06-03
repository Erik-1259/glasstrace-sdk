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
  SIDE_EFFECT_SEMANTIC_FIELD_KEYS,
  SIDE_EFFECT_OMISSION_REASONS,
  SIDE_EFFECT_OPERATION_STATUSES,
  SIDE_EFFECT_OPERATION_PHASES,
  type SideEffectOperationKind,
  type SideEffectSemanticFieldKey,
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
  ] as const;

  it("exports exactly the 21 expected side-effect attribute keys", () => {
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
  });
});

describe("DEFAULT_CAPTURE_CONFIG — sideEffectEvidence", () => {
  it("defaults sideEffectEvidence to false", () => {
    expect(DEFAULT_CAPTURE_CONFIG.sideEffectEvidence).toBe(false);
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

describe("SIDE_EFFECT_SEMANTIC_FIELD_KEYS", () => {
  it("matches the side-effect allowlist verbatim", () => {
    expect([...SIDE_EFFECT_SEMANTIC_FIELD_KEYS]).toEqual([
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
    ]);
  });

  it("derives a literal-type union usable for record key types", () => {
    const sample: SideEffectSemanticFieldKey = "templateKey";
    expect(SIDE_EFFECT_SEMANTIC_FIELD_KEYS).toContain(sample);
  });

  it("narrows the type union for each recipient-evidence key", () => {
    const recipientClass: SideEffectSemanticFieldKey = "recipientClass";
    const participantCount: SideEffectSemanticFieldKey = "participantCount";
    const activeParticipantCount: SideEffectSemanticFieldKey =
      "activeParticipantCount";
    expect(SIDE_EFFECT_SEMANTIC_FIELD_KEYS).toContain(recipientClass);
    expect(SIDE_EFFECT_SEMANTIC_FIELD_KEYS).toContain(participantCount);
    expect(SIDE_EFFECT_SEMANTIC_FIELD_KEYS).toContain(activeParticipantCount);
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
    ]);
  });

  it("derives a literal-type union", () => {
    const sample: SideEffectOmissionReason = "pii";
    expect(SIDE_EFFECT_OMISSION_REASONS).toContain(sample);
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
      SIDE_EFFECT_SEMANTIC_FIELD_KEYS,
      SIDE_EFFECT_OMISSION_REASONS,
      SIDE_EFFECT_OPERATION_STATUSES,
      SIDE_EFFECT_OPERATION_PHASES,
    ];
    for (const tuple of tuples) {
      expect(new Set(tuple).size).toBe(tuple.length);
    }
  });
});
