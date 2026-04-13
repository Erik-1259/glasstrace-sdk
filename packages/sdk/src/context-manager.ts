import { AsyncLocalStorage } from "node:async_hooks";
import * as otelApi from "@opentelemetry/api";

/**
 * Registers an AsyncLocalStorage-based context manager with the OTel API.
 *
 * This MUST be called synchronously before any spans are created —
 * otherwise, spans created before registration have no parent context
 * and each gets a fresh traceId (DISC-1183).
 *
 * Uses a static import of `node:async_hooks` (synchronous, no race
 * condition). This means the module cannot be evaluated in non-Node
 * environments (Edge Runtime, browser) — but the SDK is a server-side
 * package and non-Node environments are guarded by the `sideEffects: false`
 * flag in package.json (browser bundlers tree-shake it) and the browser
 * import check CI step externalizes `async_hooks`.
 *
 * @returns `true` if the context manager was installed, `false` if
 * another tool already registered a context manager.
 */
export function installContextManager(): boolean {
  try {
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
    return success;
  } catch {
    return false;
  }
}
