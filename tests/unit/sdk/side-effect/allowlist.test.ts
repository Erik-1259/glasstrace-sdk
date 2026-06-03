/**
 * Allowlist enforcement tests for the side-effect evidence emission
 * helpers (SDK-049). Every Layer 1 / Layer 2 rejection class is
 * covered. Rejection inputs are constructed inline so no
 * payload-shaped string ever lives in a fixture file.
 */

import { describe, it, expect } from "vitest";
import {
  checkOperationKind,
  checkOperationLabel,
  checkOperationPhase,
  checkOperationStatus,
  checkSemanticFieldKey,
  checkSemanticFieldValue,
  isKnownOmissionReason,
  MAX_SIDE_EFFECT_FIELD_VALUE_LENGTH,
  MAX_SIDE_EFFECT_OPERATION_LABEL_LENGTH,
  MAX_SIDE_EFFECT_OPERATIONS_PER_SPAN,
} from "../../../../packages/sdk/src/side-effect/allowlist.js";

describe("checkOperationKind", () => {
  it("accepts every v1 allowlisted kind", () => {
    for (const kind of [
      "email",
      "calendar_link",
      "webhook",
      "external_api",
      "queue",
      "after_callback",
    ]) {
      expect(checkOperationKind(kind)).toBe(true);
    }
  });

  it("rejects unknown kinds, non-strings, null, undefined", () => {
    expect(checkOperationKind("sms")).toBe(false);
    expect(checkOperationKind("EMAIL")).toBe(false);
    expect(checkOperationKind(42)).toBe(false);
    expect(checkOperationKind(null)).toBe(false);
    expect(checkOperationKind(undefined)).toBe(false);
    expect(checkOperationKind({})).toBe(false);
  });
});

describe("checkOperationStatus / checkOperationPhase", () => {
  it("accepts every allowlisted status", () => {
    for (const status of [
      "scheduled",
      "started",
      "succeeded",
      "failed",
      "unknown",
    ]) {
      expect(checkOperationStatus(status)).toBe(true);
    }
  });

  it("accepts every allowlisted phase", () => {
    for (const phase of [
      "request",
      "post_response",
      "background",
      "unknown",
    ]) {
      expect(checkOperationPhase(phase)).toBe(true);
    }
  });

  it("rejects unknown / non-string status and phase", () => {
    expect(checkOperationStatus("pending")).toBe(false);
    expect(checkOperationStatus(1)).toBe(false);
    expect(checkOperationPhase("startup")).toBe(false);
    expect(checkOperationPhase(null)).toBe(false);
  });
});

describe("checkSemanticFieldKey", () => {
  it("accepts every v1 semantic field key", () => {
    for (const key of [
      "templateKey",
      "providerOperation",
      "role",
      "locale",
      "timezone",
      "status",
      "phase",
    ]) {
      expect(checkSemanticFieldKey(key)).toBe(true);
    }
  });

  it("rejects unknown keys and non-strings", () => {
    expect(checkSemanticFieldKey("recipient")).toBe(false);
    expect(checkSemanticFieldKey("subject")).toBe(false);
    expect(checkSemanticFieldKey("__proto__")).toBe(false);
    expect(checkSemanticFieldKey(123)).toBe(false);
    expect(checkSemanticFieldKey(null)).toBe(false);
  });
});

describe("isKnownOmissionReason", () => {
  it("accepts every SCHEMA-036 reason", () => {
    for (const reason of [
      "pii",
      "secret",
      "raw_payload",
      "unsupported_key",
      "value_too_long",
      "not_emitted",
      "capture_disabled",
    ]) {
      expect(isKnownOmissionReason(reason)).toBe(true);
    }
  });

  it("rejects unknown reasons", () => {
    expect(isKnownOmissionReason("budget_exceeded")).toBe(false);
    expect(isKnownOmissionReason("PII")).toBe(false);
    expect(isKnownOmissionReason("")).toBe(false);
  });
});

describe("checkOperationLabel — happy paths", () => {
  it("accepts compact normalized labels", () => {
    for (const label of [
      "email.send",
      "calendar.invite.create",
      "webhook.dispatch",
      "queue.enqueue",
      "after.callback",
      "ABC",
      "send-1",
    ]) {
      const outcome = checkOperationLabel(label);
      expect(outcome.accepted).toBe(true);
      if (outcome.accepted) expect(outcome.value).toBe(label);
    }
  });
});

