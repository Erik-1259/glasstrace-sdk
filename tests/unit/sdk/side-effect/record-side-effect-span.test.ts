/**
 * Owned-span variant + no-active-span diagnostic for `recordSideEffect()`.
 *
 * Covers:
 *  - the owned-span option: `recordSideEffect(input, { span })` attaches the
 *    full categorical operation onto a caller-owned span with NO ambient span
 *    present, routes pre-attach omissions onto it, honors the per-span
 *    operation budget, never falls back to the ambient span for a dead
 *    supplied span; backward-compat (no options ⇒ ambient); a shared span
 *    composes with `capture()`.
 *  - the diagnostic: a one-time, verbose-gated `console.warn` on the genuine
 *    no-recording-span drop; silent when verbose is off / capture is disabled
 *    / the kind is invalid.
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
import { capture } from "../../../../packages/sdk/src/side-effect/capture.js";
import {
  _setCurrentConfig,
  _resetConfigForTesting,
} from "../../../../packages/sdk/src/init-client.js";
import { installContextManager } from "../../../../packages/sdk/src/context-manager.js";
import { MAX_SIDE_EFFECT_OPERATIONS_PER_SPAN } from "../../../../packages/sdk/src/side-effect/allowlist.js";
import type { SdkInitResponse } from "../../../../packages/protocol/src/wire.js";
import {
  GLASSTRACE_ATTRIBUTE_NAMES,
  MAX_SIDE_EFFECT_SCALARS_PER_OPERATION,
  SIDE_EFFECT_SCALAR_PREFIX,
} from "../../../../packages/protocol/src/index.js";

installContextManager();

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let tracer: otelApi.Tracer;

const ATTR = GLASSTRACE_ATTRIBUTE_NAMES;

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
  tracer = otelApi.trace.getTracer("glasstrace-sdk-test");
  _setCurrentConfig(configWith(true));
  _resetSideEffectVocabState();
});

afterEach(async () => {
  vi.restoreAllMocks();
  _resetSideEffectVocabState();
  _resetConfigForTesting();
  await provider.shutdown();
  otelApi.trace.disable();
  exporter.reset();
});

/** Attributes of the one finished span named `name`. */
function attrsOf(name: string): Record<string, unknown> {
  const span = exporter.getFinishedSpans().find((s) => s.name === name);
  expect(span).toBeDefined();
  return span!.attributes as Record<string, unknown>;
}

