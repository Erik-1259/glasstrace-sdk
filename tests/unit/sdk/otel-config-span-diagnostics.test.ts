/**
 * The load-bearing path: on the bare OTel path (SDK-owned BasicTracerProvider —
 * `otel.path=bare`), the flag-gated span-lifecycle diagnostic auto-attaches
 * alongside the export processor. This is how the diagnostic reaches the real
 * validation app, which registers via `registerGlasstrace({ verbose: true })`
 * and runs the bare path — no instrumentation rewrite, just the env flag.
 *
 * The diagnostic's own shutdown is driven directly (found on the provider's
 * processor list) rather than through `provider.shutdown()`, because the real
 * `BatchSpanProcessor` + pending-key exporter would block on its flush.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as otelApi from "@opentelemetry/api";
import { SpanKind } from "@opentelemetry/api";
import {
  configureOtel,
  resetOtelConfigForTesting,
} from "../../../packages/sdk/src/otel-config.js";
import { SessionManager } from "../../../packages/sdk/src/session.js";
import type { ResolvedConfig } from "../../../packages/sdk/src/env-detection.js";
import * as lifecycle from "../../../packages/sdk/src/lifecycle.js";
import { SpanDiagnosticsProcessor } from "../../../packages/sdk/src/diagnostics/span-diagnostics-processor.js";
import {
  setSpanDiagnosticsFlag,
  _resetSpanDiagnosticsFlagForTesting,
} from "../../../packages/sdk/src/span-diagnostics-flag.js";

const ENV = "GLASSTRACE_SPAN_DIAGNOSTICS";
const ENV_OUT = "GLASSTRACE_SPAN_DIAGNOSTICS_OUT";

function createTestConfig(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    endpoint: "https://ingest.glasstrace.dev",
    environment: "test",
    verbose: false,
    nodeEnv: "test",
    vercelEnv: undefined,
    apiKey: undefined, // pending → exporter buffers, no network
    coverageMapEnabled: false,
    forceEnable: false,
    ...overrides,
  };
}

/** Reach the diagnostic processor attached to the SDK-owned provider, if any. */
function findDiagnosticProcessor(): SpanDiagnosticsProcessor | undefined {
  const proxy = otelApi.trace.getTracerProvider() as unknown as {
    getDelegate?: () => unknown;
  };
  const provider =
    typeof proxy.getDelegate === "function" ? proxy.getDelegate() : proxy;
  const processors =
    (provider as { _activeSpanProcessor?: { _spanProcessors?: unknown[] } })
      ._activeSpanProcessor?._spanProcessors ?? [];
  return processors.find(
    (p): p is SpanDiagnosticsProcessor => p instanceof SpanDiagnosticsProcessor,
  );
}

describe("bare-path span-diagnostics auto-attach", () => {
  let sessionManager: SessionManager;
  let dir: string;
  let outPath: string;
  const origEnabled = process.env[ENV];
  const origOut = process.env[ENV_OUT];

  beforeEach(() => {
    otelApi.trace.disable();
    lifecycle.resetLifecycleForTesting();
    lifecycle.initLifecycle({ logger: vi.fn() });
    resetOtelConfigForTesting();
    _resetSpanDiagnosticsFlagForTesting();
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    sessionManager = new SessionManager();
    dir = mkdtempSync(join(tmpdir(), "gt-otel-diag-"));
    outPath = join(dir, "diag.jsonl");
    // The flag-off test relies on the store's null default → env fallback, so
    // the ambient env var must not leak in from the shell/CI.
    delete process.env[ENV];
    process.env[ENV_OUT] = outPath;
  });

  afterEach(() => {
    lifecycle.resetLifecycleForTesting();
    resetOtelConfigForTesting();
    _resetSpanDiagnosticsFlagForTesting();
    otelApi.trace.disable();
    otelApi.context.disable();
    if (origEnabled === undefined) delete process.env[ENV];
    else process.env[ENV] = origEnabled;
    if (origOut === undefined) delete process.env[ENV_OUT];
    else process.env[ENV_OUT] = origOut;
    rmSync(dir, { recursive: true, force: true });
  });

  it("attaches the diagnostic when the flag is on and records the span lifecycle", async () => {
    setSpanDiagnosticsFlag(true);

    await configureOtel(createTestConfig(), sessionManager);

    const tracer = otelApi.trace.getTracer("test");
    const span = tracer.startSpan("POST /settings", { kind: SpanKind.SERVER });
    span.end();

    const diag = findDiagnosticProcessor();
    expect(diag).toBeDefined(); // proves it auto-attached to the bare provider
    await diag!.shutdown(); // emits the run-summary

    expect(existsSync(outPath)).toBe(true);
    const evs = readFileSync(outPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { ev: string }).ev);
    expect(evs).toContain("start");
    expect(evs).toContain("end");
    expect(evs).toContain("run-summary");
  });

  it("does NOT attach the diagnostic when the flag is off", async () => {
    // flag left at default (off)
    await configureOtel(createTestConfig(), sessionManager);

    const tracer = otelApi.trace.getTracer("test");
    tracer.startSpan("POST /settings", { kind: SpanKind.SERVER }).end();

    expect(findDiagnosticProcessor()).toBeUndefined();
    expect(existsSync(outPath)).toBe(false);
  });
});
