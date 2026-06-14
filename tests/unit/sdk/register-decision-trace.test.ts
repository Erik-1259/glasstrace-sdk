/**
 * Decision-trace integration for the config-apply gate in `backgroundInit`.
 *
 * After `performInit` returns, `registerGlasstrace` emits a
 * `capture.sideEffectEvidence` decision for the `configApply` surface that
 * reports the backend-authoritative capture posture the SDK applied (read
 * via `getActiveConfig()`, not the pre-init resolved config). On init
 * failure it emits a distinct fail-closed line. These tests drive the real
 * register/background-init path through the mock transport and assert the
 * emitted `core:decision` event.
 *
 * They also prove the toggle wiring end-to-end: OFF (default) is silent,
 * the `decisionTrace` option turns it on, and `verbose: true` folds in.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerGlasstrace,
  _resetRegistrationForTesting,
} from "../../../packages/sdk/src/register.js";
import {
  _resetConfigForTesting,
  _setTransportForTesting,
  _setCurrentConfig,
} from "../../../packages/sdk/src/init-client.js";
import type { HttpsPostJsonResult } from "../../../packages/sdk/src/https-transport.js";
import type { SdkInitResponse } from "@glasstrace/protocol";
import {
  onLifecycleEvent,
  offLifecycleEvent,
} from "../../../packages/sdk/src/lifecycle.js";
import type { SdkLifecycleEvents } from "../../../packages/sdk/src/lifecycle.js";

const TEST_DEV_API_KEY = "gt_dev_" + "a".repeat(48);
const BACKGROUND_SETTLE_MS = 200;

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

/** Transport returning a schema-valid init response with the given capture posture. */
function transportWithCapture(
  sideEffectEvidence: boolean,
  captureFidelity: "strict" | "full" = "strict",
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
        sideEffectEvidence,
        captureFidelity,
      },
    },
    raw: "",
  }));
}

/** Transport that fails the init call so the fail-closed branch is taken. */
function failingTransport(): ReturnType<typeof vi.fn> {
  return vi.fn(async (): Promise<HttpsPostJsonResult> => ({
    status: 503,
    body: {},
    raw: "service unavailable",
  }));
}

/** A cached init response with the given capture posture, used to seed the
 *  in-memory config the way a loaded disk cache would before init runs. */
function cachedConfig(sideEffectEvidence: boolean): SdkInitResponse {
  return {
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
      sideEffectEvidence,
      captureFidelity: "strict",
    },
  } as SdkInitResponse;
}

async function settle(ms = BACKGROUND_SETTLE_MS): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function collectConfigApply(): {
  events: SdkLifecycleEvents["core:decision"][];
  stop: () => void;
} {
  const events: SdkLifecycleEvents["core:decision"][] = [];
  const listener = (e: SdkLifecycleEvents["core:decision"]): void => {
    if (e.inputs?.surface === "configApply") events.push(e);
  };
  onLifecycleEvent("core:decision", listener);
  return { events, stop: () => offLifecycleEvent("core:decision", listener) };
}

const originalEnv = { ...process.env };
const originalCwd = process.cwd();
let tempDir: string;

beforeEach(async () => {
  // Run each test in a fresh temp cwd so a successful init's on-disk config
  // cache (`.glasstrace/config`) never leaks into a sibling test's tier-2
  // config read — without this, a prior `sideEffectEvidence: true` cache
  // would surface in the fail-closed tests through `getActiveConfig()`.
  tempDir = await mkdtemp(join(tmpdir(), "glasstrace-decision-trace-"));
  process.chdir(tempDir);
  _resetRegistrationForTesting();
  _resetConfigForTesting();
  vi.restoreAllMocks();
  delete process.env.NODE_ENV;
  delete process.env.VERCEL_ENV;
  delete process.env.GLASSTRACE_API_KEY;
  delete process.env.GLASSTRACE_FORCE_ENABLE;
  delete process.env.GLASSTRACE_DECISION_TRACE;
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  process.env = { ...originalEnv };
  _resetRegistrationForTesting();
  _resetConfigForTesting();
  vi.unstubAllGlobals();
  process.chdir(originalCwd);
  await rm(tempDir, { recursive: true, force: true });
});

