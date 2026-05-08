/**
 * Tests for the SDK-not-registered fast path of `withAsyncCausality`
 * (DISC-1539 / SDK-046). Covers `async:skipped_uninstalled` and the
 * `async:no_originating_context` lifecycle event when the bridge is
 * registered.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { trace } from "@opentelemetry/api";
import {
  withAsyncCausality,
  _resetForTesting,
} from "../../../../packages/sdk/src/async-context/index.js";
import {
  initLifecycle,
  onLifecycleEvent,
  offLifecycleEvent,
  resetLifecycleForTesting,
} from "../../../../packages/sdk/src/lifecycle.js";

const mockLogger = vi.fn();

describe("withAsyncCausality — SDK not registered", () => {
  beforeEach(() => {
    trace.disable();
    resetLifecycleForTesting();
    _resetForTesting();
    mockLogger.mockClear();
    initLifecycle({ logger: mockLogger });
  });

  afterEach(() => {
    trace.disable();
    resetLifecycleForTesting();
    _resetForTesting();
  });

  it("runs the callback and emits async:skipped_uninstalled at most once", async () => {
    const events: Array<Record<string, never>> = [];
    const listener = (p: Record<string, never>) => events.push(p);
    onLifecycleEvent("async:skipped_uninstalled", listener);

    let invocations = 0;
    const cont1 = withAsyncCausality({ name: "x" }, async () => {
      invocations += 1;
      return 1;
    });
    const cont2 = withAsyncCausality({ name: "y" }, async () => {
      invocations += 1;
      return 2;
    });
    await cont1();
    await cont2();
    await cont1();

    expect(invocations).toBe(3);
    expect(events).toHaveLength(1);
    offLifecycleEvent("async:skipped_uninstalled", listener);
  });

  it("emits async:no_originating_context when capture happens outside any active span (provider registered)", async () => {
    // For this scenario we need a live tracer provider but no
    // active span at capture time — re-use the global noop tracer
    // in the non-active case. Trick: install a fresh provider,
    // capture without a span context, then run the continuation.
    const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } =
      await import("@opentelemetry/sdk-trace-base");
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);

    const events: Array<Record<string, never>> = [];
    const listener = (p: Record<string, never>) => events.push(p);
    onLifecycleEvent("async:no_originating_context", listener);

    // Capture happens with no active span (we are at module top-level
    // here, not inside `tracer.startActiveSpan`).
    const cont1 = withAsyncCausality({ name: "task1" }, async () => 1);
    const cont2 = withAsyncCausality({ name: "task2" }, async () => 2);
    await cont1();
    await cont2();

    expect(events).toHaveLength(1);
    offLifecycleEvent("async:no_originating_context", listener);
    await provider.shutdown();
  });
});
