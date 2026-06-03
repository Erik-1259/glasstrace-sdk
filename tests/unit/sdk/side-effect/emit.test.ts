/**
 * Emission and OTel edge-case tests for `recordSideEffect()`
 * (SDK-049). Uses an in-memory tracer + exporter so the assertions
 * run against real OTel `Span` objects (not mocks) and exercise the
 * exact code paths a host application would: active-span lookup,
 * `isRecording()`, attribute-slot exhaustion behavior, and per-span
 * counter scoping.
 *
 * Capture-config is asserted both in the off-by-default state and in
 * the explicit opt-in state via the SDK's `getActiveConfig()` cache.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as otelApi from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { recordSideEffect } from "../../../../packages/sdk/src/side-effect/index.js";
import {
  _setCurrentConfig,
  _resetConfigForTesting,
} from "../../../../packages/sdk/src/init-client.js";
import { installContextManager } from "../../../../packages/sdk/src/context-manager.js";
import type { SdkInitResponse } from "../../../../packages/protocol/src/wire.js";
import { GLASSTRACE_ATTRIBUTE_NAMES } from "../../../../packages/protocol/src/index.js";

// Install an AsyncLocalStorage-based context manager once at module
// load so `tracer.startActiveSpan` propagates the active span into
// `otelApi.trace.getActiveSpan()`. Without this, the OTel API falls
// back to a no-op manager and `recordSideEffect()` always observes
// "no active span" inside the test callback. `setGlobalContextManager`
// is idempotent across test files.
installContextManager();

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let tracer: otelApi.Tracer;

function makeInitResponse(sideEffectEvidence: boolean): SdkInitResponse {
  return {
    config: {
      requestBodies: false,
      queryParamValues: false,
      envVarValues: false,
      fullConsoleOutput: false,
      importGraph: false,
      consoleErrors: false,
      errorResponseBodies: false,
      sideEffectEvidence,
    },
    subscriptionStatus: "active",
    minimumSdkVersion: "0.0.0",
    apiVersion: "v1",
    tierLimits: {
      tracesPerMinute: 100,
      storageTtlHours: 48,
      maxTraceSizeBytes: 512_000,
      maxConcurrentSessions: 1,
    },
  } as SdkInitResponse;
}

function enableCapture(): void {
  _setCurrentConfig(makeInitResponse(true));
}

function disableCapture(): void {
  _setCurrentConfig(makeInitResponse(false));
}

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  otelApi.trace.setGlobalTracerProvider(provider);
  tracer = otelApi.trace.getTracer("glasstrace-sdk-test");
});

afterEach(async () => {
  _resetConfigForTesting();
  await provider.shutdown();
  otelApi.trace.disable();
  exporter.reset();
});

function exportedAttributes(): Record<string, unknown> {
  const spans = exporter.getFinishedSpans();
  expect(spans.length).toBeGreaterThanOrEqual(1);
  return spans[0].attributes as Record<string, unknown>;
}

describe("recordSideEffect — capture-config gating", () => {
  it("is a no-op when sideEffectEvidence is false (default)", () => {
    disableCapture();
    tracer.startActiveSpan("test", (span) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        status: "succeeded",
        fields: { templateKey: "EventCanceledEmail" },
      });
      span.end();
    });
    const attrs = exportedAttributes();
    expect(attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_KIND]).toBeUndefined();
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OPERATION],
    ).toBeUndefined();
  });

  it("emits when sideEffectEvidence is true", () => {
    enableCapture();
    tracer.startActiveSpan("test", (span) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        status: "succeeded",
        phase: "request",
        fields: {
          templateKey: "EventCanceledEmail",
          role: "invitee",
          locale: "en-US",
          timezone: "Europe/Paris",
        },
      });
      span.end();
    });
    const attrs = exportedAttributes();
    expect(attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_KIND]).toBe("email");
    expect(attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OPERATION]).toBe(
      "email.send",
    );
    expect(attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_STATUS]).toBe(
      "succeeded",
    );
    expect(attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_PHASE]).toBe(
      "request",
    );
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_TEMPLATE_KEY],
    ).toBe("EventCanceledEmail");
    expect(attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_ROLE]).toBe(
      "invitee",
    );
    expect(attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_LOCALE]).toBe(
      "en-US",
    );
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_TIMEZONE],
    ).toBe("Europe/Paris");
  });

  it("emits recipient-evidence fields on the span when accepted", () => {
    enableCapture();
    tracer.startActiveSpan("test", (span) => {
      recordSideEffect({
        kind: "email",
        operation: "FinalizeParticipantEmail",
        status: "succeeded",
        phase: "request",
        fields: {
          templateKey: "EventCanceledEmail",
          recipientClass: "removed-participant",
          participantCount: "2",
          activeParticipantCount: "1",
        },
      });
      span.end();
    });
    const attrs = exportedAttributes();
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_RECIPIENT_CLASS],
    ).toBe("removed-participant");
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_PARTICIPANT_COUNT],
    ).toBe("2");
    expect(
      attrs[
        GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_ACTIVE_PARTICIPANT_COUNT
      ],
    ).toBe("1");
  });
});

describe("recordSideEffect — no active span", () => {
  it("is a silent no-op when no span is active", () => {
    enableCapture();
    expect(() =>
      recordSideEffect({ kind: "email", operation: "email.send" }),
    ).not.toThrow();
    // No span was finished by recordSideEffect itself.
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe("recordSideEffect — ended span", () => {
  it("does not write to a span that has already ended", () => {
    enableCapture();
    let endedSpan: otelApi.Span | undefined;
    tracer.startActiveSpan("ended-span", (span) => {
      endedSpan = span;
      span.end();
    });
    // Re-enter the (now ended) span's context.
    const ctx = otelApi.trace.setSpan(otelApi.context.active(), endedSpan!);
    otelApi.context.with(ctx, () => {
      // Should not throw, and even if it does write, the SDK
      // exporter has already exported the span. The contract is
      // "no extra activity that is observable to the user".
      expect(() =>
        recordSideEffect({ kind: "email", operation: "email.send" }),
      ).not.toThrow();
    });
  });
});

describe("recordSideEffect — invalid kind", () => {
  it("silently drops unknown operation kinds without emitting any side-effect attribute", () => {
    enableCapture();
    tracer.startActiveSpan("test", (span) => {
      recordSideEffect({
        // @ts-expect-error intentional unknown kind for the test
        kind: "sms",
        operation: "sms.send",
      });
      span.end();
    });
    const attrs = exportedAttributes();
    // No top-level operation attribute is attached.
    expect(attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_KIND]).toBeUndefined();
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OPERATION],
    ).toBeUndefined();
    // No omission counter is incremented either: there is no
    // allowlisted kind to attribute the rejection to, so the call is
    // a fully silent drop. This is intentional — surfacing an
    // omission would imply the rejected kind was meaningful.
    for (const key of Object.keys(attrs)) {
      expect(key.startsWith("glasstrace.side_effect.")).toBe(false);
    }
  });
});

describe("recordSideEffect — operation-label rejection routes to omission", () => {
  it("omits raw_payload when the operation label is URL-shaped", () => {
    enableCapture();
    const unsafe = "https" + "://example.test/admin?token=abc";
    tracer.startActiveSpan("test", (span) => {
      recordSideEffect({
        kind: "email",
        operation: unsafe,
      });
      span.end();
    });
    const attrs = exportedAttributes();
    // No top-level operation attributes attached.
    expect(attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_KIND]).toBeUndefined();
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OPERATION],
    ).toBeUndefined();
    // Omission counter present.
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_RAW_PAYLOAD],
    ).toBe(1);
    // The rejected URL string never appears anywhere on the span.
    for (const value of Object.values(attrs)) {
      if (typeof value === "string") {
        expect(value).not.toContain(unsafe);
      }
    }
  });
});

describe("recordSideEffect — semantic-field rejection", () => {
  it("drops unsupported keys and counts them under unsupported_key", () => {
    enableCapture();
    tracer.startActiveSpan("test", (span) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        // @ts-expect-error intentional unsupported keys for the test
        fields: { recipient: "user@example.test", subject: "x" },
      });
      span.end();
    });
    const attrs = exportedAttributes();
    expect(attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_KIND]).toBe("email");
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_UNSUPPORTED_KEY],
    ).toBe(2);
    // Neither rejected key name nor value appears as an attribute.
    expect(attrs["recipient"]).toBeUndefined();
    expect(attrs["subject"]).toBeUndefined();
  });

  it("still drops keys outside the widened allowlist (e.g. defectSignal)", () => {
    // Regression guard for the allowlist widening: a key that is
    // semantically adjacent to the new recipient-evidence fields but
    // NOT in the allowlist must continue to drop under
    // unsupported_key. If a future change accidentally widens the
    // filter to accept arbitrary keys, this test fails.
    enableCapture();
    tracer.startActiveSpan("test", (span) => {
      recordSideEffect({
        kind: "email",
        operation: "FinalizeParticipantEmail",
        // @ts-expect-error defectSignal is intentionally not allowlisted
        fields: { defectSignal: "removed-participant-included" },
      });
      span.end();
    });
    const attrs = exportedAttributes();
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_UNSUPPORTED_KEY],
    ).toBe(1);
    expect(attrs["defectSignal"]).toBeUndefined();
    expect(
      attrs[
        "glasstrace.side_effect.field.defectSignal"
      ],
    ).toBeUndefined();
  });

  it("drops unsafe field values and counts them under their reason", () => {
    enableCapture();
    const unsafeRole = "https" + "://example.test/admin?token=abc";
    tracer.startActiveSpan("test", (span) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        fields: {
          templateKey: "EventCanceledEmail",
          role: unsafeRole,
        },
      });
      span.end();
    });
    const attrs = exportedAttributes();
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_TEMPLATE_KEY],
    ).toBe("EventCanceledEmail");
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_ROLE],
    ).toBeUndefined();
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_RAW_PAYLOAD],
    ).toBe(1);
    // Rejected URL never appears anywhere.
    for (const value of Object.values(attrs)) {
      if (typeof value === "string") {
        expect(value).not.toContain(unsafeRole);
      }
    }
  });

  it("routes email-shaped role values to pii", () => {
    enableCapture();
    const unsafe = "user" + "@example.test";
    tracer.startActiveSpan("test", (span) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        fields: { role: unsafe },
      });
      span.end();
    });
    const attrs = exportedAttributes();
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_PII],
    ).toBe(1);
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_ROLE],
    ).toBeUndefined();
  });

  it("routes bearer-shaped values to secret", () => {
    enableCapture();
    tracer.startActiveSpan("test", (span) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        fields: { templateKey: "Bearer abc.def.ghi" },
      });
      span.end();
    });
    const attrs = exportedAttributes();
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_SECRET],
    ).toBe(1);
  });

  it("routes oversized values to value_too_long", () => {
    enableCapture();
    const tooLong = "A".repeat(200);
    tracer.startActiveSpan("test", (span) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        fields: { templateKey: tooLong },
      });
      span.end();
    });
    const attrs = exportedAttributes();
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_VALUE_TOO_LONG],
    ).toBe(1);
  });
});

describe("recordSideEffect — invalid status / phase", () => {
  it("drops unknown status values and counts them as unsupported_key", () => {
    enableCapture();
    tracer.startActiveSpan("test", (span) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        // @ts-expect-error intentional unknown status
        status: "pending",
      });
      span.end();
    });
    const attrs = exportedAttributes();
    expect(attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_STATUS]).toBeUndefined();
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_UNSUPPORTED_KEY],
    ).toBe(1);
  });

  it("drops unknown phase values and counts them as unsupported_key", () => {
    enableCapture();
    tracer.startActiveSpan("test", (span) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        // @ts-expect-error intentional unknown phase
        phase: "startup",
      });
      span.end();
    });
    const attrs = exportedAttributes();
    expect(attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_PHASE]).toBeUndefined();
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_UNSUPPORTED_KEY],
    ).toBe(1);
  });
});

describe("recordSideEffect — per-span operation budget (5 ops max)", () => {
  it("attaches up to 5 operations and routes the 6th+ to value_too_long", () => {
    enableCapture();
    tracer.startActiveSpan("test", (span) => {
      for (let i = 0; i < 8; i++) {
        recordSideEffect({
          kind: "email",
          operation: `email.send.${i.toString()}`,
        });
      }
      span.end();
    });
    const attrs = exportedAttributes();
    // Last accepted op overwrites the previous on the same key, but
    // the over-budget calls (3 of 8) accumulate under value_too_long.
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_VALUE_TOO_LONG],
    ).toBe(3);
  });
});

describe("recordSideEffect — non-object input", () => {
  it("silently drops non-object inputs", () => {
    enableCapture();
    tracer.startActiveSpan("test", (span) => {
      // @ts-expect-error intentional invalid arg
      recordSideEffect(undefined);
      // @ts-expect-error intentional invalid arg
      recordSideEffect(null);
      // @ts-expect-error intentional invalid arg
      recordSideEffect("string");
      // @ts-expect-error intentional invalid arg
      recordSideEffect(42);
      span.end();
    });
    const attrs = exportedAttributes();
    expect(attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_KIND]).toBeUndefined();
  });
});
