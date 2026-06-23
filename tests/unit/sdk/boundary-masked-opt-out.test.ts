import { describe, it, expect, afterEach, vi } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { ExportResult } from "@opentelemetry/core";
import { GLASSTRACE_ATTRIBUTE_NAMES } from "@glasstrace/protocol";
import type { CaptureConfig } from "@glasstrace/protocol";
import { SessionManager } from "../../../packages/sdk/src/session.js";

// The boundary-masked opt-out flag (GLASSTRACE_DISABLE_BOUNDARY_MASKED) is
// read once at exporter-module init to keep the export hot path free of a
// per-span process.env lookup. Exercising both flag states therefore requires
// re-importing the exporter module under vi.resetModules(). These tests are
// isolated in their own file so that module-graph reset never bleeds into the
// main enriching-exporter suite (which mixes static and dynamic imports).

const ATTR = GLASSTRACE_ATTRIBUTE_NAMES;

const DEFAULT_CONFIG: CaptureConfig = {
  requestBodies: false,
  queryParamValues: false,
  envVarValues: false,
  fullConsoleOutput: false,
  importGraph: false,
};

const TEST_API_KEY = "gt_dev_" + "a".repeat(48);

const SERVER_SPAN_ID = "1111111111111111";
const RENDER_SPAN_ID = "2222222222222222";
const TRACE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function createMockDelegate(): SpanExporter & {
  exportedSpans: ReadableSpan[][];
} {
  const delegate = {
    exportedSpans: [] as ReadableSpan[][],
    export(spans: ReadableSpan[], cb: (result: ExportResult) => void): void {
      delegate.exportedSpans.push(spans);
      cb({ code: 0 });
    },
    shutdown: vi.fn().mockResolvedValue(undefined),
    forceFlush: vi.fn().mockResolvedValue(undefined),
  };
  return delegate;
}

