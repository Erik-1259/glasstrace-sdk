/**
 * DISC-1249 regression tests — signal handler timing.
 *
 * Before DISC-1249, signal handlers (SIGTERM / SIGINT) were registered at
 * the END of configureOtel(), after the one-tick yield, the @vercel/otel
 * probe, and the provider registration. If a signal arrived during that
 * async window, no handler existed and buffered spans were silently
 * dropped with no state transition and no warning.
 *
 * The fix moves signal handler registration to registerGlasstrace(),
 * synchronously — after the production-disabled check and before the
 * fire-and-forget configureOtel() call.
 *
 * DISC-1265 extended this further: handlers are now ALWAYS installed,
 * regardless of coexistence mode. The handler consults the coexistenceState
 * flag (set by configureOtel()'s async probe) at signal-delivery time to
 * decide whether to re-raise the signal or yield to the external provider.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as lifecycle from "../../../packages/sdk/src/lifecycle.js";
import {
  CoreState,
  initLifecycle,
  setCoreState,
  getCoreState,
  registerSignalHandlers,
  registerShutdownHook,
  resetLifecycleForTesting,
} from "../../../packages/sdk/src/lifecycle.js";

/**
 * Reproduces the DISC-1249 timing window by:
 *   1. registering signal handlers (as registerGlasstrace() now does),
 *   2. starting a controllable async operation that mimics configureOtel()'s
 *      setImmediate + provider probe,
 *   3. emitting SIGTERM while that operation is still pending,
 *   4. verifying the coordinator reached SHUTTING_DOWN / SHUTDOWN before
 *      the async operation completes.
 *
 * A "delayed probe" promise represents the work inside configureOtel()
 * between the tick yield and the point where it would have registered
 * signal handlers in the old code path.
 */

describe("DISC-1249: signal handler timing during configureOtel() window", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetLifecycleForTesting();
    initLifecycle({ logger: vi.fn() });
    // Prevent the re-raised signal from actually killing the test process.
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    resetLifecycleForTesting();
    killSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("transitions core state to SHUTDOWN when SIGTERM arrives during the async setup window", async () => {
    // Advance state to KEY_PENDING to mirror the state at which
    // registerGlasstrace() spawns configureOtel().
    setCoreState(CoreState.REGISTERING);
    setCoreState(CoreState.KEY_PENDING);

    // Register signal handlers BEFORE the async window opens
    // (the core of the DISC-1249 fix).
    registerSignalHandlers();

    // Controllable promise representing the provider-probe window inside
    // configureOtel() — resolves only when we explicitly release it.
    let releaseProbe!: () => void;
    const probe = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const configureOtelSim = (async () => {
      await probe;
    })();

    // SIGTERM arrives while the probe is still pending.
    process.emit("SIGTERM", "SIGTERM");

    // Allow the signal handler's executeShutdown() microtasks to run.
    await Promise.resolve();
    await Promise.resolve();

    // The handler reaches the coordinator even though the simulated
    // configureOtel() has not yet completed.
    expect(
      [CoreState.SHUTTING_DOWN, CoreState.SHUTDOWN] as CoreState[],
    ).toContain(getCoreState());

    // Now release the probe and verify the flow completes cleanly.
    releaseProbe();
    await configureOtelSim;
    await Promise.resolve();

    // The shutdown coordinator re-raises the signal after hooks complete.
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
  });

  it("emits core:shutdown_started during the window so listeners can stop buffering spans", async () => {
    setCoreState(CoreState.REGISTERING);
    setCoreState(CoreState.KEY_PENDING);
    registerSignalHandlers();

    // Downstream modules (exporter, span processor) subscribe to
    // core:shutdown_started to stop accepting new spans. The fix must make
    // that event reachable even if configureOtel() has not completed yet.
    const events: string[] = [];
    lifecycle.onLifecycleEvent("core:shutdown_started", () => {
      events.push("shutdown_started");
    });
    lifecycle.onLifecycleEvent("core:shutdown_completed", () => {
      events.push("shutdown_completed");
    });

    process.emit("SIGTERM", "SIGTERM");
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    expect(events).toContain("shutdown_started");
    expect(events).toContain("shutdown_completed");
  });

  it("runs hooks exactly once when both SIGTERM and SIGINT arrive (cross-signal idempotence)", async () => {
    // registerSignalHandlers() installs the SAME handler for SIGTERM and
    // SIGINT via process.once(). process.once() removes the listener after
    // it fires, so a second SIGTERM delivery alone does not exercise the
    // idempotence guard inside executeShutdown(). Delivering SIGTERM then
    // SIGINT (or vice-versa) does: both listeners fire, both call
    // executeShutdown(), and the coordinator must run hooks exactly once.
    setCoreState(CoreState.REGISTERING);
    setCoreState(CoreState.KEY_PENDING);
    registerSignalHandlers();

    let invocations = 0;
    registerShutdownHook({
      name: "counter",
      priority: 0,
      fn: async () => {
        invocations++;
      },
    });

    process.emit("SIGTERM", "SIGTERM");
    process.emit("SIGINT", "SIGINT");

    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    expect(invocations).toBe(1);
    expect(getCoreState()).toBe(CoreState.SHUTDOWN);
  });

  it("installs exactly one SIGTERM listener and one SIGINT listener", () => {
    const sigTermBefore = process.listenerCount("SIGTERM");
    const sigIntBefore = process.listenerCount("SIGINT");

    registerSignalHandlers();

    expect(process.listenerCount("SIGTERM") - sigTermBefore).toBe(1);
    expect(process.listenerCount("SIGINT") - sigIntBefore).toBe(1);

    // Calling again is idempotent — no additional listeners.
    registerSignalHandlers();
    expect(process.listenerCount("SIGTERM") - sigTermBefore).toBe(1);
    expect(process.listenerCount("SIGINT") - sigIntBefore).toBe(1);
  });

  it("does not call process.exit — exit behavior is coordinator-owned (re-raises signal)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(
      ((() => undefined) as unknown) as (code?: number) => never,
    );

    setCoreState(CoreState.REGISTERING);
    setCoreState(CoreState.KEY_PENDING);
    registerSignalHandlers();

    process.emit("SIGINT", "SIGINT");
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    expect(exitSpy).not.toHaveBeenCalled();
    // The coordinator re-raises the signal rather than exiting directly.
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");
    exitSpy.mockRestore();
  });
});

