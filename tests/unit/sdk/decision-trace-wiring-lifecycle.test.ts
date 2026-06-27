/**
 * Decision-trace wiring for the registration / OTel-config / exporter
 * lifecycle points.
 *
 * Covers the points that are decided during SDK bring-up and span export:
 *  - `env.forceEnable`, `feature.discovery`, `feature.consoleErrors` via the
 *    real `registerGlasstrace` path (mock transport, fresh temp cwd);
 *  - `otel.path` via `configureOtel` (bare vs coexistence provider);
 *  - `feature.errorResponseBodies` via the enriching exporter's per-span gate.
 *
 * Each point asserts ON emits the documented outcome and OFF (default) is
 * silent — bring-up behavior is unchanged.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as otelApi from "@opentelemetry/api";
import * as otelSdk from "@opentelemetry/sdk-trace-base";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { ExportResult } from "@opentelemetry/core";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { CaptureConfig, SdkInitResponse } from "@glasstrace/protocol";
import {
  registerGlasstrace,
  _resetRegistrationForTesting,
} from "../../../packages/sdk/src/register.js";
import {
  configureOtel,
  resetOtelConfigForTesting,
} from "../../../packages/sdk/src/otel-config.js";
import { SessionManager } from "../../../packages/sdk/src/session.js";
import { GlasstraceExporter } from "../../../packages/sdk/src/enriching-exporter.js";
import {
  _resetConfigForTesting,
  _setTransportForTesting,
} from "../../../packages/sdk/src/init-client.js";
import type { HttpsPostJsonResult } from "../../../packages/sdk/src/https-transport.js";
import type { ResolvedConfig } from "../../../packages/sdk/src/env-detection.js";
import {
  setDecisionTraceFlag,
  _resetDecisionTraceForTesting,
  type DecisionPoint,
} from "../../../packages/sdk/src/decision-trace.js";
import * as lifecycle from "../../../packages/sdk/src/lifecycle.js";
import {
  onLifecycleEvent,
  offLifecycleEvent,
} from "../../../packages/sdk/src/lifecycle.js";
import type { SdkLifecycleEvents } from "../../../packages/sdk/src/lifecycle.js";

const TEST_DEV_API_KEY = "gt_dev_" + "a".repeat(48);
const BACKGROUND_SETTLE_MS = 200;

/** Collect every `core:decision` event for a point during `fn`. */
async function eventsForPoint(
  point: DecisionPoint,
  fn: () => void | Promise<void>,
): Promise<SdkLifecycleEvents["core:decision"][]> {
  const events: SdkLifecycleEvents["core:decision"][] = [];
  const listener = (e: SdkLifecycleEvents["core:decision"]): void => {
    if (e.point === point) events.push(e);
  };
  onLifecycleEvent("core:decision", listener);
  try {
    await fn();
  } finally {
    offLifecycleEvent("core:decision", listener);
  }
  return events;
}

// ---------------------------------------------------------------------------
// registerGlasstrace points: env.forceEnable, feature.discovery, feature.consoleErrors
// ---------------------------------------------------------------------------

