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
  checkScalarField,
  checkSemanticFieldKey,
  checkSemanticFieldValue,
  isKnownOmissionReason,
  MAX_SIDE_EFFECT_FIELD_VALUE_LENGTH,
  MAX_SIDE_EFFECT_OPERATION_LABEL_LENGTH,
  MAX_SIDE_EFFECT_OPERATIONS_PER_SPAN,
} from "../../../../packages/sdk/src/side-effect/allowlist.js";
import { MAX_SIDE_EFFECT_SEMANTIC_FIELD_KEY_LENGTH } from "../../../../packages/protocol/src/index.js";

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

describe("checkSemanticFieldKey — pattern key-name length cap", () => {
  // The open-pattern regex has no length bound on its own. Without an
  // explicit key-name cap, a producer that derived a key from
  // request/provider metadata could pass a giant string ending in
  // Class/Count/Kind/Role and inflate emitted attribute payloads.
  // The SDK enforces MAX_SIDE_EFFECT_SEMANTIC_FIELD_KEY_LENGTH at the
  // admission boundary; oversized keys are rejected and routed to
  // the unsupported_key omission counter (same as any other
  // non-admissible key).
  it("admits pattern keys at exactly the length cap", () => {
    // 80-char *Class key: 75 a's + "Class" = 80 chars total
    const atCap = "a".repeat(MAX_SIDE_EFFECT_SEMANTIC_FIELD_KEY_LENGTH - 5) + "Class";
    expect(atCap.length).toBe(MAX_SIDE_EFFECT_SEMANTIC_FIELD_KEY_LENGTH);
    expect(checkSemanticFieldKey(atCap)).toBe(true);
  });

  it("rejects pattern keys one character over the cap", () => {
    const overCap =
      "a".repeat(MAX_SIDE_EFFECT_SEMANTIC_FIELD_KEY_LENGTH - 4) + "Class";
    expect(overCap.length).toBe(MAX_SIDE_EFFECT_SEMANTIC_FIELD_KEY_LENGTH + 1);
    expect(checkSemanticFieldKey(overCap)).toBe(false);
  });

  it("rejects pathological oversized keys (regression guard for unbounded regex)", () => {
    // The pattern regex alone admits any-length match; the cap is the
    // load-bearing defense against producer-derived metadata inflating
    // attribute payloads.
    const pathological = "a".repeat(100_000) + "Class";
    expect(checkSemanticFieldKey(pathological)).toBe(false);
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

describe("checkSemanticFieldValue — suffix-routed pattern keys", () => {
  // Pattern admission generalizes the DISC-1853 per-key DIGIT_REGEX
  // branch to suffix routing: `*Count` keys → DIGIT_REGEX; `*Class` /
  // `*Kind` / `*Role` keys → TOKEN_REGEX. Stable-core specialized
  // validators (locale, timezone) win over the default routing.
  // These assertions lock the new suffix routing in so a future
  // regression that re-introduces a key-name-list branch cannot
  // silently re-route them.
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
    // *Class uses the 80-char field-value cap and TOKEN_REGEX.
    const classSpace = checkSemanticFieldValue(
      "recipientClass",
      "two participants",
    );
    expect(classSpace.accepted).toBe(false);
    if (!classSpace.accepted) expect(classSpace.reason).toBe("raw_payload");
    const classEmoji = checkSemanticFieldValue(
      "recipientClass",
      "two 🚫 participants",
    );
    expect(classEmoji.accepted).toBe(false);
    if (!classEmoji.accepted) expect(classEmoji.reason).toBe("raw_payload");
    // *Count uses the tighter 16-char cap; use strings short enough to
    // pass the length check so the digit-only regex is the rejector.
    for (const key of [
      "participantCount",
      "activeParticipantCount",
    ] as const) {
      const space = checkSemanticFieldValue(key, "two parts");
      expect(space.accepted).toBe(false);
      if (!space.accepted) expect(space.reason).toBe("raw_payload");
      const emoji = checkSemanticFieldValue(key, "2🚫");
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

  it("routes any *Class / *Kind / *Role pattern key through TOKEN_REGEX", () => {
    // Suffix routing — not key-name lookup. ANY pattern key matching
    // the open-pattern regex routes to TOKEN_REGEX (except *Count).
    expect(
      checkSemanticFieldValue("attachmentClass", "no-timezone-ics").accepted,
    ).toBe(true);
    expect(
      checkSemanticFieldValue("severityClass", "critical").accepted,
    ).toBe(true);
    expect(
      checkSemanticFieldValue("notificationKind", "transactional").accepted,
    ).toBe(true);
    expect(
      checkSemanticFieldValue("actorRole", "operator").accepted,
    ).toBe(true);
  });

  it("routes any *Count pattern key through DIGIT_REGEX (not key-name list)", () => {
    // Generalization of the DISC-1853 deviation: a *Count key NOT in
    // the original participantCount/activeParticipantCount list should
    // also route through DIGIT_REGEX. This locks in suffix routing.
    expect(
      checkSemanticFieldValue("attemptCount", "3").accepted,
    ).toBe(true);
    expect(
      checkSemanticFieldValue("retryCount", "0").accepted,
    ).toBe(true);
    const bad = checkSemanticFieldValue("attemptCount", "many");
    expect(bad.accepted).toBe(false);
    if (!bad.accepted) expect(bad.reason).toBe("raw_payload");
    const decimal = checkSemanticFieldValue("retryCount", "1.5");
    expect(decimal.accepted).toBe(false);
    if (!decimal.accepted) expect(decimal.reason).toBe("raw_payload");
  });

  it("enforces the tighter *Count value-length cap (16 chars)", () => {
    // *Count values are non-negative integer strings, so they get a
    // tighter cap than the default 80-char field-value length.
    const sixteenDigits = "1234567890123456"; // 16 chars, all digits
    const seventeenDigits = sixteenDigits + "7";
    expect(
      checkSemanticFieldValue("attemptCount", sixteenDigits).accepted,
    ).toBe(true);
    const tooLong = checkSemanticFieldValue("attemptCount", seventeenDigits);
    expect(tooLong.accepted).toBe(false);
    if (!tooLong.accepted) expect(tooLong.reason).toBe("value_too_long");
  });

  it("stable-core specialized validators win over default suffix routing", () => {
    // locale and timezone are stable-core; even though they don't
    // match the suffix family, they use specialized validators.
    expect(checkSemanticFieldValue("locale", "en-US").accepted).toBe(true);
    expect(checkSemanticFieldValue("locale", "Europe/Paris").accepted).toBe(
      false,
    );
    expect(checkSemanticFieldValue("timezone", "Europe/Paris").accepted).toBe(
      true,
    );
    expect(checkSemanticFieldValue("timezone", "en-US").accepted).toBe(false);
  });
});

describe("checkSemanticFieldValue — §5.4.10 examples-table coverage", () => {
  // This describe block walks the canonical examples table from the
  // component design v6 §5.4.10 verbatim. Each entry asserts the
  // expected admission outcome. This is the single highest-leverage
  // round-trip-coverage assertion against the canonical contract; a
  // breakage here means the SDK's behavior has drifted from the
  // documented contract.
  it("admits templateKey (stable-core)", () => {
    expect(checkSemanticFieldKey("templateKey")).toBe(true);
  });
  it("admits locale (stable-core + specialized validator)", () => {
    expect(checkSemanticFieldKey("locale")).toBe(true);
  });
  it("admits recipientClass (pattern: *Class)", () => {
    expect(checkSemanticFieldKey("recipientClass")).toBe(true);
  });
  it("admits attachmentClass (pattern: *Class — was DISC-1876 trigger)", () => {
    expect(checkSemanticFieldKey("attachmentClass")).toBe(true);
  });
  it("admits participantCount with value '2' (pattern: *Count, valid digits)", () => {
    const outcome = checkSemanticFieldValue("participantCount", "2");
    expect(outcome.accepted).toBe(true);
  });
  it("rejects participantCount with value 'abc' (pattern: *Count, non-digit)", () => {
    const outcome = checkSemanticFieldValue("participantCount", "abc");
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("raw_payload");
  });
  it("rejects participantCount with value '-1' (pattern: *Count, leading hyphen)", () => {
    const outcome = checkSemanticFieldValue("participantCount", "-1");
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("raw_payload");
  });
  it("admits notificationKind=transactional (pattern: *Kind)", () => {
    expect(checkSemanticFieldKey("notificationKind")).toBe(true);
    expect(
      checkSemanticFieldValue("notificationKind", "transactional").accepted,
    ).toBe(true);
  });
  it("admits actorRole=operator (pattern: *Role)", () => {
    expect(checkSemanticFieldKey("actorRole")).toBe(true);
    expect(checkSemanticFieldValue("actorRole", "operator").accepted).toBe(
      true,
    );
  });
  it("admits severityClass=critical (pattern: *Class; future producer)", () => {
    expect(checkSemanticFieldKey("severityClass")).toBe(true);
    expect(checkSemanticFieldValue("severityClass", "critical").accepted).toBe(
      true,
    );
  });
  it("rejects random_field (no canonical suffix, not stable-core)", () => {
    expect(checkSemanticFieldKey("random_field")).toBe(false);
  });
  it("rejects RecipientClass (uppercase lead violates lowerCamelCase)", () => {
    expect(checkSemanticFieldKey("RecipientClass")).toBe(false);
  });
  it("rejects recipient_class (snake_case, not lowerCamelCase)", () => {
    expect(checkSemanticFieldKey("recipient_class")).toBe(false);
  });
  it("rejects messageId (identifier shape, no canonical suffix)", () => {
    expect(checkSemanticFieldKey("messageId")).toBe(false);
  });
  it("rejects payloadHash (hash shape, no canonical suffix)", () => {
    expect(checkSemanticFieldKey("payloadHash")).toBe(false);
  });
  it("admits userRole at the regex layer (shadow rule is PR-review-only)", () => {
    // userRole matches the *Role suffix syntactically. The component
    // design §5.4.4 documents that this is the one syntactically
    // ambiguous case (shadows stable-core `role`). Shadow detection
    // is NOT runtime-enforced; PR review catches it.
    expect(checkSemanticFieldKey("userRole")).toBe(true);
  });
  it("rejects bookingPhase (Phase is NOT a canonical suffix)", () => {
    // v6 §5.4.10 fixed this example from v5: bookingPhase is rejected
    // outright by the regex (Phase ≠ Class/Count/Kind/Role).
    expect(checkSemanticFieldKey("bookingPhase")).toBe(false);
  });
});

describe("MAX_SIDE_EFFECT_OPERATIONS_PER_SPAN", () => {
  it("matches the SCHEMA-036 budget", () => {
    expect(MAX_SIDE_EFFECT_OPERATIONS_PER_SPAN).toBe(5);
  });
});

const GTHID_32 = `gthid_${"a1b2c3d4".repeat(4)}`; // gthid_ + 32 lowercase hex

describe("checkScalarField — strict (default)", () => {
  it("accepts suffix-typed values: numbers, a boolean Flag, and a gthid_ Id", () => {
    expect(checkScalarField("renderMs", 42)).toEqual({
      accepted: true,
      value: 42,
    });
    expect(checkScalarField("totalAmount", 19.99)).toEqual({
      accepted: true,
      value: 19.99,
    });
    expect(checkScalarField("payloadBytes", 0)).toEqual({
      accepted: true,
      value: 0,
    });
    expect(checkScalarField("hadAttachmentFlag", false)).toEqual({
      accepted: true,
      value: false,
    });
    expect(checkScalarField("actorId", GTHID_32)).toEqual({
      accepted: true,
      value: GTHID_32,
    });
  });

  it("accepts a long-but-bounded duration in ms (not an epoch)", () => {
    // ~83 days in ms, well below the 1e12 epoch threshold.
    expect(checkScalarField("elapsedMs", 7_200_000_000)).toEqual({
      accepted: true,
      value: 7_200_000_000,
    });
  });

  it("rejects keys that do not match the scalar pattern (Count routes elsewhere)", () => {
    for (const key of ["participantCount", "randomKey", "Capitalized", ""]) {
      expect(checkScalarField(key, 1)).toEqual({
        accepted: false,
        reason: "unsupported_key",
      });
    }
  });

  it("enforces the value type declared by the key suffix (raw_payload on mismatch)", () => {
    // Boolean on a numeric-suffix key.
    expect(checkScalarField("latencyMs", true)).toEqual({
      accepted: false,
      reason: "raw_payload",
    });
    // Number on a *Flag key.
    expect(checkScalarField("retriedFlag", 1)).toEqual({
      accepted: false,
      reason: "raw_payload",
    });
    // Strings are not scalars (except the *Id gthid form) — they belong
    // on the categorical fields channel.
    expect(checkScalarField("regionValue", "us-east-1")).toEqual({
      accepted: false,
      reason: "raw_payload",
    });
    expect(checkScalarField("totalAmount", "42")).toEqual({
      accepted: false,
      reason: "raw_payload",
    });
    expect(checkScalarField("enabledFlag", "true")).toEqual({
      accepted: false,
      reason: "raw_payload",
    });
  });

  it("rejects non-finite numbers as non_finite", () => {
    expect(checkScalarField("scoreValue", Number.NaN)).toEqual({
      accepted: false,
      reason: "non_finite",
    });
    expect(checkScalarField("scoreValue", Number.POSITIVE_INFINITY)).toEqual({
      accepted: false,
      reason: "non_finite",
    });
  });

  it("rejects unhashed, wrong-length, or non-string *Id values as unhashed_id", () => {
    expect(checkScalarField("actorId", "user_12345")).toEqual({
      accepted: false,
      reason: "unhashed_id",
    });
    // Uppercase hex is not the lowercase gthid_ shape.
    expect(checkScalarField("actorId", "gthid_ABCDEF")).toEqual({
      accepted: false,
      reason: "unhashed_id",
    });
    // Correct charset but wrong length — strict requires the fixed shape.
    expect(checkScalarField("actorId", "gthid_a1b2")).toEqual({
      accepted: false,
      reason: "unhashed_id",
    });
    expect(checkScalarField("actorId", 12345)).toEqual({
      accepted: false,
      reason: "unhashed_id",
    });
  });

  it("rejects raw wall-clock timestamps as raw_timestamp", () => {
    // A Date object on any key.
    expect(checkScalarField("startedValue", new Date(0))).toEqual({
      accepted: false,
      reason: "raw_timestamp",
    });
    // A numeric epoch-ms on a *Ms key.
    expect(checkScalarField("createdMs", 1_700_000_000_000)).toEqual({
      accepted: false,
      reason: "raw_timestamp",
    });
  });

  it("rejects non-scalar types as raw_payload", () => {
    expect(checkScalarField("noteValue", null)).toEqual({
      accepted: false,
      reason: "raw_payload",
    });
    expect(checkScalarField("noteValue", { a: 1 })).toEqual({
      accepted: false,
      reason: "raw_payload",
    });
  });
});

describe("checkScalarField — full (privacy relaxations only)", () => {
  it("allows raw epochs and raw id strings under full", () => {
    expect(checkScalarField("createdMs", 1_700_000_000_000, "full")).toEqual({
      accepted: true,
      value: 1_700_000_000_000,
    });
    expect(checkScalarField("actorId", "raw-actor-12345", "full")).toEqual({
      accepted: true,
      value: "raw-actor-12345",
    });
  });

  it("still enforces suffix-type, Date, PII, length, and non-finite under full", () => {
    // Suffix-type is a contract, not a privacy rule — enforced in both modes.
    expect(checkScalarField("latencyMs", true, "full")).toEqual({
      accepted: false,
      reason: "raw_payload",
    });
    expect(checkScalarField("retriedFlag", 1, "full")).toEqual({
      accepted: false,
      reason: "raw_payload",
    });
    // A Date object is never an emittable scalar, even under full.
    expect(checkScalarField("createdMs", new Date(0), "full")).toEqual({
      accepted: false,
      reason: "raw_timestamp",
    });
    expect(checkScalarField("scoreValue", Number.NaN, "full")).toEqual({
      accepted: false,
      reason: "non_finite",
    });
    expect(checkScalarField("actorId", 12345, "full")).toEqual({
      accepted: false,
      reason: "unhashed_id",
    });
    // PII guard still applies to a raw id string under full.
    expect(checkScalarField("actorId", "a" + "@" + "b.co", "full")).toEqual({
      accepted: false,
      reason: "pii",
    });
    // Over-length raw id string under full.
    const long = "x".repeat(MAX_SIDE_EFFECT_FIELD_VALUE_LENGTH + 1);
    expect(checkScalarField("actorId", long, "full")).toEqual({
      accepted: false,
      reason: "value_too_long",
    });
  });

  it("still blocks secret/credential-shaped raw ids under full", () => {
    // detectUnsafePattern routes UUID/bearer/account-key shapes to secret.
    expect(
      checkScalarField(
        "sessionId",
        "550e8400-e29b-41d4-a716-446655440000",
        "full",
      ),
    ).toEqual({ accepted: false, reason: "secret" });
  });
});

describe("checkScalarField — boundary conditions", () => {
  it("treats the 1e12 epoch threshold as inclusive on *Ms (>=)", () => {
    // Exactly the threshold is rejected; one below is an accepted delta.
    expect(checkScalarField("createdMs", 1e12)).toEqual({
      accepted: false,
      reason: "raw_timestamp",
    });
    expect(checkScalarField("createdMs", 1e12 - 1)).toEqual({
      accepted: true,
      value: 1e12 - 1,
    });
  });

  it("checks non-finite before the epoch comparison on *Ms", () => {
    // Infinity >= 1e12 is true, but non_finite must win.
    expect(checkScalarField("createdMs", Number.POSITIVE_INFINITY)).toEqual({
      accepted: false,
      reason: "non_finite",
    });
  });

  it("requires the exact gthid hex length under strict (31/32/33)", () => {
    const hex = (n: number) => `gthid_${"a".repeat(n)}`;
    expect(checkScalarField("actorId", hex(31))).toEqual({
      accepted: false,
      reason: "unhashed_id",
    });
    expect(checkScalarField("actorId", hex(32))).toEqual({
      accepted: true,
      value: hex(32),
    });
    expect(checkScalarField("actorId", hex(33))).toEqual({
      accepted: false,
      reason: "unhashed_id",
    });
  });

  it("rejects a date STRING as a type mismatch (raw_payload), not raw_timestamp", () => {
    // After the suffix-typing refactor, only a Date instance / numeric
    // epoch is raw_timestamp; a datetime string on a numeric key is a
    // wrong-typed value. Pins the resolved doc/code contract.
    expect(checkScalarField("createdMs", "2026-03-08T10:00:00Z")).toEqual({
      accepted: false,
      reason: "raw_payload",
    });
  });

  it("diverges the empty-string *Id reason by mode", () => {
    expect(checkScalarField("actorId", "", "strict")).toEqual({
      accepted: false,
      reason: "unhashed_id",
    });
    expect(checkScalarField("actorId", "", "full")).toEqual({
      accepted: false,
      reason: "raw_payload",
    });
  });

  it("rejects an over-length but pattern-valid scalar key as unsupported_key", () => {
    const overLongKey = `${"a".repeat(MAX_SIDE_EFFECT_SEMANTIC_FIELD_KEY_LENGTH)}Ms`;
    expect(checkScalarField(overLongKey, 1)).toEqual({
      accepted: false,
      reason: "unsupported_key",
    });
  });
});
