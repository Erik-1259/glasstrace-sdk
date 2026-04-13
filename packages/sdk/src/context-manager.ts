import * as otelApi from "@opentelemetry/api";

/**
 * Cached AsyncLocalStorage constructor, loaded eagerly at module
 * evaluation time via dynamic import. Available by the time
 * registerGlasstrace() runs because the module is imported at the
 * top of register.ts.
 */
let AsyncLocalStorageCtor: (new <T>() => {
  getStore: () => T | undefined;
  run: <R>(store: T, fn: () => R) => R;
}) | null = null;

// Load AsyncLocalStorage eagerly via dynamic import at module evaluation.
// This runs when register.ts imports this module — before registerGlasstrace()
// is called. The dynamic import resolves in one microtask on Node.js built-ins.
// Uses Function("id", "return import(id)") to hide from static analysis
// (same pattern as tryImport in otel-config.ts).
try {
  const importFn = Function("id", "return import(id)") as (id: string) => Promise<Record<string, unknown>>;
  importFn("node:async_hooks").then(
    (mod) => {
      AsyncLocalStorageCtor = mod.AsyncLocalStorage as typeof AsyncLocalStorageCtor;
    },
    () => { /* non-Node environment */ },
  );
} catch {
  // Function constructor not available — non-standard environment
}

/**
 * Registers an AsyncLocalStorage-based context manager with the OTel API.
 *
 * This MUST be called synchronously in registerGlasstrace() before any
 * spans are created. The AsyncLocalStorage constructor is loaded eagerly
 * at module import time (above) via dynamic import. By the time
 * registerGlasstrace() is called from instrumentation.ts's register()
 * hook, the microtask has resolved and AsyncLocalStorageCtor is available.
 *
 * If AsyncLocalStorage is not yet available (extremely unlikely — would
 * require registerGlasstrace() to be called in the same microtask as the
 * module import), falls back gracefully with no context propagation.
 *
 * @returns `true` if the context manager was installed, `false` if it
 * could not be installed (non-Node env or another tool registered first).
 */
export function installContextManager(): boolean {
  if (!AsyncLocalStorageCtor) {
    return false;
  }

  try {
    const als = new AsyncLocalStorageCtor<otelApi.Context>();

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
    return success;
  } catch {
    return false;
  }
}
