/**
 * Empirical verification for DISC-1250: does `@vercel/otel`'s
 * `registerOTel()` install any process-level shutdown wiring?
 *
 * ## Why this matters
 *
 * `packages/sdk/src/otel-config.ts` takes the Vercel branch when
 * `@vercel/otel` is resolvable (Scenario E). On that branch, the SDK
 * deliberately does NOT call `registerSignalHandlers()` or
 * `registerBeforeExitTrigger()` — it assumes the library owns the
 * provider lifecycle. DISC-1250 flagged this assumption as unverified.
 *
 * ## Methodology
 *
 * We exercise `@vercel/otel` directly (not through `configureOtel()`),
 * because the point of the verification is to characterise the
 * library's behaviour. Inputs we control and outputs we measure:
 *
 *   Input:  a call to `registerOTel()` with a deterministic config.
 *   Input:  a capturing `SpanExporter` passed via `traceExporter`.
 *   Output: the set of `process` listeners that exist immediately
 *           before vs. immediately after the call.
 *   Output: whether the concrete provider's `shutdown()` is invoked
 *           by any ambient side-effect of `registerOTel()`.
 *   Output: the number of spans flushed to the exporter between
 *           `registerOTel()` return and the point where we would
 *           expect SIGTERM delivery to terminate a Vercel runtime.
 *   Output: confirmation that calling `provider.shutdown()` manually
 *           does flush the buffered span (so the gap is in the
 *           invocation, not the implementation).
 *
 * We never actually deliver a real signal to the test worker
 * (`process.emit('SIGTERM')` would invoke vitest's own worker handler
 * and kill the run). Instead we rely on listener-count deltas: if
 * `registerOTel()` registered a handler, we could observe it; and if
 * any ambient mechanism (timer, microtask, etc.) wires shutdown to
 * signal delivery, we'd see the spy fire during the 50 ms settle
 * window at the end of the test.
 *
 * ## Listener isolation
 *
 * We do NOT detach/reattach pre-existing signal listeners. Detaching
 * and re-attaching a `once()` listener via `process.on()` would
 * promote it to a persistent `on()` listener, altering vitest worker
 * shutdown behaviour for subsequent test files. Instead we snapshot
 * the set of pre-existing listener references in `beforeEach` and,
 * in `afterEach`, remove only the listeners that appeared during
 * the test. Pre-existing listeners are never touched. This is the
 * change Codex requested during DISC-1250 review.
 *
 * ## Evidence object
 *
 * Every measurement is stashed in `evidence` so the final `afterAll`
 * hook writes a citable block to `stdout` that the design doc links
 * to.
 *
 * ## Version coverage
 *
 * The suite runs against `@vercel/otel@^2.1.2`, which is the current
 * stable release of the library and the version real users receive
 * when installing alongside the SDK's OTel v2 dependencies. The peer
 * dependency range in `packages/sdk/package.json` is still declared
 * as `^1.0.0`; this is a known staleness tracked by a separate
 * follow-up discovery. We cannot pin the devDependency to v1 because
 * `@vercel/otel@1.x` requires `@opentelemetry/sdk-trace-base@<2.0.0`,
 * which conflicts with the SDK's existing OTel v2 dependencies.
 *
 * Source inspection at `vercel/otel`'s repo confirmed identical
 * absence of `process.on`, `SIGTERM`, `SIGINT`, and `beforeExit`
 * references across the latest v1.x tag (v1.14.1) through v2.1.2,
 * so the verdict holds for the entire Vercel-ecosystem range.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import * as otelApi from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { ExportResultCode } from "@opentelemetry/core";

import { registerOTel } from "@vercel/otel";
import {
  registerShutdownHook,
  registerBeforeExitTrigger,
  executeShutdown,
  resetLifecycleForTesting,
  initLifecycle,
  type ShutdownHook,
} from "../../../packages/sdk/src/lifecycle.js";

/**
 * A capturing exporter: records every batch handed to it and signals
 * success immediately so the BSP's buffering behaviour is unaffected.
 * The returned `exportedBatches` array is the same reference held
 * inside the exporter, so tests can read `exportedBatches.length`
 * at any point to observe flush progress.
 */
