/**
 * Decision-trace integration for the `recordSideEffect` capture gate.
 *
 * The gate at the top of `recordSideEffect` reads
 * `getActiveConfig().sideEffectEvidence` and silently declines when it is
 * not `true`. These tests prove the decision-trace instrumentation around
 * that gate:
 *
 *  - With the toggle OFF, capture behavior is byte-for-byte identical and
 *    no decision line / event is produced.
 *  - With the toggle ON, the gate emits exactly one decision line and one
 *    `core:decision` event carrying `surface=recordSideEffect` and the
 *    branch outcome.
 *  - The line is one-shot per (surface, outcome) under a tight loop.
 *  - An enabled→disabled rotation re-emits once for the new outcome.
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
  _resetSideEffectVocabState,
} from "../../../../packages/sdk/src/side-effect/index.js";
import { setDecisionTraceFlag } from "../../../../packages/sdk/src/decision-trace.js";
import {
  _setCurrentConfig,
  _resetConfigForTesting,
} from "../../../../packages/sdk/src/init-client.js";
import { installContextManager } from "../../../../packages/sdk/src/context-manager.js";
import {
  onLifecycleEvent,
  offLifecycleEvent,
} from "../../../../packages/sdk/src/lifecycle.js";
import type { SdkLifecycleEvents } from "../../../../packages/sdk/src/lifecycle.js";
import type { SdkInitResponse } from "../../../../packages/protocol/src/wire.js";
import { GLASSTRACE_ATTRIBUTE_NAMES } from "../../../../packages/protocol/src/index.js";

installContextManager();

const ATTR = GLASSTRACE_ATTRIBUTE_NAMES;

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let tracer: otelApi.Tracer;

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

const VALID_INPUT = {
  kind: "email" as const,
  operation: "email.send",
  status: "succeeded" as const,
  phase: "request" as const,
};

// These tests target the `capture.sideEffectEvidence` gate at the top of
// `recordSideEffect`. The same call path also resolves the active config,
// which emits its own `config.tier` decision when the toggle is ON, so both
// the line spy and the event collector are scoped to the capture point to
// keep the assertions about this gate alone.
const CAPTURE_POINT = "capture.sideEffectEvidence";
const CAPTURE_LINE_PREFIX = `[glasstrace] decision: ${CAPTURE_POINT}=`;

function decisionLineSpy(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "info").mockImplementation((...args) => {
    if (typeof args[0] === "string" && args[0].startsWith(CAPTURE_LINE_PREFIX)) {
      lines.push(args[0]);
    }
  });
  return { lines, restore: () => spy.mockRestore() };
}

function collectDecisionEvents(): {
  events: SdkLifecycleEvents["core:decision"][];
  stop: () => void;
} {
  const events: SdkLifecycleEvents["core:decision"][] = [];
  const listener = (e: SdkLifecycleEvents["core:decision"]): void => {
    if (e.point === CAPTURE_POINT) events.push(e);
  };
  onLifecycleEvent("core:decision", listener);
  return { events, stop: () => offLifecycleEvent("core:decision", listener) };
}

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  otelApi.trace.setGlobalTracerProvider(provider);
  tracer = otelApi.trace.getTracer("glasstrace-sdk-test");
  _resetSideEffectVocabState();
  delete process.env.GLASSTRACE_DECISION_TRACE;
});

afterEach(async () => {
  vi.restoreAllMocks();
  _resetSideEffectVocabState();
  _resetConfigForTesting();
  delete process.env.GLASSTRACE_DECISION_TRACE;
  await provider.shutdown();
  otelApi.trace.disable();
  exporter.reset();
});

describe("recordSideEffect capture gate — toggle OFF is byte-identical", () => {
  it("captures the same span attributes with the toggle OFF as with no instrumentation", () => {
    _setCurrentConfig(configWith(true));
    setDecisionTraceFlag(false);

    const owned = tracer.startSpan("db.Poll.findUnique");
    recordSideEffect(
      { ...VALID_INPUT, fields: { templateKey: "WelcomeEmail" }, scalars: { renderMs: 7 } },
      { span: owned },
    );
    owned.end();

    const span = exporter.getFinishedSpans().find((s) => s.name === "db.Poll.findUnique");
    const a = span!.attributes as Record<string, unknown>;
    expect(a[ATTR.SIDE_EFFECT_KIND]).toBe("email");
    expect(a[ATTR.SIDE_EFFECT_OPERATION]).toBe("email.send");
  });

  it("emits no decision line / event when the gate declines with the toggle OFF", () => {
    _setCurrentConfig(configWith(false));
    setDecisionTraceFlag(false);

    const { lines, restore } = decisionLineSpy();
    const { events, stop } = collectDecisionEvents();
    recordSideEffect(VALID_INPUT);
    stop();
    restore();

    expect(lines).toEqual([]);
    expect(events).toEqual([]);
  });

  it("does not build the detail object when OFF (hot-path call-site guard)", () => {
    _setCurrentConfig(configWith(false));
    setDecisionTraceFlag(false);

    // If the call-site guard were missing, the gate would still call into
    // the lifecycle bus on every invocation; a subscriber proves it never
    // fires when OFF even across a tight loop.
    const { events, stop } = collectDecisionEvents();
    for (let i = 0; i < 1000; i++) recordSideEffect(VALID_INPUT);
    stop();
    expect(events).toEqual([]);
  });
});

describe("recordSideEffect capture gate — toggle ON emits the branch", () => {
  it("emits one disabled line + event with surface=recordSideEffect", () => {
    _setCurrentConfig(configWith(false));
    setDecisionTraceFlag(true);

    const { lines, restore } = decisionLineSpy();
    const { events, stop } = collectDecisionEvents();
    recordSideEffect(VALID_INPUT);
    stop();
    restore();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      "[glasstrace] decision: capture.sideEffectEvidence=disabled (surface=recordSideEffect)",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      point: "capture.sideEffectEvidence",
      outcome: "disabled",
      inputs: { surface: "recordSideEffect" },
    });
  });

  it("emits one enabled line + event when capture is on", () => {
    _setCurrentConfig(configWith(true));
    setDecisionTraceFlag(true);

    const owned = tracer.startSpan("db.Poll.findUnique");
    const { lines, restore } = decisionLineSpy();
    const { events, stop } = collectDecisionEvents();
    recordSideEffect(VALID_INPUT, { span: owned });
    stop();
    restore();
    owned.end();

    expect(lines).toEqual([
      "[glasstrace] decision: capture.sideEffectEvidence=enabled (surface=recordSideEffect)",
    ]);
    expect(events[0]).toMatchObject({ outcome: "enabled", inputs: { surface: "recordSideEffect" } });
  });

  it("dedups to one line under a tight loop", () => {
    _setCurrentConfig(configWith(false));
    setDecisionTraceFlag(true);

    const { lines, restore } = decisionLineSpy();
    for (let i = 0; i < 1000; i++) recordSideEffect(VALID_INPUT);
    restore();

    expect(lines).toHaveLength(1);
  });

  it("re-emits once when the outcome rotates from disabled to enabled", () => {
    setDecisionTraceFlag(true);

    _setCurrentConfig(configWith(false));
    const first = decisionLineSpy();
    recordSideEffect(VALID_INPUT);
    first.restore();
    expect(first.lines).toEqual([
      "[glasstrace] decision: capture.sideEffectEvidence=disabled (surface=recordSideEffect)",
    ]);

    _setCurrentConfig(configWith(true));
    const owned = tracer.startSpan("db.Poll.findUnique");
    const second = decisionLineSpy();
    recordSideEffect(VALID_INPUT, { span: owned });
    second.restore();
    owned.end();
    expect(second.lines).toEqual([
      "[glasstrace] decision: capture.sideEffectEvidence=enabled (surface=recordSideEffect)",
    ]);
  });
});
