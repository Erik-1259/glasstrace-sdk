/**
 * Tests for `glasstrace.build.hash` enrichment in GlasstraceExporter.
 *
 * Lives in a separate file so we can `vi.mock` the build-info module
 * before the exporter loads. The main `enriching-exporter.test.ts`
 * does not mock build-info, so it observes the real module-load
 * behavior (build hash absent unless `GLASSTRACE_BUILD_HASH` happens
 * to be set in the test process — which it is not under CI).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { ExportResult } from "@opentelemetry/core";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { GLASSTRACE_ATTRIBUTE_NAMES } from "@glasstrace/protocol";
import type { CaptureConfig } from "@glasstrace/protocol";

const ATTR = GLASSTRACE_ATTRIBUTE_NAMES;

const TEST_API_KEY = "gt_dev_" + "a".repeat(48);

const DEFAULT_CONFIG: CaptureConfig = {
  requestBodies: false,
  queryParamValues: false,
  envVarValues: false,
  fullConsoleOutput: false,
  importGraph: false,
};

let mockBuildHash: string | undefined = undefined;

vi.mock("../../../packages/sdk/src/build-info.js", () => ({
  getBuildHash: () => mockBuildHash,
}));

function createMockSpan(): ReadableSpan {
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

function createMockDelegate(): SpanExporter & {
  exportedSpans: ReadableSpan[][];
} {
  const delegate = {
    exportedSpans: [] as ReadableSpan[][],
    export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
      delegate.exportedSpans.push(spans);
      resultCallback({ code: 0 });
    },
    shutdown: vi.fn().mockResolvedValue(undefined),
    forceFlush: vi.fn().mockResolvedValue(undefined),
  };
  return delegate;
}

describe("GlasstraceExporter — glasstrace.build.hash enrichment", () => {
  beforeEach(() => {
    mockBuildHash = undefined;
  });

  afterEach(() => {
    mockBuildHash = undefined;
  });

  it("stamps glasstrace.build.hash on every server span when build hash is set", async () => {
    mockBuildHash = "9afcede0a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const { GlasstraceExporter } = await import(
      "../../../packages/sdk/src/enriching-exporter.js"
    );
    const { SessionManager } = await import(
      "../../../packages/sdk/src/session.js"
    );

    const delegate = createMockDelegate();
    const exporter = new GlasstraceExporter({
      getApiKey: () => TEST_API_KEY,
      sessionManager: new SessionManager(),
      getConfig: () => DEFAULT_CONFIG,
      environment: undefined,
      endpointUrl: "https://api.glasstrace.dev/v1/traces",
      createDelegate: () => delegate,
    });

    exporter.export([createMockSpan()], vi.fn());

    expect(delegate.exportedSpans).toHaveLength(1);
    const enriched = delegate.exportedSpans[0][0];
    expect(enriched.attributes[ATTR.BUILD_HASH]).toBe(
      "9afcede0a1b2c3d4e5f60718293a4b5c6d7e8f90",
    );
  });

  it("omits glasstrace.build.hash when getBuildHash returns undefined", async () => {
    mockBuildHash = undefined;
    const { GlasstraceExporter } = await import(
      "../../../packages/sdk/src/enriching-exporter.js"
    );
    const { SessionManager } = await import(
      "../../../packages/sdk/src/session.js"
    );

    const delegate = createMockDelegate();
    const exporter = new GlasstraceExporter({
      getApiKey: () => TEST_API_KEY,
      sessionManager: new SessionManager(),
      getConfig: () => DEFAULT_CONFIG,
      environment: undefined,
      endpointUrl: "https://api.glasstrace.dev/v1/traces",
      createDelegate: () => delegate,
    });

    exporter.export([createMockSpan()], vi.fn());

    expect(delegate.exportedSpans).toHaveLength(1);
    const enriched = delegate.exportedSpans[0][0];
    expect(enriched.attributes[ATTR.BUILD_HASH]).toBeUndefined();
  });

  it("omits glasstrace.build.hash when getBuildHash returns an empty string", async () => {
    mockBuildHash = "";
    const { GlasstraceExporter } = await import(
      "../../../packages/sdk/src/enriching-exporter.js"
    );
    const { SessionManager } = await import(
      "../../../packages/sdk/src/session.js"
    );

    const delegate = createMockDelegate();
    const exporter = new GlasstraceExporter({
      getApiKey: () => TEST_API_KEY,
      sessionManager: new SessionManager(),
      getConfig: () => DEFAULT_CONFIG,
      environment: undefined,
      endpointUrl: "https://api.glasstrace.dev/v1/traces",
      createDelegate: () => delegate,
    });

    exporter.export([createMockSpan()], vi.fn());

    const enriched = delegate.exportedSpans[0][0];
    expect(enriched.attributes[ATTR.BUILD_HASH]).toBeUndefined();
  });

  it("does not mutate the original span's attributes", async () => {
    mockBuildHash = "deadbeef";
    const { GlasstraceExporter } = await import(
      "../../../packages/sdk/src/enriching-exporter.js"
    );
    const { SessionManager } = await import(
      "../../../packages/sdk/src/session.js"
    );

    const delegate = createMockDelegate();
    const exporter = new GlasstraceExporter({
      getApiKey: () => TEST_API_KEY,
      sessionManager: new SessionManager(),
      getConfig: () => DEFAULT_CONFIG,
      environment: undefined,
      endpointUrl: "https://api.glasstrace.dev/v1/traces",
      createDelegate: () => delegate,
    });

    const span = createMockSpan();
    const originalAttrs = { ...span.attributes };
    exporter.export([span], vi.fn());

    // Original span attributes are unchanged
    expect(span.attributes).toEqual(originalAttrs);
    expect(span.attributes[ATTR.BUILD_HASH]).toBeUndefined();
  });

  it("stamps the same build hash on every span in a batch", async () => {
    mockBuildHash = "abc123";
    const { GlasstraceExporter } = await import(
      "../../../packages/sdk/src/enriching-exporter.js"
    );
    const { SessionManager } = await import(
      "../../../packages/sdk/src/session.js"
    );

    const delegate = createMockDelegate();
    const exporter = new GlasstraceExporter({
      getApiKey: () => TEST_API_KEY,
      sessionManager: new SessionManager(),
      getConfig: () => DEFAULT_CONFIG,
      environment: undefined,
      endpointUrl: "https://api.glasstrace.dev/v1/traces",
      createDelegate: () => delegate,
    });

    exporter.export([createMockSpan(), createMockSpan(), createMockSpan()], vi.fn());

    expect(delegate.exportedSpans).toHaveLength(1);
    const enriched = delegate.exportedSpans[0];
    expect(enriched).toHaveLength(3);
    for (const span of enriched) {
      expect(span.attributes[ATTR.BUILD_HASH]).toBe("abc123");
    }
  });
});
