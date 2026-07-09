import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  setSpanDiagnosticsFlag,
  spanDiagnosticsEnabled,
  _resetSpanDiagnosticsFlagForTesting,
} from "../../../../packages/sdk/src/span-diagnostics-flag.js";

const ENV = "GLASSTRACE_SPAN_DIAGNOSTICS";

describe("span-diagnostics-flag", () => {
  const original = process.env[ENV];

  beforeEach(() => {
    _resetSpanDiagnosticsFlagForTesting();
    delete process.env[ENV];
  });

  afterEach(() => {
    _resetSpanDiagnosticsFlagForTesting();
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it("defaults OFF when unresolved and the env var is unset", () => {
    expect(spanDiagnosticsEnabled()).toBe(false);
  });

  it("returns the resolved value once set", () => {
    setSpanDiagnosticsFlag(true);
    expect(spanDiagnosticsEnabled()).toBe(true);
    setSpanDiagnosticsFlag(false);
    expect(spanDiagnosticsEnabled()).toBe(false);
  });

  it("falls back to the env var before resolution", () => {
    process.env[ENV] = "true";
    expect(spanDiagnosticsEnabled()).toBe(true);
  });

  it("only treats the exact string \"true\" as on", () => {
    process.env[ENV] = "1";
    expect(spanDiagnosticsEnabled()).toBe(false);
    process.env[ENV] = "TRUE";
    expect(spanDiagnosticsEnabled()).toBe(false);
  });

  it("a resolved explicit false wins over env true", () => {
    process.env[ENV] = "true";
    setSpanDiagnosticsFlag(false);
    expect(spanDiagnosticsEnabled()).toBe(false);
  });

  it("reset returns to the env fallback", () => {
    setSpanDiagnosticsFlag(true);
    _resetSpanDiagnosticsFlagForTesting();
    expect(spanDiagnosticsEnabled()).toBe(false);
  });

  it("converges across module instances via the globalThis Symbol.for slot", async () => {
    setSpanDiagnosticsFlag(true);
    vi.resetModules();
    const fresh = await import(
      "../../../../packages/sdk/src/span-diagnostics-flag.js"
    );
    // A freshly-evaluated module copy reads the same value the original set.
    expect(fresh.spanDiagnosticsEnabled()).toBe(true);
  });
});
