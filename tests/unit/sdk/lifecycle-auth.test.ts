import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  CoreState,
  AuthState,
  initLifecycle,
  initAuthState,
  setAuthState,
  getAuthState,
  getCoreState,
  setCoreState,
  onLifecycleEvent,
  emitLifecycleEvent,
  resetLifecycleForTesting,
} from "../../../packages/sdk/src/lifecycle.js";

const mockLogger = vi.fn();

describe("Auth Lifecycle Integration", () => {
  beforeEach(() => {
    resetLifecycleForTesting();
    mockLogger.mockClear();
    initLifecycle({ logger: mockLogger });
  });

  describe("Initial auth state", () => {
    it("defaults to ANONYMOUS", () => {
      expect(getAuthState()).toBe(AuthState.ANONYMOUS);
    });

    it("can be set to AUTHENTICATED via initAuthState", () => {
      initAuthState(AuthState.AUTHENTICATED);
      expect(getAuthState()).toBe(AuthState.AUTHENTICATED);
    });
  });

  describe("auth:key_resolved event", () => {
    it("can be emitted for anonymous mode", () => {
      const events: Array<{ key: string; mode: string }> = [];
      onLifecycleEvent("auth:key_resolved", (payload) => events.push(payload));

      emitLifecycleEvent("auth:key_resolved", { key: "gt_anon_test", mode: "anonymous" });

      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe("anonymous");
    });

    it("can be emitted for dev mode", () => {
      const events: Array<{ key: string; mode: string }> = [];
      onLifecycleEvent("auth:key_resolved", (payload) => events.push(payload));

      emitLifecycleEvent("auth:key_resolved", { key: "gt_dev_test", mode: "dev" });

      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe("dev");
    });
  });

  describe("Claim transition", () => {
    it("ANONYMOUS → CLAIMING → CLAIMED", () => {
      setAuthState(AuthState.CLAIMING);
      expect(getAuthState()).toBe(AuthState.CLAIMING);

      setAuthState(AuthState.CLAIMED);
      expect(getAuthState()).toBe(AuthState.CLAIMED);
    });

    it("emits claim events in order", () => {
      const startEvents: Array<{ accountId: string }> = [];
      const completeEvents: Array<{ newKey: string; accountId: string }> = [];

      onLifecycleEvent("auth:claim_started", (p) => startEvents.push(p));
      onLifecycleEvent("auth:claim_completed", (p) => completeEvents.push(p));

      setAuthState(AuthState.CLAIMING);
      emitLifecycleEvent("auth:claim_started", { accountId: "acct-123" });

      setAuthState(AuthState.CLAIMED);
      emitLifecycleEvent("auth:claim_completed", { newKey: "gt_dev_new", accountId: "acct-123" });

      expect(startEvents).toHaveLength(1);
      expect(startEvents[0].accountId).toBe("acct-123");
      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0].newKey).toBe("gt_dev_new");
    });
  });

  describe("AUTHENTICATED → CLAIMING (straggler linking)", () => {
    it("allows transition from AUTHENTICATED to CLAIMING", () => {
      initAuthState(AuthState.AUTHENTICATED);
      setAuthState(AuthState.CLAIMING);
      expect(getAuthState()).toBe(AuthState.CLAIMING);
    });

    it("allows CLAIMING → CLAIMED from AUTHENTICATED start", () => {
      initAuthState(AuthState.AUTHENTICATED);
      setAuthState(AuthState.CLAIMING);
      setAuthState(AuthState.CLAIMED);
      expect(getAuthState()).toBe(AuthState.CLAIMED);
    });

    it("allows re-claim from CLAIMED state", () => {
      setAuthState(AuthState.CLAIMING);
      setAuthState(AuthState.CLAIMED);
      setAuthState(AuthState.CLAIMING);
      expect(getAuthState()).toBe(AuthState.CLAIMING);
    });
  });

  describe("Auth state independence from core state", () => {
    it("auth can be ANONYMOUS while core is ACTIVE", () => {
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);
      setCoreState(CoreState.KEY_RESOLVED);
      setCoreState(CoreState.ACTIVE);

      expect(getCoreState()).toBe(CoreState.ACTIVE);
      expect(getAuthState()).toBe(AuthState.ANONYMOUS);
    });

    it("auth can be AUTHENTICATED while core is KEY_PENDING", () => {
      initAuthState(AuthState.AUTHENTICATED);
      setCoreState(CoreState.REGISTERING);
      setCoreState(CoreState.KEY_PENDING);

      expect(getCoreState()).toBe(CoreState.KEY_PENDING);
      expect(getAuthState()).toBe(AuthState.AUTHENTICATED);
    });
  });
});
