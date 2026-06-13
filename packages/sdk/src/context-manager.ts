import { AsyncLocalStorage } from "node:async_hooks";
import * as otelApi from "@opentelemetry/api";

/**
 * Branded discriminator field on the stored guard value.
 *
 * Storing the guard payload as `{ glasstraceContextManagerBrand: 1, … }`
 * lets us detect at runtime whether the value on `globalThis[GUARD]` was
 * placed there by Glasstrace or by some foreign squatter that happens to
 * collide on the well-known symbol. Foreign values are treated as
 * "not yet attempted" and overwritten — refusing to install indefinitely
 * because of an unknown squatter would be the worse failure mode (no
 * trace context propagation at all). The brand lets us make that
 * decision deterministically rather than guessing from value shape.
 */
const GLASSTRACE_BRAND = 1 as const;

/**
 * Process-wide brand used to look up the prior installation result on
 * `globalThis`. The brand survives module re-evaluation (Turbopack HMR
 * rebuilds, Webpack `next dev` rebuilds, jest module isolation) because
 * it is keyed on a `Symbol.for()` global symbol — same mechanism used
 * by the exporter brand in `coexistence.ts`. Per V8 semantics
 * `globalThis` is per-isolate, so Node `worker_threads` and `vm.Context`
 * each get a fresh slot — that is the correct behavior, since a worker
 * is a logically separate process and gets its own context manager.
 */
const GUARD = Symbol.for("glasstrace.context-manager.installed");

/**
 * Well-known key under which `@opentelemetry/api` stores its global
 * registry on `globalThis`. The major version segment matches the
 * `@opentelemetry/api` peer dependency range (`^1.9.0`), so this value
 * is stable for the lifetime of the v1.x API line.
 *
 * Reading this slot lets us observe which `ContextManager` (if any) is
 * currently registered with OTel without going through the package's
 * private `_getContextManager()` accessor. We never write to it.
 */
const OTEL_API_KEY = Symbol.for("opentelemetry.js.api.1");

/**
 * Three-state record stored under `globalThis[GUARD]`.
 *
 * - `manager: ContextManager` — installation succeeded previously; reuse
 *   the same instance and short-circuit.
 * - `manager: null` — `setGlobalContextManager()` rejected previously
 *   (another tool already owns the slot). The rejection is sticky for
 *   as long as OTel's slot remains occupied by some manager; if the
 *   competing manager is later removed (e.g. via `context.disable()`),
 *   the next call retries registration.
 *
 * The "not yet attempted" state is encoded by the absence of the brand
 * (`globalThis[GUARD] === undefined`), not by a third record value.
 * Encoding it as a record value would require a 4-state enum and
 * complicate the foreign-collision logic for no benefit.
 */
interface InstallationRecord {
  readonly glasstraceContextManagerBrand: typeof GLASSTRACE_BRAND;
  readonly manager: otelApi.ContextManager | null;
}

/**
 * Type-narrowing predicate that identifies a value that has the shape
 * of an OTel `ContextManager` — the five-method interface defined by
 * `@opentelemetry/api`'s `context/types.ts`. Used both to validate the
 * `manager` field of an installation record and to treat foreign or
 * corrupt records as "not yet attempted" so they get overwritten on
 * the next call.
 */
function isOtelContextManager(value: unknown): value is otelApi.ContextManager {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<otelApi.ContextManager>;
  return (
    typeof candidate.active === "function" &&
    typeof candidate.with === "function" &&
    typeof candidate.bind === "function" &&
    typeof candidate.enable === "function" &&
    typeof candidate.disable === "function"
  );
}

