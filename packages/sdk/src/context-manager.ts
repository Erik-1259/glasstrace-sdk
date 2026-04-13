import * as otelApi from "@opentelemetry/api";

/**
 * Registers an AsyncLocalStorage-based context manager with the OTel API.
 *
 * This MUST be called synchronously before any spans are created —
 * otherwise, spans created before registration have no parent context
 * and each gets a fresh traceId (DISC-1183).
 *
 * Uses `Function("id", "return require(id)")` to load `node:async_hooks`
 * without a static import, keeping it out of the module graph for
 * browser bundlers. This is the same pattern used by `tryImport` in
 * `otel-config.ts` for optional peer dependencies.
 *
 * No-ops silently if `AsyncLocalStorage` is unavailable (non-Node env).
 */
export function installContextManager(): void {
  try {
    // Dynamic require hidden from bundlers (same pattern as tryImport
    // but synchronous — context manager must be registered before the
    // first span is created, not after an async tick).
    const req = Function("id", "return require(id)") as (id: string) => Record<string, unknown>;
    const asyncHooks = req("node:async_hooks") as {
      AsyncLocalStorage: new <T>() => {
        getStore: () => T | undefined;
        run: <R>(store: T, fn: () => R) => R;
      };
    };

    const als = new asyncHooks.AsyncLocalStorage<otelApi.Context>();

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

    otelApi.context.setGlobalContextManager(contextManager);
  } catch {
    // AsyncLocalStorage not available (non-Node environment).
    // Spans will still be captured but without parent-child relationships.
  }
}
