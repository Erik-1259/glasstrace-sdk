import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  CoreState,
  AuthState,
  OtelState,
  initLifecycle,
  initAuthState,
  setCoreState,
  setAuthState,
  setOtelState,
  getCoreState,
  getAuthState,
  getOtelState,
  getSdkState,
  onLifecycleEvent,
  offLifecycleEvent,
  emitLifecycleEvent,
  isReady,
  waitForReady,
  getStatus,
  registerShutdownHook,
  executeShutdown,
  resetLifecycleForTesting,
} from "../../../packages/sdk/src/lifecycle.js";

const mockLogger = vi.fn();

describe("SDK Lifecycle State Machine", () => {
  beforeEach(() => {
    resetLifecycleForTesting();
    mockLogger.mockClear();
    initLifecycle({ logger: mockLogger });
  });

  describe("Initial state", () => {
    it("starts in IDLE / ANONYMOUS / UNCONFIGURED", () => {
      const state = getSdkState();
      expect(state.core).toBe(CoreState.IDLE);
      expect(state.auth).toBe(AuthState.ANONYMOUS);
      expect(state.otel).toBe(OtelState.UNCONFIGURED);
    });
  });

  describe("Core state transitions", () => {
    it("IDLE → REGISTERING", () => {
      setCoreState(CoreState.REGISTERING);
      expect(getCoreState()).toBe(CoreState.REGISTERING);
    });

    it("REGISTERING → KEY_PENDING", () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      expect(getCoreState()).toBe(CoreState.KEY_PENDING);
    });

    it("REGISTERING → PRODUCTION_DISABLED", () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.PRODUCTION_DISABLED);
      expect(getCoreState()).toBe(CoreState.PRODUCTION_DISABLED);
    });

    it("REGISTERING → REGISTRATION_FAILED", () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.REGISTRATION_FAILED);
      expect(getCoreState()).toBe(CoreState.REGISTRATION_FAILED);
    });

    it("KEY_PENDING → KEY_RESOLVED", () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.KEY_RESOLVED);
      expect(getCoreState()).toBe(CoreState.KEY_RESOLVED);
    });

    it("KEY_RESOLVED → ACTIVE", () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.KEY_RESOLVED);
      setCoreState(CoreState.ACTIVE);
      expect(getCoreState()).toBe(CoreState.ACTIVE);
    });

    it("KEY_RESOLVED → ACTIVE_DEGRADED", () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.KEY_RESOLVED);
      setCoreState(CoreState.ACTIVE_DEGRADED);
      expect(getCoreState()).toBe(CoreState.ACTIVE_DEGRADED);
    });

    it("ACTIVE ↔ ACTIVE_DEGRADED oscillation", () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.KEY_RESOLVED);
      setCoreState(CoreState.ACTIVE);
      setCoreState(CoreState.ACTIVE_DEGRADED);
      expect(getCoreState()).toBe(CoreState.ACTIVE_DEGRADED);
      setCoreState(CoreState.ACTIVE);
      expect(getCoreState()).toBe(CoreState.ACTIVE);
    });

    it("ACTIVE → SHUTTING_DOWN → SHUTDOWN", () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.KEY_RESOLVED);
      setCoreState(CoreState.ACTIVE);
      setCoreState(CoreState.SHUTTING_DOWN);
      expect(getCoreState()).toBe(CoreState.SHUTTING_DOWN);
      setCoreState(CoreState.SHUTDOWN);
      expect(getCoreState()).toBe(CoreState.SHUTDOWN);
    });

    it("KEY_PENDING → SHUTTING_DOWN (early shutdown)", () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.SHUTTING_DOWN);
      expect(getCoreState()).toBe(CoreState.SHUTTING_DOWN);
    });
  });

  describe("Invalid transitions", () => {
    it("rejects IDLE → ACTIVE", () => {
      setCoreState(CoreState.ACTIVE);
      expect(getCoreState()).toBe(CoreState.IDLE);
      expect(mockLogger).toHaveBeenCalledWith(
        "warn",
        expect.stringContaining("Invalid core state transition: IDLE → ACTIVE"),
      );
    });

    it("rejects transitions out of SHUTDOWN", () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.KEY_RESOLVED);
      setCoreState(CoreState.ACTIVE);
      setCoreState(CoreState.SHUTTING_DOWN);
      setCoreState(CoreState.SHUTDOWN);
      mockLogger.mockClear();

      setCoreState(CoreState.ACTIVE);
      expect(getCoreState()).toBe(CoreState.SHUTDOWN);
      expect(mockLogger).toHaveBeenCalledWith(
        "warn",
        expect.stringContaining("Invalid core state transition: SHUTDOWN → ACTIVE"),
      );
    });

    it("rejects transitions out of PRODUCTION_DISABLED", () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.PRODUCTION_DISABLED);
      mockLogger.mockClear();

      setCoreState(CoreState.KEY_PENDING);
      expect(getCoreState()).toBe(CoreState.PRODUCTION_DISABLED);
      expect(mockLogger).toHaveBeenCalledWith(
        "warn",
        expect.stringContaining("Invalid core state transition"),
      );
    });

    it("no-ops when setting same state", () => {
      setCoreState(CoreState.REGISTERING);
      mockLogger.mockClear();

      setCoreState(CoreState.REGISTERING);
      expect(mockLogger).not.toHaveBeenCalled();
    });
  });

  describe("Auth state transitions", () => {
    it("initial state is ANONYMOUS", () => {
      expect(getAuthState()).toBe(AuthState.ANONYMOUS);
    });

    it("ANONYMOUS → CLAIMING", () => {
      setAuthState(AuthState.CLAIMING);
      expect(getAuthState()).toBe(AuthState.CLAIMING);
    });

    it("CLAIMING → CLAIMED", () => {
      setAuthState(AuthState.CLAIMING);
      setAuthState(AuthState.CLAIMED);
      expect(getAuthState()).toBe(AuthState.CLAIMED);
    });

    it("rejects ANONYMOUS → AUTHENTICATED via setAuthState (cross-process only)", () => {
      setAuthState(AuthState.AUTHENTICATED);
      expect(getAuthState()).toBe(AuthState.ANONYMOUS);
      expect(mockLogger).toHaveBeenCalledWith(
        "warn",
        expect.stringContaining("Invalid auth state transition"),
      );
    });

    it("initAuthState sets initial state without transition validation", () => {
      initAuthState(AuthState.AUTHENTICATED);
      expect(getAuthState()).toBe(AuthState.AUTHENTICATED);
    });

    it("initAuthState warns on second call", () => {
      initAuthState(AuthState.AUTHENTICATED);
      initAuthState(AuthState.ANONYMOUS);
      expect(getAuthState()).toBe(AuthState.AUTHENTICATED);
      expect(mockLogger).toHaveBeenCalledWith(
        "warn",
        expect.stringContaining("initAuthState() called after auth state already initialized"),
      );
    });

    it("rejects transitions out of CLAIMED", () => {
      setAuthState(AuthState.CLAIMING);
      setAuthState(AuthState.CLAIMED);
      mockLogger.mockClear();

      setAuthState(AuthState.ANONYMOUS);
      expect(getAuthState()).toBe(AuthState.CLAIMED);
    });
  });

  describe("OTel state transitions", () => {
    it("initial state is UNCONFIGURED", () => {
      expect(getOtelState()).toBe(OtelState.UNCONFIGURED);
    });

    it("UNCONFIGURED → CONFIGURING", () => {
      setOtelState(OtelState.CONFIGURING);
      expect(getOtelState()).toBe(OtelState.CONFIGURING);
    });

    it("CONFIGURING → OWNS_PROVIDER", () => {
      setOtelState(OtelState.CONFIGURING);
      setOtelState(OtelState.OWNS_PROVIDER);
      expect(getOtelState()).toBe(OtelState.OWNS_PROVIDER);
    });

    it("CONFIGURING → AUTO_ATTACHED", () => {
      setOtelState(OtelState.CONFIGURING);
      setOtelState(OtelState.AUTO_ATTACHED);
      expect(getOtelState()).toBe(OtelState.AUTO_ATTACHED);
    });

    it("CONFIGURING → PROCESSOR_PRESENT", () => {
      setOtelState(OtelState.CONFIGURING);
      setOtelState(OtelState.PROCESSOR_PRESENT);
      expect(getOtelState()).toBe(OtelState.PROCESSOR_PRESENT);
    });

    it("CONFIGURING → COEXISTENCE_FAILED", () => {
      setOtelState(OtelState.CONFIGURING);
      setOtelState(OtelState.COEXISTENCE_FAILED);
      expect(getOtelState()).toBe(OtelState.COEXISTENCE_FAILED);
    });

    it("rejects UNCONFIGURED → OWNS_PROVIDER (must go through CONFIGURING)", () => {
      setOtelState(OtelState.OWNS_PROVIDER);
      expect(getOtelState()).toBe(OtelState.UNCONFIGURED);
      expect(mockLogger).toHaveBeenCalledWith(
        "warn",
        expect.stringContaining("Invalid OTel state transition"),
      );
    });
  });

  describe("Event emission", () => {
    it("emits core:state_changed on every core transition", () => {
      const events: Array<{ from: CoreState; to: CoreState }> = [];
      onLifecycleEvent("core:state_changed", (payload) => events.push(payload));

      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ from: CoreState.IDLE, to: CoreState.REGISTERING });
      expect(events[1]).toEqual({ from: CoreState.REGISTERING, to: CoreState.KEY_PENDING });
    });

    it("emits core:ready exactly once on first ACTIVE", () => {
      const readyEvents: Array<Record<string, never>> = [];
      onLifecycleEvent("core:ready", (payload) => readyEvents.push(payload));

      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.KEY_RESOLVED);
      setCoreState(CoreState.ACTIVE);
      // Oscillate — should NOT emit core:ready again
      setCoreState(CoreState.ACTIVE_DEGRADED);
      setCoreState(CoreState.ACTIVE);

      expect(readyEvents).toHaveLength(1);
    });

    it("emits core:ready on ACTIVE_DEGRADED if that's the first ready state", () => {
      const readyEvents: Array<Record<string, never>> = [];
      onLifecycleEvent("core:ready", (payload) => readyEvents.push(payload));

      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.KEY_RESOLVED);
      setCoreState(CoreState.ACTIVE_DEGRADED);

      expect(readyEvents).toHaveLength(1);
    });

    it("emits core:shutdown_started on SHUTTING_DOWN", () => {
      const events: Array<Record<string, never>> = [];
      onLifecycleEvent("core:shutdown_started", (payload) => events.push(payload));

      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.SHUTTING_DOWN);

      expect(events).toHaveLength(1);
    });

    it("emits core:shutdown_completed on SHUTDOWN", () => {
      const events: Array<Record<string, never>> = [];
      onLifecycleEvent("core:shutdown_completed", (payload) => events.push(payload));

      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.SHUTTING_DOWN);
      setCoreState(CoreState.SHUTDOWN);

      expect(events).toHaveLength(1);
    });

    it("does not emit events on invalid transitions", () => {
      const events: Array<{ from: CoreState; to: CoreState }> = [];
      onLifecycleEvent("core:state_changed", (payload) => events.push(payload));

      setCoreState(CoreState.ACTIVE); // invalid from IDLE

      expect(events).toHaveLength(0);
    });

    it("catches and logs errors in event listeners", () => {
      onLifecycleEvent("core:state_changed", () => {
        throw new Error("listener blew up");
      });

      setCoreState(CoreState.REGISTERING);

      expect(getCoreState()).toBe(CoreState.REGISTERING);
      expect(mockLogger).toHaveBeenCalledWith(
        "error",
        expect.stringContaining("Error in lifecycle event listener"),
      );
    });

    it("continues calling remaining listeners after one throws", () => {
      const calls: number[] = [];

      onLifecycleEvent("core:state_changed", () => {
        calls.push(1);
        throw new Error("first listener throws");
      });
      onLifecycleEvent("core:state_changed", () => {
        calls.push(2);
      });
      onLifecycleEvent("core:state_changed", () => {
        calls.push(3);
      });

      setCoreState(CoreState.REGISTERING);

      expect(calls).toEqual([1, 2, 3]);
    });

    it("emitLifecycleEvent allows other modules to emit typed events", () => {
      const events: Array<{ error: string }> = [];
      onLifecycleEvent("health:init_failed", (payload) => events.push(payload));

      emitLifecycleEvent("health:init_failed", { error: "network timeout" });

      expect(events).toHaveLength(1);
      expect(events[0].error).toBe("network timeout");
    });

    it("reentrant setCoreState does not emit stale events", () => {
      const events: Array<{ from: CoreState; to: CoreState }> = [];
      onLifecycleEvent("core:state_changed", (payload) => {
        events.push(payload);
        // Reentrant: listener triggers another transition
        if (payload.to === CoreState.REGISTERING) {
          setCoreState(CoreState.KEY_PENDING);
        }
      });

      setCoreState(CoreState.REGISTERING);

      // Both transitions should have occurred
      expect(getCoreState()).toBe(CoreState.KEY_PENDING);
      // The first event fires, but the reentrant call's state_changed
      // is suppressed (reentrancy guard). The state is correct though.
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ from: CoreState.IDLE, to: CoreState.REGISTERING });
    });

    it("offLifecycleEvent removes listener", () => {
      const events: Array<{ from: CoreState; to: CoreState }> = [];
      const listener = (payload: { from: CoreState; to: CoreState }) => events.push(payload);

      onLifecycleEvent("core:state_changed", listener);
      setCoreState(CoreState.REGISTERING);
      expect(events).toHaveLength(1);

      offLifecycleEvent("core:state_changed", listener);
      setCoreState(CoreState.KEY_PENDING);
      expect(events).toHaveLength(1); // no new event
    });
  });

  describe("getSdkState()", () => {
    it("returns correct composite state", () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setOtelState(OtelState.CONFIGURING);
      setOtelState(OtelState.OWNS_PROVIDER);

      const state = getSdkState();
      expect(state.core).toBe(CoreState.KEY_PENDING);
      expect(state.auth).toBe(AuthState.ANONYMOUS);
      expect(state.otel).toBe(OtelState.OWNS_PROVIDER);
    });
  });

  describe("initLifecycle()", () => {
    it("warns on double initialization", () => {
      // Already initialized in beforeEach
      const secondLogger = vi.fn();
      initLifecycle({ logger: secondLogger });

      expect(secondLogger).toHaveBeenCalledWith(
        "warn",
        expect.stringContaining("initLifecycle() called twice"),
      );
    });
  });

  describe("resetLifecycleForTesting()", () => {
    it("resets all state to initial", () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setAuthState(AuthState.CLAIMING);
      setOtelState(OtelState.CONFIGURING);

      resetLifecycleForTesting();

      const state = getSdkState();
      expect(state.core).toBe(CoreState.IDLE);
      expect(state.auth).toBe(AuthState.ANONYMOUS);
      expect(state.otel).toBe(OtelState.UNCONFIGURED);
    });

    it("removes all event listeners", () => {
      const events: unknown[] = [];
      onLifecycleEvent("core:state_changed", (payload) => events.push(payload));

      resetLifecycleForTesting();
      initLifecycle({ logger: mockLogger });

      setCoreState(CoreState.REGISTERING);
      expect(events).toHaveLength(0);
    });

    it("resets initialized flag so initLifecycle can be called again", () => {
      resetLifecycleForTesting();

      const newLogger = vi.fn();
      initLifecycle({ logger: newLogger });

      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.ACTIVE); // invalid — should warn via newLogger

      expect(newLogger).toHaveBeenCalledWith(
        "warn",
        expect.stringContaining("Invalid core state transition"),
      );
    });

    it("resets core:ready so it can fire again", () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.KEY_RESOLVED);
      setCoreState(CoreState.ACTIVE);

      resetLifecycleForTesting();
      initLifecycle({ logger: mockLogger });

      const readyEvents: unknown[] = [];
      onLifecycleEvent("core:ready", (payload) => readyEvents.push(payload));

      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.KEY_RESOLVED);
      setCoreState(CoreState.ACTIVE);

      expect(readyEvents).toHaveLength(1);
    });
  });

  describe("isReady()", () => {
    it("returns false in IDLE state", () => {
      expect(isReady()).toBe(false);
    });

    it("returns false in KEY_PENDING state", () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      expect(isReady()).toBe(false);
    });

    it("returns true in ACTIVE state", () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.KEY_RESOLVED);
      setCoreState(CoreState.ACTIVE);
      expect(isReady()).toBe(true);
    });

    it("returns true in ACTIVE_DEGRADED state", () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.KEY_RESOLVED);
      setCoreState(CoreState.ACTIVE_DEGRADED);
      expect(isReady()).toBe(true);
    });
  });

  describe("waitForReady()", () => {
    it("resolves immediately if already ACTIVE", async () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.KEY_RESOLVED);
      setCoreState(CoreState.ACTIVE);

      await expect(waitForReady()).resolves.toBeUndefined();
    });

    it("rejects immediately on PRODUCTION_DISABLED", async () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.PRODUCTION_DISABLED);

      await expect(waitForReady()).rejects.toThrow("terminal state");
    });

    it("resolves when ACTIVE is reached later", async () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);

      const promise = waitForReady(5000);

      // Simulate async progression
      setCoreState(CoreState.KEY_RESOLVED);
      setCoreState(CoreState.ACTIVE);

      await expect(promise).resolves.toBeUndefined();
    });

    it("resolves when ACTIVE_DEGRADED is reached later", async () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);

      const promise = waitForReady(5000);

      setCoreState(CoreState.KEY_RESOLVED);
      setCoreState(CoreState.ACTIVE_DEGRADED);

      await expect(promise).resolves.toBeUndefined();
    });

    it("rejects on timeout", async () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);

      await expect(waitForReady(10)).rejects.toThrow("timed out");
    });

    it("rejects when REGISTRATION_FAILED reached while waiting", async () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);

      const promise = waitForReady(5000);

      setCoreState(CoreState.REGISTRATION_FAILED);

      await expect(promise).rejects.toThrow("terminal state");
    });
  });

  describe("getStatus()", () => {
    it("returns not-configured when OTel is UNCONFIGURED", () => {
      const status = getStatus();
      expect(status.ready).toBe(false);
      expect(status.mode).toBe("anonymous");
      expect(status.tracing).toBe("not-configured");
    });

    it("returns active when ACTIVE + OWNS_PROVIDER", () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.KEY_RESOLVED);
      setCoreState(CoreState.ACTIVE);
      setOtelState(OtelState.CONFIGURING);
      setOtelState(OtelState.OWNS_PROVIDER);

      const status = getStatus();
      expect(status.ready).toBe(true);
      expect(status.tracing).toBe("active");
    });

    it("returns coexistence when AUTO_ATTACHED", () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.KEY_RESOLVED);
      setCoreState(CoreState.ACTIVE);
      setOtelState(OtelState.CONFIGURING);
      setOtelState(OtelState.AUTO_ATTACHED);

      const status = getStatus();
      expect(status.tracing).toBe("coexistence");
    });

    it("returns degraded when ACTIVE_DEGRADED", () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.KEY_RESOLVED);
      setCoreState(CoreState.ACTIVE_DEGRADED);
      setOtelState(OtelState.CONFIGURING);
      setOtelState(OtelState.OWNS_PROVIDER);

      const status = getStatus();
      expect(status.ready).toBe(true);
      expect(status.tracing).toBe("degraded");
    });

    it("returns disabled mode for PRODUCTION_DISABLED", () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.PRODUCTION_DISABLED);

      const status = getStatus();
      expect(status.mode).toBe("disabled");
    });

    it("returns authenticated mode when auth is AUTHENTICATED", () => {
      initAuthState(AuthState.AUTHENTICATED);
      const status = getStatus();
      expect(status.mode).toBe("authenticated");
    });

    it("returns not-configured during CONFIGURING state", () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setOtelState(OtelState.CONFIGURING);

      const status = getStatus();
      expect(status.tracing).toBe("not-configured");
    });
  });

  describe("Shutdown coordinator", () => {
    it("executes hooks in priority order", async () => {
      const order: string[] = [];

      registerShutdownHook({ name: "third", priority: 20, fn: async () => { order.push("third"); } });
      registerShutdownHook({ name: "first", priority: 0, fn: async () => { order.push("first"); } });
      registerShutdownHook({ name: "second", priority: 10, fn: async () => { order.push("second"); } });

      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.KEY_RESOLVED);
      setCoreState(CoreState.ACTIVE);

      await executeShutdown();

      expect(order).toEqual(["first", "second", "third"]);
      expect(getCoreState()).toBe(CoreState.SHUTDOWN);
    });

    it("catches and logs hook errors without stopping", async () => {
      const order: string[] = [];

      registerShutdownHook({ name: "fails", priority: 0, fn: async () => { throw new Error("boom"); } });
      registerShutdownHook({ name: "still-runs", priority: 10, fn: async () => { order.push("ran"); } });

      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.KEY_RESOLVED);
      setCoreState(CoreState.ACTIVE);

      await executeShutdown();

      expect(order).toEqual(["ran"]);
      expect(getCoreState()).toBe(CoreState.SHUTDOWN);
      expect(mockLogger).toHaveBeenCalledWith(
        "warn",
        expect.stringContaining('Shutdown hook "fails" failed'),
      );
    });

    it("works from non-ACTIVE state (e.g., KEY_PENDING)", async () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);

      await executeShutdown();

      expect(getCoreState()).toBe(CoreState.SHUTDOWN);
    });

    it("is idempotent — second call is no-op", async () => {
      let callCount = 0;
      registerShutdownHook({ name: "counter", priority: 0, fn: async () => { callCount++; } });

      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.KEY_RESOLVED);
      setCoreState(CoreState.ACTIVE);

      await executeShutdown();
      await executeShutdown();

      expect(callCount).toBe(1);
    });
  });
});
