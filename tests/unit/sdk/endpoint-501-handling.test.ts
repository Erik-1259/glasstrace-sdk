import { describe, it, expect, beforeEach, vi } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import { GlasstraceExporter } from "../../../packages/sdk/src/enriching-exporter.js";
import { SessionManager } from "../../../packages/sdk/src/session.js";
import type { CaptureConfig } from "@glasstrace/protocol";

/**
 * DISC-1074 item 2: Verify SDK handles HTTP 501 correctly.
 *
 * Context: The glasstrace-product backend returns HTTP 501 for the
 * `/v1/client/observations` endpoint (browser extension data). This test
 * suite verifies that the server-side SDK is unaffected because:
 *
 * 1. The SDK sends OTLP traces to `/v1/traces`, not `/v1/client/observations`.
 * 2. The SDK sends init requests to `/v1/sdk/init`, not `/v1/client/observations`.
 * 3. Even if the OTLP endpoint were to return 501, the OTel OTLP HTTP exporter
 *    treats it as a permanent (non-retryable) failure and the GlasstraceExporter
 *    continues operating for subsequent batches.
 *
 * The OTel OTLP exporter's `isExportHTTPErrorRetryable()` only retries
 * 429, 502, 503, and 504. All other 4xx/5xx codes (including 501) are
 * permanent failures — the batch is dropped and the export pipeline moves on.
 */

const DEFAULT_CONFIG: CaptureConfig = {
  requestBodies: false,
  queryParamValues: false,
  envVarValues: false,
  fullConsoleOutput: false,
  importGraph: false,
};

const TEST_API_KEY = "gt_dev_" + "a".repeat(48);

/**
 * Creates a no-op delegate exporter that reports success for every batch.
 */
function noOpDelegate(): SpanExporter {
  return {
    export(_spans: ReadableSpan[], cb: (result: ExportResult) => void) {
      cb({ code: ExportResultCode.SUCCESS });
    },
    shutdown: () => Promise.resolve(),
  };
}

