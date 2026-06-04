/**
 * Vocabulary-governance signal tests for `recordSideEffect()`:
 *
 * - **Mixed-casing warn** for `*Class` / `*Role` values that deviate
 *   from the lowercase-kebab convention. Warn fires at most once per
 *   (key, casing-pattern) pair per process; emission still succeeds.
 * - **Pattern-key proliferation warn** that fires once per process
 *   when the count of distinct pattern-admitted keys (those without
 *   an explicit `FIELD_ATTRIBUTE_BY_KEY` entry) crosses the threshold
 *   of 50. Gated on the `verbose` flag set via
 *   `registerGlasstrace({ verbose: true })`; defaults to off.
 *
 * Tests run against a real in-memory OTel tracer to exercise the full
 * `recordSideEffect()` code path; the warns must not break emission,
 * and emission must still produce the expected span attributes.
 *
 * Each test resets the module-scope vocabulary state via
 * `_resetSideEffectVocabState()` so dedup state does not leak across
 * test cases.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as otelApi from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  recordSideEffect,
  setSideEffectVerboseFlag,
  _resetSideEffectVocabState,
} from "../../../../packages/sdk/src/side-effect/index.js";
import {
  _setCurrentConfig,
  _resetConfigForTesting,
} from "../../../../packages/sdk/src/init-client.js";
import { installContextManager } from "../../../../packages/sdk/src/context-manager.js";
import type { SdkInitResponse } from "../../../../packages/protocol/src/wire.js";

installContextManager();

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let tracer: otelApi.Tracer;
let warnSpy: ReturnType<typeof vi.spyOn>;

function makeInitResponse(): SdkInitResponse {
  return {
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
}

beforeEach(() => {
  _resetSideEffectVocabState();
  _setCurrentConfig(makeInitResponse());
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  otelApi.trace.setGlobalTracerProvider(provider);
  tracer = otelApi.trace.getTracer("glasstrace-vocab-test");
});

afterEach(async () => {
  _resetConfigForTesting();
  warnSpy.mockRestore();
  await provider.shutdown();
  otelApi.trace.disable();
  exporter.reset();
});

// ---------------------------------------------------------------------------
// DISC-1878 — mixed-casing warn
// ---------------------------------------------------------------------------

describe("recordSideEffect — DISC-1878 value-casing warn", () => {
  it("warns once when a *Class value uses uppercase casing", () => {
    tracer.startActiveSpan("test", (span) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        fields: { recipientClass: "REMOVED-PARTICIPANT" },
      });
      span.end();
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnArg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnArg).toMatch(/^\[glasstrace\]/);
    expect(warnArg).toContain("recipientClass");
    expect(warnArg).toContain("uppercase");
    expect(warnArg).toContain("lowercase-kebab");
    // PII safety — value must not appear in the warn message
    expect(warnArg).not.toContain("REMOVED-PARTICIPANT");
  });

  it("warns once when a *Class value uses mixed casing", () => {
    tracer.startActiveSpan("test", (span) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        fields: { recipientClass: "RemovedParticipant" },
      });
      span.end();
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("mixed");
  });

  it("does NOT warn when a *Class value is lowercase-kebab", () => {
    tracer.startActiveSpan("test", (span) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        fields: { recipientClass: "removed-participant" },
      });
      span.end();
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns once per (key, casing-pattern) pair across multiple calls", () => {
    // Same key + same casing-pattern → one warn total
    tracer.startActiveSpan("t1", (s) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        fields: { recipientClass: "REMOVED-PARTICIPANT" },
      });
      s.end();
    });
    tracer.startActiveSpan("t2", (s) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        fields: { recipientClass: "ALSO-UPPERCASE" },
      });
      s.end();
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("warns separately for distinct casing patterns on the same key", () => {
    // Uppercase first
    tracer.startActiveSpan("t1", (s) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        fields: { recipientClass: "REMOVED-PARTICIPANT" },
      });
      s.end();
    });
    // Then mixed — distinct pattern → second warn
    tracer.startActiveSpan("t2", (s) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        fields: { recipientClass: "RemovedParticipant" },
      });
      s.end();
    });
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("uppercase");
    expect(warnSpy.mock.calls[1]?.[0]).toContain("mixed");
  });

  it("warns once when a *Role value uses uppercase casing", () => {
    tracer.startActiveSpan("test", (span) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        fields: { actorRole: "INVITEE" },
      });
      span.end();
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnArg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnArg).toContain("actorRole");
    expect(warnArg).toContain("uppercase");
    // PII safety — value must not appear in the warn message
    expect(warnArg).not.toContain("INVITEE");
  });

  it("warns separately for the same casing across *Class and *Role keys", () => {
    // Each key has its own dedup map, so the same casing-pattern on
    // a different key warns separately. This regression test ensures
    // the *Role suffix path is wired independently of *Class.
    tracer.startActiveSpan("t1", (s) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        fields: { recipientClass: "ALL-UPPERCASE" },
      });
      s.end();
    });
    tracer.startActiveSpan("t2", (s) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        fields: { actorRole: "ALL-UPPERCASE" },
      });
      s.end();
    });
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("recipientClass");
    expect(warnSpy.mock.calls[1]?.[0]).toContain("actorRole");
  });

  it("does NOT warn on *Count keys (digit-only convention)", () => {
    tracer.startActiveSpan("test", (span) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        fields: { participantCount: "42" },
      });
      span.end();
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does NOT warn on stable-core keys with mixed casing in value", () => {
    // `locale` has its own BCP-47 validator (LOCALE_REGEX) — values
    // like "en-US" are valid per spec and must not trigger the
    // lowercase-kebab warn.
    tracer.startActiveSpan("test", (span) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        fields: { locale: "en-US" },
      });
      span.end();
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("caps the dedup map at 100 keys; new keys are silently skipped past the cap", () => {
    // High-cardinality producer scenario: emit 150 distinct *Class
    // keys, each with uppercase values. The first 100 should each
    // warn once; keys 101-150 should be silently skipped (no warn,
    // no map growth). This bounds the dedup memory budget.
    for (let i = 0; i < 150; i++) {
      tracer.startActiveSpan(`t-${i}`, (s) => {
        recordSideEffect({
          kind: "email",
          operation: "email.send",
          fields: { [`k${i}Class`]: "UPPERCASE-VALUE" },
        });
        s.end();
      });
    }
    // Filter to casing warns only (proliferation warn is gated on
    // verbose=false here, so only casing warns should appear).
    const casingWarns = warnSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("unexpected casing") ||
        (typeof call[0] === "string" &&
          (call[0] as string).includes("lowercase-kebab")),
    );
    // Exactly 100 warns — one per tracked key, capped at 100
    expect(casingWarns.length).toBe(100);
    // All 150 spans should still have their attributes attached
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(150);
  });

  it("emission still succeeds even when console.warn throws", () => {
    // Defense-in-depth: a host that replaces console.warn with a
    // throwing implementation must not be able to disrupt the emit
    // path. The contract is "accepted side-effect fields land on
    // the span even when the governance signal can't be delivered".
    warnSpy.mockImplementation(() => {
      throw new Error("host replaced console.warn with a throwing impl");
    });
    tracer.startActiveSpan("test", (span) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        fields: { recipientClass: "REMOVED-PARTICIPANT" },
      });
      span.end();
    });
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);
    const attrs = spans[0].attributes as Record<string, unknown>;
    expect(attrs["glasstrace.side_effect.field.recipientClass"]).toBe(
      "REMOVED-PARTICIPANT",
    );
  });

  it("emission still attaches the field to the span when the warn fires", () => {
    tracer.startActiveSpan("test", (span) => {
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        fields: { recipientClass: "REMOVED-PARTICIPANT" },
      });
      span.end();
    });
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);
    const attrs = spans[0].attributes as Record<string, unknown>;
    expect(attrs["glasstrace.side_effect.field.recipientClass"]).toBe(
      "REMOVED-PARTICIPANT",
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// DISC-1879 — pattern-key proliferation warn
// ---------------------------------------------------------------------------

describe("recordSideEffect — DISC-1879 pattern-key proliferation warn", () => {
  it("does NOT warn when verbose is off (default)", () => {
    setSideEffectVerboseFlag(false);
    for (let i = 0; i < 60; i++) {
      tracer.startActiveSpan(`t-${i}`, (s) => {
        recordSideEffect({
          kind: "email",
          operation: "email.send",
          fields: { [`k${i}Class`]: "v" },
        });
        s.end();
      });
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("fires once when verbose=true and threshold (50) is crossed", () => {
    setSideEffectVerboseFlag(true);
    for (let i = 0; i < 60; i++) {
      tracer.startActiveSpan(`t-${i}`, (s) => {
        recordSideEffect({
          kind: "email",
          operation: "email.send",
          fields: { [`k${i}Class`]: "v" },
        });
        s.end();
      });
    }
    // The proliferation warn fires exactly once when the count
    // crosses the threshold. Casing warns may also fire (the test
    // keys all use lowercase, so no casing warn is expected).
    const proliferationWarns = warnSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("distinct pattern-admitted field keys"),
    );
    expect(proliferationWarns.length).toBe(1);
    const message = proliferationWarns[0]?.[0] as string;
    expect(message).toMatch(/^\[glasstrace\]/);
    expect(message).toContain("50");
    expect(message).toContain("vocabulary review");
  });

  it("does NOT count stable-core keys toward the threshold", () => {
    setSideEffectVerboseFlag(true);
    // 60 emissions of stable-core `templateKey` should never trip
    // the proliferation warn — stable-core has an explicit
    // FIELD_ATTRIBUTE_BY_KEY entry and never counts.
    for (let i = 0; i < 60; i++) {
      tracer.startActiveSpan(`t-${i}`, (s) => {
        recordSideEffect({
          kind: "email",
          operation: "email.send",
          fields: { templateKey: `Template${i}` },
        });
        s.end();
      });
    }
    const proliferationWarns = warnSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("distinct pattern-admitted field keys"),
    );
    expect(proliferationWarns.length).toBe(0);
  });

  it("does NOT count DISC-1853-era keys toward the threshold", () => {
    setSideEffectVerboseFlag(true);
    // recipientClass, participantCount, activeParticipantCount each
    // have explicit FIELD_ATTRIBUTE_BY_KEY entries from DISC-1853 —
    // they must not count toward the proliferation cap even though
    // they match the open-pattern regex by suffix.
    for (let i = 0; i < 60; i++) {
      tracer.startActiveSpan(`t-${i}`, (s) => {
        recordSideEffect({
          kind: "email",
          operation: "email.send",
          fields: {
            recipientClass: "removed-participant",
            participantCount: String(i),
          },
        });
        s.end();
      });
    }
    const proliferationWarns = warnSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("distinct pattern-admitted field keys"),
    );
    expect(proliferationWarns.length).toBe(0);
  });

  it("is one-shot per process — does not refire after the first warn", () => {
    setSideEffectVerboseFlag(true);
    for (let i = 0; i < 100; i++) {
      tracer.startActiveSpan(`t-${i}`, (s) => {
        recordSideEffect({
          kind: "email",
          operation: "email.send",
          fields: { [`k${i}Class`]: "v" },
        });
        s.end();
      });
    }
    const proliferationWarns = warnSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("distinct pattern-admitted field keys"),
    );
    expect(proliferationWarns.length).toBe(1);
  });

  it("warn message lists the most-recent 5 keys (not all observed)", () => {
    setSideEffectVerboseFlag(true);
    for (let i = 0; i < 60; i++) {
      tracer.startActiveSpan(`t-${i}`, (s) => {
        recordSideEffect({
          kind: "email",
          operation: "email.send",
          fields: { [`k${i}Class`]: "v" },
        });
        s.end();
      });
    }
    const proliferationWarn = warnSpy.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("distinct pattern-admitted field keys"),
    );
    const message = proliferationWarn?.[0] as string;
    // The warn fires when count crosses threshold (i.e., reaches 50).
    // The most-recent 5 keys are k45Class..k49Class.
    expect(message).toContain("k45Class");
    expect(message).toContain("k49Class");
    // Earlier keys not in the recent-5 window
    expect(message).not.toContain("k0Class,");
  });

  it("emission still succeeds for all keys above the threshold", () => {
    setSideEffectVerboseFlag(true);
    for (let i = 0; i < 60; i++) {
      tracer.startActiveSpan(`t-${i}`, (s) => {
        recordSideEffect({
          kind: "email",
          operation: "email.send",
          fields: { [`k${i}Class`]: "v" },
        });
        s.end();
      });
    }
    const spans = exporter.getFinishedSpans();
    // All 60 spans landed, each with the dynamic field attribute
    expect(spans.length).toBe(60);
    const lastSpanAttrs = spans[spans.length - 1].attributes as Record<
      string,
      unknown
    >;
    expect(lastSpanAttrs["glasstrace.side_effect.field.k59Class"]).toBe("v");
  });
});