describe("checkOperationLabel — Layer 1 type/length rejection", () => {
  it("rejects non-strings as raw_payload", () => {
    for (const value of [42, null, undefined, {}, []]) {
      const outcome = checkOperationLabel(value);
      expect(outcome.accepted).toBe(false);
      if (!outcome.accepted) expect(outcome.reason).toBe("raw_payload");
    }
  });

  it("rejects empty strings as raw_payload", () => {
    const outcome = checkOperationLabel("");
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("raw_payload");
  });

  it("rejects values exceeding the operation label budget as value_too_long", () => {
    const tooLong = "a".repeat(MAX_SIDE_EFFECT_OPERATION_LABEL_LENGTH + 1);
    const outcome = checkOperationLabel(tooLong);
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("value_too_long");
  });

  it("accepts values exactly at the operation label budget", () => {
    const justRight = "a".repeat(MAX_SIDE_EFFECT_OPERATION_LABEL_LENGTH);
    const outcome = checkOperationLabel(justRight);
    expect(outcome.accepted).toBe(true);
  });
});

describe("checkOperationLabel — Layer 1 unsafe-pattern rejection", () => {
  it("routes URL-shaped values to raw_payload", () => {
    const cases = [
      "https" + "://example.test/path",
      "ftp" + "://example.test",
      "//example.test/admin",
    ];
    for (const value of cases) {
      const outcome = checkOperationLabel(value);
      expect(outcome.accepted).toBe(false);
      if (!outcome.accepted) expect(outcome.reason).toBe("raw_payload");
    }
  });

  it("routes email-shaped values to pii", () => {
    const value = "user" + "@example.test";
    const outcome = checkOperationLabel(value);
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("pii");
  });

  it("routes query-string and fragment markers to raw_payload", () => {
    const cases = ["op?token=x", "op#frag"];
    for (const value of cases) {
      const outcome = checkOperationLabel(value);
      expect(outcome.accepted).toBe(false);
      if (!outcome.accepted) expect(outcome.reason).toBe("raw_payload");
    }
  });

  it("routes header-shaped and bearer-shaped values to secret", () => {
    const cases = [
      "Authorization: Bearer x",
      "Bearer abc.def.ghi",
      "Cookie: sid=1",
    ];
    for (const value of cases) {
      const outcome = checkOperationLabel(value);
      expect(outcome.accepted).toBe(false);
      if (!outcome.accepted) expect(outcome.reason).toBe("secret");
    }
  });

  it("routes token-key-value patterns to secret", () => {
    const cases = [
      "password=abc",
      "api_key=xyz",
      "client_secret=abc",
      "secret=abc",
    ];
    for (const value of cases) {
      const outcome = checkOperationLabel(value);
      expect(outcome.accepted).toBe(false);
      if (!outcome.accepted) expect(outcome.reason).toBe("secret");
    }
  });

  it("routes UUID-shaped values to secret", () => {
    const uuid = "12345678-1234-4abc-8def-1234567890ab";
    const outcome = checkOperationLabel(uuid);
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("secret");
  });

  it("routes Glasstrace-key-shaped values to secret", () => {
    const value = "gt_dev_" + "a".repeat(48);
    const outcome = checkOperationLabel(value);
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("secret");
  });

  it("routes prose-shaped whitespace values to raw_payload", () => {
    const cases = ["multi  space", "carriage\rreturn", "new\nline", "tab\tchar"];
    for (const value of cases) {
      const outcome = checkOperationLabel(value);
      expect(outcome.accepted).toBe(false);
      if (!outcome.accepted) expect(outcome.reason).toBe("raw_payload");
    }
  });

  it("routes leading/trailing whitespace to raw_payload", () => {
    const outcome = checkOperationLabel(" leading");
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("raw_payload");
  });
});

describe("checkOperationLabel — Layer 2 token-shape rejection", () => {
  it("rejects values with slashes as raw_payload (not a compact label)", () => {
    const outcome = checkOperationLabel("calendar/booking");
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("raw_payload");
  });

  it("rejects values starting with non-alphanumeric as raw_payload", () => {
    const outcome = checkOperationLabel("-leading-dash");
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("raw_payload");
  });
});