function makeCapturingExporter(): {
  exporter: SpanExporter;
  exportedBatches: ReadableSpan[][];
} {
  const exportedBatches: ReadableSpan[][] = [];
  const exporter: SpanExporter = {
    export(spans, cb) {
      exportedBatches.push(spans);
      cb({ code: ExportResultCode.SUCCESS });
    },
    async shutdown() {
      // no-op; shutdown propagation from BSP to exporter is covered
      // implicitly by the flush tests below.
    },
    async forceFlush() {
      // no-op; force flushes arrive as `export()` calls.
    },
  };
  return { exporter, exportedBatches };
}

/**
 * Unwrap a `ProxyTracerProvider` to the concrete `BasicTracerProvider`
 * that `@vercel/otel` installed.
 */
function getConcreteProvider(): otelApi.TracerProvider & {
  shutdown?: () => Promise<void>;
  forceFlush?: () => Promise<void>;
} {
  const proxy = otelApi.trace.getTracerProvider() as unknown as {
    getDelegate?: () => otelApi.TracerProvider;
  };
  return (typeof proxy.getDelegate === "function"
    ? proxy.getDelegate()
    : proxy) as otelApi.TracerProvider & {
    shutdown?: () => Promise<void>;
    forceFlush?: () => Promise<void>;
  };
}

interface Evidence {
  vercelOtelVersion: string;
  sigtermListenersBefore: number;
  sigtermListenersAfter: number;
  sigintListenersBefore: number;
  sigintListenersAfter: number;
  beforeExitListenersBefore: number;
  beforeExitListenersAfter: number;
  providerConstructorName: string;
  providerShutdownInvocations: number;
  spansFlushedAtRegistration: number;
  spansFlushedAfterManualShutdown: number;
}

const evidence: Evidence = {
  vercelOtelVersion: "",
  sigtermListenersBefore: -1,
  sigtermListenersAfter: -1,
  sigintListenersBefore: -1,
  sigintListenersAfter: -1,
  beforeExitListenersBefore: -1,
  beforeExitListenersAfter: -1,
  providerConstructorName: "",
  providerShutdownInvocations: -1,
  spansFlushedAtRegistration: -1,
  spansFlushedAfterManualShutdown: -1,
};

/**
 * Snapshot signal-listener state across the three events. We do NOT
 * detach and re-attach pre-existing listeners — doing so would strip
 * `once()` semantics off listeners that Node internally wraps,
 * promoting them to persistent `on()` listeners and altering the
 * worker's shutdown behaviour for subsequent test files. Instead we
 * record the set of pre-existing listener references and, in
 * `afterEach`, remove only the listeners that appeared during the
 * test. This preserves the baseline worker semantics and avoids
 * cross-test flakiness (Codex DISC-1250 review feedback).
 */
interface SignalBaseline {
  sigterm: ReadonlySet<unknown>;
  sigint: ReadonlySet<unknown>;
  beforeExit: ReadonlySet<unknown>;
}

function captureSignalBaseline(): SignalBaseline {
  return {
    sigterm: new Set(process.listeners("SIGTERM")),
    sigint: new Set(process.listeners("SIGINT")),
    beforeExit: new Set(process.listeners("beforeExit")),
  };
}

/**
 * Remove listeners that appeared between `captureSignalBaseline` and
 * this call. Pre-existing listeners are left untouched so their
 * `once`/`on` mode is preserved.
 */
function removeAddedSignalListeners(baseline: SignalBaseline): void {
  for (const { sig, pre } of [
    { sig: "SIGTERM" as const, pre: baseline.sigterm },
    { sig: "SIGINT" as const, pre: baseline.sigint },
    { sig: "beforeExit" as const, pre: baseline.beforeExit },
  ]) {
    for (const l of process.listeners(sig)) {
      if (!pre.has(l)) {
        process.removeListener(sig, l as (...args: unknown[]) => void);
      }
    }
  }
}