/**
 * Type-narrowing predicate that identifies a payload Glasstrace itself
 * stored. Anything else (a plain string, a number, an object missing
 * the discriminator, an old Glasstrace-shaped value with a different
 * brand version, an object whose `manager` field is corrupt and not a
 * real OTel `ContextManager`) is treated as "not yet attempted" and
 * overwritten on the next call.
 *
 * Validating the `manager` shape — not just `typeof === "object"` —
 * prevents an attacker or a buggy collaborator that has corrupted the
 * brand slot to `{ glasstraceContextManagerBrand: 1, manager: {} }`
 * from short-circuiting `installContextManager()` and leaving the SDK
 * with no real context manager registered.
 */
function isInstallationRecord(value: unknown): value is InstallationRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<InstallationRecord>;
  if (candidate.glasstraceContextManagerBrand !== GLASSTRACE_BRAND) return false;
  return candidate.manager === null || isOtelContextManager(candidate.manager);
}

/**
 * Returns the `ContextManager` that OTel's global API currently has
 * registered, or `undefined` if no manager is registered (i.e. a call
 * to `otelApi.context.disable()` has cleared the slot, or no call to
 * `setGlobalContextManager()` has succeeded yet).
 *
 * Reads `globalThis[Symbol.for("opentelemetry.js.api.1")].context`
 * directly rather than calling the private `_getContextManager()`
 * accessor on the API instance — the latter falls back to a singleton
 * `NoopContextManager` when nothing is registered, which we cannot
 * disambiguate from "an unrelated tool registered the noop manager".
 * Reading the global slot itself is the only way to observe the
 * registration state truthfully.
 */
function getOtelRegisteredContextManager(): otelApi.ContextManager | undefined {
  const otelSlot = (globalThis as Record<symbol, unknown>)[OTEL_API_KEY];
  if (typeof otelSlot !== "object" || otelSlot === null) return undefined;
  const ctx = (otelSlot as { context?: unknown }).context;
  return isOtelContextManager(ctx) ? ctx : undefined;
}

/**
 * Internal helper used by tests to clear the `globalThis` brand between
 * cases. Not exported from the package barrel.
 *
 * @internal
 */
export function _resetContextManagerForTesting(): void {
  delete (globalThis as Record<symbol, unknown>)[GUARD];
}

/**
 * Registers an AsyncLocalStorage-based context manager with the OTel API.
 *
 * This MUST be called synchronously before any spans are created —
 * otherwise, spans created before registration have no parent context
 * and each gets a fresh traceId.
 *
 * Uses a static import of `node:async_hooks` (synchronous, no race
 * condition). This means the module cannot be evaluated in non-Node
 * environments (Edge Runtime, browser) — but the SDK is a server-side
 * package and non-Node environments are guarded by the `sideEffects: false`
 * flag in package.json (browser bundlers tree-shake it) and the browser
 * import check CI step externalizes `async_hooks`.
 *
 * **Idempotency contract.** Construction is idempotent
 * across module re-evaluations within a single V8 isolate. The first
 * successful call records the installed `ContextManager` instance
 * under `globalThis[Symbol.for("glasstrace.context-manager.installed")]`;
 * subsequent calls — including those that arrive after a Turbopack HMR
 * rebuild has reset the SDK's module-level `_coreState` — read the
 * recorded instance and return without constructing a fresh
 * `AsyncLocalStorage`, **so long as OTel's global slot still holds
 * that same manager instance**. This guard prevents unbounded
 * `AsyncLocalStorage` accumulation under Turbopack HMR
 * while still allowing recovery if an external caller has run
 * `otelApi.context.disable()` or replaced the manager underneath us.
 *
 * **Recovery semantics.** When the cached record disagrees with OTel's
 * actual registered manager, the SDK does the cheapest correct thing:
 *
 * - Cache says success and OTel's slot is now empty or holds a
 *   different manager → re-register the cached manager (no fresh
 *   `AsyncLocalStorage` allocation; the existing ALS continues to
 *   work).
 * - Cache says rejection and OTel's slot is now empty → drop the
 *   sticky-false state and attempt a real registration with a fresh
 *   manager. (If the slot is still occupied — by anyone — the
 *   sticky-false state remains.)
 *
 * The guard is per-V8-isolate (`globalThis` scope). `node:worker_threads`
 * and `node:vm` contexts each get a fresh slot, which is the correct
 * behavior — workers are logically separate processes and benefit from
 * their own context manager.
 *
 * @returns `true` if Glasstrace's context manager is registered with
 * OTel after this call (either still from a prior call or as a result
 * of this call); `false` if `setGlobalContextManager` rejected this
 * call or a prior rejection is still in effect.
 */
