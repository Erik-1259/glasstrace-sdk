/**
 * Round-trip emission test for `recordSideEffect()` (SDK-049).
 *
 * Drives the full path: opt in via the cached config helper, start a
 * recording span, emit a happy-path call alongside a rejection-path
 * call, end the span, read the exported attributes, and assert:
 *
 *  - the expected `glasstrace.side_effect.*` attribute set is present;
 *  - no rejected value appears anywhere on the span attribute set or
 *    on the JSON-serialized span snapshot;
 *  - no attribute under `glasstrace.side_effect.*` exists outside the
 *    allowlisted wire-string set.
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
import {
  GLASSTRACE_ATTRIBUTE_NAMES,
  MAX_SIDE_EFFECT_SCALARS_PER_OPERATION,
  SIDE_EFFECT_SCALAR_PREFIX,
} from "../../../../packages/protocol/src/index.js";

// Install the AsyncLocalStorage context manager so `startActiveSpan`
// propagates the span into `otelApi.trace.getActiveSpan()`.
installContextManager();

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let tracer: otelApi.Tracer;

const ALLOWLISTED_WIRE_KEYS: ReadonlyArray<string> = [
  GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_KIND,
  GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OPERATION,
  GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_STATUS,
  GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_PHASE,
  GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_TEMPLATE_KEY,
  GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_PROVIDER_OPERATION,
  GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_ROLE,
  GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_LOCALE,
  GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_TIMEZONE,
  GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_STATUS,
  GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_PHASE,
  GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_PII,
  GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_SECRET,
  GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_RAW_PAYLOAD,
  GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_UNSUPPORTED_KEY,
  GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_VALUE_TOO_LONG,
  GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_NOT_EMITTED,
  GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_CAPTURE_DISABLED,
  GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_RAW_TIMESTAMP,
  GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_UNHASHED_ID,
  GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_NON_FINITE,
];

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  otelApi.trace.setGlobalTracerProvider(provider);
  tracer = otelApi.trace.getTracer("glasstrace-sdk-test");

  const response: SdkInitResponse = {
    config: {
      requestBodies: false,
      queryParamValues: false,
      envVarValues: false,
      fullConsoleOutput: false,
      importGraph: false,
      consoleErrors: false,
      errorResponseBodies: false,
      sideEffectEvidence: true,
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
  _setCurrentConfig(response);
});

afterEach(async () => {
  _resetConfigForTesting();
  await provider.shutdown();
  otelApi.trace.disable();
  exporter.reset();
});

describe("recordSideEffect — round trip", () => {
  it("emits exactly the expected attribute set and never echoes rejected values", () => {
    // Construct the rejected URL inline so it never lives in a
    // fixture file or appears as a string literal at module scope.
    const rejectedUrl = "https" + "://example.test/admin?token=abc";
    const rejectedEmail = "user" + "@example.test";

    tracer.startActiveSpan("round-trip", (span) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        status: "succeeded",
        phase: "request",
        fields: {
          templateKey: "EventCanceledEmail",
          providerOperation: "sendTemplate",
          role: "invitee",
          locale: "en-US",
          timezone: "Europe/Paris",
        },
      });
      // Rejection-path call alongside the happy path.
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        // @ts-expect-error intentional unsupported key for the test
        fields: { recipient: rejectedEmail, role: rejectedUrl },
      });
      span.end();
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const attrs = spans[0].attributes as Record<string, unknown>;

    // Top-level operation attributes attached.
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

    // Allowlisted semantic field attributes attached.
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_TEMPLATE_KEY],
    ).toBe("EventCanceledEmail");
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_PROVIDER_OPERATION],
    ).toBe("sendTemplate");
    expect(attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_ROLE]).toBe(
      "invitee",
    );
    expect(attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_LOCALE]).toBe(
      "en-US",
    );
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_FIELD_TIMEZONE],
    ).toBe("Europe/Paris");

    // Omission counters present from the rejection-path call.
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_UNSUPPORTED_KEY],
    ).toBe(1);
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_RAW_PAYLOAD],
    ).toBe(1);

    // Every glasstrace.side_effect.* attribute key on the span is in
    // the allowlisted wire-string set.
    for (const key of Object.keys(attrs)) {
      if (key.startsWith("glasstrace.side_effect.")) {
        expect(ALLOWLISTED_WIRE_KEYS).toContain(key);
      }
    }

    // Rejected values appear nowhere on the serialized span data.
    // Extract a JSON-safe shape so we can string-search the entire
    // span tree without tripping over OTel's internal circular
    // references between spans, processors, and exporters.
    const serialized = JSON.stringify(
      spans.map((s) => ({
        name: s.name,
        attributes: s.attributes,
        events: s.events,
        status: s.status,
        spanContext: s.spanContext(),
      })),
    );
    expect(serialized).not.toContain(rejectedUrl);
    expect(serialized).not.toContain(rejectedEmail);
    expect(serialized).not.toContain("recipient");
  });

  it("does not emit anything outside the allowlisted attribute set when capture is enabled but the call is fully rejected", () => {
    const unsafe = "Bearer " + "abc.def.ghi";
    tracer.startActiveSpan("rejected-only", (span) => {
      recordSideEffect({
        kind: "email",
        operation: unsafe,
        fields: { templateKey: unsafe },
      });
      span.end();
    });

    const spans = exporter.getFinishedSpans();
    const attrs = spans[0].attributes as Record<string, unknown>;
    // No top-level operation attributes attached because the
    // operation label was rejected before any attach.
    expect(attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_KIND]).toBeUndefined();
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OPERATION],
    ).toBeUndefined();

    // Omission counter for the rejected operation label present.
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_SECRET],
    ).toBe(1);

    // Rejected substring never appears anywhere on the span tree.
    const serialized = JSON.stringify(
      spans.map((s) => ({
        name: s.name,
        attributes: s.attributes,
        events: s.events,
        status: s.status,
        spanContext: s.spanContext(),
      })),
    );
    expect(serialized).not.toContain("abc.def.ghi");
  });
});

describe("recordSideEffect — scalar channel round trip", () => {
  it("emits accepted scalars as native-typed attributes and counts rejections", () => {
    const rawId = "user_" + "999";
    tracer.startActiveSpan("scalar-round-trip", (span) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        fields: { templateKey: "Welcome" },
        scalars: {
          renderMs: 42, // accepted number
          hadAttachmentFlag: true, // accepted boolean
          attemptValue: 3, // accepted number
          createdMs: 1_700_000_000_000, // rejected: raw epoch
          actorId: rawId, // rejected: unhashed id
          scoreValue: Number.NaN, // rejected: non-finite
        },
      });
      span.end();
    });

    const span = exporter.getFinishedSpans()[0];
    const attrs = span.attributes as Record<string, unknown>;

    // Accepted scalars carry NATIVE types (the product validator rejects
    // numeric-/boolean-shaped strings, so stringify would break parity).
    expect(attrs[`${SIDE_EFFECT_SCALAR_PREFIX}renderMs`]).toBe(42);
    expect(typeof attrs[`${SIDE_EFFECT_SCALAR_PREFIX}renderMs`]).toBe("number");
    expect(attrs[`${SIDE_EFFECT_SCALAR_PREFIX}hadAttachmentFlag`]).toBe(true);
    expect(typeof attrs[`${SIDE_EFFECT_SCALAR_PREFIX}hadAttachmentFlag`]).toBe(
      "boolean",
    );
    expect(attrs[`${SIDE_EFFECT_SCALAR_PREFIX}attemptValue`]).toBe(3);
    expect(typeof attrs[`${SIDE_EFFECT_SCALAR_PREFIX}attemptValue`]).toBe(
      "number",
    );

    // Rejected scalars never reach the wire.
    expect(attrs[`${SIDE_EFFECT_SCALAR_PREFIX}createdMs`]).toBeUndefined();
    expect(attrs[`${SIDE_EFFECT_SCALAR_PREFIX}actorId`]).toBeUndefined();

    // Each rejection bumped its omission counter (integer count only).
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_RAW_TIMESTAMP],
    ).toBe(1);
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_UNHASHED_ID],
    ).toBe(1);
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_NON_FINITE],
    ).toBe(1);

    // Closed-world invariant: every `glasstrace.side_effect.*` attribute
    // is either an allowlisted wire key or a `scalar.*` key — no stray
    // attribute leaks from the scalar path.
    for (const k of Object.keys(attrs)) {
      if (!k.startsWith("glasstrace.side_effect.")) continue;
      const ok =
        ALLOWLISTED_WIRE_KEYS.includes(k) ||
        k.startsWith(SIDE_EFFECT_SCALAR_PREFIX);
      expect(ok, `unexpected side-effect attribute: ${k}`).toBe(true);
    }

    // The raw rejected id never appears anywhere on the span's
    // attribute set (where a leaked value would surface).
    expect(JSON.stringify(attrs)).not.toContain(rawId);
  });

  it("enforces the per-operation scalar cap", () => {
    const scalars: Record<string, number> = {};
    for (let i = 0; i < MAX_SIDE_EFFECT_SCALARS_PER_OPERATION + 3; i++) {
      scalars[`metric${i}Value`] = i;
    }

    tracer.startActiveSpan("scalar-cap", (span) => {
      recordSideEffect({ kind: "email", operation: "email.send", scalars });
      span.end();
    });

    const attrs = exporter.getFinishedSpans()[0].attributes as Record<
      string,
      unknown
    >;
    const scalarKeys = Object.keys(attrs).filter((k) =>
      k.startsWith(SIDE_EFFECT_SCALAR_PREFIX),
    );
    expect(scalarKeys).toHaveLength(MAX_SIDE_EFFECT_SCALARS_PER_OPERATION);
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_VALUE_TOO_LONG],
    ).toBe(1);
  });

  it("counts rejected scalars against the per-operation budget", () => {
    // The cap counts every processed entry, accepted or rejected, so a
    // burst of rejections exhausts the budget and a later valid scalar is
    // dropped (over-budget) rather than emitted.
    const scalars: Record<string, unknown> = {};
    for (let i = 0; i < MAX_SIDE_EFFECT_SCALARS_PER_OPERATION; i++) {
      scalars[`flag${i}Flag`] = i; // number on *Flag → raw_payload
    }
    scalars.lateValue = 7; // a valid scalar, but the budget is spent

    tracer.startActiveSpan("scalar-budget", (span) => {
      recordSideEffect({ kind: "email", operation: "email.send", scalars });
      span.end();
    });

    const attrs = exporter.getFinishedSpans()[0].attributes as Record<
      string,
      unknown
    >;
    // No scalar emitted — all 16 slots consumed by rejections.
    expect(
      Object.keys(attrs).filter((k) => k.startsWith(SIDE_EFFECT_SCALAR_PREFIX)),
    ).toHaveLength(0);
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_RAW_PAYLOAD],
    ).toBe(MAX_SIDE_EFFECT_SCALARS_PER_OPERATION);
    expect(
      attrs[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_VALUE_TOO_LONG],
    ).toBe(1);
  });
});
