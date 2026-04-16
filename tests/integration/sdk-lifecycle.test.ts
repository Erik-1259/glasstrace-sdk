/**
 * Cross-Layer Lifecycle Integration Tests (SDK-027)
 *
 * Verifies the full SDK lifecycle across all four layers: core, auth,
 * OTel coexistence, and CLI runtime bridge. These tests compose all
 * lifecycle modules into realistic scenarios.
 *
 * Tests run serially due to global OTel state mutation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as otelApi from "@opentelemetry/api";
import * as otelSdk from "@opentelemetry/sdk-trace-base";
import type { SdkInitResponse } from "@glasstrace/protocol";

import {
  registerGlasstrace,
  _resetRegistrationForTesting,
} from "../../packages/sdk/src/register.js";
import { _resetConfigForTesting } from "../../packages/sdk/src/init-client.js";
import {
  CoreState,
  AuthState,
  OtelState,
  getCoreState,
  getAuthState,
  getOtelState,
  getSdkState,
  isReady,
  waitForReady,
  getStatus,
  executeShutdown,
} from "../../packages/sdk/src/lifecycle.js";

const TEST_DEV_KEY = "gt_dev_" + "a".repeat(48);

const STANDARD_INIT_RESPONSE: SdkInitResponse = {
  config: {
    requestBodies: false,
    queryParamValues: false,
    envVarValues: false,
    fullConsoleOutput: false,
    importGraph: false,
    consoleErrors: false,
    errorResponseBodies: false,
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
} as SdkInitResponse;

function createMockFetch(): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(STANDARD_INIT_RESPONSE),
  });
}

describe("SDK Lifecycle Integration Tests (SDK-027)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    _resetRegistrationForTesting();
    _resetConfigForTesting();
    otelApi.trace.disable();
    otelApi.context.disable();
    vi.restoreAllMocks();
    delete process.env.NODE_ENV;
    delete process.env.VERCEL_ENV;
    delete process.env.GLASSTRACE_API_KEY;
    delete process.env.GLASSTRACE_FORCE_ENABLE;
    delete process.env.GLASSTRACE_ENV;
    delete process.env.GLASSTRACE_COVERAGE_MAP;
    delete process.env.GLASSTRACE_DISCOVERY_ENABLED;
    vi.stubGlobal("fetch", createMockFetch());
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    _resetRegistrationForTesting();
    _resetConfigForTesting();
    otelApi.trace.disable();
    otelApi.context.disable();
    otelApi.propagation.disable();
    otelApi.diag.disable();
    vi.unstubAllGlobals();
  });

  it("full startup reaches ACTIVE with dev key", async () => {
    process.env.GLASSTRACE_API_KEY = TEST_DEV_KEY;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    registerGlasstrace();

    await waitForReady(3000);

    expect(isReady()).toBe(true);
    expect(getCoreState()).toBe(CoreState.ACTIVE);
    expect(getAuthState()).toBe(AuthState.AUTHENTICATED);

    const status = getStatus();
    expect(status.ready).toBe(true);
    expect(status.mode).toBe("authenticated");
  });

  it("full startup with Sentry coexistence: auto-attach", async () => {
    process.env.GLASSTRACE_API_KEY = TEST_DEV_KEY;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});

    // Pre-register a provider (simulating Sentry)
    const existingProvider = new otelSdk.BasicTracerProvider();
    otelApi.trace.setGlobalTracerProvider(existingProvider);

    registerGlasstrace();

    await waitForReady(3000);

    expect(getOtelState()).toBe(OtelState.AUTO_ATTACHED);

    // No SIGTERM handlers from SDK (existing provider owns them)
    // Verify via lifecycle state, not process listener count
    const status = getStatus();
    expect(status.tracing).toBe("coexistence");
  });

  it("production mode: REGISTERING → PRODUCTION_DISABLED", () => {
    process.env.NODE_ENV = "production";
    vi.spyOn(console, "warn").mockImplementation(() => {});

    registerGlasstrace();

    expect(getCoreState()).toBe(CoreState.PRODUCTION_DISABLED);
    expect(isReady()).toBe(false);

    const status = getStatus();
    expect(status.ready).toBe(false);
    expect(status.mode).toBe("disabled");
  });

  it("shutdown coordinator: ACTIVE → SHUTTING_DOWN → SHUTDOWN", async () => {
    process.env.GLASSTRACE_API_KEY = TEST_DEV_KEY;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    registerGlasstrace();
    await waitForReady(3000);

    expect(getCoreState()).toBe(CoreState.ACTIVE);

    await executeShutdown();

    expect(getCoreState()).toBe(CoreState.SHUTDOWN);
  });

  it("failed init: KEY_RESOLVED → ACTIVE_DEGRADED", async () => {
    process.env.GLASSTRACE_API_KEY = TEST_DEV_KEY;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // Mock fetch to fail
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    registerGlasstrace();

    await waitForReady(3000);

    // SDK should be degraded but still ready (OTel is configured, init failed)
    expect(isReady()).toBe(true);
    expect(getCoreState()).toBe(CoreState.ACTIVE_DEGRADED);

    // Wait for OTel to finish configuring before asserting tracing status
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (getOtelState() !== OtelState.UNCONFIGURED && getOtelState() !== OtelState.CONFIGURING) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const status = getStatus();
    expect(status.ready).toBe(true);
    expect(status.tracing).toBe("degraded");
  });

  it("getSdkState returns composite state across all layers", async () => {
    process.env.GLASSTRACE_API_KEY = TEST_DEV_KEY;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    registerGlasstrace();
    await waitForReady(3000);

    // Wait for OTel to finish configuring
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (getOtelState() === OtelState.OWNS_PROVIDER) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const state = getSdkState();
    expect(state.core).toBe(CoreState.ACTIVE);
    expect(state.auth).toBe(AuthState.AUTHENTICATED);
    expect(state.otel).toBe(OtelState.OWNS_PROVIDER);
  });

  it("double registration is prevented", () => {
    process.env.GLASSTRACE_API_KEY = TEST_DEV_KEY;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    registerGlasstrace();
    const stateAfterFirst = getCoreState();

    registerGlasstrace(); // second call
    const stateAfterSecond = getCoreState();

    // State should not regress to IDLE or REGISTERING
    expect(stateAfterSecond).toBe(stateAfterFirst);
  });
});