describe("recordSideEffect — owned-span variant", () => {
  it("attaches the full operation onto a supplied owned span with NO ambient span present", () => {
    expect(otelApi.trace.getActiveSpan()).toBeUndefined();
    const owned = tracer.startSpan("db.Poll.findUnique");
    recordSideEffect(
      {
        kind: "email",
        operation: "email.send",
        status: "succeeded",
        phase: "request",
        fields: { templateKey: "EventCanceledEmail", role: "invitee" },
        scalars: { renderMs: 42 },
      },
      { span: owned },
    );
    owned.end();

    const a = attrsOf("db.Poll.findUnique");
    expect(a[ATTR.SIDE_EFFECT_KIND]).toBe("email");
    expect(a[ATTR.SIDE_EFFECT_OPERATION]).toBe("email.send");
    expect(a[ATTR.SIDE_EFFECT_STATUS]).toBe("succeeded");
    expect(a[ATTR.SIDE_EFFECT_PHASE]).toBe("request");
    expect(a[ATTR.SIDE_EFFECT_FIELD_TEMPLATE_KEY]).toBe("EventCanceledEmail");
    expect(a[ATTR.SIDE_EFFECT_FIELD_ROLE]).toBe("invitee");
    expect(a[`${SIDE_EFFECT_SCALAR_PREFIX}renderMs`]).toBe(42);
  });

  it("routes a pre-attach omission (rejected status) onto the OWNED span, not silently", () => {
    const owned = tracer.startSpan("owned");
    recordSideEffect(
      // @ts-expect-error intentional out-of-allowlist status
      { kind: "email", operation: "email.send", status: "bogus" },
      { span: owned },
    );
    owned.end();

    const a = attrsOf("owned");
    // The operation still attached; the bad status routed to an omission
    // counter on the owned span — it must NOT silently land on a (missing)
    // ambient span.
    expect(a[ATTR.SIDE_EFFECT_KIND]).toBe("email");
    expect(a[ATTR.SIDE_EFFECT_OMITTED_UNSUPPORTED_KEY]).toBe(1);
    expect(a[ATTR.SIDE_EFFECT_STATUS]).toBeUndefined();
  });

  it("honors the per-span operation budget on the owned span (over-budget ⇒ value_too_long)", () => {
    const owned = tracer.startSpan("owned");
    for (let i = 0; i < MAX_SIDE_EFFECT_OPERATIONS_PER_SPAN + 1; i++) {
      recordSideEffect(
        { kind: "email", operation: `email.send.${i}` },
        { span: owned },
      );
    }
    owned.end();

    const a = attrsOf("owned");
    // 5 attached; the 6th over-budgeted and recorded one value_too_long.
    expect(a[ATTR.SIDE_EFFECT_OMITTED_VALUE_TOO_LONG]).toBe(1);
  });

  it("honors the per-operation scalar budget on the owned span (over-budget ⇒ scalar_cap_exceeded)", () => {
    const owned = tracer.startSpan("owned");
    const scalars: Record<string, boolean> = {};
    for (let i = 0; i < MAX_SIDE_EFFECT_SCALARS_PER_OPERATION + 4; i++) {
      scalars[`feature${i}Flag`] = i % 2 === 0;
    }

    recordSideEffect(
      { kind: "email", operation: "email.send", scalars },
      { span: owned },
    );
    owned.end();

    const a = attrsOf("owned");
    const scalarCount = Object.keys(a).filter((key) =>
      key.startsWith(SIDE_EFFECT_SCALAR_PREFIX),
    ).length;
    expect(scalarCount).toBe(MAX_SIDE_EFFECT_SCALARS_PER_OPERATION);
    expect(a[ATTR.SIDE_EFFECT_OMITTED_SCALAR_CAP_EXCEEDED]).toBe(1);
    expect(a[ATTR.SIDE_EFFECT_OMITTED_VALUE_TOO_LONG]).toBeUndefined();
  });

  it("does NOT fall back to the ambient span when the supplied span is non-recording", () => {
    tracer.startActiveSpan("request", (active) => {
      const owned = tracer.startSpan("owned");
      owned.end(); // now non-recording
      recordSideEffect(
        { kind: "email", operation: "email.send" },
        { span: owned },
      );
      active.end();
    });

    // The active (ambient) span received nothing — no silent fallback.
    const a = attrsOf("request");
    expect(a[ATTR.SIDE_EFFECT_KIND]).toBeUndefined();
  });

  it("backward-compat: with no options, attaches to the ambient active span", () => {
    tracer.startActiveSpan("request", (active) => {
      recordSideEffect({ kind: "email", operation: "email.send" });
      active.end();
    });
    expect(attrsOf("request")[ATTR.SIDE_EFFECT_KIND]).toBe("email");
  });

  it("shares one owned span with capture() without cross-write interference", () => {
    const owned = tracer.startSpan("owned");
    recordSideEffect({ kind: "email", operation: "email.send" }, { span: owned });
    capture("renderMs", 7, { span: owned });
    owned.end();

    // Both writers target the same span; the operation and the value-fidelity
    // scalar coexist (each path keeps its own per-call/per-span counter).
    const a = attrsOf("owned");
    expect(a[ATTR.SIDE_EFFECT_KIND]).toBe("email");
    expect(a[`${SIDE_EFFECT_SCALAR_PREFIX}renderMs`]).toBe(7);
  });
});

describe("recordSideEffect — no-active-span diagnostic", () => {
  it("emits a one-time verbose diagnostic when no recording span is available", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setSideEffectVerboseFlag(true);
    expect(otelApi.trace.getActiveSpan()).toBeUndefined();

    recordSideEffect({ kind: "email", operation: "email.send" });
    recordSideEffect({ kind: "email", operation: "email.send" });

    expect(warn).toHaveBeenCalledTimes(1); // deduped one-shot
    expect(String(warn.mock.calls[0][0])).toContain(
      "no recording active span",
    );
  });

  it("is silent when verbose is off", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setSideEffectVerboseFlag(false);
    recordSideEffect({ kind: "email", operation: "email.send" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn when capture is disabled (config gate precedes span resolution)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setSideEffectVerboseFlag(true);
    _setCurrentConfig(configWith(false));
    recordSideEffect({ kind: "email", operation: "email.send" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn for an invalid kind (no valid call, nothing to diagnose)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setSideEffectVerboseFlag(true);
    // @ts-expect-error intentional out-of-allowlist kind
    recordSideEffect({ kind: "not-a-kind", operation: "email.send" });
    expect(warn).not.toHaveBeenCalled();
  });
});
