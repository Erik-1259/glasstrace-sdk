/**
 * Register-wiring for the span-diagnostics flag: `registerGlasstrace()` resolves
 * `GLASSTRACE_SPAN_DIAGNOSTICS` once (synchronously, before the async OTel
 * setup), deliberately NOT folded with `verbose`, and
 * `_resetRegistrationForTesting()` clears it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  registerGlasstrace,
  _resetRegistrationForTesting,
} from "../../../packages/sdk/src/register.js";
import {
  spanDiagnosticsEnabled,
  _resetSpanDiagnosticsFlagForTesting,
} from "../../../packages/sdk/src/span-diagnostics-flag.js";
import {
  _resetConfigForTesting,
  _setTransportForTesting,
} from "../../../packages/sdk/src/init-client.js";
import type { HttpsPostJsonResult } from "../../../packages/sdk/src/https-transport.js";

const TEST_DEV_API_KEY = "gt_dev_" + "a".repeat(48);
const ENV = "GLASSTRACE_SPAN_DIAGNOSTICS";

/** A transport that fails init, so no real network is used and no config applies. */
function failingTransport(): ReturnType<typeof vi.fn> {
  return vi.fn(async (): Promise<HttpsPostJsonResult> => ({
    status: 503,
    body: {},
    raw: "unavailable",
  }));
}

const originalEnv = { ...process.env };

beforeEach(() => {
  _resetRegistrationForTesting();
  _resetConfigForTesting();
  _resetSpanDiagnosticsFlagForTesting();
  vi.restoreAllMocks();
  delete process.env.NODE_ENV;
  delete process.env.VERCEL_ENV;
  delete process.env.GLASSTRACE_API_KEY;
  delete process.env.GLASSTRACE_FORCE_ENABLE;
  delete process.env[ENV];
  _setTransportForTesting(failingTransport() as never);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originalEnv };
  _resetRegistrationForTesting();
  _resetConfigForTesting();
  _resetSpanDiagnosticsFlagForTesting();
});

describe("register span-diagnostics flag wiring", () => {
  it("leaves diagnostics OFF by default", () => {
    registerGlasstrace({ apiKey: TEST_DEV_API_KEY });
    expect(spanDiagnosticsEnabled()).toBe(false);
  });

  it("resolves diagnostics ON from GLASSTRACE_SPAN_DIAGNOSTICS=true", () => {
    process.env[ENV] = "true";
    registerGlasstrace({ apiKey: TEST_DEV_API_KEY });
    expect(spanDiagnosticsEnabled()).toBe(true);
  });

  it("does NOT fold diagnostics into verbose (verbose alone leaves it OFF)", () => {
    registerGlasstrace({ apiKey: TEST_DEV_API_KEY, verbose: true });
    expect(spanDiagnosticsEnabled()).toBe(false);
  });

  it("_resetRegistrationForTesting clears the resolved flag", () => {
    process.env[ENV] = "true";
    registerGlasstrace({ apiKey: TEST_DEV_API_KEY });
    expect(spanDiagnosticsEnabled()).toBe(true);
    delete process.env[ENV];
    _resetRegistrationForTesting();
    expect(spanDiagnosticsEnabled()).toBe(false);
  });
});