describe("DISC-1249 / DISC-1265: registerGlasstrace() signal handler ownership", () => {
  // Verifies the wiring:
  //   - Scenario A (no existing provider): registerGlasstrace() installs
  //     signal handlers synchronously (DISC-1249).
  //   - Scenario B (existing provider): registerGlasstrace() ALSO installs
  //     signal handlers synchronously (DISC-1265). The handler consults the
  //     coexistenceState flag at delivery time to decide whether to re-raise.
  let killSpy: ReturnType<typeof vi.spyOn>;

  const initResponseJson = {
    config: {
      requestBodies: false,
      queryParamValues: false,
      envVarValues: false,
      fullConsoleOutput: false,
      importGraph: false,
    },
    minimumSdkVersion: "0.0.0",
    apiVersion: "v1",
    subscriptionStatus: "anonymous" as const,
    tierLimits: {
      tracesPerMinute: 100,
      storageTtlHours: 48,
      maxTraceSizeBytes: 512000,
      maxConcurrentSessions: 1,
    },
  };

  beforeEach(() => {
    resetLifecycleForTesting();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(async () => {
    const { _resetRegistrationForTesting } = await import(
      "../../../packages/sdk/src/register.js"
    );
    _resetRegistrationForTesting();
    resetLifecycleForTesting();
    killSpy.mockRestore();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // Reset global tracer provider touched by the coexistence test.
    const otelApi = await import("@opentelemetry/api");
    otelApi.trace.disable();
    otelApi.context.disable();
    otelApi.propagation.disable();
  });

  it("Scenario A: installs signal handlers synchronously when no existing provider", async () => {
    const signalSpy = vi.spyOn(lifecycle, "registerSignalHandlers");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(initResponseJson),
      }),
    );

    const { registerGlasstrace, _resetRegistrationForTesting } = await import(
      "../../../packages/sdk/src/register.js"
    );
    _resetRegistrationForTesting();

    registerGlasstrace({
      apiKey: "gt_dev_" + "a".repeat(48),
      environment: "test",
    });

    // Installed synchronously during registerGlasstrace() — before the
    // async configureOtel() chain resolves.
    expect(signalSpy).toHaveBeenCalledTimes(1);
  });

  it("Scenario B: installs signal handlers even when an existing provider is registered (DISC-1265)", async () => {
    const signalSpy = vi.spyOn(lifecycle, "registerSignalHandlers");

    // Seed the global OTel API with an existing (non-Proxy) provider so
    // that the synchronous ProxyTracer probe sees it and selects Scenario B.
    const otelSdk = await import("@opentelemetry/sdk-trace-base");
    const otelApi = await import("@opentelemetry/api");
    const existingProvider = new otelSdk.BasicTracerProvider();
    otelApi.trace.setGlobalTracerProvider(existingProvider);

    const sigTermBefore = process.listenerCount("SIGTERM");
    const sigIntBefore = process.listenerCount("SIGINT");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(initResponseJson),
      }),
    );

    const { registerGlasstrace, _resetRegistrationForTesting } = await import(
      "../../../packages/sdk/src/register.js"
    );
    _resetRegistrationForTesting();

    registerGlasstrace({
      apiKey: "gt_dev_" + "a".repeat(48),
      environment: "test",
    });

    // DISC-1265: handlers are always installed, even in Scenario B.
    // The handler consults coexistenceState at delivery time — not here.
    expect(signalSpy).toHaveBeenCalledTimes(1);
    expect(process.listenerCount("SIGTERM") - sigTermBefore).toBe(1);
    expect(process.listenerCount("SIGINT") - sigIntBefore).toBe(1);
  });
});
