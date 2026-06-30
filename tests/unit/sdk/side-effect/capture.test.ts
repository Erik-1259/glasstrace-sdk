/**
 * Behavior tests for the `capture(name, value, { span })` primitive.
 *
 * `capture` emits a single value-fidelity scalar onto a caller-OWNED span.
 * Unlike `recordSideEffect`, it never resolves the ambient active span, so
 * these tests assert:
 *
 *  - happy path: an allowlisted scalar lands on the supplied span as a
 *    NATIVE value (no stringify);
 *  - the full strict negative matrix routes to the correct omission reason
 *    on the supplied span, and the rejected value never appears;
 *  - the omission counter lands on the SUPPLIED span, never the active one;
 *  - capture-disabled ⇒ no scalar AND no omission counter;
 *  - an ended / non-recording supplied span ⇒ silent no-op, no counter, no
 *    throw.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as otelApi from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { capture } from "../../../../packages/sdk/src/side-effect/capture.js";
import {
  _setCurrentConfig,
  _resetConfigForTesting,
} from "../../../../packages/sdk/src/init-client.js";
import { installContextManager } from "../../../../packages/sdk/src/context-manager.js";
import type { SdkInitResponse } from "../../../../packages/protocol/src/wire.js";
import {
  GLASSTRACE_ATTRIBUTE_NAMES,
  SIDE_EFFECT_SCALAR_PREFIX,
} from "../../../../packages/protocol/src/index.js";

installContextManager();

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let tracer: otelApi.Tracer;

const NAMES = GLASSTRACE_ATTRIBUTE_NAMES;
const scalarKey = (k: string): string => `${SIDE_EFFECT_SCALAR_PREFIX}${k}`;

function configWith(sideEffectEvidence: boolean): SdkInitResponse {
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

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  otelApi.trace.setGlobalTracerProvider(provider);
  tracer = otelApi.trace.getTracer("glasstrace-capture-test");
  _setCurrentConfig(configWith(true));
});

afterEach(async () => {
  _resetConfigForTesting();
  await provider.shutdown();
  otelApi.trace.disable();
  exporter.reset();
});

/** Emit `value` under `key` onto a fresh owned span; return its attributes. */
function captureOnOwnedSpan(
  key: string,
  value: unknown,
): Record<string, unknown> {
  const span = tracer.startSpan("db.Test.findUnique");
  capture(key, value, { span });
  span.end();
  const finished = exporter.getFinishedSpans();
  return finished[finished.length - 1].attributes as Record<string, unknown>;
}

describe("capture — happy path (native scalar on the owned span)", () => {
  it("attaches a boolean *Flag natively", () => {
    const attrs = captureOnOwnedSpan("mutedFlag", false);
    expect(attrs[scalarKey("mutedFlag")]).toBe(false);
    expect(typeof attrs[scalarKey("mutedFlag")]).toBe("boolean");
  });

  it("attaches a numeric *Value natively (no stringify)", () => {
    const attrs = captureOnOwnedSpan("renderValue", 42);
    expect(attrs[scalarKey("renderValue")]).toBe(42);
    expect(typeof attrs[scalarKey("renderValue")]).toBe("number");
  });

  it("attaches a strict gthid_ *Id (fixed-length hex)", () => {
    const gthid = "gthid_" + "deadbeef".repeat(4); // 32 hex chars
    const attrs = captureOnOwnedSpan("ownerId", gthid);
    expect(attrs[scalarKey("ownerId")]).toBe(gthid);
  });
});