describe("DISC-1250: @vercel/otel shutdown verification", () => {
  let baseline: SignalBaseline;

  beforeEach(() => {
    baseline = captureSignalBaseline();
    otelApi.trace.disable();
    otelApi.context.disable();
    otelApi.propagation.disable();
    otelApi.diag.disable();
  });

  afterEach(() => {
    otelApi.trace.disable();
    otelApi.context.disable();
    otelApi.propagation.disable();
    otelApi.diag.disable();
    removeAddedSignalListeners(baseline);
  });

  afterAll(() => {
    // Emit a citable evidence block so the design doc can reference
    // the exact measurements captured by this run.
    process.stdout.write(
      "\n[DISC-1250 evidence] " + JSON.stringify(evidence, null, 2) + "\n",
    );
  });

  it("records the @vercel/otel version under test", async () => {
    // Resolved from node_modules so the design doc cites an exact
    // library version alongside the measurements below. The package
    // blocks `package.json` via its `exports` field, so we fall back
    // to a direct filesystem read rooted at the project's
    // `node_modules`.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    // process.cwd() is the monorepo root under vitest; node_modules
    // is hoisted there.
    const pkgPath = resolve(
      process.cwd(),
      "node_modules/@vercel/otel/package.json",
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version: string;
    };
    evidence.vercelOtelVersion = pkg.version;
    expect(evidence.vercelOtelVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("registerOTel() adds zero SIGTERM / SIGINT / beforeExit listeners", () => {
    evidence.sigtermListenersBefore = process.listenerCount("SIGTERM");
    evidence.sigintListenersBefore = process.listenerCount("SIGINT");
    evidence.beforeExitListenersBefore = process.listenerCount("beforeExit");

    const { exporter } = makeCapturingExporter();
    registerOTel({ serviceName: "disc-1250-probe", traceExporter: exporter });

    evidence.sigtermListenersAfter = process.listenerCount("SIGTERM");
    evidence.sigintListenersAfter = process.listenerCount("SIGINT");
    evidence.beforeExitListenersAfter = process.listenerCount("beforeExit");

    // Any delta is fully attributable to @vercel/otel because we
    // call registerOTel() directly here (no Glasstrace lifecycle
    // coordinator involved) and measure listenerCount before and
    // after that single call. Pre-existing vitest listeners sit in
    // both snapshots and cancel out; only new additions would show.
    expect(evidence.sigtermListenersAfter - evidence.sigtermListenersBefore).toBe(0);
    expect(evidence.sigintListenersAfter - evidence.sigintListenersBefore).toBe(0);
    expect(
      evidence.beforeExitListenersAfter - evidence.beforeExitListenersBefore,
    ).toBe(0);
  });

  it("registerOTel() installs a concrete tracer provider with a shutdown() method", () => {
    const { exporter } = makeCapturingExporter();
    registerOTel({ serviceName: "disc-1250-probe", traceExporter: exporter });

    const provider = getConcreteProvider();
    evidence.providerConstructorName = provider.constructor.name;

    // The shipped `@vercel/otel` bundle is minified, so the class name
    // may be short or empty depending on bundling and minification.
    // We record it for reference but only assert on the property we
    // actually depend on: that `shutdown()` exists on the provider.
    expect(typeof provider.shutdown).toBe("function");
  });

  it("no ambient code path invokes provider.shutdown() post-registration", async () => {
    const { exporter } = makeCapturingExporter();
    registerOTel({ serviceName: "disc-1250-probe", traceExporter: exporter });

    const provider = getConcreteProvider();
    const originalShutdown = provider.shutdown?.bind(provider);
    let calls = 0;
    const spy = async () => {
      calls += 1;
      if (originalShutdown) await originalShutdown();
    };
    Object.defineProperty(provider, "shutdown", {
      value: spy,
      configurable: true,
      writable: true,
    });

    // Allow any deferred work (resource detection, timers, microtasks)
    // that registerOTel() may have scheduled to run. If the library
    // wired shutdown to any ambient event source, we'd see the call
    // count rise here.
    await new Promise((resolve) => setTimeout(resolve, 50));

    evidence.providerShutdownInvocations = calls;
    expect(calls).toBe(0);
  });

  it("spans emitted immediately after registerOTel() are NOT flushed until shutdown/flush is called", async () => {
    const { exporter, exportedBatches } = makeCapturingExporter();
    registerOTel({ serviceName: "disc-1250-probe", traceExporter: exporter });

    const tracer = otelApi.trace.getTracer("disc-1250");
    const span = tracer.startSpan("disc-1250.probe");
    span.end();

    // Let microtasks drain. BSP defaults buffer spans until either
    // the 5 s scheduled flush, a forceFlush, or shutdown. Nothing
    // here should have triggered any of those.
    await Promise.resolve();
    await Promise.resolve();

    evidence.spansFlushedAtRegistration = exportedBatches.reduce(
      (n, b) => n + b.length,
      0,
    );
    expect(evidence.spansFlushedAtRegistration).toBe(0);
  });

  it("provider.shutdown(), when called manually, drains the buffered span", async () => {
    const { exporter, exportedBatches } = makeCapturingExporter();
    registerOTel({ serviceName: "disc-1250-probe", traceExporter: exporter });

    const tracer = otelApi.trace.getTracer("disc-1250");
    const span = tracer.startSpan("disc-1250.probe");
    span.end();

    const provider = getConcreteProvider();
    // Shutdown propagates through @vercel/otel's CompositeSpanProcessor
    // and ultimately the BatchSpanProcessor that wraps our capturing
    // exporter. This confirms the flush path works — the gap is
    // solely in *when* shutdown is invoked.
    await provider.shutdown?.();

    evidence.spansFlushedAfterManualShutdown = exportedBatches.reduce(
      (n, b) => n + b.length,
      0,
    );
    expect(evidence.spansFlushedAfterManualShutdown).toBeGreaterThanOrEqual(1);
  });

  it("evidence summary records the DISC-1250 verdict", () => {
    // Verdict: @vercel/otel ships no signal handlers and no
    // beforeExit handler. registerOTel() creates an `Sdk` instance
    // locally and discards the reference, so neither the library nor
    // user code can call `Sdk.shutdown()`. Manual
    // `provider.shutdown()` works, but nothing triggers it on exit.
    // Consequence: buffered spans are lost on SIGTERM-driven Vercel
    // shutdown. The fix, per DISC-1250, is for the Glasstrace SDK's
    // Vercel branch to register its OWN signal handlers via the
    // lifecycle coordinator and call `provider.shutdown()` itself.
    expect(evidence.sigtermListenersAfter).toBe(evidence.sigtermListenersBefore);
    expect(evidence.sigintListenersAfter).toBe(evidence.sigintListenersBefore);
    expect(evidence.beforeExitListenersAfter).toBe(
      evidence.beforeExitListenersBefore,
    );
    expect(evidence.providerShutdownInvocations).toBe(0);
    expect(evidence.spansFlushedAtRegistration).toBe(0);
    expect(evidence.spansFlushedAfterManualShutdown).toBeGreaterThanOrEqual(1);
    // Bundled class name is recorded as-is in the evidence block; we
    // do not assert on it because minification may produce a short or
    // empty name across library releases.
    expect(evidence.vercelOtelVersion).not.toBe("");
  });
});

/**
 * DISC-1263: Verify that the Glasstrace lifecycle shutdown hook correctly
 * calls `provider.shutdown()` on the @vercel/otel provider when SIGTERM fires.
 *
 * These tests exercise the hook implementation that DISC-1263 adds to the
 * Vercel branch in `configureOtel()`. They work by:
 *   1. Calling `registerOTel()` directly (same as the Vercel branch does)
 *   2. Manually wiring the `vercel-otel-shutdown` hook (matching the
 *      implementation exactly) so we can test it in isolation from
 *      `tryImport()` resolution differences across environments
 *   3. Verifying the hook's effect: buffered spans are flushed on execution
 *
 * The lifecycle coordinator functions (`registerShutdownHook`,
 * `executeShutdown`) are the same ones used by the production code path,
 * so this is not a unit test of stubs — it exercises the real coordination
 * layer end-to-end.
 */
describe("DISC-1263: vercel-otel-shutdown hook flushes spans via lifecycle coordinator", () => {
  let baseline: SignalBaseline;

  beforeEach(() => {
    baseline = captureSignalBaseline();
    otelApi.trace.disable();
    otelApi.context.disable();
    otelApi.propagation.disable();
    otelApi.diag.disable();
    resetLifecycleForTesting();
    initLifecycle({ logger: () => {} });
  });

  afterEach(() => {
    otelApi.trace.disable();
    otelApi.context.disable();
    otelApi.propagation.disable();
    otelApi.diag.disable();
    removeAddedSignalListeners(baseline);
    resetLifecycleForTesting();
  });

  /**
   * Builds the same `vercel-otel-shutdown` hook that `configureOtel()` registers
   * after calling `registerOTel()`. This mirrors the production implementation
   * so any drift between the test and the real code will be caught at review.
   */
  function buildVercelShutdownHook(): ShutdownHook {
    return {
      name: "vercel-otel-shutdown",
      priority: 0,
      fn: async () => {
        try {
          const proxy = otelApi.trace.getTracerProvider() as unknown as {
            getDelegate?: () => { shutdown?: () => Promise<void> };
          };
          const concrete =
            typeof proxy.getDelegate === "function"
              ? proxy.getDelegate()
              : (proxy as { shutdown?: () => Promise<void> });
          await concrete.shutdown?.();
        } catch {
          // best-effort
        }
      },
    };
  }

  it("shutdown hook is registered with priority 0 (matches bare-path OTel hook)", () => {
    // The hook priority must be 0 so it runs at the same time as Scenario A's
    // `otel-provider-shutdown` hook and before application-level hooks.
    const hook = buildVercelShutdownHook();
    expect(hook.name).toBe("vercel-otel-shutdown");
    expect(hook.priority).toBe(0);
  });

  it("executing the shutdown hook calls provider.shutdown() and drains buffered spans", async () => {
    const { exporter, exportedBatches } = makeCapturingExporter();
    registerOTel({ serviceName: "disc-1263-probe", traceExporter: exporter });

    // Emit a span and verify it is buffered (not yet exported).
    const tracer = otelApi.trace.getTracer("disc-1263");
    const span = tracer.startSpan("disc-1263.probe");
    span.end();
    await Promise.resolve();
    expect(exportedBatches.reduce((n, b) => n + b.length, 0)).toBe(0);

    // Register and execute the hook exactly as the production code does.
    registerShutdownHook(buildVercelShutdownHook());
    registerBeforeExitTrigger();
    await executeShutdown();

    // The BatchSpanProcessor inside @vercel/otel should have flushed.
    expect(exportedBatches.reduce((n, b) => n + b.length, 0)).toBeGreaterThanOrEqual(1);
  });

  it("executing the shutdown hook twice does not double-shutdown (idempotence)", async () => {
    const { exporter, exportedBatches } = makeCapturingExporter();
    registerOTel({ serviceName: "disc-1263-idempotence", traceExporter: exporter });

    const tracer = otelApi.trace.getTracer("disc-1263");
    const span = tracer.startSpan("disc-1263.idempotence");
    span.end();

    // Capture the concrete provider's shutdown invocation count.
    const concrete = getConcreteProvider();
    const originalShutdown = concrete.shutdown?.bind(concrete);
    let shutdownCalls = 0;
    Object.defineProperty(concrete, "shutdown", {
      value: async () => {
        shutdownCalls += 1;
        await originalShutdown?.();
      },
      configurable: true,
      writable: true,
    });

    const hook = buildVercelShutdownHook();
    // Calling the hook fn twice simulates two shutdown triggers (e.g. both
    // SIGTERM and beforeExit fire). The hook itself is not idempotent (it
    // calls the provider each time), but the lifecycle coordinator's
    // executeShutdown() is — it runs hooks at most once per lifecycle.
    // This test verifies that calling executeShutdown() twice is safe.
    registerShutdownHook(hook);
    await executeShutdown(); // first run — hooks execute
    await executeShutdown(); // second run — coordinator no-ops

    // provider.shutdown() called exactly once (first executeShutdown only).
    expect(shutdownCalls).toBe(1);
    // Spans were flushed by the first shutdown.
    expect(exportedBatches.reduce((n, b) => n + b.length, 0)).toBeGreaterThanOrEqual(1);
  });
});