describe("checkSemanticFieldValue — locale", () => {
  it("accepts 2- and 3-letter primary tags", () => {
    for (const value of ["en", "fr", "zho"]) {
      const outcome = checkSemanticFieldValue("locale", value);
      expect(outcome.accepted).toBe(true);
    }
  });

  it("accepts compound tags up to 3 subtags", () => {
    for (const value of ["en-US", "zh-Hans-CN", "es-419"]) {
      const outcome = checkSemanticFieldValue("locale", value);
      expect(outcome.accepted).toBe(true);
    }
  });

  it("rejects email-shaped string masquerading as locale (pii)", () => {
    const value = "customer" + "@example.test";
    const outcome = checkSemanticFieldValue("locale", value);
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("pii");
  });

  it("rejects malformed locale tokens as raw_payload", () => {
    for (const value of ["1234", "EN_US", "english"]) {
      const outcome = checkSemanticFieldValue("locale", value);
      expect(outcome.accepted).toBe(false);
      if (!outcome.accepted) expect(outcome.reason).toBe("raw_payload");
    }
  });
});

describe("checkSemanticFieldValue — timezone", () => {
  it("accepts UTC, GMT, and IANA-shaped tokens", () => {
    for (const value of [
      "UTC",
      "GMT",
      "Europe/Paris",
      "America/New_York",
      "America/Indiana/Indianapolis",
    ]) {
      const outcome = checkSemanticFieldValue("timezone", value);
      expect(outcome.accepted).toBe(true);
    }
  });

  it("rejects URL-shaped string masquerading as timezone", () => {
    const value = "https" + "://example.test";
    const outcome = checkSemanticFieldValue("timezone", value);
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("raw_payload");
  });

  it("rejects free-form prose timezone", () => {
    const outcome = checkSemanticFieldValue("timezone", "Eastern Time");
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("raw_payload");
  });
});

describe("checkSemanticFieldValue — token fields (templateKey, role, etc.)", () => {
  it("accepts compact tokens for templateKey", () => {
    for (const value of [
      "EventCanceledEmail",
      "evt.cancel.email",
      "Booking-Confirmed",
    ]) {
      const outcome = checkSemanticFieldValue("templateKey", value);
      expect(outcome.accepted).toBe(true);
    }
  });

  it("accepts compact tokens for providerOperation", () => {
    for (const value of [
      "sendTemplate",
      "createCalendarEvent",
      "queue.enqueue",
    ]) {
      const outcome = checkSemanticFieldValue("providerOperation", value);
      expect(outcome.accepted).toBe(true);
    }
  });

  it("accepts the SCHEMA-036 status enum members under the field 'status' key", () => {
    for (const value of [
      "scheduled",
      "started",
      "succeeded",
      "failed",
      "unknown",
    ]) {
      const outcome = checkSemanticFieldValue("status", value);
      expect(outcome.accepted).toBe(true);
    }
  });

  it("rejects values exceeding the field budget as value_too_long", () => {
    const tooLong = "A".repeat(MAX_SIDE_EFFECT_FIELD_VALUE_LENGTH + 1);
    const outcome = checkSemanticFieldValue("templateKey", tooLong);
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("value_too_long");
  });

  it("rejects empty strings as raw_payload", () => {
    const outcome = checkSemanticFieldValue("role", "");
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("raw_payload");
  });

  it("rejects non-strings as raw_payload", () => {
    for (const value of [123, null, undefined, {}]) {
      const outcome = checkSemanticFieldValue("role", value);
      expect(outcome.accepted).toBe(false);
      if (!outcome.accepted) expect(outcome.reason).toBe("raw_payload");
    }
  });

  it("rejects URL-shaped values as raw_payload", () => {
    const value = "https" + "://example.test/admin";
    const outcome = checkSemanticFieldValue("role", value);
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("raw_payload");
  });

  it("rejects email-shaped values as pii", () => {
    const value = "user" + "@example.test";
    const outcome = checkSemanticFieldValue("role", value);
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("pii");
  });

  it("rejects bearer-token-shaped values as secret", () => {
    const outcome = checkSemanticFieldValue(
      "templateKey",
      "Bearer abc.def.ghi",
    );
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("secret");
  });

  it("rejects values with slashes as raw_payload (not compact tokens)", () => {
    const outcome = checkSemanticFieldValue(
      "templateKey",
      "calendar/booking",
    );
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("raw_payload");
  });
});