describe("capture — strict negative matrix (omission on the owned span, value never echoed)", () => {
  const cases: ReadonlyArray<{
    name: string;
    key: string;
    value: unknown;
    omitted: string;
  }> = [
    {
      name: "non-boolean on a *Flag key → raw_payload",
      key: "mutedFlag",
      value: "true",
      omitted: NAMES.SIDE_EFFECT_OMITTED_RAW_PAYLOAD,
    },
    {
      name: "Date instance → raw_timestamp",
      key: "createdMs",
      value: new Date(1_700_000_000_000),
      omitted: NAMES.SIDE_EFFECT_OMITTED_RAW_TIMESTAMP,
    },
    {
      name: "numeric epoch on a *Ms key → raw_timestamp",
      key: "createdMs",
      value: 1_700_000_000_000,
      omitted: NAMES.SIDE_EFFECT_OMITTED_RAW_TIMESTAMP,
    },
    {
      name: "ISO datetime STRING on a numeric key → raw_payload (not raw_timestamp)",
      key: "createdValue",
      value: "2026-01-01T00:00:00.000Z",
      omitted: NAMES.SIDE_EFFECT_OMITTED_RAW_PAYLOAD,
    },
    {
      name: "non-finite number → non_finite",
      key: "ratioValue",
      value: Number.POSITIVE_INFINITY,
      omitted: NAMES.SIDE_EFFECT_OMITTED_NON_FINITE,
    },
    {
      name: "unhashed (raw) *Id → unhashed_id",
      key: "ownerId",
      value: "plain-string",
      omitted: NAMES.SIDE_EFFECT_OMITTED_UNHASHED_ID,
    },
    {
      name: "unknown key suffix → unsupported_key",
      key: "bogusField",
      value: 1,
      omitted: NAMES.SIDE_EFFECT_OMITTED_UNSUPPORTED_KEY,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const attrs = captureOnOwnedSpan(c.key, c.value);
      // The omission counter is recorded on the supplied span.
      expect(attrs[c.omitted]).toBe(1);
      // The scalar was never attached.
      expect(attrs[scalarKey(c.key)]).toBeUndefined();
    });
  }

  it("an email-shaped *Id rejects as unhashed_id and never echoes the value", () => {
    const rejected = "user" + "@example.test";
    const span = tracer.startSpan("db.Test.findUnique");
    capture("ownerId", rejected, { span });
    span.end();
    const finished = exporter.getFinishedSpans();
    const serialized = JSON.stringify(
      finished.map((s) => ({ name: s.name, attributes: s.attributes })),
    );
    expect(serialized).not.toContain(rejected);
    const attrs = finished[finished.length - 1].attributes as Record<
      string,
      unknown
    >;
    expect(attrs[NAMES.SIDE_EFFECT_OMITTED_UNHASHED_ID]).toBe(1);
  });
});

describe("capture — owned-span isolation", () => {
  it("records the omission on the SUPPLIED span, never the active span", () => {
    tracer.startActiveSpan("active-request", (activeSpan) => {
      const owned = tracer.startSpan("db.Test.findUnique");
      // Reject on the owned span while a different span is active.
      capture("mutedFlag", "not-a-boolean", { span: owned });
      owned.end();
      activeSpan.end();
    });

    const finished = exporter.getFinishedSpans();
    const owned = finished.find((s) => s.name === "db.Test.findUnique");
    const active = finished.find((s) => s.name === "active-request");
    expect(owned?.attributes[NAMES.SIDE_EFFECT_OMITTED_RAW_PAYLOAD]).toBe(1);
    // The active span carries no side-effect attribute at all.
    for (const key of Object.keys(active?.attributes ?? {})) {
      expect(key.startsWith("glasstrace.side_effect.")).toBe(false);
    }
  });
});

describe("capture — fail-closed and caller-misuse guards", () => {
  it("captures nothing and records NO counter when sideEffectEvidence is off", () => {
    _setCurrentConfig(configWith(false));
    // Pass an invalid value too: even the omission path must stay silent.
    const okAttrs = captureOnOwnedSpan("mutedFlag", false);
    const rejectAttrs = captureOnOwnedSpan("mutedFlag", "not-a-boolean");
    expect(okAttrs[scalarKey("mutedFlag")]).toBeUndefined();
    for (const attrs of [okAttrs, rejectAttrs]) {
      for (const key of Object.keys(attrs)) {
        expect(key.startsWith("glasstrace.side_effect.")).toBe(false);
      }
    }
  });

  it("is a silent no-op (no throw, no scalar) on an already-ended span", () => {
    const span = tracer.startSpan("db.Test.findUnique");
    span.end();
    expect(() => capture("mutedFlag", false, { span })).not.toThrow();
    const finished = exporter.getFinishedSpans();
    const attrs = finished[finished.length - 1].attributes as Record<
      string,
      unknown
    >;
    expect(attrs[scalarKey("mutedFlag")]).toBeUndefined();
  });

  it("never throws on a missing span option", () => {
    expect(() =>
      capture("mutedFlag", false, { span: undefined as unknown as otelApi.Span }),
    ).not.toThrow();
  });
});

describe("capture — per-span scalar budget", () => {
  it("attaches up to the 16-scalar budget then omits the overflow as scalar_cap_exceeded", () => {
    const span = tracer.startSpan("db.Test.findUnique");
    // 20 distinct, valid boolean *Flag scalars on one owned span.
    for (let i = 0; i < 20; i++) {
      capture(`feature${i}Flag`, i % 2 === 0, { span });
    }
    span.end();

    const finished = exporter.getFinishedSpans();
    const attrs = finished[finished.length - 1].attributes as Record<
      string,
      unknown
    >;
    const scalarCount = Object.keys(attrs).filter((k) =>
      k.startsWith(SIDE_EFFECT_SCALAR_PREFIX),
    ).length;

    expect(scalarCount).toBe(16); // capped at the per-operation budget
    expect(attrs[NAMES.SIDE_EFFECT_OMITTED_SCALAR_CAP_EXCEEDED]).toBe(4); // 20 - 16
    expect(attrs[NAMES.SIDE_EFFECT_OMITTED_VALUE_TOO_LONG]).toBeUndefined();
  });
});