describe("config-apply decision — toggle OFF", () => {
  it("emits no config-apply event by default", async () => {
    _setTransportForTesting(transportWithCapture(true) as never);
    const { events, stop } = collectConfigApply();
    registerGlasstrace({ apiKey: TEST_DEV_API_KEY });
    await settle();
    stop();
    expect(events).toEqual([]);
  });
});

describe("config-apply decision — toggle ON via option", () => {
  it("reports the backend-applied enabled posture with captureFidelity", async () => {
    _setTransportForTesting(transportWithCapture(true, "full") as never);
    const { events, stop } = collectConfigApply();
    registerGlasstrace({ apiKey: TEST_DEV_API_KEY, decisionTrace: true });
    await settle();
    stop();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      point: "capture.sideEffectEvidence",
      outcome: "enabled",
      reason: "config_applied",
      inputs: { surface: "configApply", captureFidelity: "full" },
    });
  });

  it("reports the backend-applied disabled posture", async () => {
    _setTransportForTesting(transportWithCapture(false) as never);
    const { events, stop } = collectConfigApply();
    registerGlasstrace({ apiKey: TEST_DEV_API_KEY, decisionTrace: true });
    await settle();
    stop();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "disabled",
      reason: "config_applied",
      inputs: { surface: "configApply" },
    });
  });
});

describe("config-apply decision — toggle ON via env var", () => {
  it("env var alone enables the config-apply emission", async () => {
    process.env.GLASSTRACE_DECISION_TRACE = "true";
    _setTransportForTesting(transportWithCapture(true) as never);
    const { events, stop } = collectConfigApply();
    registerGlasstrace({ apiKey: TEST_DEV_API_KEY });
    await settle();
    stop();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "enabled" });
  });
});

describe("config-apply decision — verbose fold", () => {
  it("verbose: true enables decision tracing without the explicit flag", async () => {
    _setTransportForTesting(transportWithCapture(true) as never);
    const { events, stop } = collectConfigApply();
    registerGlasstrace({ apiKey: TEST_DEV_API_KEY, verbose: true });
    await settle();
    stop();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "enabled", reason: "config_applied" });
  });
});

describe("config-apply decision — fail-closed branch", () => {
  it("emits the fail-closed line when init fails", async () => {
    _setTransportForTesting(failingTransport() as never);
    const { events, stop } = collectConfigApply();
    registerGlasstrace({ apiKey: TEST_DEV_API_KEY, decisionTrace: true });
    await settle();
    stop();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      point: "capture.sideEffectEvidence",
      outcome: "disabled",
      reason: "init_failed_fail_closed",
      inputs: { surface: "configApply" },
    });
  });

  it("reports the cached-config posture when init fails but the cache keeps capture enabled", async () => {
    // Simulate a previously cached init response that enabled capture; a
    // fresh init failure leaves that cached config active, so the SDK can
    // still record side effects from the cache. The decision line must
    // report the real posture (enabled) rather than claiming fail-closed.
    _setCurrentConfig(cachedConfig(true));
    _setTransportForTesting(failingTransport() as never);
    const { events, stop } = collectConfigApply();
    registerGlasstrace({ apiKey: TEST_DEV_API_KEY, decisionTrace: true });
    await settle();
    stop();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      point: "capture.sideEffectEvidence",
      outcome: "enabled",
      reason: "init_failed_cached_config_active",
      inputs: { surface: "configApply", captureFidelity: "strict" },
    });
  });

  it("still reports fail-closed when init fails and no cached config enables capture", async () => {
    // A cached config that left capture OFF must not mask the fail-closed
    // posture — the gate is genuinely closed in this scenario.
    _setCurrentConfig(cachedConfig(false));
    _setTransportForTesting(failingTransport() as never);
    const { events, stop } = collectConfigApply();
    registerGlasstrace({ apiKey: TEST_DEV_API_KEY, decisionTrace: true });
    await settle();
    stop();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      point: "capture.sideEffectEvidence",
      outcome: "disabled",
      reason: "init_failed_fail_closed",
      inputs: { surface: "configApply" },
    });
  });
});