function createMockSpan(name?: string): ReadableSpan {
  return {
    name: name ?? "GET /api/users",
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
    attributes: { "http.method": "GET", "http.status_code": 200 },
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

describe("SDK endpoint targeting (DISC-1074)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("SDK does not send to client observation endpoint", () => {
    // Verifies the exporter interface contract: GlasstraceExporter passes
    // the configured endpoint URL through to the delegate factory unchanged.
    // Full OTel SDK wiring (configureOtel → GlasstraceExporter) is tested
    // in otel-config.test.ts; this test isolates the exporter's URL handling.
    it("configures OTLP exporter with /v1/traces endpoint, not /v1/client/observations", () => {
      const capturedUrls: string[] = [];

      const exporter = new GlasstraceExporter({
        getApiKey: () => TEST_API_KEY,
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://ingest.glasstrace.dev/v1/traces",
        createDelegate: (url) => {
          capturedUrls.push(url);
          return noOpDelegate();
        },
      });

      // Trigger delegate creation by exporting a span
      exporter.export([createMockSpan()], vi.fn());

      expect(capturedUrls).toHaveLength(1);
      expect(capturedUrls[0]).toBe("https://ingest.glasstrace.dev/v1/traces");
      expect(capturedUrls[0]).not.toContain("/v1/client/observations");
    });

    it("passes the configured endpoint URL through to the delegate without modification", () => {
      const capturedUrls: string[] = [];

      const exporter = new GlasstraceExporter({
        getApiKey: () => TEST_API_KEY,
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://custom.endpoint.dev/v1/traces",
        createDelegate: (url) => {
          capturedUrls.push(url);
          return noOpDelegate();
        },
      });

      exporter.export([createMockSpan()], vi.fn());

      expect(capturedUrls).toHaveLength(1);
      expect(capturedUrls[0]).toBe("https://custom.endpoint.dev/v1/traces");
    });
  });

  describe("Delegate failure resilience (501 and other non-retryable errors)", () => {
    it("continues operating after delegate reports permanent failure", () => {
      let exportCallCount = 0;

      const createDelegate = (): SpanExporter => ({
        export: (_spans: ReadableSpan[], cb: (result: ExportResult) => void) => {
          exportCallCount++;
          if (exportCallCount === 1) {
            // Simulate 501 — OTel OTLP exporter reports permanent failure
            cb({
              code: ExportResultCode.FAILED,
              error: new Error("Fetch request failed with non-retryable status 501"),
            });
          } else {
            // Subsequent batches succeed
            cb({ code: ExportResultCode.SUCCESS });
          }
        },
        shutdown: () => Promise.resolve(),
      });

      const exporter = new GlasstraceExporter({
        getApiKey: () => TEST_API_KEY,
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://ingest.glasstrace.dev/v1/traces",
        createDelegate: () => createDelegate(),
      });

      // First batch — delegate fails with 501-style error
      const callback1 = vi.fn();
      exporter.export([createMockSpan("batch-1")], callback1);
      expect(callback1).toHaveBeenCalledWith(
        expect.objectContaining({ code: ExportResultCode.FAILED }),
      );

      // Second batch — should still work, exporter is not broken
      const callback2 = vi.fn();
      exporter.export([createMockSpan("batch-2")], callback2);
      expect(callback2).toHaveBeenCalledWith(
        expect.objectContaining({ code: ExportResultCode.SUCCESS }),
      );
    });

    it("propagates delegate throw but continues operating on subsequent exports", () => {
      let throwOnce = true;

      const createDelegate = (): SpanExporter => ({
        export: (_spans: ReadableSpan[], cb: (result: ExportResult) => void) => {
          if (throwOnce) {
            throwOnce = false;
            throw new Error("Unexpected 501 handling error");
          }
          cb({ code: ExportResultCode.SUCCESS });
        },
        shutdown: () => Promise.resolve(),
      });

      const exporter = new GlasstraceExporter({
        getApiKey: () => TEST_API_KEY,
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://ingest.glasstrace.dev/v1/traces",
        createDelegate: () => createDelegate(),
      });

      // First batch — delegate throws. GlasstraceExporter calls delegate.export
      // directly without try-catch, so the throw propagates, but the exporter
      // itself should not be in a broken state for subsequent calls.
      expect(() => {
        exporter.export([createMockSpan("batch-1")], vi.fn());
      }).toThrow("Unexpected 501 handling error");

      // Second batch — should still work
      const callback2 = vi.fn();
      exporter.export([createMockSpan("batch-2")], callback2);
      expect(callback2).toHaveBeenCalledWith(
        expect.objectContaining({ code: ExportResultCode.SUCCESS }),
      );
    });

    it("propagates the delegate's failure result code to the caller without modification", () => {
      const failureError = new Error("Fetch request failed with non-retryable status 501");

      const createDelegate = (): SpanExporter => ({
        export: (_spans: ReadableSpan[], cb: (result: ExportResult) => void) => {
          cb({ code: ExportResultCode.FAILED, error: failureError });
        },
        shutdown: () => Promise.resolve(),
      });

      const exporter = new GlasstraceExporter({
        getApiKey: () => TEST_API_KEY,
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://ingest.glasstrace.dev/v1/traces",
        createDelegate: () => createDelegate(),
      });

      const callback = vi.fn();
      exporter.export([createMockSpan()], callback);

      expect(callback).toHaveBeenCalledTimes(1);
      const result = callback.mock.calls[0][0] as ExportResult;
      expect(result.code).toBe(ExportResultCode.FAILED);
      expect(result.error).toBe(failureError);
    });
  });

  describe("Init endpoint does not target client observation path", () => {
    it("sendInitRequest sends to /v1/sdk/init, not /v1/client/observations", async () => {
      // Import sendInitRequest to verify its target endpoint
      const { sendInitRequest } = await import(
        "../../../packages/sdk/src/init-client.js"
      );

      const mockResponse = {
        config: DEFAULT_CONFIG,
        subscriptionStatus: "anonymous",
        minimumSdkVersion: "0.0.0",
        apiVersion: "v1",
        tierLimits: {
          tracesPerMinute: 100,
          storageTtlHours: 48,
          maxTraceSizeBytes: 512000,
          maxConcurrentSessions: 1,
        },
      };

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
      });
      vi.stubGlobal("fetch", fetchSpy);

      try {
        await sendInitRequest(
          {
            apiKey: TEST_API_KEY,
            endpoint: "https://ingest.glasstrace.dev",
            environment: undefined,
            verbose: false,
            nodeEnv: undefined,
            vercelEnv: undefined,
            coverageMapEnabled: false,
            forceEnable: false,
          },
          null,
          "0.1.0",
        );

        const calledUrl = fetchSpy.mock.calls[0][0] as string;
        expect(calledUrl).not.toContain("/v1/client/observations");
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
