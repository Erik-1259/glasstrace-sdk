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
 * Snapshot the current listeners so we can strip them for the
 * duration of a test and restore them afterwards. Without this,
 * vitest's own SIGTERM/SIGINT listeners contaminate the count and
 * `process.emit('SIGTERM')` would terminate the worker.
 */
interface SavedListeners {
  sigterm: ((...args: unknown[]) => void)[];
  sigint: ((...args: unknown[]) => void)[];
  beforeExit: ((...args: unknown[]) => void)[];
}

function detachSignalListeners(): SavedListeners {
  const saved: SavedListeners = {
    sigterm: process.listeners("SIGTERM") as ((...args: unknown[]) => void)[],
    sigint: process.listeners("SIGINT") as ((...args: unknown[]) => void)[],
    beforeExit: process.listeners("beforeExit") as ((...args: unknown[]) => void)[],
  };
  for (const l of saved.sigterm) process.removeListener("SIGTERM", l);
  for (const l of saved.sigint) process.removeListener("SIGINT", l);
  for (const l of saved.beforeExit) process.removeListener("beforeExit", l);
  return saved;
}

function reattachSignalListeners(saved: SavedListeners): void {
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("beforeExit");
  for (const l of saved.sigterm) process.on("SIGTERM", l);
  for (const l of saved.sigint) process.on("SIGINT", l);
  for (const l of saved.beforeExit) process.on("beforeExit", l);
}

describe("DISC-1250: @vercel/otel shutdown verification", () => {
  let saved: SavedListeners;

  beforeEach(() => {
    saved = detachSignalListeners();
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
    reattachSignalListeners(saved);
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
    // detached vitest's listeners in beforeEach and we're calling
    // registerOTel() directly (no Glasstrace lifecycle coordinator
    // involved).
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
