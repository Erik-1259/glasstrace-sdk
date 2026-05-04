/**
 * Per-middleware overhead microbenchmark for `tracedMiddleware`.
 *
 * SDK-036 acceptance criterion 10 / DISC-1217: per-span overhead under
 * `BatchSpanProcessor` must be below 0.5 ms/span. This test runs a
 * small batch (2_000 spans) on a real BatchSpanProcessor + in-memory
 * exporter, then divides total wall-clock by span count.
 *
 * The assertion uses a generous ceiling (0.5 ms/span as the brief
 * specifies) so the test is not flaky on slow CI runners. The
 * captured per-span figure is logged for the PR description.
 */
import { describe, it, expect } from "vitest";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";
import { tracedMiddleware } from "../../../../packages/sdk/src/trpc/index.js";

// Intentionally NOT calling `installContextManager()` here. The benchmark
// measures per-span overhead in isolation and does not assert on
// parent-child propagation, so the OTel API's no-op context manager is
// sufficient. Calling installContextManager() in this file in addition
// to the runtime test file (`traced-middleware.test.ts`) would trigger
// the duplicate-install warning from `setGlobalContextManager` on the
// second test-file load and pollute test output.

describe("tracedMiddleware — per-span overhead microbenchmark", () => {
  it("stays under 0.5 ms/span on the BatchSpanProcessor path (DISC-1217)", async () => {
    const exporter = new InMemorySpanExporter();
    const processor = new BatchSpanProcessor(exporter, {
      maxQueueSize: 4096,
      maxExportBatchSize: 1024,
      scheduledDelayMillis: 5_000,
    });
    const provider = new BasicTracerProvider({ spanProcessors: [processor] });
    trace.setGlobalTracerProvider(provider);

    try {
      const noop = tracedMiddleware(
        { name: "bench-noop" },
        async (opts: {
          next: () => Promise<{ ok: true; data: unknown }>;
        }) => opts.next(),
      );

      const N = 2_000;
      const fakeOpts = {
        ctx: {},
        type: "query" as const,
        path: "polls.book",
        input: undefined,
        next: () =>
          Promise.resolve({ ok: true as const, data: undefined }),
      };

      // Warm-up: skip first 100 iterations to let the JIT settle.
      for (let i = 0; i < 100; i++) {
        await noop(fakeOpts);
      }

      const start = process.hrtime.bigint();
      for (let i = 0; i < N; i++) {
        await noop(fakeOpts);
      }
      const end = process.hrtime.bigint();

      const totalMs = Number(end - start) / 1_000_000;
      const perSpanMs = totalMs / N;
      console.log(
        `[traced-middleware-bench] ${String(N)} spans / ${totalMs.toFixed(2)} ms total / ${perSpanMs.toFixed(4)} ms/span`,
      );

      // Brief criterion 10 budget. CI runs are slow; the budget gives
      // ample headroom for a typical Node 20+ host. If a host exceeds
      // the budget, we file a follow-up DISC and investigate sampling
      // strategies (per the brief's deferment clause).
      expect(perSpanMs).toBeLessThan(0.5);
    } finally {
      await provider.shutdown();
      trace.disable();
    }
  });
});