export function installContextManager(): boolean {
  try {
    const slot = globalThis as Record<symbol, unknown>;
    const existing = slot[GUARD];
    const otelCurrent = getOtelRegisteredContextManager();

    // Fast path: a prior call already registered our manager and OTel
    // still has it. No allocation, no API call, just return true.
    if (
      isInstallationRecord(existing) &&
      existing.manager !== null &&
      existing.manager === otelCurrent
    ) {
      return true;
    }

    // Cache says we previously hit a rejection. The rejection stays
    // sticky as long as OTel's slot is occupied — by anyone. Only when
    // the slot becomes empty do we drop the sticky-false state and
    // attempt a fresh registration below.
    if (
      isInstallationRecord(existing) &&
      existing.manager === null &&
      otelCurrent !== undefined
    ) {
      return false;
    }

    // Cache says we previously succeeded but OTel's state has
    // diverged: someone called `context.disable()` or replaced our
    // manager. Re-register the cached manager — its underlying
    // AsyncLocalStorage is still functional, so we avoid the
    // allocation that would otherwise reintroduce DISC-1310 under
    // repeated divergences.
    if (isInstallationRecord(existing) && existing.manager !== null) {
      const reSuccess = otelApi.context.setGlobalContextManager(existing.manager);
      if (!reSuccess) {
        console.warn(
          "[glasstrace] Another context manager is already registered. " +
          "Trace context propagation may not work as expected.",
        );
      }
      const reRecord: InstallationRecord = {
        glasstraceContextManagerBrand: GLASSTRACE_BRAND,
        manager: reSuccess ? existing.manager : null,
      };
      slot[GUARD] = reRecord;
      return reSuccess;
    }

    // Either no record exists, the existing record is foreign/corrupt,
    // or the prior rejection has expired (OTel slot is now empty).
    // Allocate a fresh ALS and attempt a real registration.
    const als = new AsyncLocalStorage<otelApi.Context>();

    const contextManager: otelApi.ContextManager = {
      active: () => als.getStore() ?? otelApi.ROOT_CONTEXT,
      with: <A extends unknown[], F extends (...args: A) => ReturnType<F>>(
        context: otelApi.Context,
        fn: F,
        thisArg?: ThisParameterType<F>,
        ...args: A
      ): ReturnType<F> => als.run(context, () => fn.apply(thisArg, args)),
      bind: <T>(context: otelApi.Context, target: T): T => {
        if (typeof target === "function") {
          const bound = (...fnArgs: unknown[]) =>
            als.run(context, () => (target as (...a: unknown[]) => unknown)(...fnArgs));
          return bound as T;
        }
        return target;
      },
      enable: () => contextManager,
      disable: () => contextManager,
    };

    const success = otelApi.context.setGlobalContextManager(contextManager);
    if (!success) {
      console.warn(
        "[glasstrace] Another context manager is already registered. " +
        "Trace context propagation may not work as expected.",
      );
    }

    // Record the outcome only AFTER setGlobalContextManager has returned,
    // so a throw from the OTel API leaves the slot empty and a
    // subsequent call may legitimately retry. A successful call records
    // the installed manager; a rejected call records `null` so the
    // rejection is sticky until OTel's slot is freed.
    const record: InstallationRecord = {
      glasstraceContextManagerBrand: GLASSTRACE_BRAND,
      manager: success ? contextManager : null,
    };
    slot[GUARD] = record;

    return success;
  } catch {
    return false;
  }
}
