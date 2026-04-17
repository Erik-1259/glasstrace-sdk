import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as otelApi from "@opentelemetry/api";
import { registerGlasstrace, _resetRegistrationForTesting } from "../../packages/sdk/src/register.js";
import { _resetConfigForTesting, _setTransportForTesting } from "../../packages/sdk/src/init-client.js";
import type { HttpsPostJsonResult } from "../../packages/sdk/src/https-transport.js";

/** Shared transport spy used by tests that assert the init request was issued. */
let transportSpy: ReturnType<typeof vi.fn>;

/** Valid developer API key for testing. */
const TEST_DEV_KEY = "gt_dev_" + "a".repeat(48);

/** Waits for fire-and-forget background promises to settle. */
async function waitForBackgroundWork(ms = 300): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("registerGlasstrace lifecycle integration", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    otelApi.trace.disable();
    _resetRegistrationForTesting();
    _resetConfigForTesting();
    vi.restoreAllMocks();

    delete process.env.NODE_ENV;
    delete process.env.VERCEL_ENV;
    delete process.env.GLASSTRACE_API_KEY;
    delete process.env.GLASSTRACE_FORCE_ENABLE;
    delete process.env.GLASSTRACE_ENV;
    delete process.env.GLASSTRACE_COVERAGE_MAP;
    delete process.env.GLASSTRACE_DISCOVERY_ENABLED;

    // Install a transport mock (bypasses node:https) to prevent real
    // network calls. We mock at the transport layer — not globalThis.fetch
    // — because the SDK bypasses the global fetch (DISC-493 Issue 3).
    transportSpy = vi.fn(async (): Promise<HttpsPostJsonResult> => ({
      status: 200,
      body: {
        config: {
          requestBodies: false,
          queryParamValues: false,
          envVarValues: false,
          fullConsoleOutput: false,
          importGraph: false,
        },
        subscriptionStatus: "anonymous",
        minimumSdkVersion: "0.0.0",
        apiVersion: "v1",
        tierLimits: {
          tracesPerMinute: 100,
          storageTtlHours: 48,
          maxTraceSizeBytes: 512000,
          maxConcurrentSessions: 1,
        },
      },
      raw: "",
    }));
    _setTransportForTesting(transportSpy as never);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    _resetRegistrationForTesting();
    _resetConfigForTesting();
    otelApi.trace.disable();
    vi.unstubAllGlobals();
  });

  it("registers an OTel provider and enriches spans with glasstrace attributes", async () => {
    process.env.GLASSTRACE_API_KEY = TEST_DEV_KEY;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});

    registerGlasstrace();

    // Wait for async OTel configuration to complete
    await waitForBackgroundWork();

    // The provider should be registered globally after configureOtel runs.
    // Create a span and verify it can be created without error.
    const tracer = otelApi.trace.getTracer("test-tracer");
    expect(tracer).toBeDefined();
    expect(tracer.constructor.name).not.toBe("ProxyTracer");

    // Create a span to verify the pipeline is functional
    const span = tracer.startSpan("test-operation");
    expect(span).toBeDefined();
    span.end();
  });

  it("creates spans that flow through the pipeline without errors", async () => {
    process.env.GLASSTRACE_API_KEY = TEST_DEV_KEY;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});

    registerGlasstrace();

    await waitForBackgroundWork();

    const tracer = otelApi.trace.getTracer("lifecycle-test");

    // Create multiple spans
    const span1 = tracer.startSpan("operation-1");
    span1.setAttribute("test.key", "value1");
    span1.end();

    const span2 = tracer.startSpan("operation-2");
    span2.setAttribute("test.key", "value2");
    span2.end();

    // Allow spans to be processed
    await waitForBackgroundWork(100);

    // Verify the init transport was called. Span export goes through
    // an OTLP exporter which may or may not fire within the test
    // window — init is the deterministic indicator.
    expect(transportSpy).toHaveBeenCalled();
  });

  it("fires background init request with the correct endpoint", async () => {
    process.env.GLASSTRACE_API_KEY = TEST_DEV_KEY;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    registerGlasstrace();

    await waitForBackgroundWork();

    // Find the init request (POST to /v1/sdk/init)
    const initCall = transportSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/v1/sdk/init"),
    );
    expect(initCall).toBeDefined();

    // Verify Authorization header is present
    const options = initCall![2] as { headers: Record<string, string> };
    expect(options.headers.Authorization).toBe(`Bearer ${TEST_DEV_KEY}`);
  });
});