describe("checkSemanticFieldValue — recipient-evidence fields", () => {
  // The three keys added to the allowlist are not `locale` or
  // `timezone`, so `passesFieldValidator` falls through to
  // TOKEN_REGEX. These assertions lock in that routing so a future
  // regression that adds a per-key branch cannot silently re-route
  // them to a different validator.
  it("routes recipientClass through TOKEN_REGEX (compact token)", () => {
    expect(
      checkSemanticFieldValue("recipientClass", "removed-participant").accepted,
    ).toBe(true);
    expect(
      checkSemanticFieldValue("recipientClass", "active.participant").accepted,
    ).toBe(true);
    expect(
      checkSemanticFieldValue("recipientClass", "primary_role").accepted,
    ).toBe(true);
  });

  it("accepts non-negative integer strings for participantCount and activeParticipantCount", () => {
    for (const value of ["0", "1", "2", "12", "999"]) {
      expect(
        checkSemanticFieldValue("participantCount", value).accepted,
      ).toBe(true);
      expect(
        checkSemanticFieldValue("activeParticipantCount", value).accepted,
      ).toBe(true);
    }
  });

  it("rejects non-digit count values as raw_payload (digit-only validator)", () => {
    // Strict integer-string shape for the count fields rejects misleading
    // labels like "many", "a few", or shape-confused values like "1:2"
    // or "1.5". TOKEN_REGEX would accept some of these; the per-key
    // digit-only branch in passesFieldValidator catches them and routes
    // to raw_payload omission instead of emitting bad causal evidence.
    for (const key of [
      "participantCount",
      "activeParticipantCount",
    ] as const) {
      for (const value of ["many", "one", "1:2", "1.5", "2k"]) {
        const outcome = checkSemanticFieldValue(key, value);
        expect(outcome.accepted).toBe(false);
        if (!outcome.accepted) expect(outcome.reason).toBe("raw_payload");
      }
    }
  });

  it("preserves case verbatim for recipientClass (no normalization)", () => {
    const upper = checkSemanticFieldValue(
      "recipientClass",
      "REMOVED-PARTICIPANT",
    );
    const lower = checkSemanticFieldValue(
      "recipientClass",
      "removed-participant",
    );
    expect(upper.accepted).toBe(true);
    expect(lower.accepted).toBe(true);
    if (upper.accepted) expect(upper.value).toBe("REMOVED-PARTICIPANT");
    if (lower.accepted) expect(lower.value).toBe("removed-participant");
  });

  it("rejects negative-encoded counts as raw_payload (TOKEN_REGEX rejects leading hyphen)", () => {
    for (const value of ["-1", "-12"]) {
      const outcome = checkSemanticFieldValue("participantCount", value);
      expect(outcome.accepted).toBe(false);
      if (!outcome.accepted) expect(outcome.reason).toBe("raw_payload");
    }
  });

  it("rejects values with embedded spaces or emoji as raw_payload", () => {
    for (const key of [
      "recipientClass",
      "participantCount",
      "activeParticipantCount",
    ] as const) {
      const space = checkSemanticFieldValue(key, "two participants");
      expect(space.accepted).toBe(false);
      if (!space.accepted) expect(space.reason).toBe("raw_payload");
      const emoji = checkSemanticFieldValue(key, "two 🚫 participants");
      expect(emoji.accepted).toBe(false);
      if (!emoji.accepted) expect(emoji.reason).toBe("raw_payload");
    }
  });

  it("rejects empty string and non-string values as raw_payload", () => {
    for (const key of [
      "recipientClass",
      "participantCount",
      "activeParticipantCount",
    ] as const) {
      expect(checkSemanticFieldValue(key, "").accepted).toBe(false);
      for (const value of [123, null, undefined, {}]) {
        const outcome = checkSemanticFieldValue(key, value);
        expect(outcome.accepted).toBe(false);
        if (!outcome.accepted) expect(outcome.reason).toBe("raw_payload");
      }
    }
  });

  it("rejects values exceeding the field budget as value_too_long", () => {
    const tooLong = "A".repeat(MAX_SIDE_EFFECT_FIELD_VALUE_LENGTH + 1);
    const outcome = checkSemanticFieldValue("recipientClass", tooLong);
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("value_too_long");
  });
});

describe("MAX_SIDE_EFFECT_OPERATIONS_PER_SPAN", () => {
  it("matches the SCHEMA-036 budget", () => {
    expect(MAX_SIDE_EFFECT_OPERATIONS_PER_SPAN).toBe(5);
  });
});
