/**
 * Unit tests for `installContextManager()`.
 *
 * Covers the DISC-1310 idempotency contract:
 *   1. Idempotency — repeated calls construct exactly one
 *      AsyncLocalStorage and call `setGlobalContextManager` exactly once
 *      while OTel's registered manager is still ours.
 *   2. OTel rejection — sticky as long as OTel's slot remains occupied;
 *      drops to "retry" once the slot becomes free again.
 *   3. Module re-evaluation — clearing the SDK's lifecycle module state
 *      (mimicking Turbopack HMR) and re-calling reuses the prior manager.
 *   4. Brand collision — a foreign actor squatting on the brand symbol
 *      with a non-conforming value (including a corrupt `manager` shape)
 *      is overwritten, not crashed on.
 *   5. Stale-cache recovery — when OTel's actual registered manager has
 *      diverged from our cached record, the next call re-registers
 *      rather than incorrectly short-circuiting on the cached state.
 *   6. DISC-1183 regression — context propagation across an async
 *      boundary survives in all three guard states.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as otelApi from "@opentelemetry/api";
import {
  installContextManager,
  _resetContextManagerForTesting,
} from "../../../packages/sdk/src/context-manager.js";
import { resetLifecycleForTesting } from "../../../packages/sdk/src/lifecycle.js";

const GUARD_SYMBOL = Symbol.for("glasstrace.context-manager.installed");

describe("installContextManager() — DISC-1310 idempotency", () => {
  beforeEach(() => {
    _resetContextManagerForTesting();
    // Clear OTel's global context manager between tests so each case
    // starts from a clean slate. `disable()` removes the manager from
    // OTel's global slot.
    otelApi.context.disable();
    resetLifecycleForTesting();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    _resetContextManagerForTesting();
    otelApi.context.disable();
    resetLifecycleForTesting();
    vi.restoreAllMocks();
  });

  describe("idempotency", () => {
    it("returns true on first call when OTel accepts the registration", () => {
      const result = installContextManager();
      expect(result).toBe(true);
    });

    it("calls setGlobalContextManager exactly once across N=3 sequential calls", () => {
      const spy = vi.spyOn(otelApi.context, "setGlobalContextManager");

      installContextManager();
      installContextManager();
      installContextManager();

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("returns true on every subsequent call after a successful first call", () => {
      expect(installContextManager()).toBe(true);
      expect(installContextManager()).toBe(true);
      expect(installContextManager()).toBe(true);
    });

    it("constructs exactly one ContextManager — the second call's active() returns the same context as the first", () => {
      installContextManager();
      const firstManager = otelApi.context["_getContextManager"]?.()
        ?? (otelApi.context as unknown as { _contextManager?: otelApi.ContextManager })
          ._contextManager;

      installContextManager();
      const secondManager = (otelApi.context as unknown as {
        _getContextManager?: () => otelApi.ContextManager;
        _contextManager?: otelApi.ContextManager;
      })._getContextManager?.()
        ?? (otelApi.context as unknown as { _contextManager?: otelApi.ContextManager })
          ._contextManager;

      expect(secondManager).toBe(firstManager);
    });

    it("records the installed manager on globalThis under the well-known brand symbol", () => {
      installContextManager();
      const stored = (globalThis as Record<symbol, unknown>)[GUARD_SYMBOL] as {
        glasstraceContextManagerBrand?: number;
        manager?: unknown;
      };
      expect(stored).toBeDefined();
      expect(stored.glasstraceContextManagerBrand).toBe(1);
      expect(stored.manager).not.toBeNull();
    });
  });

  describe("OTel rejection (sticky while slot is occupied)", () => {
    /**
     * Build a stand-in competing context manager that satisfies the
     * OTel `ContextManager` shape. Registering it before
     * `installContextManager()` makes OTel's slot legitimately
     * occupied, which is what triggers a real rejection.
     */
    function makeCompetingManager(): otelApi.ContextManager {
      const cm: otelApi.ContextManager = {
        active: () => otelApi.ROOT_CONTEXT,
        with: (_ctx, fn, thisArg, ...args) =>
          (fn as (...a: unknown[]) => unknown).apply(thisArg, args) as ReturnType<typeof fn>,
        bind: (_ctx, target) => target,
        enable: () => cm,
        disable: () => cm,
      };
      return cm;
    }

    it("returns false when OTel's slot is already occupied, and short-circuits while it stays occupied", () => {
      const competing = makeCompetingManager();
      otelApi.context.setGlobalContextManager(competing);

      const spy = vi.spyOn(otelApi.context, "setGlobalContextManager");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const first = installContextManager();
      const second = installContextManager();
      const third = installContextManager();

      expect(first).toBe(false);
      expect(second).toBe(false);
      expect(third).toBe(false);

      // Sticky while occupied: setGlobalContextManager called exactly
      // once across three install attempts.
      expect(spy).toHaveBeenCalledTimes(1);

      // Rejection logs the warning exactly once (subsequent calls
      // short-circuit before reaching the warn).
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("Another context manager is already registered");
    });

    it("records null under the brand when OTel rejects", () => {
      const competing = makeCompetingManager();
      otelApi.context.setGlobalContextManager(competing);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);

      installContextManager();

      const stored = (globalThis as Record<symbol, unknown>)[GUARD_SYMBOL] as {
        glasstraceContextManagerBrand?: number;
        manager?: unknown;
      };
      expect(stored.glasstraceContextManagerBrand).toBe(1);
      expect(stored.manager).toBeNull();
    });

    it("retries registration once OTel's slot becomes free again (regression: previously stuck on stale-false)", () => {
      const competing = makeCompetingManager();
      otelApi.context.setGlobalContextManager(competing);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);

      // First attempt: rejected (slot occupied).
      expect(installContextManager()).toBe(false);

      // Some other component frees the slot.
      otelApi.context.disable();

      // Next attempt should retry registration and succeed instead of
      // returning a stale `false`.
      expect(installContextManager()).toBe(true);
    });
  });

  describe("module re-evaluation (Turbopack HMR simulation)", () => {
    it("reuses the prior installation after lifecycle state has been reset", () => {
      const spy = vi.spyOn(otelApi.context, "setGlobalContextManager");

      // First call: real registration.
      const firstResult = installContextManager();
      expect(firstResult).toBe(true);

      // Simulate Turbopack HMR re-evaluating the SDK module graph: the
      // lifecycle module's _coreState resets to IDLE. The
      // `globalThis`-anchored brand survives this reset because it is
      // not module-local state.
      resetLifecycleForTesting();

      // Second call: under the old behavior this would construct a
      // brand-new AsyncLocalStorage. Under the guard it must short-
      // circuit.
      const secondResult = installContextManager();
      expect(secondResult).toBe(true);

      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe("brand collision (foreign squatter)", () => {
    it("overwrites a non-object squatter and proceeds with installation", () => {
      const slot = globalThis as Record<symbol, unknown>;
      slot[GUARD_SYMBOL] = "not a record";

      const result = installContextManager();
      expect(result).toBe(true);

      const stored = slot[GUARD_SYMBOL] as { glasstraceContextManagerBrand?: number };
      expect(stored.glasstraceContextManagerBrand).toBe(1);
    });

    it("overwrites a number squatter and proceeds with installation", () => {
      const slot = globalThis as Record<symbol, unknown>;
      slot[GUARD_SYMBOL] = 42;

      const result = installContextManager();
      expect(result).toBe(true);
    });

    it("overwrites null and proceeds with installation", () => {
      const slot = globalThis as Record<symbol, unknown>;
      slot[GUARD_SYMBOL] = null;

      const result = installContextManager();
      expect(result).toBe(true);
    });

    it("overwrites an object missing the discriminator field", () => {
      const slot = globalThis as Record<symbol, unknown>;
      slot[GUARD_SYMBOL] = { manager: "looks plausible but no brand" };

      const result = installContextManager();
      expect(result).toBe(true);

      const stored = slot[GUARD_SYMBOL] as { glasstraceContextManagerBrand?: number };
      expect(stored.glasstraceContextManagerBrand).toBe(1);
    });

    it("overwrites an object with a wrong brand version", () => {
      const slot = globalThis as Record<symbol, unknown>;
      slot[GUARD_SYMBOL] = {
        glasstraceContextManagerBrand: 99,
        manager: null,
      };

      const result = installContextManager();
      expect(result).toBe(true);

      const stored = slot[GUARD_SYMBOL] as { glasstraceContextManagerBrand?: number };
      expect(stored.glasstraceContextManagerBrand).toBe(1);
    });

    it("overwrites an object whose manager is a non-null primitive", () => {
      const slot = globalThis as Record<symbol, unknown>;
      slot[GUARD_SYMBOL] = {
        glasstraceContextManagerBrand: 1,
        manager: "not a context manager",
      };

      const result = installContextManager();
      expect(result).toBe(true);
    });

    it("overwrites a record whose `manager` is an empty object missing the OTel ContextManager methods", () => {
      // Copilot finding (PR #209, line 69): if the brand slot is
      // corrupted to `{ glasstraceContextManagerBrand: 1, manager: {} }`,
      // the previous predicate would short-circuit and return `true`
      // without ensuring a real OTel ContextManager is registered.
      const slot = globalThis as Record<symbol, unknown>;
      slot[GUARD_SYMBOL] = {
        glasstraceContextManagerBrand: 1,
        manager: {},
      };

      const result = installContextManager();
      expect(result).toBe(true);

      const stored = slot[GUARD_SYMBOL] as { manager?: unknown };
      // After installation, `manager` must be a real OTel
      // ContextManager (has the five-method shape), not the corrupt
      // empty object.
      const m = stored.manager as Record<string, unknown> | null;
      expect(m).not.toBeNull();
      expect(typeof m?.active).toBe("function");
      expect(typeof m?.with).toBe("function");
      expect(typeof m?.bind).toBe("function");
      expect(typeof m?.enable).toBe("function");
      expect(typeof m?.disable).toBe("function");
    });

    it("overwrites a record whose `manager` is partially shaped (missing one method)", () => {
      const slot = globalThis as Record<symbol, unknown>;
      slot[GUARD_SYMBOL] = {
        glasstraceContextManagerBrand: 1,
        manager: {
          active: () => otelApi.ROOT_CONTEXT,
          with: () => undefined,
          bind: <T>(_c: otelApi.Context, t: T) => t,
          enable: () => undefined,
          // disable: missing
        },
      };

      const result = installContextManager();
      expect(result).toBe(true);
    });
  });

  describe("stale-cache recovery (cached state diverges from OTel reality)", () => {
    it("re-registers when OTel's slot has been disabled underneath us (regression: previously short-circuited stale-true)", () => {
      // Codex P2 finding (PR #209, line 130).
      const spy = vi.spyOn(otelApi.context, "setGlobalContextManager");

      // First call registers our manager.
      expect(installContextManager()).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);

      // Some other component frees OTel's slot.
      otelApi.context.disable();

      // Next call must NOT short-circuit — OTel needs us re-registered.
      expect(installContextManager()).toBe(true);
      expect(spy).toHaveBeenCalledTimes(2);

      // And after re-registration the cache should reflect the
      // currently registered manager.
      const otelKey = Symbol.for("opentelemetry.js.api.1");
      const otelSlot = (globalThis as Record<symbol, unknown>)[otelKey] as {
        context?: otelApi.ContextManager;
      };
      const stored = (globalThis as Record<symbol, unknown>)[GUARD_SYMBOL] as {
        manager?: otelApi.ContextManager;
      };
      expect(stored.manager).toBe(otelSlot.context);
    });

    it("re-registers the SAME manager instance (no fresh AsyncLocalStorage) when re-attaching after disable", async () => {
      // First registration.
      installContextManager();
      const recordAfterFirst = (globalThis as Record<symbol, unknown>)[GUARD_SYMBOL] as {
        manager: otelApi.ContextManager;
      };
      const firstManager = recordAfterFirst.manager;

      otelApi.context.disable();

      installContextManager();
      const recordAfterSecond = (globalThis as Record<symbol, unknown>)[GUARD_SYMBOL] as {
        manager: otelApi.ContextManager;
      };

      // Identity check: re-registration reuses the cached manager
      // (and therefore its underlying AsyncLocalStorage).
      expect(recordAfterSecond.manager).toBe(firstManager);

      // And the propagation contract still holds.
      const ctx = otelApi.ROOT_CONTEXT.setValue(Symbol.for("test.k"), "v");
      let observed: otelApi.Context | undefined;
      await otelApi.context.with(ctx, async () => {
        await Promise.resolve();
        observed = otelApi.context.active();
      });
      expect(observed).toBe(ctx);
    });

    it("DISC-1310: 10 sequential install calls produce exactly one setGlobalContextManager call when OTel state is unchanged", () => {
      // HMR-rebuild simulation: the lifecycle module-state may reset
      // between calls, but the globalThis brand survives. While OTel
      // continues to hold our manager, the fast-path must short-circuit.
      const spy = vi.spyOn(otelApi.context, "setGlobalContextManager");

      for (let i = 0; i < 10; i++) {
        resetLifecycleForTesting();
        expect(installContextManager()).toBe(true);
      }

      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe("DISC-1183 regression — context survives async boundary", () => {
    it("first-call (fresh ALS): als.run(ctx, fn) preserves ctx across await", async () => {
      installContextManager();

      const ctx = otelApi.ROOT_CONTEXT.setValue(Symbol.for("test.k"), "value-1");

      let observed: otelApi.Context | undefined;
      await otelApi.context.with(ctx, async () => {
        await Promise.resolve();
        observed = otelApi.context.active();
      });

      expect(observed).toBe(ctx);
    });

    it("idempotent-second-call: prior ContextManager instance still propagates ctx", async () => {
      installContextManager();
      installContextManager(); // short-circuited, but ALS is the same

      const ctx = otelApi.ROOT_CONTEXT.setValue(Symbol.for("test.k"), "value-2");

      let observed: otelApi.Context | undefined;
      await otelApi.context.with(ctx, async () => {
        await Promise.resolve();
        observed = otelApi.context.active();
      });

      expect(observed).toBe(ctx);
    });

    it("failed-registration: SDK ALS path inactive but no exception thrown and OTel default still works", async () => {
      vi.spyOn(otelApi.context, "setGlobalContextManager").mockReturnValue(false);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const result = installContextManager();
      expect(result).toBe(false);

      // Even though the SDK's ALS-backed manager was rejected, calling
      // `otelApi.context.with` must not throw. OTel's default
      // (NoopContextManager) returns ROOT_CONTEXT but does not
      // propagate user contexts; the contract here is "no exception."
      let didThrow = false;
      try {
        await otelApi.context.with(otelApi.ROOT_CONTEXT, async () => {
          await Promise.resolve();
        });
      } catch {
        didThrow = true;
      }
      expect(didThrow).toBe(false);
    });
  });
});