describe("decision-trace wiring — registration points", () => {
  const STANDARD_INIT_FIELDS = {
    minimumSdkVersion: "0.0.0",
    apiVersion: "v1",
    tierLimits: {
      tracesPerMinute: 100,
      storageTtlHours: 48,
      maxTraceSizeBytes: 512000,
      maxConcurrentSessions: 1,
    },
  };

  function transportWith(
    overrides: Partial<SdkInitResponse["config"]> = {},
  ): ReturnType<typeof vi.fn> {
    return vi.fn(async (): Promise<HttpsPostJsonResult> => ({
      status: 200,
      body: {
        ...STANDARD_INIT_FIELDS,
        subscriptionStatus: "active",
        config: {
          requestBodies: false,
          queryParamValues: false,
          envVarValues: false,
          fullConsoleOutput: false,
          importGraph: false,
          consoleErrors: false,
          errorResponseBodies: false,
          sideEffectEvidence: false,
          ...overrides,
        },
      },
      raw: "",
    }));
  }

  async function settle(ms = BACKGROUND_SETTLE_MS): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "glasstrace-wiring-reg-"));
    process.chdir(tempDir);
    _resetRegistrationForTesting();
    _resetConfigForTesting();
    _resetDecisionTraceForTesting();
    vi.restoreAllMocks();
    delete process.env.NODE_ENV;
    delete process.env.VERCEL_ENV;
    delete process.env.GLASSTRACE_API_KEY;
    delete process.env.GLASSTRACE_FORCE_ENABLE;
    delete process.env.GLASSTRACE_DECISION_TRACE;
    delete process.env.GLASSTRACE_DISCOVERY_ENABLED;
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    _resetRegistrationForTesting();
    _resetConfigForTesting();
    _resetDecisionTraceForTesting();
    vi.unstubAllGlobals();
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("ON: a normal dev run emits env.forceEnable=normal", async () => {
    process.env.NODE_ENV = "development";
    _setTransportForTesting(transportWith() as never);
    const events = await eventsForPoint("env.forceEnable", async () => {
      registerGlasstrace({ apiKey: TEST_DEV_API_KEY, decisionTrace: true });
      await settle();
    });
    expect(events.map((e) => e.outcome)).toEqual(["normal"]);
  });

  it("ON: force-enable past production emits env.forceEnable=forced", async () => {
    process.env.NODE_ENV = "production";
    _setTransportForTesting(transportWith() as never);
    const events = await eventsForPoint("env.forceEnable", async () => {
      registerGlasstrace({
        apiKey: TEST_DEV_API_KEY,
        forceEnable: true,
        decisionTrace: true,
      });
      await settle();
    });
    expect(events.map((e) => e.outcome)).toEqual(["forced"]);
  });

  it("ON: production without force emits env.forceEnable=production_disabled", async () => {
    process.env.NODE_ENV = "production";
    _setTransportForTesting(transportWith() as never);
    const events = await eventsForPoint("env.forceEnable", async () => {
      registerGlasstrace({ apiKey: TEST_DEV_API_KEY, decisionTrace: true });
      await settle();
    });
    expect(events.map((e) => e.outcome)).toEqual(["production_disabled"]);
  });

  it("ON: anonymous dev run emits feature.discovery=enabled", async () => {
    process.env.NODE_ENV = "development";
    _setTransportForTesting(transportWith() as never);
    // Anonymous mode (no api key) reaches the discovery gate.
    const events = await eventsForPoint("feature.discovery", async () => {
      registerGlasstrace({ decisionTrace: true });
      await settle();
    });
    expect(events.map((e) => e.outcome)).toEqual(["enabled"]);
  });

  it("ON: discovery explicitly disabled emits feature.discovery=disabled", async () => {
    process.env.NODE_ENV = "development";
    process.env.GLASSTRACE_DISCOVERY_ENABLED = "false";
    _setTransportForTesting(transportWith() as never);
    const events = await eventsForPoint("feature.discovery", async () => {
      registerGlasstrace({ decisionTrace: true });
      await settle();
    });
    expect(events.map((e) => e.outcome)).toEqual(["disabled"]);
  });

  it("ON: consoleErrors enabled in config emits feature.consoleErrors=enabled", async () => {
    process.env.NODE_ENV = "development";
    _setTransportForTesting(transportWith({ consoleErrors: true }) as never);
    const events = await eventsForPoint("feature.consoleErrors", async () => {
      registerGlasstrace({ apiKey: TEST_DEV_API_KEY, decisionTrace: true });
      await settle();
    });
    // The authoritative outcome (after init applies the server config) is
    // `enabled`. An earlier `disabled` line may precede it when the pre-init
    // tier resolves with console capture off; the install decision converges on
    // `enabled` and never emits another outcome after.
    expect(events.map((e) => e.outcome)).toContain("enabled");
    // Every emitted outcome is from the closed two-value set.
    for (const e of events) {
      expect(["enabled", "disabled"]).toContain(e.outcome);
    }
  });

  it("ON: consoleErrors off emits feature.consoleErrors=disabled", async () => {
    process.env.NODE_ENV = "development";
    _setTransportForTesting(transportWith({ consoleErrors: false }) as never);
    const events = await eventsForPoint("feature.consoleErrors", async () => {
      registerGlasstrace({ apiKey: TEST_DEV_API_KEY, decisionTrace: true });
      await settle();
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.outcome === "disabled")).toBe(true);
  });

  it("OFF: a normal dev run emits none of the registration points", async () => {
    process.env.NODE_ENV = "development";
    _setTransportForTesting(transportWith({ consoleErrors: true }) as never);
    const collected: string[] = [];
    const listener = (e: SdkLifecycleEvents["core:decision"]): void => {
      if (
        e.point === "env.forceEnable" ||
        e.point === "feature.discovery" ||
        e.point === "feature.consoleErrors"
      ) {
        collected.push(e.point);
      }
    };
    onLifecycleEvent("core:decision", listener);
    registerGlasstrace({ apiKey: TEST_DEV_API_KEY });
    await settle();
    offLifecycleEvent("core:decision", listener);
    expect(collected).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// otel.path
// ---------------------------------------------------------------------------

describe("decision-trace wiring — otel.path", () => {
  let sessionManager: SessionManager;

  function createTestConfig(
    overrides?: Partial<ResolvedConfig>,
  ): ResolvedConfig {
    return {
      endpoint: "https://ingest.glasstrace.dev",
      environment: "test",
      verbose: false,
      nodeEnv: "test",
      vercelEnv: undefined,
      apiKey: undefined,
      coverageMapEnabled: false,
      forceEnable: false,
      ...overrides,
    };
  }

  beforeEach(() => {
    otelApi.trace.disable();
    lifecycle.resetLifecycleForTesting();
    lifecycle.initLifecycle({ logger: vi.fn() });
    resetOtelConfigForTesting();
    _resetDecisionTraceForTesting();
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    sessionManager = new SessionManager();
  });

  afterEach(() => {
    lifecycle.resetLifecycleForTesting();
    resetOtelConfigForTesting();
    _resetDecisionTraceForTesting();
    otelApi.trace.disable();
    otelApi.context.disable();
    otelApi.propagation.disable();
    otelApi.diag.disable();
  });

  it("ON: no existing provider emits otel.path=bare", async () => {
    setFlagOn();
    const events = await eventsForPoint("otel.path", async () => {
      await configureOtel(createTestConfig(), sessionManager);
    });
    expect(events.map((e) => e.outcome)).toEqual(["bare"]);
  });

  it("ON: an existing provider emits a coexistence otel.path outcome", async () => {
    setFlagOn();
    const existingProvider = new otelSdk.BasicTracerProvider();
    otelApi.trace.setGlobalTracerProvider(existingProvider);
    const events = await eventsForPoint("otel.path", async () => {
      await configureOtel(createTestConfig(), sessionManager);
    });
    expect(events).toHaveLength(1);
    expect(["coexist_present", "coexist_attached", "coexist_failed"]).toContain(
      events[0].outcome,
    );
  });

  it("OFF: configureOtel emits no otel.path event", async () => {
    // flag stays at default OFF
    const events = await eventsForPoint("otel.path", async () => {
      await configureOtel(createTestConfig(), sessionManager);
    });
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// feature.errorResponseBodies (exporter per-span gate)
// ---------------------------------------------------------------------------

describe("decision-trace wiring — feature.errorResponseBodies", () => {
  const TEST_API_KEY = "gt_dev_" + "a".repeat(48);

  function baseConfig(errorResponseBodies: boolean): CaptureConfig {
    return {
      requestBodies: false,
      queryParamValues: false,
      envVarValues: false,
      fullConsoleOutput: false,
      importGraph: false,
      errorResponseBodies,
    } as CaptureConfig;
  }

  function mockSpan(): ReadableSpan {
    return {
      name: "GET /api/users",
      kind: SpanKind.SERVER,
      spanContext: () => ({
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        traceFlags: 1,
      }),
      parentSpanId: undefined,
      startTime: [1700000000, 0],
      endTime: [1700000000, 150_000_000],
      status: { code: SpanStatusCode.OK },
      attributes: {
        "http.method": "GET",
        "http.route": "/api/users",
        "http.status_code": 200,
      },
      links: [],
      events: [],
      duration: [0, 150_000_000],
      ended: true,
      resource: { attributes: {} },
      instrumentationScope: { name: "test", version: "1.0.0" },
      instrumentationLibrary: { name: "test", version: "1.0.0" },
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    } as unknown as ReadableSpan;
  }

  function mockDelegate(): SpanExporter {
    return {
      export(_spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
        cb({ code: 0 });
      },
      shutdown: vi.fn().mockResolvedValue(undefined),
      forceFlush: vi.fn().mockResolvedValue(undefined),
    };
  }

  function makeExporter(config: CaptureConfig): GlasstraceExporter {
    return new GlasstraceExporter({
      getApiKey: () => TEST_API_KEY,
      sessionManager: new SessionManager(),
      getConfig: () => config,
      environment: undefined,
      endpointUrl: "https://api.glasstrace.dev/v1/traces",
      createDelegate: () => mockDelegate(),
    });
  }

  beforeEach(() => {
    _resetDecisionTraceForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetDecisionTraceForTesting();
  });

  it("ON: errorResponseBodies enabled emits feature.errorResponseBodies=enabled", async () => {
    setFlagOn();
    const exporter = makeExporter(baseConfig(true));
    const events = await eventsForPoint(
      "feature.errorResponseBodies",
      () => {
        exporter.export([mockSpan()], vi.fn());
      },
    );
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("enabled");
  });

  it("ON: errorResponseBodies off emits feature.errorResponseBodies=disabled, deduped across many spans", async () => {
    setFlagOn();
    const exporter = makeExporter(baseConfig(false));
    const events = await eventsForPoint(
      "feature.errorResponseBodies",
      () => {
        // Many spans on the per-span hot path collapse to a single decision
        // line under the one-shot key.
        for (let i = 0; i < 200; i++) exporter.export([mockSpan()], vi.fn());
      },
    );
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("disabled");
  });

  it("OFF: the exporter emits no feature.errorResponseBodies event", async () => {
    const exporter = makeExporter(baseConfig(true));
    const events = await eventsForPoint(
      "feature.errorResponseBodies",
      () => {
        exporter.export([mockSpan()], vi.fn());
      },
    );
    expect(events).toEqual([]);
  });
});

/** Turn the decision-trace toggle ON for a test. */
function setFlagOn(): void {
  setDecisionTraceFlag(true);
}