function serverSpan(): ReadableSpan {
  return {
    name: "GET /[locale]/page",
    kind: SpanKind.SERVER,
    spanContext: () => ({ traceId: TRACE_ID, spanId: SERVER_SPAN_ID, traceFlags: 1 }),
    parentSpanContext: undefined,
    startTime: [1700000000, 0],
    endTime: [1700000000, 150_000_000],
    status: { code: SpanStatusCode.UNSET },
    attributes: {
      "http.method": "GET",
      "http.route": "/[locale]/page",
      "http.status_code": 200,
    },
    links: [],
    events: [],
    duration: [0, 150_000_000],
    ended: true,
    resource: { attributes: {} },
    instrumentationScope: { name: "test", version: "1.0.0" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan;
}

function renderRouteSpan(): ReadableSpan {
  return {
    name: "render route (app) /[locale]/page",
    kind: SpanKind.INTERNAL,
    spanContext: () => ({ traceId: TRACE_ID, spanId: RENDER_SPAN_ID, traceFlags: 1 }),
    parentSpanContext: { traceId: TRACE_ID, spanId: SERVER_SPAN_ID, traceFlags: 1 },
    startTime: [1700000000, 50_000_000],
    endTime: [1700000000, 120_000_000],
    status: { code: SpanStatusCode.ERROR },
    attributes: { "next.span_type": "AppRender.getBodyResult" },
    links: [],
    events: [
      {
        time: [1700000000, 50_000_000],
        name: "exception",
        attributes: {
          "exception.type": "PrismaClientKnownRequestError",
          "exception.message": "Can't reach database server (P1001)",
        },
      },
    ],
    duration: [0, 70_000_000],
    ended: true,
    resource: { attributes: {} },
    instrumentationScope: { name: "test", version: "1.0.0" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan;
}

/**
 * Imports a fresh exporter + breaker + lifecycle module graph (so the
 * init-time flag read observes the current env var), runs a descendant
 * boundary-masked scenario, and returns the enriched SERVER span plus whether
 * the lifecycle event fired.
 */
async function runDescendantScenario(): Promise<{
  status: unknown;
  scope: unknown;
  emitted: boolean;
}> {
  const mod = await import("../../../packages/sdk/src/enriching-exporter.js");
  const breakerMod = await import(
    "../../../packages/sdk/src/export-circuit-breaker.js"
  );
  const lifecycleMod = await import("../../../packages/sdk/src/lifecycle.js");
  breakerMod._resetExportCircuitBreakerForTesting();

  const delegate = createMockDelegate();
  const exporter = new mod.GlasstraceExporter({
    getApiKey: () => TEST_API_KEY,
    sessionManager: new SessionManager(),
    getConfig: () => DEFAULT_CONFIG,
    environment: undefined,
    endpointUrl: "https://api.glasstrace.dev/v1/traces",
    createDelegate: () => delegate,
  });

  const handler = vi.fn();
  lifecycleMod.onLifecycleEvent("core:error_boundary_detected", handler);
  exporter.export([serverSpan(), renderRouteSpan()], vi.fn());
  lifecycleMod.offLifecycleEvent("core:error_boundary_detected", handler);

  const enrichedServer = delegate.exportedSpans[0].find(
    (s) => s.spanContext().spanId === SERVER_SPAN_ID,
  )!;
  return {
    status: enrichedServer.attributes[ATTR.HTTP_STATUS_CODE],
    scope: enrichedServer.attributes[ATTR.HTTP_BOUNDARY_MASKED_SCOPE],
    emitted: handler.mock.calls.length > 0,
  };
}

/**
 * Same-span variant: a single SERVER span carrying its OWN exception event
 * (no descendant). Used to prove the opt-out flag also disables the same-span
 * promotion path, not just the descendant path.
 */
function sameSpanServer(): ReadableSpan {
  return {
    name: "GET /api/checkout",
    kind: SpanKind.SERVER,
    spanContext: () => ({ traceId: TRACE_ID, spanId: SERVER_SPAN_ID, traceFlags: 1 }),
    parentSpanContext: undefined,
    startTime: [1700000000, 0],
    endTime: [1700000000, 150_000_000],
    status: { code: SpanStatusCode.UNSET },
    attributes: {
      "http.method": "GET",
      "http.route": "/api/checkout",
      "http.status_code": 200,
    },
    links: [],
    events: [
      {
        time: [1700000000, 50_000_000],
        name: "exception",
        attributes: {
          "exception.type": "TypeError",
          "exception.message": "boom on the request span itself",
        },
      },
    ],
    duration: [0, 150_000_000],
    ended: true,
    resource: { attributes: {} },
    instrumentationScope: { name: "test", version: "1.0.0" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan;
}

async function runSameSpanScenario(): Promise<{
  status: unknown;
  scope: unknown;
  masked: unknown;
  emitted: boolean;
}> {
  const mod = await import("../../../packages/sdk/src/enriching-exporter.js");
  const breakerMod = await import(
    "../../../packages/sdk/src/export-circuit-breaker.js"
  );
  const lifecycleMod = await import("../../../packages/sdk/src/lifecycle.js");
  breakerMod._resetExportCircuitBreakerForTesting();

  const delegate = createMockDelegate();
  const exporter = new mod.GlasstraceExporter({
    getApiKey: () => TEST_API_KEY,
    sessionManager: new SessionManager(),
    getConfig: () => DEFAULT_CONFIG,
    environment: undefined,
    endpointUrl: "https://api.glasstrace.dev/v1/traces",
    createDelegate: () => delegate,
  });

  const handler = vi.fn();
  lifecycleMod.onLifecycleEvent("core:error_boundary_detected", handler);
  exporter.export([sameSpanServer()], vi.fn());
  lifecycleMod.offLifecycleEvent("core:error_boundary_detected", handler);

  const enriched = delegate.exportedSpans[0][0];
  return {
    status: enriched.attributes[ATTR.HTTP_STATUS_CODE],
    scope: enriched.attributes[ATTR.HTTP_BOUNDARY_MASKED_SCOPE],
    masked: enriched.attributes[ATTR.HTTP_BOUNDARY_MASKED],
    emitted: handler.mock.calls.length > 0,
  };
}

describe("Boundary-masked opt-out flag (GLASSTRACE_DISABLE_BOUNDARY_MASKED)", () => {
  const ORIGINAL_ENV = process.env.GLASSTRACE_DISABLE_BOUNDARY_MASKED;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.GLASSTRACE_DISABLE_BOUNDARY_MASKED;
    } else {
      process.env.GLASSTRACE_DISABLE_BOUNDARY_MASKED = ORIGINAL_ENV;
    }
    vi.resetModules();
  });

  it("both-state: '1' suppresses promotion (no scope, no lifecycle emit); unset promotes", async () => {
    process.env.GLASSTRACE_DISABLE_BOUNDARY_MASKED = "1";
    vi.resetModules();
    const disabled = await runDescendantScenario();
    expect(disabled.status).toBe(200);
    expect(disabled.scope).toBeUndefined();
    expect(disabled.emitted).toBe(false);

    delete process.env.GLASSTRACE_DISABLE_BOUNDARY_MASKED;
    vi.resetModules();
    const enabled = await runDescendantScenario();
    expect(enabled.status).toBe(500);
    expect(enabled.scope).toBe("descendant");
    expect(enabled.emitted).toBe(true);
  });

  it("flag parsing: '1'/'true'/'TRUE'/' True ' are truthy (disable); other values leave detection on", async () => {
    for (const truthy of ["1", "true", "TRUE", " True "]) {
      process.env.GLASSTRACE_DISABLE_BOUNDARY_MASKED = truthy;
      vi.resetModules();
      const r = await runDescendantScenario();
      expect(r.status, `value=${JSON.stringify(truthy)}`).toBe(200);
    }
    for (const nonTruthy of ["0", "false", "no", "yes", "off", ""]) {
      process.env.GLASSTRACE_DISABLE_BOUNDARY_MASKED = nonTruthy;
      vi.resetModules();
      const r = await runDescendantScenario();
      expect(r.status, `value=${JSON.stringify(nonTruthy)}`).toBe(500);
    }
  });

  // The opt-out flag is orthogonal to scope: it must disable the same-span
  // promotion path too, not just the descendant path.
  it("same-span path: '1' suppresses own-exception promotion (no scope, no masked attr, no emit); unset promotes", async () => {
    process.env.GLASSTRACE_DISABLE_BOUNDARY_MASKED = "1";
    vi.resetModules();
    const disabled = await runSameSpanScenario();
    expect(disabled.status).toBe(200);
    expect(disabled.scope).toBeUndefined();
    expect(disabled.masked).toBeUndefined();
    expect(disabled.emitted).toBe(false);

    delete process.env.GLASSTRACE_DISABLE_BOUNDARY_MASKED;
    vi.resetModules();
    const enabled = await runSameSpanScenario();
    expect(enabled.status).toBe(500);
    expect(enabled.scope).toBe("same_span");
    expect(enabled.masked).toBe(true);
    expect(enabled.emitted).toBe(true);
  });

  // Read-once-at-load proof: import the module graph with the flag unset
  // (promotion on), then set the flag WITHOUT resetModules and confirm the
  // already-loaded module still promotes — the env var is read only at init.
  it("reads the flag once at module load: setting it after import does not re-enable suppression", async () => {
    delete process.env.GLASSTRACE_DISABLE_BOUNDARY_MASKED;
    vi.resetModules();
    const first = await runDescendantScenario();
    expect(first.status).toBe(500);

    // Mutate the env var but do NOT reset modules — the cached init-time read
    // must not change.
    process.env.GLASSTRACE_DISABLE_BOUNDARY_MASKED = "1";
    const second = await runDescendantScenario();
    expect(second.status).toBe(500);
    expect(second.scope).toBe("descendant");
  });
});
