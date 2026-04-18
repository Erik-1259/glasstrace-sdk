/**
 * DISC-1265 regression tests — coexistence-aware signal handler.
 *
 * Before DISC-1265, signal handler installation was conditional:
 *   - Scenario A (no existing provider): installed.
 *   - Scenario B (coexisting provider): skipped.
 *
 * This left a gap: PR #145 removed heartbeat.ts's own SIGTERM listener in
 * favour of routing through the lifecycle coordinator. PR #146 then
 * conditionally skipped the coordinator's signal handler in Scenario B.
 * Combined effect: on a Scenario-B container, SIGTERM ran no hooks at all,
 * so the heartbeat's final health report was silently dropped.
 *
 * The fix (DISC-1265) always installs the handler, and consults a
 * coexistenceState flag at DELIVERY time rather than at installation time:
 *   - "unknown"     — flag not yet updated by async probe; re-raise.
 *   - "sole-owner"  — Glasstrace owns the provider; re-raise (Scenarios A/E).
 *   - "coexisting"  — external provider detected; run hooks, then yield if
 *                     another handler is present, else re-raise to prevent hang.
 *
 * These tests cover all three flag states plus the heartbeat-in-B scenario.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CoreState,
  initLifecycle,
  setCoreState,
  getCoreState,
  registerSignalHandlers,
  registerShutdownHook,
  resetLifecycleForTesting,
  setCoexistenceState,
  getCoexistenceState,
} from "../../../packages/sdk/src/lifecycle.js";

describe("DISC-1265: coexistence-aware signal handler", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetLifecycleForTesting();
    initLifecycle({ logger: vi.fn() });
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    resetLifecycleForTesting();
    killSpy.mockRestore();
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Signal handler is always installed (regression guard for PR #146 condition)
  // ---------------------------------------------------------------------------

  it("signal handler is installed regardless of coexistence state", () => {
    const sigTermBefore = process.listenerCount("SIGTERM");
    const sigIntBefore = process.listenerCount("SIGINT");

    // Default state is "unknown" — handlers must still be installed
    expect(getCoexistenceState()).toBe("unknown");
    registerSignalHandlers();

    expect(process.listenerCount("SIGTERM") - sigTermBefore).toBe(1);
    expect(process.listenerCount("SIGINT") - sigIntBefore).toBe(1);
  });

  it("signal handler installation is idempotent when called twice", () => {
    const sigTermBefore = process.listenerCount("SIGTERM");
    registerSignalHandlers();
    registerSignalHandlers();
    expect(process.listenerCount("SIGTERM") - sigTermBefore).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // "unknown" flag state (async probe has not yet completed)
  // ---------------------------------------------------------------------------

  it('flag "unknown": SIGTERM fires hooks and re-raises the signal', async () => {
    setCoreState(CoreState.REGISTERING);
    setCoreState(CoreState.KEY_PENDING);
    registerSignalHandlers();

    // Flag stays "unknown" — probe window has not closed
    expect(getCoexistenceState()).toBe("unknown");

    let hookRan = false;
    registerShutdownHook({
      name: "test-hook",
      priority: 0,
      fn: async () => {
        hookRan = true;
      },
    });

    process.emit("SIGTERM", "SIGTERM");
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    expect(hookRan).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
  });

  // ---------------------------------------------------------------------------
  // "sole-owner" flag state (Scenario A / E — Glasstrace owns the provider)
  // ---------------------------------------------------------------------------

  it('flag "sole-owner": SIGTERM fires hooks and re-raises the signal', async () => {
    setCoreState(CoreState.REGISTERING);
    setCoreState(CoreState.KEY_PENDING);
    registerSignalHandlers();
    setCoexistenceState("sole-owner");

    let hookRan = false;
    registerShutdownHook({
      name: "test-hook",
      priority: 0,
      fn: async () => {
        hookRan = true;
      },
    });

    process.emit("SIGTERM", "SIGTERM");
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    expect(hookRan).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
  });

  it('flag "sole-owner": SIGINT fires hooks and re-raises the signal', async () => {
    setCoreState(CoreState.REGISTERING);
    setCoreState(CoreState.KEY_PENDING);
    registerSignalHandlers();
    setCoexistenceState("sole-owner");

    let hookRan = false;
    registerShutdownHook({
      name: "test-hook",
      priority: 0,
      fn: async () => {
        hookRan = true;
      },
    });

    process.emit("SIGINT", "SIGINT");
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    expect(hookRan).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");
  });

  it('flag "sole-owner": core state reaches SHUTDOWN after SIGTERM', async () => {
    setCoreState(CoreState.REGISTERING);
    setCoreState(CoreState.KEY_PENDING);
    registerSignalHandlers();
    setCoexistenceState("sole-owner");

    process.emit("SIGTERM", "SIGTERM");
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    expect(getCoreState()).toBe(CoreState.SHUTDOWN);
  });

  // ---------------------------------------------------------------------------
  // "coexisting" flag state (Scenario B / D — external provider present)
  // ---------------------------------------------------------------------------

  it('flag "coexisting": hooks run but signal is NOT re-raised when another handler is present', async () => {
    setCoreState(CoreState.REGISTERING);
    setCoreState(CoreState.KEY_PENDING);
    registerSignalHandlers();
    setCoexistenceState("coexisting");

    let hookRan = false;
    registerShutdownHook({
      name: "test-hook",
      priority: 0,
      fn: async () => {
        hookRan = true;
      },
    });

    // Simulate the external provider's signal handler
    const externalHandler = vi.fn();
    process.on("SIGTERM", externalHandler);

    try {
      process.emit("SIGTERM", "SIGTERM");
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }

      // Glasstrace hooks ran
      expect(hookRan).toBe(true);
      // Glasstrace did NOT re-raise — external handler owns termination
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      process.removeListener("SIGTERM", externalHandler);
    }
  });

  it('flag "coexisting": core state reaches SHUTDOWN even without re-raise', async () => {
    setCoreState(CoreState.REGISTERING);
    setCoreState(CoreState.KEY_PENDING);
    registerSignalHandlers();
    setCoexistenceState("coexisting");

    // External handler registered
    const externalHandler = vi.fn();
    process.on("SIGTERM", externalHandler);

    try {
      process.emit("SIGTERM", "SIGTERM");
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }

      expect(getCoreState()).toBe(CoreState.SHUTDOWN);
    } finally {
      process.removeListener("SIGTERM", externalHandler);
    }
  });

  it('flag "coexisting" + no other handler: re-raises to prevent process hang', async () => {
    setCoreState(CoreState.REGISTERING);
    setCoreState(CoreState.KEY_PENDING);
    registerSignalHandlers();
    setCoexistenceState("coexisting");

    // No external handler — coexistenceState says "coexisting" but no
    // actual handler is present (e.g., misconfigured provider)
    process.emit("SIGTERM", "SIGTERM");
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    // Must re-raise to avoid leaving the process running indefinitely
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
  });

  // ---------------------------------------------------------------------------
  // Heartbeat hook fires in Scenario B (DISC-1265 primary bug regression)
  // ---------------------------------------------------------------------------

  it("Scenario B: heartbeat-style final-report hook runs on SIGTERM", async () => {
    // This is the primary regression: PR #146 skipped signal handler
    // installation in Scenario B, which combined with PR #145's removal of
    // heartbeat.ts's own SIGTERM listener meant the final report was never sent.
    setCoreState(CoreState.REGISTERING);
    setCoreState(CoreState.KEY_PENDING);
    registerSignalHandlers();
    setCoexistenceState("coexisting");

    // Register a "heartbeat final-report" hook (simulates what heartbeat.ts
    // registers via the lifecycle coordinator in DISC-1248).
    let finalReportSent = false;
    registerShutdownHook({
      name: "heartbeat-final-report",
      priority: 10,
      fn: async () => {
        finalReportSent = true;
      },
    });

    // Simulate external provider's SIGTERM handler
    const externalHandler = vi.fn();
    process.on("SIGTERM", externalHandler);

    try {
      process.emit("SIGTERM", "SIGTERM");
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }

      // The heartbeat hook must run even in Scenario B
      expect(finalReportSent).toBe(true);
    } finally {
      process.removeListener("SIGTERM", externalHandler);
    }
  });

  it("Scenario B: multiple shutdown hooks all run in priority order before yielding", async () => {
    setCoreState(CoreState.REGISTERING);
    setCoreState(CoreState.KEY_PENDING);
    registerSignalHandlers();
    setCoexistenceState("coexisting");

    const order: string[] = [];
    registerShutdownHook({
      name: "otel-flush",
      priority: 5,
      fn: async () => {
        order.push("otel-flush");
      },
    });
    registerShutdownHook({
      name: "heartbeat-final-report",
      priority: 10,
      fn: async () => {
        order.push("heartbeat-final-report");
      },
    });
    registerShutdownHook({
      name: "early-hook",
      priority: 0,
      fn: async () => {
        order.push("early-hook");
      },
    });

    const externalHandler = vi.fn();
    process.on("SIGTERM", externalHandler);

    try {
      process.emit("SIGTERM", "SIGTERM");
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }

      expect(order).toEqual(["early-hook", "otel-flush", "heartbeat-final-report"]);
    } finally {
      process.removeListener("SIGTERM", externalHandler);
    }
  });

  // ---------------------------------------------------------------------------
  // Late-arriving provider (async probe window — flag updated after install)
  // ---------------------------------------------------------------------------

  it("flag updated from 'unknown' to 'coexisting' between install and delivery", async () => {
    // Represents the async-probe window: handler installed with flag "unknown",
    // then configureOtel()'s async probe detects an existing provider and
    // updates the flag to "coexisting" before SIGTERM is delivered.
    setCoreState(CoreState.REGISTERING);
    setCoreState(CoreState.KEY_PENDING);
    registerSignalHandlers();

    // Simulate the async probe completing
    setCoexistenceState("coexisting");

    let hookRan = false;
    registerShutdownHook({
      name: "test-hook",
      priority: 0,
      fn: async () => {
        hookRan = true;
      },
    });

    // External provider's handler
    const externalHandler = vi.fn();
    process.on("SIGTERM", externalHandler);

    try {
      process.emit("SIGTERM", "SIGTERM");
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }

      expect(hookRan).toBe(true);
      // Handler correctly reads "coexisting" at delivery time — does NOT re-raise
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      process.removeListener("SIGTERM", externalHandler);
    }
  });

  it("flag updated from 'unknown' to 'sole-owner' between install and delivery", async () => {
    setCoreState(CoreState.REGISTERING);
    setCoreState(CoreState.KEY_PENDING);
    registerSignalHandlers();

    // Async probe completes: no external provider
    setCoexistenceState("sole-owner");

    process.emit("SIGTERM", "SIGTERM");
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    // Re-raises because sole-owner
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
  });
});
