/**
 * DISC-1265 — coexistence-aware signal handler tests.
 *
 * The signal handler is always installed by registerGlasstrace(), regardless
 * of whether another OTel provider exists. The re-raise decision is deferred
 * to delivery time based on coexistenceState (set by configureOtel() once
 * the async provider probe completes):
 *
 *   "unknown"    → re-raise (startup window; safe default)
 *   "sole-owner" → re-raise (Glasstrace owns the provider)
 *   "coexisting" → hooks run, no re-raise (existing provider owns shutdown)
 *
 * These tests exercise the three states directly through the lifecycle and
 * signal-handler modules without going through the full registration stack.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  initLifecycle,
  setCoreState,
  getCoreState,
  CoreState,
  registerSignalHandlers,
  registerShutdownHook,
  resetLifecycleForTesting,
} from "../../../packages/sdk/src/lifecycle.js";
import {
  setCoexistenceState,
  getCoexistenceState,
  _resetCoexistenceStateForTesting,
} from "../../../packages/sdk/src/signal-handler.js";

describe("DISC-1265: coexistence-aware signal handler", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetCoexistenceStateForTesting();
    resetLifecycleForTesting();
    initLifecycle({ logger: vi.fn() });
    setCoreState(CoreState.REGISTERING);
    setCoreState(CoreState.KEY_PENDING);
    // Prevent the re-raised signal from actually killing the test process.
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
    vi.restoreAllMocks();
    resetLifecycleForTesting();
    _resetCoexistenceStateForTesting();
  });

  // -------------------------------------------------------------------------
  // State: "unknown" (async window before probe completes)
  // -------------------------------------------------------------------------

  it("state=unknown: re-raises signal (safe default during startup window)", async () => {
    // coexistenceState starts as "unknown" — the probe has not resolved yet.
    expect(getCoexistenceState()).toBe("unknown");

    registerSignalHandlers();
    process.emit("SIGTERM", "SIGTERM");

    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
    expect(getCoreState()).toBe(CoreState.SHUTDOWN);
  });

  it("state=unknown: shutdown hooks still run before re-raise", async () => {
    expect(getCoexistenceState()).toBe("unknown");

    let hookRan = false;
    registerSignalHandlers();
    registerShutdownHook({
      name: "test-hook",
      priority: 0,
      fn: async () => {
        hookRan = true;
      },
    });

    process.emit("SIGINT", "SIGINT");

    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    expect(hookRan).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");
  });

  // -------------------------------------------------------------------------
  // State: "sole-owner" (Scenario A / E — Glasstrace owns the provider)
  // -------------------------------------------------------------------------

  it("state=sole-owner: re-raises signal after hooks drain", async () => {
    setCoexistenceState("sole-owner");

    registerSignalHandlers();
    process.emit("SIGTERM", "SIGTERM");

    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
    expect(getCoreState()).toBe(CoreState.SHUTDOWN);
  });

  it("state=sole-owner: hooks run and state transitions to SHUTDOWN", async () => {
    setCoexistenceState("sole-owner");

    const hookNames: string[] = [];
    registerSignalHandlers();
    registerShutdownHook({
      name: "flush-spans",
      priority: 0,
      fn: async () => {
        hookNames.push("flush-spans");
      },
    });

    process.emit("SIGINT", "SIGINT");

    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    expect(hookNames).toEqual(["flush-spans"]);
    expect(getCoreState()).toBe(CoreState.SHUTDOWN);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");
  });

  // -------------------------------------------------------------------------
  // State: "coexisting" (Scenario B — existing provider owns shutdown)
  // -------------------------------------------------------------------------

  it("state=coexisting: hooks run but signal is NOT re-raised", async () => {
    setCoexistenceState("coexisting");

    let hookRan = false;
    registerSignalHandlers();
    registerShutdownHook({
      name: "coexistence-flush",
      priority: 5,
      fn: async () => {
        hookRan = true;
      },
    });

    process.emit("SIGTERM", "SIGTERM");

    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    expect(hookRan).toBe(true);
    expect(getCoreState()).toBe(CoreState.SHUTDOWN);
    // The existing provider owns re-raise — we must not call process.kill().
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("state=coexisting: heartbeat hook fires on exit", async () => {
    setCoexistenceState("coexisting");

    const hookLog: string[] = [];
    registerSignalHandlers();
    registerShutdownHook({
      name: "heartbeat-flush",
      priority: 10,
      fn: async () => {
        hookLog.push("heartbeat-flush");
      },
    });
    registerShutdownHook({
      name: "coexistence-flush",
      priority: 5,
      fn: async () => {
        hookLog.push("coexistence-flush");
      },
    });

    process.emit("SIGINT", "SIGINT");

    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    // Both hooks fire (priority order: 5 before 10).
    expect(hookLog).toEqual(["coexistence-flush", "heartbeat-flush"]);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("state=coexisting: no re-raise on SIGINT either", async () => {
    setCoexistenceState("coexisting");
    registerSignalHandlers();

    process.emit("SIGINT", "SIGINT");

    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    expect(killSpy).not.toHaveBeenCalled();
    expect(getCoreState()).toBe(CoreState.SHUTDOWN);
  });

  // -------------------------------------------------------------------------
  // Scenario B startup window race (Codex review finding on #168)
  // -------------------------------------------------------------------------

  it("Scenario B: synchronous setCoexistenceState prevents re-raise even before configureOtel() async probe", async () => {
    // Reproduces the exact race found in the Codex review: when an external
    // provider is detected synchronously in registerGlasstrace(), we must set
    // coexistenceState="coexisting" BEFORE installing the signal handler so
    // that a signal arriving in the configureOtel() async tick window does not
    // re-raise and terminate the process prematurely.
    //
    // Pattern from registerGlasstrace():
    //   1. anotherProviderRegistered = true (synchronous probe)
    //   2. setCoexistenceState("coexisting")      ← must come before handler
    //   3. registerSignalHandlers()
    //   4. ... async configureOtel() still pending ...
    //   5. SIGTERM arrives while step 4 is awaiting

    setCoexistenceState("coexisting");  // step 2 (simulates register.ts)
    registerSignalHandlers();           // step 3

    // step 5: signal arrives while configureOtel() async probe is still pending
    process.emit("SIGTERM", "SIGTERM");

    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    // Must NOT re-raise — the existing provider owns signal shutdown.
    expect(killSpy).not.toHaveBeenCalled();
    expect(getCoreState()).toBe(CoreState.SHUTDOWN);
  });

  // -------------------------------------------------------------------------
  // Signal handler is always installed (DISC-1265 core requirement)
  // -------------------------------------------------------------------------

  it("signal handler is installed unconditionally — not gated on coexistenceState", () => {
    // All three states: handler installs regardless.
    for (const state of ["unknown", "sole-owner", "coexisting"] as const) {
      _resetCoexistenceStateForTesting();
      resetLifecycleForTesting();
      initLifecycle({ logger: vi.fn() });
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);

      setCoexistenceState(state);

      const sigTermBefore = process.listenerCount("SIGTERM");
      const sigIntBefore = process.listenerCount("SIGINT");

      registerSignalHandlers();

      expect(process.listenerCount("SIGTERM") - sigTermBefore).toBe(1);
      expect(process.listenerCount("SIGINT") - sigIntBefore).toBe(1);
    }
  });

  it("calling registerSignalHandlers() twice is idempotent — no duplicate listeners", () => {
    const sigTermBefore = process.listenerCount("SIGTERM");
    const sigIntBefore = process.listenerCount("SIGINT");

    registerSignalHandlers();
    registerSignalHandlers();

    expect(process.listenerCount("SIGTERM") - sigTermBefore).toBe(1);
    expect(process.listenerCount("SIGINT") - sigIntBefore).toBe(1);
  });
});
