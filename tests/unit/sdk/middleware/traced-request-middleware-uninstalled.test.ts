/**
 * Tests for the SDK-not-registered fast path of
 * `tracedRequestMiddleware` (DISC-1537 / SDK-046).
 *
 * In this scenario the OTel API is in its initial noop state — no
 * `TracerProvider` has been registered. The wrapper must:
 *   1. Run the wrapped handler unwrapped.
 *   2. Emit a `middleware:skipped_uninstalled` lifecycle event at
 *      most once per process.
 *   3. Not attempt to open a real span (no AsyncLocalStorage usage,
 *      no exporter delivery).
 *
 * The lifecycle event channel is end-to-end: the wrapper calls
 * `tryEmitLifecycleEvent`, which is bridged via globalThis to
 * `emitLifecycleEvent` from `lifecycle.ts` once `initLifecycle()` has
 * run. This test exercises both the noop tracer detection and the
 * lifecycle-bridge round trip.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { trace } from "@opentelemetry/api";
import {
  tracedRequestMiddleware,
  _resetForTesting,
} from "../../../../packages/sdk/src/middleware/index.js";
import {
  initLifecycle,
  onLifecycleEvent,
  offLifecycleEvent,
  resetLifecycleForTesting,
} from "../../../../packages/sdk/src/lifecycle.js";

const mockLogger = vi.fn();

describe("tracedRequestMiddleware — SDK not registered", () => {
  beforeEach(() => {
    // Clear OTel global state so `trace.getTracer()` returns the
    // noop tracer. `trace.disable()` resets the global
    // ProxyTracerProvider's delegate to the default noop.
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

  it("runs the wrapped handler and emits middleware:skipped_uninstalled exactly once", async () => {
    const events: Array<Record<string, never>> = [];
    const listener = (p: Record<string, never>) => events.push(p);
    onLifecycleEvent("middleware:skipped_uninstalled", listener);

    let invocations = 0;
    const wrapped = tracedRequestMiddleware(
      { name: "auth" },
      async () => {
        invocations += 1;
        return { status: 200 };
      },
    );

    await wrapped({ nextUrl: { pathname: "/x" } });
    await wrapped({ nextUrl: { pathname: "/y" } });
    await wrapped({ nextUrl: { pathname: "/z" } });

    expect(invocations).toBe(3);
    // Once-per-process; subsequent invocations do not re-emit.
    expect(events).toHaveLength(1);

    offLifecycleEvent("middleware:skipped_uninstalled", listener);
  });

  it("does not crash if the wrapped handler throws (no span context to wrap on)", async () => {
    const wrapped = tracedRequestMiddleware(
      { name: "auth" },
      async () => {
        throw new Error("boom");
      },
    );

    await expect(
      wrapped({ nextUrl: { pathname: "/x" } }),
    ).rejects.toThrow("boom");
  });

  it("emits no lifecycle event if the bridge has no listener registered", async () => {
    // No onLifecycleEvent subscription; the wrapper must still run
    // cleanly and not throw from the bridge call.
    const wrapped = tracedRequestMiddleware(
      { name: "auth" },
      async () => ({ status: 200 }),
    );

    await expect(
      wrapped({ nextUrl: { pathname: "/x" } }),
    ).resolves.toEqual({ status: 200 });
  });
});
